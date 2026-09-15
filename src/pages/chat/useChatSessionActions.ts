/**
 * 会话操作 hook（2026-09-15 拆分）。
 *
 * 从 ChatPage 迁出五个会话级操作：createNewSession（建会话并绑定项目默认
 * 场景，返回新会话 id）、handleDeleteSession（删会话 + 活动会话回退）、
 * handleRenameSession（重命名并持久化）、handleAutoNameSession（按消息内容
 * 自动命名）、handleArchiveSession（归档/取消归档 + 活动会话回退）。
 * 依赖（state、setter、回调）全部经 deps 对象显式注入，宿主快照语义与
 * conversation/chatTurnFlow.ts 的显式注入模式一致：
 * - createNewSession / handleDeleteSession / handleArchiveSession 保持普通
 *   函数声明（每渲染重建，闭包取当前渲染快照），与迁出前一致；
 * - handleRenameSession 保持 useCallback：原依赖数组为 []（闭包捕获首渲染
 *   的 setSessions）；这里写 [setSessions]，React 保证 useState 的 setter
 *   标识恒定，故 useCallback 返回的函数标识同样跨渲染稳定，行为等价；
 * - handleAutoNameSession 保持 useCallback，依赖数组与迁出前一致
 *   （[currentSessionId, messages, handleRenameSession]）。
 * 纯移动，行为语义不变。
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { TranslateFn } from '../../i18n';
import {
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionUpdateRequest,
  type SessionListItem,
} from '../../../engine/runtime/SessionRuntimeContract';
import { now, type ChatMessage } from './chatPageModel';

export interface UseChatSessionActionsDeps {
  /** 当前激活科研项目 id（无则新会话不绑定项目）。 */
  activeResearchProjectId: string | null;
  /** 当前活动会话 id（删除/归档当前会话时用于活动会话回退）。 */
  currentSessionId: string;
  /** 会话列表快照（删除/归档时计算回退目标与最终列表）。 */
  sessions: SessionListItem[];
  /** 当前会话消息（自动命名时提取候选标题）。 */
  messages: ChatMessage[];
  /** 受保护的活动会话切换（宿主 useCallback 注入）。 */
  activateSession: (sessionId: string) => void;
  /** 会话列表 setter。 */
  setSessions: Dispatch<SetStateAction<SessionListItem[]>>;
  /** 文案翻译函数（新会话默认标题）。 */
  t: TranslateFn;
}

export interface ChatSessionActions {
  createNewSession: () => Promise<string | null>;
  handleDeleteSession: (id: string) => Promise<void>;
  handleRenameSession: (id: string, title: string) => Promise<void>;
  handleAutoNameSession: () => void;
  handleArchiveSession: (id: string) => Promise<void>;
}

export function useChatSessionActions(deps: UseChatSessionActionsDeps): ChatSessionActions {
  const {
    activeResearchProjectId,
    currentSessionId,
    sessions,
    messages,
    activateSession,
    setSessions,
    t,
  } = deps;

  // Helper: create a new session (defined before useEffect that calls it).
  // Returns the new session id on success, null on failure — callers that
  // auto-create a session on first send need the id synchronously because
  // React state updates are not visible inside the same invocation.
  async function createNewSession(): Promise<string | null> {
    const ts = now();
    const id = `session_${ts}`;
    const request = decodeSessionCreateRequest({
      sessionId: id,
      ...(activeResearchProjectId ? { projectId: activeResearchProjectId } : {}),
    });
    if (!request.ok) return null;
    const metis = window.metis;
    if (metis?.createSession) {
      const result = await metis.createSession(id, request.value.projectId).catch(() => null);
      if (!result?.success) return null;
    }
    // 多对话架构(2026-09-04 刘总要求):新对话默认绑定项目默认场景(defaultScenarioId
    // 只是推荐值,用户可在对话中单独更换;不影响其他对话)。
    if (metis?.updateSession) {
      let defaultScenario: string | null = null;
      if (activeResearchProjectId) {
        try {
          const response = await metis.getDefaultScenario?.(activeResearchProjectId);
          defaultScenario = response?.scenarioId ?? null;
        } catch { defaultScenario = null; }
      }
      const patch: { scenarioId?: string | null } = { scenarioId: defaultScenario };
      await metis.updateSession(id, patch).catch(() => undefined);
    }
    activateSession(id);
    setSessions((prev) => [
      {
        id,
        title: t('chat.newSessionTitle') ?? '新会话',
        createdAt: ts,
        lastActivity: ts,
        messageCount: 0,
        archived: false,
        projectId: request.value.projectId,
      },
      ...prev,
    ]);
    return id;
  }

  // Helper: delete a session
  async function handleDeleteSession(id: string) {
    const request = decodeSessionDeleteRequest({ sessionId: id });
    if (!request.ok) return;
    const metis = window.metis;
    if (metis?.deleteSession) {
      const result = await metis.deleteSession(id).catch(() => null);
      if (!result?.success) return;
    }
    if (id === currentSessionId) {
      const remaining = sessions.filter((s) => s.id !== id);
      if (remaining.length > 0 && remaining[0]) {
        activateSession(remaining[0].id);
      } else {
        activateSession('');
      }
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }

  // Helper: rename a session and persist metadata
  const handleRenameSession = useCallback(async (id: string, title: string) => {
    const request = decodeSessionUpdateRequest({
      sessionId: id,
      patch: { title },
    });
    if (!request.ok) return;
    const metis = window.metis;
    if (metis?.updateSession) {
      const result = await metis.updateSession(id, request.value.patch).catch(() => null);
      if (!result?.success) return;
    }
    setSessions((prev) => prev.map((s) => (
      s.id === id ? { ...s, title: request.value.patch.title } : s
    )));
  }, [setSessions]);

  // Name the conversation from its content: the first substantive user
  // message wins; a short or command-like opener falls back to the longest
  // user message so the title still describes the conversation.
  const handleAutoNameSession = useCallback(() => {
    if (!currentSessionId) return;
    const userMessages = messages
      .filter((m) => m.role === 'user' && m.content.trim())
      .map((m) => m.content.trim());
    if (userMessages.length === 0) return;
    const first = userMessages[0]!;
    const candidate = first.length >= 4
      ? first
      : [...userMessages].sort((a, b) => b.length - a.length)[0]!;
    const title = candidate.length > 30 ? `${candidate.slice(0, 30)}…` : candidate;
    void handleRenameSession(currentSessionId, title);
  }, [currentSessionId, messages, handleRenameSession]);

  // Helper: archive/unarchive a session and persist metadata
  async function handleArchiveSession(id: string) {
    const existing = sessions.find((session) => session.id === id);
    if (!existing) return;
    const request = decodeSessionUpdateRequest({
      sessionId: id,
      patch: { archived: !existing.archived },
    });
    if (!request.ok) return;
    if (window.metis?.updateSession) {
      const result = await window.metis.updateSession(id, request.value.patch).catch(() => null);
      if (!result?.success) return;
    }

    const next = sessions.map((session) => (
      session.id === id
        ? { ...session, archived: request.value.patch.archived ?? session.archived }
        : session
    ));
    const updated = next.find((session) => session.id === id);
    if (updated?.archived && id === currentSessionId) {
      const remaining = next.filter((session) => !session.archived);
      if (remaining.length > 0 && remaining[0]) {
        activateSession(remaining[0].id);
      } else {
        activateSession('');
      }
    }
    setSessions(next);
  }

  return {
    createNewSession,
    handleDeleteSession,
    handleRenameSession,
    handleAutoNameSession,
    handleArchiveSession,
  };
}
