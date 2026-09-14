/**
 * Agent bridge — Agent 调用/控制 + Chat streaming 订阅（从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';
import {
  AgentChatOptionsSchema,
  decodeChatStreamChunkEvent,
  decodeAgentExecutionEvent,
  AgentEventReplayRequestSchema,
  AgentEventReplayResponseSchema,
  decodeAgentResponse,
  type AgentChatOptions,
} from '../../engine/runtime/ChatRuntimeContract.js';
import {
  AgentControlRequestSchema,
  decodeAgentControlResponse,
  type AgentControlRequest,
} from '../../engine/runtime/LiveSteeringContract.js';
import {
  ScenarioRunControlRequestSchema,
  decodeScenarioRunControlResponse,
  type ScenarioRunControlRequest,
} from '../../engine/runtime/ScenarioControlContract.js';

export const agentBridge = {
  // ── Agent ──────────────────────────────────────────────
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentChat: async (sessionId: string, messages: unknown[], skillId: string | undefined, rawOptions: AgentChatOptions) => {
    const options = AgentChatOptionsSchema.safeParse(rawOptions);
    if (!options.success) return decodeAgentResponse(null);
    return decodeAgentResponse(await ipcRenderer.invoke('agent:chat', sessionId, messages, skillId, options.data));
  },
  /**
   * O15: 多模型同会话对比——用指定 provider profile 跑一个临时对话回合。
   * 主进程用 ProviderProfileStore.configFor(profileId) 构建临时 provider /
   * AgentLoop，响应契约与 agentChat 完全一致（AgentResponse）；区别是该路径
   * 不在主进程落库，对比消息的持久化由渲染端统一负责，避免 N 个 profile
   * 各写一遍用户消息。
   */
  agentChatWithProfile: async (profileId: string, sessionId: string, messages: unknown[], skillId: string | undefined, rawOptions: AgentChatOptions) => {
    const options = AgentChatOptionsSchema.safeParse(rawOptions);
    if (!options.success) return decodeAgentResponse(null);
    return decodeAgentResponse(await ipcRenderer.invoke('agent:chatWithProfile', profileId, sessionId, messages, skillId, options.data));
  },
  agentControl: async (rawRequest: AgentControlRequest) => {
    const request = AgentControlRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeAgentControlResponse(null);
    return decodeAgentControlResponse(
      await ipcRenderer.invoke('agent:control', request.data),
      request.data.operationId,
    );
  },
  /**
   * Public Scenario run control: pause persists a durable paused checkpoint
   * (the next turn resumes it); cancel moves the run to terminal cancelled.
   */
  scenarioControl: async (rawRequest: ScenarioRunControlRequest) => {
    const request = ScenarioRunControlRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeScenarioRunControlResponse(null);
    return decodeScenarioRunControlResponse(
      await ipcRenderer.invoke('scenario:control', request.data),
      request.data.operationId,
    );
  },
  /**
   * 步骤卡控制（2026-09-01 刘总方案二期）：对运行的某一步「指导重做/跳过」。
   * 落库成功后前端补发「继续」即可触发断点恢复。
   */
  scenarioStepControl: async (request: { sessionId: string; stepId: string; action: 'redo' | 'skip'; guidance?: string }) => (
    ipcRenderer.invoke('scenario:stepControl', request) as Promise<
      { ok: true; runId: string; message: string } | { ok: false; code: string; message: string }
    >
  ),
  /**
   * Metis Office 关闭自动同步事件（2026-09-01 刘总要求）：编辑器进程退出时
   * 主进程自动同步（有改动建新版本/无改动安静收尾）并推送结果。
   * 返回取消订阅函数。
   */
  onOutcomeExternalEditorAutoSync: (callback: (payload: {
    projectId: string; outcomeId: string; ok: boolean; changed: boolean;
    version?: number; title?: string; code?: string; message?: string;
  }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on('outcomes:external-editor:auto-sync', listener);
    return () => { ipcRenderer.removeListener('outcomes:external-editor:auto-sync', listener); };
  },

  // ── Chat streaming ───────────────────────────────────────
  // O15: 对比回合的流式分片额外携带 profileId，渲染端据此把 token 路由到
  // 对应模型的气泡；普通回合不带该字段，行为与之前完全一致。
  onChatStreamChunk: (callback: (data: import('../../engine/runtime/ChatRuntimeContract.js').ChatStreamChunkEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeChatStreamChunkEvent(data);
      if (decoded.ok) callback(decoded.value);
    };
    ipcRenderer.on('chat:stream-chunk', handler);
    return () => { ipcRenderer.removeListener('chat:stream-chunk', handler); };
  },
  onChatToolEvent: (callback: (data: { sessionId: string; turnId?: string; tool: string | null; toolCallId?: string | null; state: 'done' | 'failed' | 'running'; summary?: string | null }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      // 轻量契约校验：形状不对的事件直接丢弃，不进渲染状态。
      if (typeof data !== 'object' || data === null) return;
      const row = data as { sessionId?: unknown; turnId?: unknown; tool?: unknown; toolCallId?: unknown; state?: unknown; summary?: unknown };
      if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) return;
      if (row.state !== 'running' && row.state !== 'done' && row.state !== 'failed') return;
      callback({
        sessionId: row.sessionId,
        ...(typeof row.turnId === 'string' ? { turnId: row.turnId } : {}),
        tool: typeof row.tool === 'string' ? row.tool : null,
        ...(typeof row.toolCallId === 'string' ? { toolCallId: row.toolCallId } : {}),
        state: row.state,
        summary: typeof row.summary === 'string' ? row.summary : null,
      });
    };
    ipcRenderer.on('chat:tool-event', handler);
    return () => { ipcRenderer.removeListener('chat:tool-event', handler); };
  },
  onAgentExecutionEvent: (callback: (payload: import('../../engine/runtime/ChatRuntimeContract.js').AgentExecutionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const decoded = decodeAgentExecutionEvent(raw);
      if (decoded.ok) callback(decoded.value);
    };
    ipcRenderer.on('agent:execution-event', handler);
    return () => { ipcRenderer.removeListener('agent:execution-event', handler); };
  },
  replayAgentEvents: async (rawRequest: import('../../engine/runtime/ChatRuntimeContract.js').AgentEventReplayRequest) => {
    const request = AgentEventReplayRequestSchema.safeParse(rawRequest);
    if (!request.success) return null;
    const response = AgentEventReplayResponseSchema.safeParse(
      await ipcRenderer.invoke('agent:execution-replay', request.data),
    );
    return response.success ? response.data : null;
  },
};
