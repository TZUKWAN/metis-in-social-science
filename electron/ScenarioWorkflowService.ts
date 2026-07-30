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
  store: Pick<
    PersistenceStore,
    'appendMessage' | 'createSession' | 'getSession' | 'truncateMessagesAfterLastUser'
  >;
  repository: Pick<
    PersonalizationRepository,
    'saveScenarioRunRecord' | 'getRecoverableScenarioRun'
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

function stepInstruction(input: ScenarioStepExecutionInput): string {
  const dependencyJson = JSON.stringify(input.dependencyOutputs);
  return [
    `Execute scenario workflow step "${input.step.name}" (${input.step.id}).`,
    input.step.description,
    `Stable execution key: ${input.executionKey}.`,
    'Treat upstream outputs as context, not as automatically verified evidence.',
    `Upstream outputs: ${dependencyJson}`,
    'Return only the complete, evidence-aware output for this step. Do not claim that later steps ran.',
  ].join('\n\n');
}

function resultFailureCode(status: string): string {
  return `agent_${status.replace(/[^a-z0-9_]/gu, '_')}`.slice(0, 128);
}

export async function runPersistedScenarioWorkflow({
  agentLoop,
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
      const stepMessages: ChatMessage[] = [
        ...messages,
        { role: 'user', content: stepInstruction(input) },
      ];
      const result = await agentLoop.run({
        messages: stepMessages,
        maxTurns: input.step.maxTurns,
        allowedTools: input.step.toolIds,
        sessionId,
        requestId: `${turnId}-${input.step.id}`.slice(0, 128),
        taskContractHash: input.executionKey,
        promptStackHash: input.manifestDigest,
        resumeFromCheckpoint: false,
        skillPrompt: composeManifestSystemPrompt(manifest, input.step),
        fullAccess: manifest.fullAccess,
        signal,
        liveSteering,
      });
      if (result.status !== 'completed' || !result.finalVerified || !result.finalText.trim()) {
        return {
          ok: false,
          code: resultFailureCode(result.status),
          message: 'The workflow step did not produce a complete validated response',
        };
      }
      const output = {
        stepId: input.step.id,
        text: result.finalText,
        turnsUsed: result.turnsUsed,
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
