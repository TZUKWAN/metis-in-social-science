/**
 * Goal domain IPC registrar — 从 main.ts 迁出（2026-09-13 拆分）。
 *
 * 18 个 goal:* handler 与看板状态/优先级转换。引擎闭包（goalEngine）、
 * 广播（broadcastGoalChanged）、执行选项解析（resolveGoalExecutionOptions）
 * 与请求计数都经 DomainIpcContext 注入，保持本文件与 main.ts 无循环依赖。
 */
import type { Goal } from '../../engine/goal/GoalPlanner.js';
import type { WorkflowDefinition, WorkflowHooks } from '../../engine/workflow/types.js';
import {
  CHAT_RUNTIME_CONTRACT_VERSION,
  RuntimeIdSchema,
  decodeGoalLiveEvent,
} from '../../engine/runtime/ChatRuntimeContract.js';
import {
  createGoalWorkflowRecovery,
  decodeGoalCreateResponse,
  decodeGoalListResponse,
  decodeGoalPlanResponse,
  decodeGoalSummaryResponse,
  decodeGoalWorkflowResponse,
  GoalCreateRequestSchema,
  GoalIdRequestSchema,
  GoalRefineRequestSchema,
} from '../../engine/runtime/GoalRuntimeContract.js';
import { trackEphemeralOperation } from '../RuntimeShutdownCoordinator.js';
import { GOAL_PLAN_LABEL } from '../../engine/runtime/GoalRuntimeContract.js';
import type { DomainIpcContext } from './DomainIpcContext.js';
import { goalCheckpointSummary, presentGoalPlan, presentGoalSummary, presentGoalWorkflow } from './goalPresentation.js';

