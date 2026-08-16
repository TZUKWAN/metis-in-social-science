/**
 * Workflow engine — serial DAG executor for single-agent workflows.
 *
 * Ported from metis/swarm/ concepts (DAG + topological sort + serial execution).
 *
 * Flow:
 *   1. Topological sort steps
 *   2. For each step in order:
 *      a. Check upstream dependencies completed
 *      b. Collect upstream outputs
 *      c. HITL approval (if required)
 *      d. Execute agent loop with step's prompt
 *      e. Store result
 *   3. Return WorkflowRun with all results
 */

import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import type { AgentLoop } from '../core/AgentLoop.js';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowRun,
  StepResult,
  WorkflowHooks,
  WorkflowRunOptions,
} from './types.js';
import { topologicalSort } from './types.js';
import { evaluateAcceptanceCriteria, hasAcceptanceCriteria } from './AcceptanceCriteria.js';

/**
 * O7: consecutive-failure threshold at which a step escalates to a human
 * decision (retry / skip / stop) instead of silently looping. Matches
 * mission-control's "after 3 attempts, escalates to a user decision" policy.
 */
export const STEP_FAILURE_ESCALATION_THRESHOLD = 3;

export class WorkflowEngine {
  private readonly agent: AgentLoop;

  constructor(agent: AgentLoop) {
    this.agent = agent;
  }

