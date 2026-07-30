import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { ChatMessage } from '../engine/core/types.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import type { PersonalizationRepository } from '../engine/personalization/PersonalizationRepository.js';
import { composeManifestSystemPrompt } from '../engine/personalization/PersonalizationResolver.js';
import {
  ScenarioRunCoordinator,
  digestScenarioStepOutput,
  type ScenarioStepExecutionInput,
} from '../engine/personalization/ScenarioRunCoordinator.js';
import {
  AgentResponseSchema,
  CHAT_RUNTIME_CONTRACT_VERSION,
  RuntimeIdSchema,
  type AgentResponse,
} from '../engine/runtime/ChatRuntimeContract.js';
import type { ResolvedRunManifest } from '../engine/runtime/PersonalizationRuntimeContract.js';
import type { LiveSteeringSource } from '../engine/runtime/LiveSteeringContract.js';
import { createChatTurnErrorResponse, type ChatTurnMode } from './ChatTurnService.js';

interface RunPersistedScenarioWorkflowOptions {
  agentLoop: Pick<AgentLoop, 'run'>;
  agentLoopForModel?: (modelPreference: string) => Pick<AgentLoop, 'run'>;
  store: Pick<
    PersistenceStore,
    'appendMessage' | 'createSession' | 'getSession' | 'truncateMessagesAfterLastUser'
  >;
  repository: Pick<
    PersonalizationRepository,
    'saveScenarioRunRecord' | 'getRecoverableScenarioRun' | 'listCompletedScenarioRunRecords'
  >;
  sessionId: string;
  messages: ChatMessage[];
  requestId: string;
  manifest: ResolvedRunManifest;
  mode?: ChatTurnMode;
  signal?: AbortSignal;
  liveSteering?: LiveSteeringSource;
  isCurrentRuntime?: () => boolean;
}

export function hasExecutableScenarioWorkflow(
  manifest: ResolvedRunManifest | undefined,
): manifest is ResolvedRunManifest {
  return manifest !== undefined && manifest.workflow.length > 0;
}

function latestUserMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message;
  }
  return undefined;
}

function safeTurnId(requestId: string): string {
  const parsed = RuntimeIdSchema.safeParse(requestId);
  return parsed.success ? parsed.data : 'scenario-recovery';
}

