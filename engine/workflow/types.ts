/**
 * Workflow types — DAG definitions, step specifications, run state.
 *
 * Design: One Agent executes steps serially in topological order.
 * Each step has structured input/output, independent budget, and optional HITL/Evals gates.
 */

import type { AgentRunResult } from '../core/types.js';

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
}

export interface StepResult {
  stepId: string;
  status: StepStatus;
  output: string;
  agentResult: AgentRunResult | null;
  startedAt: number;
  completedAt: number | null;
  retryCount: number;
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