  /**
   * Execute a workflow definition serially.
   *
   * @param liveSteering Optional steering source forwarded to every step's
   *   AgentLoop.run, so human pause/interrupt can take effect mid-step (not
   *   only at phase boundaries). Used by the autonomous research engine.
   * @param options O13/O14 执行选项：provider 绑定、项目作用域、checkpoint 恢复。
   *   提供 options.checkpointRun 时，其中已 completed 的步骤结果被搬入新 run
   *   并跳过执行，实现「从上次失败点续跑」而非从 0 重来。
   */
  async run(
    definition: WorkflowDefinition,
    input: Record<string, unknown> = {},
    hooks?: WorkflowHooks,
    liveSteering?: import('../runtime/LiveSteeringContract.js').LiveSteeringSource,
    options?: WorkflowRunOptions,
  ): Promise<WorkflowRun> {
    const order = topologicalSort(definition);
    const stepMap = new Map(definition.steps.map((s) => [s.id, s]));

    const run: WorkflowRun = {
      id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      workflowId: definition.id,
      status: 'running',
      currentStepId: null,
      stepResults: {},
      startedAt: Date.now(),
      completedAt: null,
      input,
      errors: [],
      ...(options?.providerBinding ? { providerBinding: options.providerBinding } : {}),
    };

    // Initialize all step results as pending
    for (const step of definition.steps) {
      run.stepResults[step.id] = {
        stepId: step.id,
        status: 'pending',
        output: '',
        agentResult: null,
        startedAt: 0,
        completedAt: null,
        retryCount: 0,
      };
    }

    // O14: 从 checkpoint 搬入已完成步骤的结果（含输出与 agent 结果），
    // 使下游步骤可以继续引用 {{stepId.output}} 而不必重新执行上游。
    let completedCount = 0;
    if (options?.checkpointRun) {
      for (const stepId of order) {
        const checkpointResult = options.checkpointRun.stepResults[stepId];
        if (checkpointResult?.status === 'completed') {
          run.stepResults[stepId] = { ...checkpointResult, status: 'completed' };
          completedCount++;
        }
      }
    }
    const totalCount = definition.steps.length;

    for (const stepId of order) {
      const step = stepMap.get(stepId);
      if (!step) continue;

      // Get or create step result (guaranteed to exist from initialization)
      const stepResult = this.getOrCreateStepResult(run, stepId);

      // O14: checkpoint 中已完成的步骤直接跳过，不再执行、不重复触发 hook。
      if (stepResult.status === 'completed' && options?.checkpointRun) {
        continue;
      }

      // Check if all dependencies completed
      const deps = definition.dependencies[stepId];
      // Skipped steps (user chose "skip" on an escalated step) count as
      // satisfied so downstream steps can still run.
      const allDepsComplete = deps?.every((dep: string) =>
        ['completed', 'skipped'].includes(run.stepResults[dep]?.status ?? '')) ?? true;

      if (!allDepsComplete) {
        stepResult.status = 'skipped';
        continue;
      }

      // Collect upstream outputs
      const upstreamOutputs = collectUpstreamOutputs(step, run.stepResults);

      // HITL approval
      if (step.hitl?.requireApproval && hooks?.onApprovalRequired) {
        const approved = await hooks.onApprovalRequired(step, run);
        if (!approved) {
          run.status = 'paused';
          run.currentStepId = stepId;
          return run;
        }
      }

      // Execute step
      run.currentStepId = stepId;
      stepResult.status = 'running';
      stepResult.startedAt = Date.now();

      if (hooks?.onStepStart) {
        await hooks.onStepStart(step, run);
      }

      if (hooks?.onProgress) {
        hooks.onProgress(completedCount, totalCount, step);
      }

      const result = await this.executeStep(step, upstreamOutputs, input, liveSteering, options);

      stepResult.agentResult = result.agentResult;
      stepResult.retryCount = result.retryCount;

      if (result.status === 'completed') {
        stepResult.status = 'completed';
        stepResult.output = result.output;
        stepResult.completedAt = Date.now();
        completedCount++;

        if (hooks?.onStepComplete) {
          await hooks.onStepComplete(step, stepResult, run);
        }

        if (hooks?.onProgress) {
          hooks.onProgress(completedCount, totalCount, step);
        }
      } else {
        stepResult.status = 'failed';
        stepResult.completedAt = Date.now();
        // O7: escalate to a human decision after repeated consecutive failures.
        // Mirrors mission-control's loop detection: pause the run and require
        // retry / skip / stop instead of silently continuing or failing.
        const priorReasons = stepResult.failureReasons ?? [];
        const attemptReason = result.failureReasons ?? [`Step '${step.name}' (${stepId}) failed`];
        stepResult.failureReasons = [...priorReasons, ...attemptReason];
        if (result.retryCount + 1 >= STEP_FAILURE_ESCALATION_THRESHOLD) {
          stepResult.decisionRequired = true;
          run.status = 'paused';
          run.currentStepId = stepId;
          run.errors.push(`Step '${step.name}' (${stepId}) failed ${result.retryCount + 1} times — awaiting human decision (retry/skip/stop)`);
          if (hooks?.onStepFailed) {
            await hooks.onStepFailed(step, stepResult, run);
          }
          return run;
        }
        run.errors.push(`Step '${step.name}' (${stepId}) failed`);

        if (hooks?.onStepFailed) {
          await hooks.onStepFailed(step, stepResult, run);
        }

        // Continue to next step (don't abort entire workflow)
      }
    }

    run.status = run.errors.length === 0 ? 'completed' : 'failed';
    run.completedAt = Date.now();
    run.currentStepId = null;

    return run;
  }