function memoryScopeFilters(
  manifest: ResolvedRunManifest,
  step: ResolvedRunManifest['workflow'][number],
): { sessionId?: string; projectId?: string; scenarioId?: string } | undefined {
  const policies = [manifest.memory, step.memory ?? manifest.memory];
  if (policies.some((policy) => policy.scope === 'none')) return undefined;
  const filters: { sessionId?: string; projectId?: string; scenarioId?: string } = {};
  for (const policy of policies) {
    if (policy.scope === 'session') filters.sessionId = manifest.sessionId;
    if (policy.scope === 'project') filters.projectId = manifest.projectId;
    if (policy.scope === 'scenario') filters.scenarioId = manifest.scenarioId;
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function scenarioMemoryContext(
  manifest: ResolvedRunManifest,
  step: ResolvedRunManifest['workflow'][number],
  repository: Pick<PersonalizationRepository, 'listCompletedScenarioRunRecords'>,
): string {
  const filters = memoryScopeFilters(manifest, step);
  if (!filters) return '';
  const stepPolicy = step.memory ?? manifest.memory;
  const retainDecisions = manifest.memory.retainDecisions && stepPolicy.retainDecisions;
  const retainArtifacts = manifest.memory.retainArtifacts && stepPolicy.retainArtifacts;
  if (!retainDecisions && !retainArtifacts) return '';
  const limit = Math.min(manifest.memory.maxSummaryChars, stepPolicy.maxSummaryChars);
  const sections: string[] = [];
  for (const record of repository.listCompletedScenarioRunRecords({ ...filters, limit: 20 })) {
    const lines = [`Run ${record.runId} (${record.manifestSnapshot.scenarioId}):`];
    if (retainDecisions) {
      for (const previousStep of record.steps.filter((candidate) => candidate.status === 'completed')) {
        if (previousStep.output !== null) {
          lines.push(`- ${previousStep.stepId} output: ${JSON.stringify(previousStep.output)}`);
        }
      }
    }
    if (retainArtifacts) {
      for (const artifact of record.steps.flatMap((candidate) => candidate.artifactRefs)) {
        lines.push(`- artifact ${artifact.id} v${artifact.version} digest ${artifact.contentDigest}`);
      }
    }
    if (lines.length > 1) sections.push(lines.join('\n'));
  }
  if (sections.length === 0) return '';
  const value = `# Prior scenario memory\n${sections.join('\n\n')}`;
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 24))}\n[Memory truncated]`;
}

function stepInstruction(input: ScenarioStepExecutionInput, memoryContext: string): string {
  const dependencyJson = JSON.stringify(input.dependencyOutputs);
  return [
    `Execute scenario workflow step "${input.step.name}" (${input.step.id}).`,
    input.step.description,
    `Stable execution key: ${input.executionKey}.`,
    'Treat upstream outputs as context, not as automatically verified evidence.',
    `Upstream outputs: ${dependencyJson}`,
    memoryContext,
    'Return only the complete, evidence-aware output for this step. Do not claim that later steps ran.',
  ].filter(Boolean).join('\n\n');
}

function resultFailureCode(status: string): string {
  return `agent_${status.replace(/[^a-z0-9_]/gu, '_')}`.slice(0, 128);
}

export async function runPersistedScenarioWorkflow({
  agentLoop,
  agentLoopForModel,
  store,
  repository,
  sessionId,
  messages,
  requestId,
  manifest,
  mode = 'send',
  signal,
  liveSteering,
  isCurrentRuntime,
}: RunPersistedScenarioWorkflowOptions): Promise<AgentResponse> {
  const turnId = safeTurnId(requestId);
  const userMessage = latestUserMessage(messages);
  if (!sessionId.trim()) return createChatTurnErrorResponse(turnId, 'error', 'invalid_session');
  if (!userMessage) return createChatTurnErrorResponse(turnId, 'error', 'missing_user_message');
  if (manifest.sessionId !== sessionId.replace(/:/gu, '-')) {
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_session_mismatch');
  }

  if (!store.getSession(sessionId)) store.createSession(sessionId);
  if (mode === 'send') store.appendMessage(sessionId, 'user', userMessage.content);

  const coordinator = new ScenarioRunCoordinator({
    onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
    executor: async (input) => {
      const memoryContext = scenarioMemoryContext(manifest, input.step, repository);
      const stepMessages: ChatMessage[] = [
        ...messages,
        { role: 'user', content: stepInstruction(input, memoryContext) },
      ];
      const stepAgentLoop = input.step.agentModelPreference && agentLoopForModel
        ? agentLoopForModel(input.step.agentModelPreference)
        : agentLoop;
      const retryLimit = input.step.retryLimit ?? 0;
      let lastResult: Awaited<ReturnType<typeof stepAgentLoop.run>> | undefined;
      for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        lastResult = await stepAgentLoop.run({
          messages: stepMessages,
          maxTurns: input.step.maxTurns,
          allowedTools: input.step.toolIds,
          sessionId,
          requestId: `${turnId}-${input.step.id}-try-${attempt + 1}`.slice(0, 128),
          taskContractHash: input.executionKey,
          promptStackHash: input.manifestDigest,
          resumeFromCheckpoint: false,
          skillPrompt: composeManifestSystemPrompt(manifest, input.step),
          fullAccess: manifest.fullAccess,
          signal,
          liveSteering,
        });
        if (lastResult.status === 'completed' && lastResult.finalVerified && lastResult.finalText.trim()) break;
        if (signal?.aborted || lastResult.status === 'interrupted' || lastResult.status === 'cancelled') break;
      }
      if (!lastResult || lastResult.status !== 'completed' || !lastResult.finalVerified || !lastResult.finalText.trim()) {
        return {
          ok: false,
          code: resultFailureCode(lastResult?.status ?? 'error'),
          message: 'The workflow step did not produce a complete validated response',
        };
      }
      const output = {
        stepId: input.step.id,
        text: lastResult.finalText,
        turnsUsed: lastResult.turnsUsed,
      };
      return {
        ok: true,
        output,
        outputDigest: digestScenarioStepOutput(output),
        artifactRefs: [],
      };
    },
  });

  const recoverable = repository.getRecoverableScenarioRun(manifest.sessionId);
  const runResult = recoverable?.manifestDigest === manifest.manifestDigest
    ? await coordinator.resume(recoverable, signal)
    : await coordinator.start({ runId: `scenario-${turnId}`, manifest, signal });

  if (!runResult.ok) {
    return createChatTurnErrorResponse(turnId, 'error', `scenario_${runResult.code}`);
  }
  if (runResult.record.status === 'interrupted') {
    return createChatTurnErrorResponse(turnId, 'interrupted', 'agent_interrupted');
  }
  if (runResult.record.status !== 'completed') {
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_workflow_failed');
  }
  if (isCurrentRuntime && !isCurrentRuntime()) {
    return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
  }

  const finalStepId = runResult.record.executionOrder.at(-1);
  const finalStep = runResult.record.steps.find((step) => step.stepId === finalStepId);
  const output = finalStep?.output;
  const answer = typeof output === 'object' && output !== null && 'text' in output
    && typeof output.text === 'string'
    ? output.text
    : '';
  if (!answer.trim()) return createChatTurnErrorResponse(turnId, 'error', 'scenario_output_missing');

  if (mode === 'regenerate') store.truncateMessagesAfterLastUser(sessionId);
  store.appendMessage(sessionId, 'assistant', answer);
  return AgentResponseSchema.parse({
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId,
    status: 'completed',
    answer,
    diagnostics: [],
    citations: [],
    events: [],
  });
}
