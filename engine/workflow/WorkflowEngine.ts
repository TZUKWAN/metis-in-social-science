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
} from './types.js';
import { topologicalSort } from './types.js';

export class WorkflowEngine {
  private readonly agent: AgentLoop;

  constructor(agent: AgentLoop) {
    this.agent = agent;
  }

  /**
   * Execute a workflow definition serially.
   */
  async run(
    definition: WorkflowDefinition,
    input: Record<string, unknown> = {},
    hooks?: WorkflowHooks,
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

    let completedCount = 0;
    const totalCount = definition.steps.length;

    for (const stepId of order) {
      const step = stepMap.get(stepId);
      if (!step) continue;

      // Get or create step result (guaranteed to exist from initialization)
      const stepResult = this.getOrCreateStepResult(run, stepId);

      // Check if all dependencies completed
      const deps = definition.dependencies[stepId];
      const allDepsComplete = deps?.every((dep: string) => run.stepResults[dep]?.status === 'completed') ?? true;

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

      const result = await this.executeStep(step, upstreamOutputs, input);

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
   */
  async resume(
    definition: WorkflowDefinition,
    pausedRun: WorkflowRun,
    fromStepId: string,
    hooks?: WorkflowHooks,
  ): Promise<WorkflowRun> {
    const order = topologicalSort(definition);
    const fromIndex = order.indexOf(fromStepId);
    if (fromIndex === -1) {
      throw new Error(`Step '${fromStepId}' not found in workflow`);
    }

    const stepMap = new Map(definition.steps.map((s) => [s.id, s]));
    const run: WorkflowRun = { ...pausedRun, status: 'running', errors: [...pausedRun.errors] };

    for (let i = fromIndex; i < order.length; i++) {
      const stepId = order[i];
      if (!stepId) continue;
      const step = stepMap.get(stepId);
      if (!step) continue;

      const deps = definition.dependencies[stepId];
      const allDepsComplete = deps?.every((dep: string) => run.stepResults[dep]?.status === 'completed') ?? true;

      const existingResult = this.getOrCreateStepResult(run, stepId);

      if (!allDepsComplete) {
        run.stepResults[stepId] = { ...existingResult, status: 'skipped' };
        continue;
      }

      run.currentStepId = stepId;
      run.stepResults[stepId] = { ...existingResult, status: 'running', startedAt: Date.now() };

      if (hooks?.onStepStart) await hooks.onStepStart(step, run);

      const upstreamOutputs = collectUpstreamOutputs(step, run.stepResults);
      const result = await this.executeStep(step, upstreamOutputs, run.input);

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
  ): Promise<{ status: 'completed' | 'failed'; output: string; agentResult: AgentRunResult; retryCount: number }> {
    const maxRetries = step.retry?.maxRetries ?? 0;
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      const prompt = buildStepPrompt(step, upstreamOutputs, globalInput, retryCount > 0 ? step.retry?.onFailPrompt : undefined);

      const request: AgentRunRequest = {
        sessionId: `wf-step-${step.id}`,
        messages: [{ role: 'user', content: prompt }],
        allowedTools: step.tools.length > 0 ? step.tools : undefined,
        maxTurns: step.maxTurns,
        taskContractHash: '',
        promptStackHash: '',
        resumeFromCheckpoint: false,
        requestId: `wf-${step.id}-${Date.now()}`,
      };

      const agentResult = await this.agent.run(request);

      if (agentResult.status === 'completed' && agentResult.finalText) {
        return {
          status: 'completed',
          output: agentResult.finalText,
          agentResult,
          retryCount,
        };
      }

      retryCount++;
      if (retryCount > maxRetries) {
        return {
          status: 'failed',
          output: agentResult.finalText ?? '',
          agentResult,
          retryCount: retryCount - 1,
        };
      }
    }

    // Should not reach here, but just in case
    throw new Error(`Unexpected state in step execution: ${step.id}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────

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