  /**
   * Resume a paused workflow from a specific step.
   *
   * O14: 从 fromStepId 起遍历拓扑序；凡是在 pausedRun 中已经 completed 的
   * 步骤直接跳过（保留其输出供下游引用），只重新执行未完成/失败的步骤，
   * 即「恢复到最近成功 checkpoint 后继续」。
   */
  async resume(
    definition: WorkflowDefinition,
    pausedRun: WorkflowRun,
    fromStepId: string,
    hooks?: WorkflowHooks,
    liveSteering?: import('../runtime/LiveSteeringContract.js').LiveSteeringSource,
    options?: WorkflowRunOptions,
  ): Promise<WorkflowRun> {
    const order = topologicalSort(definition);
    const fromIndex = order.indexOf(fromStepId);
    if (fromIndex === -1) {
      throw new Error(`Step '${fromStepId}' not found in workflow`);
    }

    const stepMap = new Map(definition.steps.map((s) => [s.id, s]));
    const run: WorkflowRun = {
      ...pausedRun,
      status: 'running',
      // O14: errors 反映「本次尝试」的失败。resume 是一次全新尝试——若沿用旧
      // run 的 errors，恢复成功也会被误判为 failed（结尾按 errors 计算状态）。
      errors: [],
      // O13: 显式传入的新绑定优先；否则沿用 checkpoint 中记录的绑定。
      ...(options?.providerBinding
        ? { providerBinding: options.providerBinding }
        : pausedRun.providerBinding
          ? { providerBinding: pausedRun.providerBinding }
          : {}),
    };
    // O14: resume 本身就是一种 checkpoint 恢复——除非调用方显式关闭，
    // 步骤请求默认携带 resumeFromCheckpoint: true。
    const effectiveOptions: WorkflowRunOptions = {
      resumeFromCheckpoint: true,
      ...options,
      checkpointRun: options?.checkpointRun ?? pausedRun,
    };

    for (let i = fromIndex; i < order.length; i++) {
      const stepId = order[i];
      if (!stepId) continue;
      const step = stepMap.get(stepId);
      if (!step) continue;

      const deps = definition.dependencies[stepId];
      // Skipped steps (user chose "skip" on an escalated step) count as
      // satisfied so downstream steps can still run.
      const allDepsComplete = deps?.every((dep: string) =>
        ['completed', 'skipped'].includes(run.stepResults[dep]?.status ?? '')) ?? true;

      const existingResult = this.getOrCreateStepResult(run, stepId);

      // O14: 已完成的步骤不重跑（checkpoint 语义），保留输出供下游引用。
      if (existingResult.status === 'completed') {
        continue;
      }

      if (!allDepsComplete) {
        run.stepResults[stepId] = { ...existingResult, status: 'skipped' };
        continue;
      }

      run.currentStepId = stepId;
      run.stepResults[stepId] = { ...existingResult, status: 'running', startedAt: Date.now() };

      if (hooks?.onStepStart) await hooks.onStepStart(step, run);

      const upstreamOutputs = collectUpstreamOutputs(step, run.stepResults);
      const result = await this.executeStep(step, upstreamOutputs, run.input, liveSteering, effectiveOptions);

      run.stepResults[stepId] = {
        ...run.stepResults[stepId]!,
        agentResult: result.agentResult,
        retryCount: result.retryCount,
        status: result.status === 'completed' ? 'completed' : 'failed',
        output: result.output,
        completedAt: Date.now(),
      };

      const updatedResult = run.stepResults[stepId]!;

      if (result.status === 'completed') {
        if (hooks?.onStepComplete) await hooks.onStepComplete(step, updatedResult, run);
      } else {
        // O7: accumulate failure reasons and escalate to a human decision
        // (retry / skip / stop) after the configured threshold, mirroring
        // mission-control's loop-detection policy. Until resolved the run
        // pauses rather than burning more attempts or silently failing.
        const priorReasons = run.stepResults[stepId]?.failureReasons ?? [];
        const attemptReason = result.failureReasons ?? [`步骤「${step.name}」执行失败（尝试 ${updatedResult.retryCount + 1}）`];
        updatedResult.failureReasons = [...priorReasons, ...attemptReason];
        run.stepResults[stepId] = updatedResult;

        if (updatedResult.retryCount + 1 >= STEP_FAILURE_ESCALATION_THRESHOLD) {
          updatedResult.decisionRequired = true;
          run.status = 'paused';
          run.errors.push(`步骤「${step.name}」连续失败 ${updatedResult.retryCount + 1} 次，等待人工决策（重试/跳过/停止）`);
          run.currentStepId = stepId;
          if (hooks?.onStepFailed) await hooks.onStepFailed(step, updatedResult, run);
          return run;
        }
        run.errors.push(`Step '${step.name}' (${stepId}) failed`);
        if (hooks?.onStepFailed) await hooks.onStepFailed(step, updatedResult, run);
      }
    }

    run.status = run.errors.length === 0 ? 'completed' : 'failed';
    run.completedAt = Date.now();
    run.currentStepId = null;
    return run;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private getOrCreateStepResult(run: WorkflowRun, stepId: string): StepResult {
    const existing = run.stepResults[stepId];
    if (existing) return existing;
    const fresh: StepResult = {
      stepId,
      status: 'pending',
      output: '',
      agentResult: null,
      startedAt: 0,
      completedAt: null,
      retryCount: 0,
    };
    run.stepResults[stepId] = fresh;
    return fresh;
  }

  // ─── Step Execution ─────────────────────────────────────────

  private async executeStep(
    step: WorkflowStep,
    upstreamOutputs: Record<string, string>,
    globalInput: Record<string, unknown>,
    liveSteering?: import('../runtime/LiveSteeringContract.js').LiveSteeringSource,
    options?: WorkflowRunOptions,
  ): Promise<{ status: 'completed' | 'failed'; output: string; agentResult: AgentRunResult; retryCount: number; failureReasons?: string[] }> {
    const maxRetries = step.retry?.maxRetries ?? 0;
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      const prompt = buildStepPrompt(step, upstreamOutputs, globalInput, retryCount > 0 ? step.retry?.onFailPrompt : undefined);

      const request: AgentRunRequest = {
        sessionId: `wf-step-${step.id}`,
        messages: [
          // O13: 项目级系统提示（覆盖全局）注入到步骤消息最前。
          ...(options?.providerBinding?.systemPrompt
            ? [{ role: 'system' as const, content: options.providerBinding.systemPrompt }]
            : []),
          { role: 'user', content: prompt },
        ],
        allowedTools: step.tools.length > 0 ? step.tools : undefined,
        // Floor of 6 turns: tool-using steps need turn headroom (reason → call
        // → observe → answer). The previous planner default of 3 truncated
        // final steps mid-tool-call with max_turns_reached.
        maxTurns: Math.min(Math.max(step.maxTurns ?? 6, 6), 20),
        taskContractHash: '',
        promptStackHash: '',
        // O14: 不再硬编码 false——由执行选项决定（checkpoint 恢复时为 true）。
        resumeFromCheckpoint: options?.resumeFromCheckpoint ?? false,
        requestId: `wf-${step.id}-${Date.now()}`,
        ...(options?.projectId ? { projectId: options.projectId } : {}),
        ...(options?.providerBinding ? { providerProfileBinding: options.providerBinding } : {}),
        ...(liveSteering ? { liveSteering } : {}),
      };

      const agentResult = await this.agent.run(request);

      // A step only counts as completed when the run finished cleanly AND the
      // output is a real accomplishment: verified run (no internal errors),
      // non-empty text, and not an agent-declared inability ("我无法…",
      // "please paste the text for me", …). Refusals that sneak through as
      // final answers previously marked steps completed with finalVerified
      // true — undermining the runtime's research-integrity guarantee.
      const output = agentResult.finalText ?? '';
      const accomplished = agentResult.status === 'completed'
        && agentResult.finalVerified === true
        && output.trim().length > 0
        && !isNonAccomplishmentOutput(output);

      // O6: objective acceptance criteria. Even when the agent claims
      // completion, deterministic checks (min length, must-contain, must-not-
      // contain, regex) must also pass; otherwise treat as a failure and retry.
      if (accomplished && hasAcceptanceCriteria(step.acceptanceCriteria)) {
        const check = evaluateAcceptanceCriteria(output, step.acceptanceCriteria);
        if (!check.passed) {
          // Append the failure reasons to the retry prompt so the next attempt
          // knows what was missing, then loop.
          if (retryCount < maxRetries) {
            retryCount++;
            continue;
          }
          return {
            status: 'failed',
            output,
            agentResult,
            retryCount,
            failureReasons: check.failures,
          };
        }
      }

      if (accomplished) {
        return {
          status: 'completed',
          output,
          agentResult,
          retryCount,
        };
      }

      retryCount++;
      if (retryCount > maxRetries) {
        const reason = isNonAccomplishmentOutput(output)
          ? ['输出为拒答或非实绩内容']
          : (agentResult.status !== 'completed'
            ? [`执行未正常结束（status=${agentResult.status}）`]
            : ['输出为空或未通过完成校验']);
        return {
          status: 'failed',
          output: agentResult.finalText ?? '',
          agentResult,
          retryCount: retryCount - 1,
          failureReasons: reason,
        };
      }
    }

    // Should not reach here, but just in case
    throw new Error(`Unexpected state in step execution: ${step.id}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * O14: 从 checkpoint（上次持久化的 WorkflowRun）推导恢复点——拓扑序中第一个
 * 未完成的步骤。全部完成时返回 null（无需恢复）。GoalEngine.resumeGoal 用它
 * 实现「从上次断点继续」而不是从 0 重来。
 */
export function findCheckpointResumeStep(
  definition: WorkflowDefinition,
  checkpointRun: WorkflowRun,
): string | null {
  const order = topologicalSort(definition);
  for (const stepId of order) {
    if (checkpointRun.stepResults[stepId]?.status !== 'completed') {
      return stepId;
    }
  }
  return null;
}

/** O14: 判断一个 run 是否留有可恢复的 checkpoint（至少一步已完成且有未完成步骤）。 */
export function hasResumableCheckpoint(
  definition: WorkflowDefinition,
  run: WorkflowRun | null | undefined,
): boolean {
  if (!run) return false;
  const results = Object.values(run.stepResults);
  const hasCompleted = results.some((r) => r.status === 'completed');
  return hasCompleted && findCheckpointResumeStep(definition, run) !== null;
}

/**
 * Detect agent outputs that declare inability instead of accomplishing the
 * step task. Only fires when the refusal dominates the answer: the pattern
 * must appear near the start and the whole output must stay short — a long
 * answer that mentions a limitation in passing (or quotes one) still counts
 * as an accomplishment.
 */
export function isNonAccomplishmentOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) return false;
  const head = trimmed.slice(0, 300);
  const refusalPatterns: RegExp[] = [
    /我(目前)?无法(直接|实际)?(访问|调用|创建|完成|读取|执行|检索|搜索)/u,
    /(当前)?环境中没有(提供)?[^。.\n]{0,30}工具/u,
    /没有(提供|可用)[^。.\n]{0,30}工具/u,
    /请(你|您)(将|把)[^。.\n]{0,40}(粘贴|提供|发)给?我/u,
    /我(无法|不能)(为你|帮您|帮助你)/u,
    /I('m| am) unable to (access|call|create|read|complete)/i,
    /I can(not|'t) (directly )?(access|call|create|read)/i,
    /I do(n't| not) have access to/i,
  ];
  return refusalPatterns.some((pattern) => pattern.test(head));
}

function collectUpstreamOutputs(
  step: WorkflowStep,
  stepResults: Record<string, StepResult>,
): Record<string, string> {
  const outputs: Record<string, string> = {};

  for (const inputId of step.inputFrom) {
    const result = stepResults[inputId];
    if (result?.status === 'completed') {
      outputs[inputId] = result.output;
    }
  }

  return outputs;
}

function buildStepPrompt(
  step: WorkflowStep,
  upstreamOutputs: Record<string, string>,
  globalInput: Record<string, unknown>,
  retryPrompt?: string,
): string {
  let prompt = step.prompt;

  // Replace {{stepId.output}} placeholders
  for (const [stepId, output] of Object.entries(upstreamOutputs)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${stepId}\\.output\\}\\}`, 'g'), output);
  }

  // Replace {{input.key}} placeholders
  for (const [key, value] of Object.entries(globalInput)) {
    prompt = prompt.replace(new RegExp(`\\{\\{input\\.${key}\\}\\}`, 'g'), String(value));
  }

  // Append retry prompt if needed
  if (retryPrompt) {
    prompt += `\n\n---\nPrevious attempt failed. ${retryPrompt}`;
  }

  return prompt;
}
