import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
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
  emitScenarioHookEvent,
  hooksFromManifest,
  notifyScenarioRunEvent,
  scenarioHookExecutor,
  scenarioRuntimeHookBridge,
  type ScenarioHookEvent,
} from '../engine/personalization/ScenarioHookExecutor.js';
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
  /** Public pause control: persists a durable paused checkpoint that the next turn resumes. */
  pauseSignal?: AbortSignal;
  /** Public cancel control: persists terminal cancelled; late provider results cannot revive the run. */
  cancelSignal?: AbortSignal;
  liveSteering?: LiveSteeringSource;
  projectId?: string;
  isCurrentRuntime?: () => boolean;
  /** 场景 Hook（场景重构 P4）：审批决策通道必须接到真实确认；事件汇用于通知/日志。 */
  hookApproval?: (input: { hookId: string; stepId: string; instruction: string; runId: string }) => Promise<boolean> | boolean;
  hookEvent?: (event: ScenarioHookEvent) => void;
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
    input.step.goal ? `Step goal:\n${input.step.goal}` : input.step.description,
    input.step.prompt ? `Dedicated step prompt:\n${input.step.prompt}` : '',
    input.step.condition ? `Execution condition:\n${input.step.condition}` : '',
    input.step.inputs?.length ? `Declared inputs:\n${JSON.stringify(input.step.inputs, null, 2)}` : '',
    input.step.outputs?.length ? `Required outputs:\n${JSON.stringify(input.step.outputs, null, 2)}` : '',
    input.step.completionCriteria?.length
      ? `Completion criteria (all must be checked before returning):\n- ${input.step.completionCriteria.join('\n- ')}`
      : '',
    input.step.failurePolicy?.instruction ? `Failure recovery instruction:\n${input.step.failurePolicy.instruction}` : '',
    input.step.loop?.enabled
      ? `Step Loop policy: at most ${input.step.loop.maxIterations} iteration(s); stop when ${input.step.loop.stopCondition || 'the completion criteria are met'}.`
      : '',
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

// ── Restricted Harness judges ────────────────────────────────────────────────
// 受限评估 Agent：无工具、单轮、严格 JSON 裁决。任何解析失败都不放行：
// 条件裁决抛错由 coordinator fail-closed 为 condition_evaluation_failed；
// Step/Workflow 停止裁决失败按“未满足”处理，由耗尽策略兜底。

const JUDGE_MARKER = '[ScenarioJudge]';

const ConditionVerdictSchema = z.strictObject({
  run: z.boolean(),
  reason: z.string().min(1).max(4_000),
});
const CompletionVerdictSchema = z.strictObject({
  satisfied: z.boolean(),
  reason: z.string().min(1).max(4_000),
});
const WorkflowLoopVerdictSchema = z.strictObject({
  complete: z.boolean(),
  reason: z.string().min(1).max(4_000),
});

