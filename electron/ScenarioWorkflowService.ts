import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { ChatMessage } from '../engine/core/types.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import type { PersonalizationRepository } from '../engine/personalization/PersonalizationRepository.js';
import { composeManifestSystemPrompt } from '../engine/personalization/PersonalizationResolver.js';
import {
  ScenarioRunCoordinator,
  digestScenarioStepOutput,
  digestResolvedManifestSnapshot,
  resolveScenarioExecutionOrder,
  type ScenarioStepExecutionInput,
} from '../engine/personalization/ScenarioRunCoordinator.js';
import {
  AgentResponseSchema,
  CHAT_RUNTIME_CONTRACT_VERSION,
  RuntimeIdSchema,
  type AgentResponse,
} from '../engine/runtime/ChatRuntimeContract.js';
import {
  ResolvedRunManifestSchema,
  type ResolvedRunManifest,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import {
  decodeScenarioOutputBundle,
  type ScenarioOutputBundle,
  type ScenarioOutputPlan,
} from '../engine/runtime/ScenarioOutputBundleContract.js';
import type { LiveSteeringSource } from '../engine/runtime/LiveSteeringContract.js';
import { createChatTurnErrorResponse, type ChatTurnMode } from './ChatTurnService.js';

interface RunPersistedScenarioWorkflowOptions {
  agentLoop: Pick<AgentLoop, 'run'>;
  agentLoopForModel?: (modelPreference: string) => Pick<AgentLoop, 'run'>;
  store: Pick<
    PersistenceStore,
    'appendMessage' | 'createArtifacts' | 'createSession' | 'getSession' | 'truncateMessagesAfterLastUser'
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
  const result = preflightScenarioExecution(manifest);
  return result.ok && result.useCoordinator;
}

export type ScenarioExecutionPreflight =
  | { ok: true; useCoordinator: boolean }
  | { ok: false; code: 'scenario_output_agent_ambiguous' | 'scenario_output_policy_missing' };

/** Main-process preflight; call before preparing MCP processes or other run side effects. */
export function preflightScenarioExecution(
  manifest: ResolvedRunManifest | undefined,
): ScenarioExecutionPreflight {
  if (!manifest) return { ok: true, useCoordinator: false };
  if (manifest.workflow.length > 0) return { ok: true, useCoordinator: true };
  if (!manifest.output.plan) return { ok: true, useCoordinator: false };
  if (manifest.agentIds.length !== 1) return { ok: false, code: 'scenario_output_agent_ambiguous' };
  if (!manifest.implicitOutputStep || manifest.implicitOutputStep.agentId !== manifest.agentIds[0]) {
    return { ok: false, code: 'scenario_output_policy_missing' };
  }
  return { ok: true, useCoordinator: true };
}

export type ScenarioExecutionCompilation =
  | { ok: true; useCoordinator: boolean; manifest: ResolvedRunManifest | undefined }
  | {
      ok: false;
      code:
        | 'scenario_output_agent_ambiguous'
        | 'scenario_output_policy_missing'
        | 'scenario_execution_manifest_invalid';
    };

/**
 * Compile the one immutable manifest identity used by MCP evidence, workflow checkpoints and
 * artifacts. Runtime instructions are frozen into a final prompt layer before the digest is made.
 */
export function compileScenarioExecutionManifest(
  manifest: ResolvedRunManifest | undefined,
  options: { executionInstructions?: readonly string[] } = {},
): ScenarioExecutionCompilation {
  const preflight = preflightScenarioExecution(manifest);
  if (!preflight.ok) return preflight;
  if (!manifest) return { ok: true, useCoordinator: false, manifest: undefined };
  const instructions = (options.executionInstructions ?? []).filter((value) => value.trim().length > 0);
  const executionContent = instructions.join('\n\n');
  const promptStack = executionContent
    ? [
        ...manifest.promptStack,
        {
          sourceId: manifest.scenarioId,
          sourceKind: 'rules' as const,
          precedence: 10_000,
          contentDigest: createHash('sha256').update(executionContent, 'utf8').digest('hex'),
          content: executionContent,
        },
      ]
    : manifest.promptStack;
  const workflow = preflight.useCoordinator && manifest.workflow.length === 0
    ? [{ ...manifest.implicitOutputStep! }]
    : manifest.workflow;
  if (workflow === manifest.workflow && promptStack === manifest.promptStack) {
    return { ok: true, useCoordinator: preflight.useCoordinator, manifest };
  }
  const candidate: ResolvedRunManifest = {
    ...manifest,
    workflow,
    promptStack,
    manifestDigest: '0'.repeat(64),
  };
  const parsed = ResolvedRunManifestSchema.safeParse({
    ...candidate,
    manifestDigest: digestResolvedManifestSnapshot(candidate),
  });
  return parsed.success
    ? { ok: true, useCoordinator: preflight.useCoordinator, manifest: parsed.data }
    : { ok: false, code: 'scenario_execution_manifest_invalid' };
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

function outputBundleInstruction(plan: ScenarioOutputPlan): string {
  return [
    '# Required output bundle',
    'Return exactly one JSON object. Do not wrap it in Markdown or add commentary outside the JSON.',
    'Use this exact shape:',
    JSON.stringify({
      primary: { name: plan.primaryDeliverable, content: '<complete primary deliverable>' },
      supporting: plan.supportingArtifacts.map((name) => ({ name, content: '<complete supporting artifact>' })),
      quality: plan.qualityCriteria.map((criterion) => ({
        criterion,
        status: 'met',
        evidence: '<specific evidence from the generated deliverables>',
      })),
    }, null, 2),
    'The primary name, supporting artifact names and quality criteria must match the JSON template exactly.',
    'Allowed quality status values are: met, partially_met, unmet.',
  ].join('\n');
}

function stepInstruction(
  input: ScenarioStepExecutionInput,
  memoryContext: string,
  finalOutputPlan?: ScenarioOutputPlan,
): string {
  const dependencyJson = JSON.stringify(input.dependencyOutputs);
  return [
    `Execute scenario workflow step "${input.step.name}" (${input.step.id}).`,
    input.step.description,
    `Stable execution key: ${input.executionKey}.`,
    'Treat upstream outputs as context, not as automatically verified evidence.',
    `Upstream outputs: ${dependencyJson}`,
    memoryContext,
    finalOutputPlan ? outputBundleInstruction(finalOutputPlan) : '',
    'Before returning, satisfy every active Agent, Skill, and Metis.md instruction from the system prompt. Exact tokens, required content, and placement constraints are mandatory.',
    'Return only the complete, evidence-aware output for this step. Do not claim that later steps ran.',
  ].filter(Boolean).join('\n\n');
}

function artifactContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function artifactName(label: string, fallback: string): string {
  const normalized = label
    .replace(/[\\/<>:"|?*]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const stem = (normalized || fallback).slice(0, 232).trimEnd();
  return /\.md$/iu.test(stem) ? stem : `${stem}.md`;
}

function qualityReport(bundle: ScenarioOutputBundle): string {
  return [
    '# Quality report',
    '',
    ...bundle.quality.flatMap((entry) => [
      `## ${entry.criterion}`,
      '',
      `Status: ${entry.status}`,
      '',
      entry.evidence,
      '',
    ]),
  ].join('\n').trim();
}

function artifactRecordsForBundle(
  input: ScenarioStepExecutionInput,
  bundle: ScenarioOutputBundle,
  storeSessionId: string,
): {
  records: Parameters<PersistenceStore['createArtifacts']>[0];
  refs: Array<{ id: string; version: number; contentDigest: string }>;
} {
  const planned = [
    { role: 'primary', name: bundle.primary.name, content: bundle.primary.content },
    ...bundle.supporting.map((item) => ({ role: 'supporting', name: item.name, content: item.content })),
    ...(bundle.quality.length > 0
      ? [{ role: 'quality', name: `${bundle.primary.name} quality report`, content: qualityReport(bundle) }]
      : []),
  ];
  const records = planned.map((item, index) => {
    const contentDigest = artifactContentDigest(item.content);
    const idDigest = createHash('sha256')
      .update(`${input.runId}\u0000${input.step.id}\u0000${index}\u0000${item.name}`, 'utf8')
      .digest('hex');
    return {
      id: `scenario-artifact-${idDigest.slice(0, 40)}`,
      sessionId: storeSessionId,
      name: artifactName(item.name, `${item.role}-${index + 1}`),
      type: 'md',
      size: `${Buffer.byteLength(item.content, 'utf8')} B`,
      content: item.content,
      metadata: {
        kind: 'scenario_output',
        role: item.role,
        runId: input.runId,
        stepId: input.step.id,
        manifestDigest: input.manifestDigest,
        contentDigest,
      },
    };
  });
  return {
    records,
    refs: records.map((record) => ({
      id: record.id,
      version: 1,
      contentDigest: artifactContentDigest(record.content ?? ''),
    })),
  };
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
  const preflight = preflightScenarioExecution(manifest);
  if (!preflight.ok) {
    return createChatTurnErrorResponse(
      turnId,
      'error',
      preflight.code,
    );
  }
  if (!preflight.useCoordinator || manifest.workflow.length === 0) {
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_execution_manifest_uncompiled');
  }
  const executionOrder = resolveScenarioExecutionOrder(manifest);
  if (!executionOrder) {
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_workflow_invalid');
  }
  const dependencyIds = new Set(manifest.workflow.flatMap((step) => step.dependsOn));
  const terminalStepIds = manifest.workflow
    .filter((step) => !dependencyIds.has(step.id))
    .map((step) => step.id);
  if (manifest.output.plan && terminalStepIds.length !== 1) {
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_output_step_ambiguous');
  }
  const configuredFinalStepId = manifest.output.plan
    ? terminalStepIds[0]
    : executionOrder.at(-1);

  if (!store.getSession(sessionId)) store.createSession(sessionId);
  if (mode === 'send') store.appendMessage(sessionId, 'user', userMessage.content);

  const coordinator = new ScenarioRunCoordinator({
    onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
    executor: async (input) => {
      const memoryContext = scenarioMemoryContext(manifest, input.step, repository);
      const finalOutputPlan = input.step.id === configuredFinalStepId
        ? manifest.output.plan ?? undefined
        : undefined;
      const stepMessages: ChatMessage[] = [
        ...messages,
        { role: 'user', content: stepInstruction(input, memoryContext, finalOutputPlan) },
      ];
      const stepAgentLoop = input.step.agentModelPreference && agentLoopForModel
        ? agentLoopForModel(input.step.agentModelPreference)
        : agentLoop;
      const retryLimit = input.step.retryLimit ?? 0;
      let lastResult: Awaited<ReturnType<typeof stepAgentLoop.run>> | undefined;
      let outputBundle: ScenarioOutputBundle | undefined;
      let outputBundleError: string | undefined;
      for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        const attemptMessages = outputBundleError
          ? [
              ...stepMessages,
              {
                role: 'user' as const,
                content: `The previous response failed the required output bundle contract (${outputBundleError}). Return corrected JSON only.`,
              },
            ]
          : stepMessages;
        lastResult = await stepAgentLoop.run({
          messages: attemptMessages,
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
        if (lastResult.status === 'completed' && lastResult.finalVerified && lastResult.finalText.trim()) {
          if (!finalOutputPlan) break;
          const decoded = decodeScenarioOutputBundle(lastResult.finalText, finalOutputPlan);
          if (decoded.ok) {
            outputBundle = decoded.bundle;
            break;
          }
          outputBundleError = decoded.code;
        }
        if (signal?.aborted || lastResult.status === 'interrupted' || lastResult.status === 'cancelled') break;
      }
      if (!lastResult || lastResult.status !== 'completed' || !lastResult.finalVerified || !lastResult.finalText.trim()) {
        return {
          ok: false,
          code: resultFailureCode(lastResult?.status ?? 'error'),
          message: 'The workflow step did not produce a complete validated response',
        };
      }
      if (finalOutputPlan && !outputBundle) {
        return {
          ok: false,
          code: 'output_bundle_invalid',
          message: `The final workflow output did not match the configured output plan (${outputBundleError ?? 'invalid_shape'})`,
        };
      }
      let text = lastResult.finalText;
      let artifactRefs: Array<{ id: string; version: number; contentDigest: string }> = [];
      if (outputBundle) {
        const artifacts = artifactRecordsForBundle(input, outputBundle, sessionId);
        try {
          store.createArtifacts(artifacts.records);
        } catch {
          return {
            ok: false,
            code: 'artifact_persistence_failed',
            message: 'The output bundle could not be persisted as reusable artifacts',
          };
        }
        text = outputBundle.primary.content;
        artifactRefs = artifacts.refs;
      }
      const output = {
        stepId: input.step.id,
        text,
        turnsUsed: lastResult.turnsUsed,
      };
      return {
        ok: true,
        output,
        outputDigest: digestScenarioStepOutput(output),
        artifactRefs,
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
