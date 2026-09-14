/**
 * Goal bridge — Goal 运行时 CRUD/规划/执行 + 生命周期事件订阅
 * （从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';
import {
  decodeGoalLiveEvent,
  type GoalLiveEvent,
} from '../../engine/runtime/ChatRuntimeContract.js';
import {
  decodeGoalChangedEvent,
  decodeGoalCreateResponse,
  decodeGoalExecutionResult,
  decodeGoalListResponse,
  decodeGoalPlanResponse,
  decodeGoalSummaryResponse,
  decodeGoalWorkflowResponse,
  type GoalChangedEvent,
} from '../../engine/runtime/GoalRuntimeContract.js';

type GoalStepStartEvent = Extract<GoalLiveEvent, { type: 'step-start' }>;
type GoalStepCompleteEvent = Extract<GoalLiveEvent, { type: 'step-complete' }>;
type GoalStepFailedEvent = Extract<GoalLiveEvent, { type: 'step-failed' }>;
type GoalProgressEvent = Extract<GoalLiveEvent, { type: 'progress' }>;

export const goalBridge = {
  createGoal: async (description: string, context?: string, projectId?: string) =>
    decodeGoalCreateResponse(await ipcRenderer.invoke('goal:create', description, context, projectId)),
  getGoal: async (goalId: string) =>
    decodeGoalSummaryResponse(await ipcRenderer.invoke('goal:get', goalId)),
  // O17: 读取 goal 的工作流定义 + 最新 run 步骤状态（WorkflowGraph 只读可视化）。
  getGoalWorkflow: async (goalId: string) =>
    decodeGoalWorkflowResponse(await ipcRenderer.invoke('goal:getWorkflow', goalId)),
  listGoals: async () => decodeGoalListResponse(await ipcRenderer.invoke('goal:list')),
  generatePlan: async (goalId: string) =>
    decodeGoalPlanResponse(await ipcRenderer.invoke('goal:generatePlan', goalId)),
  refinePlan: async (goalId: string, feedback: string) =>
    decodeGoalPlanResponse(await ipcRenderer.invoke('goal:refinePlan', goalId, feedback)),
  updatePlan: (goalId: string, workflow: Record<string, unknown>) => ipcRenderer.invoke('goal:updatePlan', goalId, workflow),
  executeGoal: async (goalId: string) =>
    decodeGoalExecutionResult(await ipcRenderer.invoke('goal:execute', goalId)),
  pauseGoal: (goalId: string) => ipcRenderer.invoke('goal:pause', goalId),
  resumeGoal: async (goalId: string, fromStepId?: string) =>
    decodeGoalExecutionResult(await ipcRenderer.invoke('goal:resume', goalId, fromStepId)),
  resolveStepDecision: async (goalId: string, action: 'retry' | 'skip' | 'stop') =>
    ipcRenderer.invoke('goal:resolveStepDecision', { goalId, action }) as Promise<{ success: boolean; code?: string }>,
  cancelGoal: (goalId: string) => ipcRenderer.invoke('goal:cancel', goalId),
  getGoalProgress: (goalId: string) => ipcRenderer.invoke('goal:getProgress', goalId),
  archiveGoal: (goalId: string) => ipcRenderer.invoke('goal:archive', goalId),
  listArchives: () => ipcRenderer.invoke('goal:listArchives'),
  updateGoalStatus: async (request: { goalId: string; status: string }) => ipcRenderer.invoke('goal:updateStatus', request) as Promise<{ ok: boolean; error?: string }>,
  updateGoalPriority: async (request: { goalId: string; priority: string }) => ipcRenderer.invoke('goal:updatePriority', request) as Promise<{ ok: boolean; error?: string }>,
  deleteGoal: async (goalId: string) => ipcRenderer.invoke('goal:delete', goalId) as Promise<{ ok: boolean; error?: string }>,

  onGoalStepStart: (callback: (data: GoalStepStartEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-start') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:start', handler);
    return () => { ipcRenderer.removeListener('goal:step:start', handler); };
  },
  onGoalStepComplete: (callback: (data: GoalStepCompleteEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-complete') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:complete', handler);
    return () => { ipcRenderer.removeListener('goal:step:complete', handler); };
  },
  onGoalStepFailed: (callback: (data: GoalStepFailedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-failed') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:failed', handler);
    return () => { ipcRenderer.removeListener('goal:step:failed', handler); };
  },
  onGoalProgress: (callback: (data: GoalProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'progress') callback(decoded.value);
    };
    ipcRenderer.on('goal:progress', handler);
    return () => { ipcRenderer.removeListener('goal:progress', handler); };
  },
  onGoalChanged: (callback: (data: GoalChangedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalChangedEvent(data);
      if (decoded) callback(decoded);
    };
    ipcRenderer.on('goal:changed', handler);
    return () => { ipcRenderer.removeListener('goal:changed', handler); };
  },
};