function extractJudgeJson(text: string): unknown | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|```\s*$/giu, '');
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to bounded substring extraction */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

interface JudgeRunOptions {
  sessionId: string;
  requestId: string;
  manifestDigest: string;
  fullAccess: ResolvedRunManifest['fullAccess'];
  prompt: string;
  signal?: AbortSignal;
}

async function runRestrictedJudge(
  agentLoop: Pick<AgentLoop, 'run'>,
  options: JudgeRunOptions,
): Promise<unknown | undefined> {
  const verdictHash = createHash('sha256').update(`judge:${options.requestId}`, 'utf8').digest('hex');
  const result = await agentLoop.run({
    messages: [{ role: 'user', content: options.prompt }],
    maxTurns: 2,
    allowedTools: [],
    sessionId: options.sessionId,
    requestId: options.requestId.slice(0, 128),
    taskContractHash: verdictHash,
    promptStackHash: options.manifestDigest,
    resumeFromCheckpoint: false,
    // 受限来自空工具集与单轮上限；权限策略只有 full_access 一种合法形态。
    fullAccess: options.fullAccess,
    signal: options.signal,
  });
  if (result.status !== 'completed' || !result.finalText.trim()) return undefined;
  return extractJudgeJson(result.finalText);
}

function judgeJsonRules(shape: string): string {
  return [
    JUDGE_MARKER,
    'You are a strict Harness evaluation judge. You have no tools and must not claim side effects.',
    'Return exactly one JSON object and nothing else — no Markdown fences, no commentary.',
    `Use this exact shape: ${shape}`,
    'The reason must be one concise sentence grounded in the provided evidence.',
  ].join('\n');
}

function boundedJson(value: unknown, maxChars: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
  return serialized.length <= maxChars ? serialized : `${serialized.slice(0, maxChars)}…[truncated]`;
}

function conditionJudgePrompt(input: {
  stepName: string;
  condition: string;
  dependencyOutputs: Readonly<Record<string, unknown>>;
}): string {
  return [
    judgeJsonRules('{"run": true, "reason": "<one sentence>"}'),
    '',
    'Decide whether the workflow step below must run in this pass.',
    `Step: ${input.stepName}`,
    `Authored execution condition:\n${input.condition}`,
    `Upstream outputs (context, not verified evidence): ${boundedJson(input.dependencyOutputs, 4_000)}`,
    'Set "run" to false only when the condition is clearly not met.',
  ].join('\n');
}

function completionJudgePrompt(input: {
  stepName: string;
  stopCondition: string;
  completionCriteria: readonly string[];
  outputText: string;
  stepIteration: number;
}): string {
  return [
    judgeJsonRules('{"satisfied": true, "reason": "<one sentence>"}'),
    '',
    `Judge whether iteration ${input.stepIteration} of workflow step "${input.stepName}" satisfies its stop condition.`,
    `Stop condition:\n${input.stopCondition || '(none authored — judge against the completion criteria)'}`,
    input.completionCriteria.length > 0
      ? `Completion criteria:\n- ${input.completionCriteria.join('\n- ')}`
      : '',
    `Step output under judgement:\n${input.outputText.slice(0, 6_000)}`,
    'Set "satisfied" to true only when the stop condition is genuinely met by this output.',
  ].filter(Boolean).join('\n');
}

function workflowLoopJudgePrompt(input: {
  stopCondition: string;
  workflowIteration: number;
  steps: ReadonlyArray<{ stepId: string; status: string; output: unknown }>;
}): string {
  const summary = input.steps.map((step) => ({
    stepId: step.stepId,
    status: step.status,
    output: boundedJson(step.output, 1_500),
  }));
  return [
    judgeJsonRules('{"complete": true, "reason": "<one sentence>"}'),
    '',
    `Judge whether workflow iteration ${input.workflowIteration} as a whole satisfies its stop condition.`,
    `Workflow stop condition:\n${input.stopCondition}`,
    `Step results this iteration:\n${boundedJson(summary, 8_000)}`,
    'Set "complete" to true only when the stop condition is genuinely met; another full iteration is expensive.',
  ].join('\n');
}

function toolCallSummaries(
  result: { toolResults?: ReadonlyArray<{ toolName: string; status: 'ok' | 'error'; error?: string; metadata?: Record<string, unknown> }> },
): Array<{ toolName: string; status: 'ok' | 'error'; code: string | null }> {
  return (result.toolResults ?? []).slice(0, 1_000).map((tool) => ({
    toolName: tool.toolName.slice(0, 256),
    status: tool.status,
    code: tool.status === 'error'
      ? (typeof tool.metadata?.['code'] === 'string' ? tool.metadata['code'].slice(0, 128) : 'tool_error')
      : null,
  }));
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
  pauseSignal,
  cancelSignal,
  liveSteering,
  projectId,
  isCurrentRuntime,
  hookApproval,
  hookEvent,
}: RunPersistedScenarioWorkflowOptions): Promise<AgentResponse> {
  const turnId = safeTurnId(requestId);
  const userMessage = latestUserMessage(messages);
  console.log(`[ScenarioRun] start: session=${sessionId.slice(0, 40)} manifestSession=${manifest.sessionId.slice(0, 40)} workflow=${manifest.workflow.length} hooks=${manifest.hooks?.length ?? 0}`);
  if (!sessionId.trim()) return createChatTurnErrorResponse(turnId, 'error', 'invalid_session');
  if (!userMessage) return createChatTurnErrorResponse(turnId, 'error', 'missing_user_message');
  if (manifest.sessionId !== sessionId.replace(/:/gu, '-')) {
    console.warn('[ScenarioRun] rejected: scenario_session_mismatch');
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_session_mismatch');
  }
  const preflight = preflightScenarioExecution(manifest);
  if (!preflight.ok) {
    console.warn('[ScenarioRun] rejected:', preflight.code);
    return createChatTurnErrorResponse(
      turnId,
      'error',
      preflight.code,
    );
  }
  if (!preflight.useCoordinator || manifest.workflow.length === 0) {
    console.warn('[ScenarioRun] rejected: scenario_execution_manifest_uncompiled');
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_execution_manifest_uncompiled');
  }
  const executionOrder = resolveScenarioExecutionOrder(manifest);
  if (!executionOrder) {
    console.warn('[ScenarioRun] rejected: scenario_workflow_invalid (dag); workflow=', JSON.stringify(manifest.workflow).slice(0, 500), '; output.plan=', JSON.stringify(manifest.output?.plan ?? null).slice(0, 120));
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

  const runId = `scenario-${turnId}`;
  const scenarioHooks = hooksFromManifest(manifest);
  notifyScenarioRunEvent(scenarioHooks, 'run_start', { runId, onHookEvent: hookEvent });
  const runtimeHookBridge = scenarioRuntimeHookBridge({
    hooks: scenarioHooks,
    runId,
    // 无审批通道时 fail closed：approval 钩子拒绝/异常 → pause 指令。
    onApprovalRequired: hookApproval ?? (() => false),
    onHookEvent: hookEvent,
  });
  const coordinator = new ScenarioRunCoordinator({
    onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
    onCheckpointSaved: () => {
      emitScenarioHookEvent(scenarioHooks, 'checkpoint_saved', { runId, onHookEvent: hookEvent });
    },
    onRuntimeEvent: (event) => runtimeHookBridge(event),
    evaluateStepCondition: manifest.workflow.some((step) => step.condition)
      ? async ({ step, dependencyOutputs }) => {
          const verdict = ConditionVerdictSchema.safeParse(await runRestrictedJudge(agentLoop, {
            sessionId,
            requestId: `${turnId}-${step.id}-condition`,
            manifestDigest: manifest.manifestDigest,
            fullAccess: manifest.fullAccess,
            prompt: conditionJudgePrompt({
              stepName: step.name,
              condition: step.condition ?? '',
              dependencyOutputs,
            }),
            signal,
          }));
          if (!verdict.success) throw new Error('Condition judge returned an invalid verdict');
          return verdict.data;
        }
      : undefined,
    evaluateWorkflowLoop: manifest.workflowLoop?.enabled
      ? async ({ record, stopCondition }) => {
          const verdict = WorkflowLoopVerdictSchema.safeParse(await runRestrictedJudge(agentLoop, {
            sessionId,
            requestId: `${turnId}-workflow-loop-${record.workflowIteration}`,
            manifestDigest: manifest.manifestDigest,
            fullAccess: manifest.fullAccess,
            prompt: workflowLoopJudgePrompt({
              stopCondition,
              workflowIteration: record.workflowIteration,
              steps: record.steps.map((step) => ({
                stepId: step.stepId,
                status: step.status,
                output: step.output,
              })),
            }),
            signal,
          }));
          return verdict.success
            ? verdict.data
            : { complete: false, reason: 'Workflow stop-condition judge returned an invalid verdict' };
        }
      : undefined,
    executor: scenarioHookExecutor(async (input) => {
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
          projectId,
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
      let completionAssessment: { satisfied: boolean; reason: string } | undefined;
      // Every authored completion standard is a real state-machine gate.  A
      // hidden system loop is synthesized by ScenarioRunCoordinator whenever
      // a step has criteria but no explicit legacy loop policy.
      if ((input.step.completionCriteria?.length ?? 0) > 0 || input.step.loop?.enabled) {
        if (input.step.loop?.enabled && input.step.loop.evaluator === 'manual') {
          // 人工评估复用审批通道；无通道或通道异常都 fail closed 为“未满足”，由耗尽策略接管。
          let approved = false;
          let channelFailed = false;
          if (hookApproval) {
            try {
              approved = await hookApproval({
                hookId: `manual-loop-${input.step.id}`,
                stepId: input.step.id,
                instruction: `Step "${input.step.name}" iteration ${input.stepIteration ?? 1} awaits manual review. Stop condition: ${input.step.loop.stopCondition || '(none)'}. Approve to stop the loop.`,
                runId,
              }) === true;
            } catch {
              channelFailed = true;
            }
          }
          completionAssessment = {
            satisfied: approved,
            reason: !hookApproval
              ? 'Manual evaluation requires a user approval channel'
              : channelFailed
                ? 'Manual review channel failed closed'
                : approved
                  ? 'Approved by manual review'
                  : 'Manual review requested another iteration',
          };
        } else {
          const verdict = CompletionVerdictSchema.safeParse(await runRestrictedJudge(agentLoop, {
            sessionId,
            requestId: `${turnId}-${input.step.id}-loop-${input.stepIteration ?? 1}`,
            manifestDigest: input.manifestDigest,
            fullAccess: manifest.fullAccess,
            prompt: completionJudgePrompt({
              stepName: input.step.name,
              stopCondition: input.step.loop?.stopCondition
                ?? input.step.completionCriteria?.join('\n')
                ?? '',
              completionCriteria: input.step.completionCriteria ?? [],
              outputText: text,
              stepIteration: input.stepIteration ?? 1,
            }),
            signal,
          }));
          completionAssessment = verdict.success
            ? verdict.data
            : { satisfied: false, reason: 'Completion judge returned an invalid verdict' };
        }
      }
      const includeToolSummary = manifest.checkpointPolicy?.includeToolCallSummary !== false;
      const toolCallSummary = includeToolSummary ? toolCallSummaries(lastResult) : undefined;
      return {
        ok: true,
        output,
        outputDigest: digestScenarioStepOutput(output),
        artifactRefs,
        completionAssessment,
        toolCallSummary,
      };
    }, {
      hooks: scenarioHooks,
      runId,
      // 无审批通道时 fail closed：带 approval 钩子的步骤不能静默放行。
      onApprovalRequired: hookApproval ?? (() => false),
      onHookEvent: hookEvent,
    }),
  });

  const recoverable = repository.getRecoverableScenarioRun(manifest.sessionId);
  const runResult = recoverable?.manifestDigest === manifest.manifestDigest
    ? await coordinator.resume(recoverable, { signal, pauseSignal, cancelSignal })
    : await coordinator.start({ runId, manifest, signal, pauseSignal, cancelSignal });
  notifyScenarioRunEvent(scenarioHooks, 'run_end', { runId, onHookEvent: hookEvent });

  if (!runResult.ok) {
    return createChatTurnErrorResponse(turnId, 'error', `scenario_${runResult.code}`);
  }
  // Public control outcomes are first-class responses: paused keeps the
  // checkpoint resumable, cancelled is terminal and persists as such.
  if (runResult.record.status === 'cancelled') {
    return createChatTurnErrorResponse(turnId, 'cancelled', 'scenario_run_cancelled');
  }
  if (runResult.record.status === 'paused') {
    return createChatTurnErrorResponse(turnId, 'interrupted', 'scenario_run_paused');
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