export function registerGoalIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, runtimeShutdown, goalEngine, broadcastGoalChanged, nextRequestId, resolveGoalExecutionOptions } = ctx;
  const dom = ctx.registry.domain('goal', ['goal:']);

  dom.handle('goal:create', (event, rawDescription: unknown, rawContext?: unknown, rawProjectId?: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine()) return decodeGoalCreateResponse(null);
      const request = GoalCreateRequestSchema.parse({
        description: rawDescription,
        context: rawContext,
        projectId: typeof rawProjectId === 'string' ? rawProjectId : undefined,
      });
      const goal = goalEngine()!.createGoal(request.description, request.context, request.projectId);
      broadcastGoalChanged(event.sender, goal);
      return decodeGoalCreateResponse({
        success: true,
        goalId: goal.id,
        status: goal.status,
      });
    } catch {
      return decodeGoalCreateResponse(null);
    }
  });
  dom.handle('goal:get', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine()) return decodeGoalSummaryResponse(null);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const goal = goalEngine()!.getGoal(goalId);
      return goal
        ? decodeGoalSummaryResponse({ success: true, goal: presentGoalSummary(goal, goalCheckpointSummary(goalEngine(), goal.id)) })
        : decodeGoalSummaryResponse(null);
    } catch {
      return decodeGoalSummaryResponse(null);
    }
  });
  // O17: 工作流可视化——返回 goal 的 WorkflowDefinition（契约化截断）与最新
  // run 的步骤状态，供渲染端 WorkflowGraph 只读渲染 DAG 节点图。
  dom.handle('goal:getWorkflow', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine()) return createGoalWorkflowRecovery();
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const view = goalEngine()!.getWorkflowView(goalId);
      if (!view) return createGoalWorkflowRecovery();
      return decodeGoalWorkflowResponse(presentGoalWorkflow(goalId, view));
    } catch {
      return createGoalWorkflowRecovery();
    }
  });
  dom.handle('goal:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine()) return decodeGoalListResponse(null);
      return decodeGoalListResponse({
        success: true,
        goals: goalEngine()!.listGoals().map((goal) => presentGoalSummary(goal, goalCheckpointSummary(goalEngine(), goal.id))),
      });
    } catch {
      return decodeGoalListResponse(null);
    }
  });
  dom.handle('goal:generatePlan', async (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine()) return decodeGoalPlanResponse(null);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `goal:generatePlan:${goalId}:${nextRequestId()}`,
        rejection: decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] }),
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const result = await goalEngine()!.generatePlan(goalId, { signal: tracked.signal });
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        const goal = goalEngine()!.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
        return presentGoalPlan(goalId, result.workflow);
      } catch (error) {
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        throw error;
      } finally {
        tracked.cleanup();
      }
    } catch {
      return decodeGoalPlanResponse(null);
    }
  });
  dom.handle('goal:refinePlan', async (event, rawGoalId: unknown, rawFeedback: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine()) return decodeGoalPlanResponse(null);
      const request = GoalRefineRequestSchema.parse({
        goalId: rawGoalId,
        feedback: rawFeedback,
      });
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `goal:refinePlan:${request.goalId}:${nextRequestId()}`,
        rejection: decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] }),
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const result = await goalEngine()!.refinePlan(request.goalId, request.feedback, { signal: tracked.signal });
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        const goal = goalEngine()!.getGoal(request.goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
        return presentGoalPlan(request.goalId, result.workflow);
      } catch (error) {
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        throw error;
      } finally {
        tracked.cleanup();
      }
    } catch {
      return decodeGoalPlanResponse(null);
    }
  });
  dom.handle('goal:updatePlan', async (event, rawGoalId: unknown, rawWorkflow: unknown) => {
    try {
      requireRendererMainFrame(event);
      const goalId = RuntimeIdSchema.parse(rawGoalId);
      // O17: the renderer builds a WorkflowDefinition-shaped object; decode it
      // leniently (structure is validated by GoalPlanner.validatePlan below).
      if (!goalEngine() || typeof rawWorkflow !== 'object' || rawWorkflow === null) {
        return { valid: false, errors: ['goal_plan_update_unavailable'], warnings: [] };
      }
      const workflow = rawWorkflow as WorkflowDefinition;
      const result = goalEngine()!.updatePlan(goalId, workflow);
      if (result.valid) {
        const goal = goalEngine()!.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return { valid: result.valid, errors: result.errors, warnings: result.warnings };
    } catch {
      return { valid: false, errors: ['goal_plan_update_unavailable'], warnings: [] };
    }
  });
  dom.handle('goal:execute', async (event, rawGoalId: unknown) => {
    if (runtimeShutdown.isDraining()) return { success: false, code: 'application_shutting_down' };
    let goalId: string;
    try {
      requireRendererMainFrame(event);
      goalId = RuntimeIdSchema.parse(rawGoalId);
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
    if (!goalEngine()) return { success: false, code: 'goal_execution_unavailable' };
    let sequence = 0;
    const sendGoalEvent = (channel: string, payload: unknown) => {
      const decoded = decodeGoalLiveEvent(payload);
      if (decoded.ok) event.sender.send(channel, decoded.value);
    };
    const hooks: WorkflowHooks = {
      onStepStart: (step) => {
        sendGoalEvent('goal:step:start', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-start',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
        });
      },
      onStepComplete: (step) => {
        sendGoalEvent('goal:step:complete', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-complete',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
          output: '',
        });
      },
      onStepFailed: (step) => {
        sendGoalEvent('goal:step:failed', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-failed',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
          error: 'goal_step_failed',
        });
      },
      onProgress: (completed, total) => {
        sendGoalEvent('goal:progress', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'progress',
          goalId,
          sequence: sequence++,
          completed,
          total,
          currentStep: 'Research step',
        });
      },
    };
    try {
      // O13: 解析项目级 provider 覆盖（无覆盖时返回全局绑定）。
      const executeTarget = goalEngine()!.getGoal(goalId);
      const executionOptions = executeTarget ? resolveGoalExecutionOptions(executeTarget) : undefined;
      const run = await goalEngine()!.executeGoal(goalId, hooks, executionOptions);
      const goal = goalEngine()!.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      if (run.status === 'completed') return { success: true, code: 'completed' };
      if (run.status === 'paused') return { success: false, code: 'paused' };
      if (run.status === 'cancelled') return { success: false, code: 'cancelled' };
      return { success: false, code: 'failed' };
    } catch (error) {
      console.error('[goal:execute] execution failed', error);
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  dom.handle('goal:pause', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine()) return { success: false, code: 'goal_execution_unavailable' };
      const paused = goalEngine()!.pauseGoal(goalId);
      const goal = goalEngine()!.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return paused
        ? { success: true, code: 'pause_requested' }
        : { success: false, code: 'goal_execution_unavailable' };
    } catch {
      return { success: false };
    }
  });
  dom.handle('goal:resume', async (event, rawGoalId: unknown, rawFromStepId?: unknown) => {
    if (runtimeShutdown.isDraining()) return { success: false, code: 'application_shutting_down' };
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const fromStepId = rawFromStepId === undefined
        ? undefined
        : RuntimeIdSchema.parse(rawFromStepId);
      if (!goalEngine()) return { success: false, code: 'goal_execution_unavailable' };
      // O13/O14: resume 同样解析项目级 provider 覆盖；fromStepId 省略时
      // 由 GoalEngine 从 checkpoint 推导恢复点。
      const resumeTarget = goalEngine()!.getGoal(goalId);
      const executionOptions = resumeTarget ? resolveGoalExecutionOptions(resumeTarget) : undefined;
      const run = await goalEngine()!.resumeGoal(goalId, fromStepId, undefined, executionOptions);
      const goal = goalEngine()!.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      if (run.status === 'completed') return { success: true, code: 'completed' };
      if (run.status === 'paused') return { success: false, code: 'paused' };
      if (run.status === 'cancelled') return { success: false, code: 'cancelled' };
      return { success: false, code: 'failed' };
    } catch (error) {
      console.error('[goal:resume] resume failed', error);
      // 已取消/已完成的目标是终态，恢复永远不可能成功——必须把这个事实
      // 如实返回给渲染端，而不是笼统的 unavailable（那会让用户一直重试）。
      const message = String((error as Error)?.message ?? error);
      if (message.includes('was cancelled and cannot be resumed')) {
        return { success: false, code: 'goal_cancelled' };
      }
      if (message.includes('not found')) {
        return { success: false, code: 'goal_not_found' };
      }
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  // O7: human decision on an escalated step (retry / skip / stop).
  dom.handle('goal:resolveStepDecision', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: string; action?: string };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const action = request?.action;
      if (!goalId || (action !== 'retry' && action !== 'skip' && action !== 'stop') || !goalEngine()) {
        return { success: false, code: 'invalid_request' };
      }
      const goal = goalEngine()!.getGoal(goalId);
      const executionOptions = goal ? resolveGoalExecutionOptions(goal) : undefined;
      await goalEngine()!.resolveStepDecision(goalId, action, undefined, executionOptions);
      const updated = goalEngine()!.getGoal(goalId);
      if (updated) broadcastGoalChanged(event.sender, updated);
      return { success: true };
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  dom.handle('goal:cancel', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine()) return { success: false, code: 'goal_execution_unavailable' };
      const cancelled = goalEngine()!.cancelGoal(goalId);
      const goal = goalEngine()!.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return cancelled
        ? { success: true, code: 'cancelled' }
        : { success: false, code: 'goal_not_found' };
    } catch {
      return { success: false };
    }
  });
  dom.handle('goal:getProgress', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      return goalEngine()?.getProgress(goalId);
    } catch {
      return undefined;
    }
  });
  dom.handle('goal:archive', async (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine()) return { success: false };
      await goalEngine()!.archiveGoal(goalId);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  dom.handle('goal:listArchives', (event) => {
    try {
      requireRendererMainFrame(event);
      return goalEngine()?.getArchives() ?? [];
    } catch {
      return [];
    }
  });

  // ── Kanban status/priority transitions ──────────────────
  dom.handle('goal:updateStatus', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: unknown; status?: unknown };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const status = typeof request?.status === 'string' ? request.status : '';
      const valid = new Set(['draft', 'planning', 'ready', 'running', 'paused', 'completed', 'failed']);
      if (!goalId || !valid.has(status) || !goalEngine()) return { ok: false, error: 'invalid_request' };
      const updated = goalEngine()!.setStatus(goalId, status as Goal['status']);
      if (updated) {
        const goal = goalEngine()!.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  dom.handle('goal:updatePriority', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: unknown; priority?: unknown };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const priority = typeof request?.priority === 'string' ? request.priority : '';
      const valid = new Set(['low', 'medium', 'high', 'urgent']);
      if (!goalId || !valid.has(priority) || !goalEngine()) return { ok: false, error: 'invalid_request' };
      const updated = goalEngine()!.setPriority(goalId, priority as Goal['priority']);
      if (updated) {
        const goal = goalEngine()!.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  dom.handle('goal:delete', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const goalId = typeof rawGoalId === 'string' ? rawGoalId : '';
      if (!goalId || !goalEngine()) return { ok: false, error: 'invalid_request' };
      const goal = goalEngine()!.getGoal(goalId);
      const deleted = goalEngine()!.deleteGoal(goalId);
      if (deleted && goal) {
        // Deletion is presented to open cards as a cancellation so chat cards
        // never dangle; the board reloads and the card disappears.
        broadcastGoalChanged(event.sender, goal, 'cancelled');
      }
      return deleted ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  return () => dom.dispose();
}
