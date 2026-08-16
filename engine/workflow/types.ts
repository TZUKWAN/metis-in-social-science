/**
 * Workflow types — DAG definitions, step specifications, run state.
 *
 * Design: One Agent executes steps serially in topological order.
 * Each step has structured input/output, independent budget, and optional HITL/Evals gates.
 */

import type { AgentRunResult } from '../core/types.js';
import type { ProviderProfileBinding } from '../runtime/ProviderProfileContract.js';
import type { AcceptanceCriterion } from './AcceptanceCriteria.js';

// ─── Workflow Definition ──────────────────────────────────────

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  steps: WorkflowStep[];
  /** DAG: stepId → list of stepIds it depends on. */
  dependencies: Record<string, string[]>;
}

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  /** Prompt template sent to the LLM. Use {{stepId.output}} to reference upstream outputs. */
  prompt: string;
  /** Step IDs whose outputs are used as input. */
  inputFrom: string[];
  /** Tool names allowed for this step. */
  tools: string[];
  /** Maximum turns for this step's agent run. */
  maxTurns: number;
  /** HITL configuration. */
  hitl?: StepHITLConfig;
  /** Retry configuration. */
  retry?: StepRetryConfig;
  /** Eval gate names to check after step completion. */
  evalGates?: string[];
  /**
   * Objective acceptance criteria (O6). When present, the step only counts as
   * completed when every criterion passes against the final output text, in
   * addition to the agent's finalVerified + non-refusal heuristic.
   */
  acceptanceCriteria?: AcceptanceCriterion[];
}

export interface StepHITLConfig {
  /** Require user approval before executing this step. */
  requireApproval: boolean;
  /** Allow user to edit the step's output before continuing. */
  allowEdit: boolean;
}

export interface StepRetryConfig {
  maxRetries: number;
  /** Prompt to append on retry. */
  onFailPrompt: string;
}

// ─── Workflow Run State ───────────────────────────────────────

export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  currentStepId: string | null;
  stepResults: Record<string, StepResult>;
  startedAt: number;
  completedAt: number | null;
  input: Record<string, unknown>;
  errors: string[];
  /** O13: 本次运行绑定的 provider profile（全局默认或项目覆盖）。 */
  providerBinding?: ProviderProfileBinding;
}

/**
 * O13/O14: WorkflowEngine.run / resume 的执行选项。
 */
export interface WorkflowRunOptions {
  /**
   * O14: 是否从 checkpoint 恢复执行。为 true 时每个步骤的 AgentRunRequest
   * 携带 resumeFromCheckpoint: true；配合 checkpointRun 跳过已完成步骤。
   */
  resumeFromCheckpoint?: boolean;
  /**
   * O14: 上次运行留下的 checkpoint（持久化的 WorkflowRun）。提供时，其中
   * 状态为 completed 的步骤结果被搬入新 run 并跳过执行，从失败点续跑。
   */
  checkpointRun?: WorkflowRun;
  /** O13: 本次运行生效的 provider profile 绑定，注入到每个步骤请求。 */
  providerBinding?: ProviderProfileBinding;
  /** O13/METIS-F12: 项目作用域，注入到每个步骤请求。 */
  projectId?: string;
}

export interface StepResult {
  stepId: string;
  status: StepStatus;
  output: string;
  agentResult: AgentRunResult | null;
  startedAt: number;
  completedAt: number | null;
  retryCount: number;
  /**
   * O7: set when the step has failed repeatedly past the escalation threshold
   * and is now awaiting a human decision (retry / skip / stop). The run pauses
   * until the caller resolves it.
   */
  decisionRequired?: boolean;
  /** O7: human-readable failure reasons accumulated across attempts. */
  failureReasons?: string[];
}

// ─── Hooks ────────────────────────────────────────────────────

export interface WorkflowHooks {
  onStepStart?: (step: WorkflowStep, run: WorkflowRun) => void | Promise<void>;
  onStepComplete?: (step: WorkflowStep, result: StepResult, run: WorkflowRun) => void | Promise<void>;
  onStepFailed?: (step: WorkflowStep, result: StepResult, run: WorkflowRun) => void | Promise<void>;
  onApprovalRequired?: (step: WorkflowStep, run: WorkflowRun) => Promise<boolean>;
  onEditOutput?: (step: WorkflowStep, result: StepResult, run: WorkflowRun) => Promise<string>;
  onProgress?: (completed: number, total: number, step: WorkflowStep) => void;
}

// ─── Topological Sort ─────────────────────────────────────────

/**
 * Topological sort of workflow steps using Kahn's algorithm.
 * Returns step IDs in valid execution order.
 * Throws if a cycle is detected.
 */
export function topologicalSort(def: WorkflowDefinition): string[] {
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};

  // Initialize
  for (const step of def.steps) {
    inDegree[step.id] = 0;
    adjacency[step.id] = [];
  }

  // Build graph from dependencies
  for (const [stepId, deps] of Object.entries(def.dependencies)) {
    if (!Object.prototype.hasOwnProperty.call(inDegree, stepId)) continue;
    inDegree[stepId] = deps.length;
    for (const dep of deps) {
      if (adjacency[dep]) {
        adjacency[dep].push(stepId);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const stepId of Object.keys(inDegree)) {
    if (inDegree[stepId] === 0) queue.push(stepId);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const neighbor of adjacency[current] ?? []) {
      const currentDeg = inDegree[neighbor];
      if (currentDeg === undefined) continue;
      inDegree[neighbor] = currentDeg - 1;
      if (currentDeg - 1 === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sorted.length !== def.steps.length) {
    const missing = def.steps.map((s) => s.id).filter((id) => !sorted.includes(id));
    throw new Error(`Workflow DAG has a cycle involving steps: ${missing.join(', ')}`);
  }

  return sorted;
}

/**
 * Validate a workflow definition: check for missing steps, dangling deps, cycles.
 */
export function validateWorkflowDefinition(def: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const stepIds = new Set(def.steps.map((s) => s.id));

  // Check for duplicate step IDs
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (seen.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    seen.add(step.id);
  }

  // Check dependencies reference existing steps
  for (const [stepId, deps] of Object.entries(def.dependencies)) {
    if (!stepIds.has(stepId)) {
      errors.push(`Dependency key references non-existent step: ${stepId}`);
    }
    for (const dep of deps) {
      if (!stepIds.has(dep)) {
        errors.push(`Step '${stepId}' depends on non-existent step: ${dep}`);
      }
    }
  }

  // Check inputFrom references existing steps
  for (const step of def.steps) {
    for (const inputId of step.inputFrom) {
      if (!stepIds.has(inputId)) {
        errors.push(`Step '${step.id}' references non-existent inputFrom: ${inputId}`);
      }
    }
  }

  // Check for cycles
  try {
    topologicalSort(def);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'DAG cycle detected');
  }

  return errors;
}
