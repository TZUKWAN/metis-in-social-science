/**
 * topicBridge.ts — Task 3 §5 preload domain split.
 * Mechanical extraction from electron/preload.ts; method bodies unchanged.
 */

import { ipcRenderer } from 'electron';

export const topicBridge = {
    // ---- 选题 Topic(2026-09-04 刘总要求:选题一级功能)----
    topicCreateSession: async (rawRequest: { title?: string; initialIntent?: string; sourceProjectId?: string | null; discipline?: string; constraints?: Record<string, unknown>; category?: string | null }) => (
      ipcRenderer.invoke('topic:sessions:create', rawRequest) as Promise<{ ok: boolean; code?: string; session?: unknown }>
    ),

    topicListSessions: async () => (
      ipcRenderer.invoke('topic:sessions:list') as Promise<Array<Record<string, unknown>>>
    ),

    topicGetSession: async (sessionId: string) => (
      ipcRenderer.invoke('topic:sessions:get', { sessionId }) as Promise<{ session: Record<string, unknown>; candidates: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } | null>
    ),

    topicUpdateSession: async (rawRequest: { sessionId: string; patch: Record<string, unknown> }) => (
      ipcRenderer.invoke('topic:sessions:update', rawRequest) as Promise<Record<string, unknown> | null>
    ),

    topicDeleteSession: async (sessionId: string) => (
      ipcRenderer.invoke('topic:sessions:delete', { sessionId }) as Promise<boolean>
    ),

    topicUpdateCandidate: async (rawRequest: { sessionId: string; candidateId: string; patch: Record<string, unknown> }) => (
      ipcRenderer.invoke('topic:candidates:update', rawRequest) as Promise<Record<string, unknown> | null>
    ),

    topicSelectCandidate: async (rawRequest: { sessionId: string; candidateId: string }) => (
      ipcRenderer.invoke('topic:select', rawRequest) as Promise<{ ok: boolean; code?: string; session?: unknown; candidate?: unknown; brief?: unknown }>
    ),

    topicMarkConverted: async (rawRequest: { candidateId: string; projectId?: string; scenarioId?: string }) => (
      ipcRenderer.invoke('topic:markConverted', rawRequest) as Promise<Record<string, unknown> | null>
    ),

    topicGetBrief: async (sessionId: string) => (
      ipcRenderer.invoke('topic:brief', { sessionId }) as Promise<Record<string, unknown> | null>
    ),

    // ── P0b/P0d: 中断与后台运行 ───────────────────────────────
    topicAbort: async (rawRequest: { sessionId: string }) => (
      ipcRenderer.invoke('topic:abort', rawRequest) as Promise<{ ok: boolean; aborted?: boolean; code?: string }>
    ),
    topicRunning: async (rawRequest: { sessionId: string }) => (
      ipcRenderer.invoke('topic:running', rawRequest) as Promise<{ running: boolean; startedAt?: number | null }>
    ),

    // ── P0a/P0c: 工具事件与思考行流 ───────────────────────────
    onTopicToolEvent: (handler: (payload: { sessionId: string; tool: string | null; state: 'done' | 'failed' | 'running'; summary?: string | null }) => void) => {
      const listener = (_event: unknown, payload: { sessionId: string; tool: string | null; state: 'done' | 'failed' | 'running'; summary?: string | null }) => handler(payload);
      ipcRenderer.on('topic:tool-event', listener as never);
      return () => { ipcRenderer.removeListener('topic:tool-event', listener as never); };
    },
    onTopicReasoningDelta: (handler: (payload: { sessionId: string; text: string }) => void) => {
      const listener = (_event: unknown, payload: { sessionId: string; text: string }) => handler(payload);
      ipcRenderer.on('topic:reasoning-delta', listener as never);
      return () => { ipcRenderer.removeListener('topic:reasoning-delta', listener as never); };
    },
    onTopicStreamEnd: (handler: (payload: { sessionId: string }) => void) => {
      const listener = (_event: unknown, payload: { sessionId: string }) => handler(payload);
      ipcRenderer.on('topic:stream-end', listener as never);
      return () => { ipcRenderer.removeListener('topic:stream-end', listener as never); };
    },
};
