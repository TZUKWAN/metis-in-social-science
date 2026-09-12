/**
 * Topic (选题) domain IPC registrar — Task 3 §4.
 *
 * Migrated verbatim from `electron/main.ts` (channel names, request schemas,
 * recovery shapes and the `topic:stream-chunk` forwarding contract are
 * unchanged; this file only relocates registration and receives former module
 * state through {@link DomainIpcContext}). Conversation streaming internals
 * are NOT modified — `topic:chat` keeps its hook-based token forwarding.
 */

import { z } from 'zod';
import {
  TopicChatRequestSchema,
  TopicSessionCreateRequestSchema,
  TopicSessionUpdatePatchSchema,
  TopicCandidateUpsertSchema,
  type TopicCandidateDto,
} from '../../engine/runtime/TopicRuntimeContract.js';
import { trackEphemeralOperation } from '../RuntimeShutdownCoordinator.js';
import { TopicStreamGate, type TopicToolEvent } from '../../engine/runtime/TopicStreamGate.js';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerTopicIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, runtimeShutdown, ensureTopicService } = ctx;
  const agentLoop = (): ReturnType<DomainIpcContext['agentLoop']> => ctx.agentLoop();
  const topic = ctx.registry.domain('topic', ['topic:']);
  // P0b/P0d: in-flight topic chats keyed by sessionId — the run keeps going
  // when the user switches sessions or navigates away; topic:abort retires it.
  const activeRuns = new Map<string, { abort: () => void; startedAt: number }>();

  topic.handle('topic:sessions:create', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = TopicSessionCreateRequestSchema.safeParse(raw ?? {});
      if (!parsed.success) return { ok: false as const, code: 'invalid_request' };
      const session = ensureTopicService().createSession(parsed.data);
      return { ok: true as const, session };
    } catch (error) {
      return { ok: false as const, code: error instanceof Error && error.message === 'topic_persistence_unavailable' ? 'persistence_unavailable' : 'create_failed' };
    }
  });
  topic.handle('topic:sessions:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return ensureTopicService().listSessions();
    } catch { return []; }
  });
  topic.handle('topic:sessions:get', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().getSessionDetail(parsed.data.sessionId);
    } catch { return null; }
  });
  topic.handle('topic:sessions:update', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160), patch: TopicSessionUpdatePatchSchema }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().updateSession(parsed.data.sessionId, parsed.data.patch);
    } catch { return null; }
  });
  topic.handle('topic:sessions:delete', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return false;
      return ensureTopicService().deleteSession(parsed.data.sessionId);
    } catch { return false; }
  });
  topic.handle('topic:candidates:update', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        sessionId: z.string().min(1).max(160),
        candidateId: z.string().min(1).max(160),
        patch: TopicCandidateUpsertSchema.partial(),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().updateCandidate(parsed.data.sessionId, parsed.data.candidateId, parsed.data.patch as Partial<TopicCandidateDto>);
    } catch { return null; }
  });
  topic.handle('topic:select', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160), candidateId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return { ok: false as const, code: 'invalid_request' };
      return ensureTopicService().selectCandidate(parsed.data.sessionId, parsed.data.candidateId);
    } catch (error) {
      return { ok: false as const, code: error instanceof Error && error.message === 'topic_persistence_unavailable' ? 'persistence_unavailable' : 'select_failed' };
    }
  });
  topic.handle('topic:markConverted', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        candidateId: z.string().min(1).max(160),
        projectId: z.string().max(160).optional(),
        scenarioId: z.string().max(160).optional(),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().markConverted(parsed.data.candidateId, parsed.data);
    } catch { return null; }
  });
  topic.handle('topic:brief', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().getBrief(parsed.data.sessionId);
    } catch { return null; }
  });
  topic.handle('topic:chat', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = TopicChatRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false as const, code: 'invalid_request' };
      if (!agentLoop()) return { ok: false as const, code: 'agent_unavailable', message: 'AI 运行时尚未就绪,请稍后重试。' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `topic:chat:${parsed.data.sessionId}:${Date.now().toString(36)}`,
        rejection: { ok: false as const, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      // P0d: register the in-flight run so topic:abort can retire it even
      // after the user switches sessions or navigates away.
      const abortController = new AbortController();
      activeRuns.set(parsed.data.sessionId, {
        abort: () => abortController.abort(),
        startedAt: Date.now(),
      });
      const composedSignal = tracked.signal
        ? AbortSignal.any([tracked.signal, abortController.signal])
        : abortController.signal;
      // P0a/P0c: token 级流式转发——经 TopicStreamGate 清洗工具协议文本
      // (<dots_function_call>… 不得进入对话正文)，工具调用改走专用事件；
      // reasoning 单独转发供思考行一行刷新。按 topic 会话 id 隔离。
      const topicStreamHookName = `topic-stream-forward:${parsed.data.sessionId}`;
      const gate = new TopicStreamGate();
      gate.onToolEvent = (toolEvent: TopicToolEvent) => {
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('topic:tool-event', {
              sessionId: parsed.data.sessionId,
              tool: toolEvent.tool ?? null,
              state: 'done',
              summary: (toolEvent.raw.match(/"query"\s*:\s*"([^"]{0,120})"/)?.[1] ?? toolEvent.raw.slice(0, 120)),
            });
          }
        } catch { /* 工具事件绝不中断对话 */ }
      };
      const forwardTopicStream = (hookCtx: import('../../engine/core/HookBus.js').HookContext): import('../../engine/core/HookBus.js').HookContext => {
        const payload = hookCtx as unknown as { sessionId?: unknown; content?: unknown; reasoning?: unknown; isFinished?: unknown };
        if (payload.sessionId !== `topic_${parsed.data.sessionId}`) return hookCtx;
        try {
          if (event.sender.isDestroyed()) return hookCtx;
          const reasoning = typeof payload.reasoning === 'string' ? payload.reasoning : '';
          if (reasoning) {
            event.sender.send('topic:reasoning-delta', {
              sessionId: parsed.data.sessionId,
              text: reasoning,
            });
          }
          const content = typeof payload.content === 'string' ? payload.content : '';
          const safe = gate.push(content);
          if (safe.length > 0 || reasoning) {
            event.sender.send('topic:stream-chunk', {
              sessionId: parsed.data.sessionId,
              content: safe,
              isFinished: payload.isFinished === true,
            });
          }
        } catch { /* 流转发绝不中断对话 */ }
        return hookCtx;
      };
      // P0a: 工具生命周期事件（AgentLoop 在工具执行完成后发出）。
      const toolHookName = `topic-tool-forward:${parsed.data.sessionId}`;
      const forwardToolEvent = (hookCtx: import('../../engine/core/HookBus.js').HookContext): import('../../engine/core/HookBus.js').HookContext => {
        const payload = hookCtx as unknown as { sessionId?: unknown; toolName?: unknown; status?: unknown; toolFeedback?: unknown };
        if (payload.sessionId !== `topic_${parsed.data.sessionId}`) return hookCtx;
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('topic:tool-event', {
              sessionId: parsed.data.sessionId,
              tool: typeof payload.toolName === 'string' ? payload.toolName : null,
              state: payload.status === 'failed' ? 'failed' : 'done',
              summary: typeof payload.toolFeedback === 'string' ? payload.toolFeedback.slice(0, 200) : null,
            });
          }
        } catch { /* 工具事件绝不中断对话 */ }
        return hookCtx;
      };
      agentLoop()!.registerHook('model.stream_chunk', forwardTopicStream, { name: topicStreamHookName });
      agentLoop()!.registerHook('tool.dispatched', forwardToolEvent, { name: toolHookName });
      try {
        return await ensureTopicService().chat({
          sessionId: parsed.data.sessionId,
          message: parsed.data.message,
          signal: composedSignal,
        });
      } finally {
        agentLoop()!.unregisterHook('model.stream_chunk', topicStreamHookName);
        agentLoop()!.unregisterHook('tool.dispatched', toolHookName);
        activeRuns.delete(parsed.data.sessionId);
        try { if (!event.sender.isDestroyed()) event.sender.send('topic:stream-end', { sessionId: parsed.data.sessionId }); } catch { /* */ }
      }
    } catch (error) {
      return { ok: false as const, code: error instanceof Error && error.message === 'topic_persistence_unavailable' ? 'persistence_unavailable' : 'chat_failed', message: error instanceof Error ? error.message.slice(0, 300) : undefined };
    }
  });

  topic.handle('topic:abort', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      const run = activeRuns.get(parsed.data.sessionId);
      if (!run) return { ok: true as const, aborted: false };
      run.abort();
      return { ok: true as const, aborted: true };
    } catch {
      return { ok: false, code: 'abort_failed' };
    }
  });
  topic.handle('topic:running', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return { running: false };
      return { running: activeRuns.has(parsed.data.sessionId), startedAt: activeRuns.get(parsed.data.sessionId)?.startedAt ?? null };
    } catch {
      return { running: false };
    }
  });

  return () => {
    // Removes every topic:* handler from ipcMain and the registry ledger.
    // Also aborts any in-flight topic runs so disposal is complete.
    for (const run of activeRuns.values()) run.abort();
    activeRuns.clear();
    topic.dispose();
  };
}
