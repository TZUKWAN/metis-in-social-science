/**
 * Goal presentation helpers — 契约化投影（从 main.ts 迁出，2026-09-13 拆分）。
 *
 * presentGoalPlan / presentGoalSummary / goalCheckpointSummary /
 * presentGoalWorkflow 只服务 goal 域 IPC；独立成模块让 main.ts 不再承载
 * 展示层逻辑，也便于单独测试。所有自由文本在这里截断清洗，渲染端拿到的
 * 内容可直接安全渲染。
 */
import {
  GOAL_PLAN_LABEL,
  GOAL_PLAN_STEP_LABEL,
  GOAL_RUNTIME_LIMITS,
  decodeGoalPlanResponse,
} from '../../engine/runtime/GoalRuntimeContract.js';
import type { GoalEngine } from '../../engine/goal/GoalEngine.js';
import type { WorkflowDefinition, WorkflowRun } from '../../engine/workflow/types.js';

export function presentGoalPlan(goalId: string, workflow: WorkflowDefinition) {
  return decodeGoalPlanResponse({
    success: true,
    goalId,
    label: GOAL_PLAN_LABEL,
    steps: workflow.steps.map((step, index) => ({
      stepId: step.id,
      label: GOAL_PLAN_STEP_LABEL,
      ordinal: index + 1,
    })),
  });
}

export function presentGoalSummary(
  goal: { id: string; description?: unknown; status: unknown; createdAt: number; projectId?: string },
  checkpoint?: { resumable: boolean; completedSteps: number; totalSteps: number },
) {
  // UX-GOAL-001: 看板/列表展示持久化的 goal.description，而不是统一占位
  // 标题。空值或损坏记录才回退到固定兜底文案。
  const rawDescription = typeof goal.description === 'string' ? goal.description.trim() : '';
  const label = rawDescription
    ? rawDescription.slice(0, GOAL_RUNTIME_LIMITS.labelChars)
    : 'Research goal';
  return {
    goalId: goal.id,
    label,
    status: goal.status,
    createdAt: goal.createdAt,
    ...(goal.projectId ? { projectId: goal.projectId } : {}),
    // O14: 附带 checkpoint 摘要，渲染端据此显示「从上次断点继续」。
    ...(checkpoint ? { checkpoint } : {}),
  };
}

/** O14: 读取 goal 的 checkpoint 摘要；无持久化 run 或引擎不可用时返回 undefined。 */
export function goalCheckpointSummary(goalEngine: GoalEngine | null, goalId: string): { resumable: boolean; completedSteps: number; totalSteps: number } | undefined {
  if (!goalEngine) return undefined;
  const info = goalEngine.getCheckpointInfo(goalId);
  if (!info.hasCheckpoint) return undefined;
  return { resumable: info.resumable, completedSteps: info.completedSteps, totalSteps: info.totalSteps };
}

// ─── O17: 工作流可视化 presenter ──────────────────────────────

/** 契约文本上限，与 GoalRuntimeContract 的 WORKFLOW_VIEW_TEXT_LIMIT 对齐。 */
const WORKFLOW_VIEW_TEXT_LIMIT = 20_000;
// eslint-disable-next-line no-control-regex
const WORKFLOW_VIEW_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** 契约化清洗：去控制字符（保留换行/回车）并截断到上限。 */
function workflowViewText(value: unknown, limit = WORKFLOW_VIEW_TEXT_LIMIT): string {
  if (typeof value !== 'string') return '';
  return value.replace(WORKFLOW_VIEW_UNSAFE, ' ').slice(0, limit);
}

function workflowViewId(value: unknown): string {
  return workflowViewText(value, 200).replace(/\s+/gu, ' ').trim();
}

/** 验收标准 → 人类可读摘要串（kind + 值/描述）。 */
function presentAcceptanceCriteria(criteria: readonly import('../../engine/workflow/AcceptanceCriteria.js').AcceptanceCriterion[] | undefined): string[] | undefined {
  if (!criteria || criteria.length === 0) return undefined;
  return criteria.map((criterion) => {
    const note = criterion.description?.trim();
    const base = note ? `${note}` : criterion.kind;
    return workflowViewText(`${base} (${criterion.kind}: ${criterion.value})`, 500);
  });
}

/**
 * O17: 把 GoalEngine 的只读视图映射为契约形状。所有自由文本都在这里
 * 截断清洗，保证渲染端拿到的内容可直接安全渲染。
 */
export function presentGoalWorkflow(
  goalId: string,
  view: { workflow: WorkflowDefinition; run: WorkflowRun | undefined },
) {
  const { workflow, run } = view;
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  const dependencies: Record<string, string[]> = {};
  for (const [stepId, deps] of Object.entries(workflow.dependencies)) {
    if (!stepIds.has(stepId)) continue;
    dependencies[stepId] = deps.filter((dep) => stepIds.has(dep));
  }
  const KNOWN_STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'skipped']);
  const stepResults: Record<string, {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    output: string;
    retryCount: number;
    failureReasons?: string[];
    decisionRequired?: boolean;
  }> = {};
  for (const [stepId, result] of Object.entries(run?.stepResults ?? {})) {
    if (!stepIds.has(stepId)) continue;
    stepResults[stepId] = {
      status: (KNOWN_STEP_STATUSES.has(result.status) ? result.status : 'pending') as 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
      output: workflowViewText(result.output),
      retryCount: Number.isFinite(result.retryCount) ? Math.max(0, Math.floor(result.retryCount)) : 0,
      ...(result.failureReasons?.length ? { failureReasons: result.failureReasons.map((reason) => workflowViewText(reason, 500)) } : {}),
      ...(result.decisionRequired ? { decisionRequired: true } : {}),
    };
  }
  return {
    success: true as const,
    goalId,
    workflow: {
      id: workflowViewId(workflow.id) || 'workflow',
      name: workflowViewText(workflow.name, 500),
      description: workflowViewText(workflow.description, 2000),
      version: workflowViewId(workflow.version) || '1',
      steps: workflow.steps.map((step) => ({
        id: step.id,
        name: workflowViewText(step.name, 500),
        description: workflowViewText(step.description, 2000),
        prompt: workflowViewText(step.prompt),
        tools: step.tools.map((tool) => workflowViewId(tool)).filter(Boolean),
        maxTurns: Number.isFinite(step.maxTurns) ? Math.max(0, Math.floor(step.maxTurns)) : 0,
        ...(presentAcceptanceCriteria(step.acceptanceCriteria) ? { acceptanceCriteria: presentAcceptanceCriteria(step.acceptanceCriteria) } : {}),
      })),
      dependencies,
    },
    stepResults,
  };
}
