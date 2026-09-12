import React from 'react';
import { AssistantTurn, UserTurn } from '../conversation/ConversationTurns';
import { StreamingMarkdown } from '../presentation/StreamingMarkdown';
import { ChevronRight, Plus } from 'lucide-react';
import './TopicWorkspacePage.css';
import type { TopicCandidateDto, TopicResearchBrief, TopicSessionDto } from '../../engine/runtime/TopicRuntimeContract.js';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore.js';
import { setPendingScenarioHandoff } from '../topic/scenarioHandoff.js';
import ChatbotCollabPanel from '../topic/ChatbotCollabPanel';
import ModelThinkingSelector from '../components/ModelThinkingSelector';
import SplitHandle from '../components/SplitHandle';
import { buildTopicContextPackage } from '../topic/contextPackage';
import type { ExternalModelReference } from '../../engine/runtime/ExternalReferenceContract.js';

/**
 * 选题 Topic Workspace(2026-09-04 刘总要求:选题一级功能)。
 * 布局:主区顶部=会话 tab 条(按分类分组,可切换/关闭,「+」新建);中=AI 研究过程
 * (真实检索/研究版图/结构化选择);右=候选池(可折叠)。
 * 复用 METIS 桌面工作台设计(高信息密度、克制、无卡片墙/评分圆环)。
 */

const SESSION_STATUS_LABELS: Record<string, string> = {
  exploring: '意向确认中', researching: '检索研究中', comparing: '候选比较中',
  selected: '选题已确定', converted: '已转项目', archived: '已归档',
};

const CANDIDATE_STATUS_LABELS: Record<string, string> = {
  candidate: '候选', shortlisted: '已收藏', selected: '已选定', rejected: '已排除', converted: '已转项目',
};

interface TopicStreamChunk { sessionId: string; content: string; reasoning?: string; isFinished: boolean }

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function EvidenceList({ refs }: { refs: TopicCandidateDto['evidenceRefs'] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="topic-evidence">
      {refs.slice(0, 6).map((ref, index) => (
        <li key={`${ref.title}-${index}`}>
          {ref.title}
          {ref.authors && ref.authors.length > 0 ? `(${ref.authors.slice(0, 3).join(',')}${ref.authors.length > 3 ? '等' : ''})` : ''}
          {ref.year ? ` ${ref.year}` : ''}
          {ref.venue ? `·${ref.venue}` : ''}
          {ref.url ? <a href={ref.url} target="_blank" rel="noreferrer"> 链接</a> : ref.doi ? <span> DOI:{ref.doi}</span> : null}
          {ref.claim ? <small> 支持:{ref.claim}</small> : null}
        </li>
      ))}
      {refs.length > 6 && <li>{`等 ${refs.length} 条证据`}</li>}
    </ul>
  );
}

export default function TopicWorkspacePage() {
  const [sessions, setSessions] = React.useState<TopicSessionDto[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<TopicSessionDto | null>(null);
  const [candidates, setCandidates] = React.useState<TopicCandidateDto[]>([]);
  const [messages, setMessages] = React.useState<Array<{ id: string; role: string; content: string }>>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  // P0d: streaming is per-session. Switching sessions mid-run keeps the
  // background run going; coming back restores the live view.
  const [streamingSessionId, setStreamingSessionId] = React.useState<string | null>(null);
  const [streamTail, setStreamTail] = React.useState('');
  // P0a: tool activity rows + P0c: one-line reasoning ticker.
  const [toolEvents, setToolEvents] = React.useState<Array<{ id: number; tool: string | null; state: 'done' | 'failed' | 'running'; summary?: string | null }>>([]);
  const [reasoningLine, setReasoningLine] = React.useState('');
  const [rightCollapsed, setRightCollapsed] = React.useState(false);
  // P1a: 三栏拖动调宽（左会话栏/中间主区/右侧候选栏），宽度持久化到 localStorage。
  const [leftWidth, setLeftWidth] = React.useState<number>(() => {
    try { return Number(localStorage.getItem('metis-topic-left-width')) || 236; } catch { return 236; }
  });
  const [rightWidth, setRightWidth] = React.useState<number>(() => {
    try { return Number(localStorage.getItem('metis-topic-right-width')) || 300; } catch { return 300; }
  });
  const dragRef = React.useRef<{ side: 'left' | 'right'; startX: number; startW: number } | null>(null);
  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      if (dragRef.current.side === 'left') {
        const next = Math.max(180, Math.min(420, dragRef.current.startW + dx));
        setLeftWidth(next);
        try { localStorage.setItem('metis-topic-left-width', String(next)); } catch { /* */ }
      } else {
        const next = Math.max(220, Math.min(480, dragRef.current.startW - dx));
        setRightWidth(next);
        try { localStorage.setItem('metis-topic-right-width', String(next)); } catch { /* */ }
      }
    };
    const onUp = () => { dragRef.current = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);
  const startDrag = React.useCallback((side: 'left' | 'right') => (e: React.MouseEvent) => {
    dragRef.current = { side, startX: e.clientX, startW: side === 'left' ? leftWidth : rightWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [leftWidth, rightWidth]);
  const [notice, setNotice] = React.useState('');
  // 会话管理(2026-09 刘总：左侧列表 + 右键菜单——重命名/移动分类/删除)。
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [categoryDraft, setCategoryDraft] = React.useState('');
  const [menuNewCategory, setMenuNewCategory] = React.useState(false);
  const [sessionMenu, setSessionMenu] = React.useState<{ sessionId: string; x: number; y: number } | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const [activeCandidateId, setActiveCandidateId] = React.useState<string | null>(null);
  const [projectCreating, setProjectCreating] = React.useState(false);
  // Chatbot 协作视图（2026-09-05 刘总规格书）：临时双栏，关闭即退出嵌入。
  const [chatbotOpen, setChatbotOpen] = React.useState(false);
  // P0-4 scoped external refs: refs belong to ONE scope (projectId + topic
  // session). On scope change the state resets immediately (refs cleared,
  // status loading) and every async return is discarded unless its generation
  // still matches — a slow or failed request can never leak Topic A refs into
  // Topic B's context package.
  type ExternalRefsStatus = 'idle' | 'loading' | 'ready' | 'error';
  interface ExternalRefsState {
    scopeKey: string;
    status: ExternalRefsStatus;
    refs: ExternalModelReference[];
  }
  const externalRefsScopeKey = React.useCallback((projectId: string | null, sessionId: string | null): string =>
    `${projectId ?? 'global'}::${sessionId ?? 'none'}`, []);
  const [externalRefsState, setExternalRefsState] = React.useState<ExternalRefsState>({ scopeKey: 'global::none', status: 'idle', refs: [] });
  const externalRefsGeneration = React.useRef(0);
  const [chatbotSplit, setChatbotSplit] = React.useState<number>(() => {
    try {
      const value = Number(window.localStorage.getItem('metis-chatbot-split-v2'));
      return Number.isFinite(value) && value >= 0.4 && value <= 0.45 ? value : 0.42;
    } catch { return 0.42; }
  });
  const collabWrapRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    try { window.localStorage.setItem('metis-chatbot-split-v2', String(chatbotSplit)); } catch { /* best-effort */ }
  }, [chatbotSplit]);
  const applySplitFromClientX = React.useCallback((clientX: number) => {
    const rect = collabWrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = (rect.right - clientX) / rect.width;
    setChatbotSplit(Math.min(0.45, Math.max(0.4, ratio)));
  }, []);
  const syncChatbotBounds = React.useCallback(() => {
    // 松手后按新尺寸恢复嵌入视图（拖动期间已隐藏）。
    window.dispatchEvent(new CustomEvent('metis:restore-embedded-views'));
  }, []);
  const sessionIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    sessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const loadSessionRef = React.useRef<((id: string) => Promise<void>) | null>(null);

  // 会话切换时收起重命名编辑态,避免串到下一个会话。
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 与既有会话切换清理同款（收起编辑态/菜单，属于状态重置而非派生数据）
    setRenamingId(null);
    setSessionMenu(null);
  }, [activeSessionId]);

  // tab 条按分类分组:归档(软删除)会话不显示;无分类归入「未分类」组。
  const visibleSessions = sessions.filter((item) => item.status !== 'archived');
  const [selectedCategory, setSelectedCategory] = React.useState<string | null>(null);
  const [newCategoryFilter, setNewCategoryFilter] = React.useState<string | null>(null);
  const allCategories = [...new Set([
    ...visibleSessions.map((item) => item.category?.trim() ?? '').filter((name) => name.length > 0),
    ...(newCategoryFilter ? [newCategoryFilter] : []),
  ])];
  const categories = selectedCategory ? allCategories.filter((name) => name === selectedCategory) : allCategories;
  const sessionGroups: Array<{ name: string | null; items: TopicSessionDto[] }> = [
    ...categories.map((name) => ({ name, items: visibleSessions.filter((item) => (item.category?.trim() ?? '') === name) })),
    { name: null, items: visibleSessions.filter((item) => !(item.category?.trim())) },
  ].filter((group) => group.items.length > 0);

  const refreshExternalRefs = React.useCallback(async (scope?: { sessionId?: string | null; projectId?: string | null }) => {
    // 任务2 上下文隔离：只取当前选题会话（+其来源项目）捕获的外部参考。
    // 空 scope 的全局拉取已被 runtime 禁止（scope_required）——那会把其他
    // Topic/Project 的 Chatbot 引用串进本会话上下文。
    const sessionId = scope?.sessionId ?? sessionIdRef.current;
    const projectId = scope?.projectId ?? session?.sourceProjectId ?? null;
    const scopeKey = externalRefsScopeKey(projectId, sessionId);
    const generation = ++externalRefsGeneration.current;
    // Scope 切换第一时间清空旧 refs 并置 loading——旧 scope 的引用绝不跨 scope 存活。
    setExternalRefsState({ scopeKey, status: 'loading', refs: [] });
    if (!sessionId) { setExternalRefsState({ scopeKey, status: 'ready', refs: [] }); return; }
    try {
      const result = await window.metis?.externalRefList?.({
        sessionId,
        ...(projectId ? { projectId } : {}),
        limit: 50,
      });
      if (generation !== externalRefsGeneration.current) return; // 晚到的旧 scope 响应：丢弃
      if (result?.ok && result.references) setExternalRefsState({ scopeKey, status: 'ready', refs: result.references });
      else setExternalRefsState({ scopeKey, status: result ? 'error' : 'error', refs: [] }); // 失败：明确 error，绝不保留旧数据
    } catch {
      if (generation !== externalRefsGeneration.current) return;
      setExternalRefsState({ scopeKey, status: 'error', refs: [] });
    }
  }, [externalRefsScopeKey, session?.sourceProjectId]);

  const refreshSessions = React.useCallback(async () => {
    try {
      const rows = await window.metis?.topicListSessions?.();
      setSessions((rows ?? []).filter((row): row is TopicSessionDto => Boolean(row && typeof (row as { id?: unknown }).id === 'string')));
    } catch { setSessions([]); }
  }, []);

  const loadSession = React.useCallback(async (id: string) => {
    try {
      const detail = await window.metis?.topicGetSession?.(id);
      if (!detail) return;
      setSession(detail.session as unknown as TopicSessionDto);
      setCandidates((detail.candidates ?? []) as unknown as TopicCandidateDto[]);
      setMessages((detail.messages ?? []).map((message) => ({ id: String((message as { id: string }).id), role: String((message as { role: string }).role), content: String((message as { content: string }).content) })));
    } catch { /* 加载失败保留当前状态 */ }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot session list load
    void refreshSessions();
  }, [refreshSessions]);

  // 任务2 上下文隔离：会话/项目切换时按新 scope 重新拉取外部参考，
  // 保证 context package 只含当前 Topic（+来源项目）的引用。
  React.useEffect(() => {
    void refreshExternalRefs();
  }, [refreshExternalRefs, activeSessionId]);

  // P0d: per-session streaming state — 切走后台继续跑，回来恢复实时视图。
  const backgroundRunsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const unsubscribe = window.metis?.onTopicStreamChunk?.((chunk: TopicStreamChunk) => {
      // 事件按会话隔离。当前会话实时显示；非当前会话标记后台运行徽标。
      if (chunk.sessionId !== sessionIdRef.current) {
        if (chunk.content) backgroundRunsRef.current.add(chunk.sessionId);
        return;
      }
      // P0 2026-09-05：保存完整累积内容交给 StreamingMarkdown 增量渲染
      // （旧版截断 400 字导致用户看不到完整流式回答）。上限仅作内存保护：
      // 超限时尾部截断会触发解析器一代重置，单帧全量解析，可接受。
      setStreamTail((previous) => {
        const next = previous + (chunk.content ?? '');
        return next.length > 20_000 ? next.slice(-20_000) : next;
      });
    });
    const unsubscribeTools = window.metis?.onTopicToolEvent?.((payload) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      setToolEvents((current) => [...current.slice(-19), {
        id: Date.now() + Math.floor(Math.random() * 1000),
        tool: payload.tool,
        state: payload.state,
        summary: payload.summary ?? null,
      }]);
    });
    const unsubscribeReasoning = window.metis?.onTopicReasoningDelta?.((payload) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      // P0c: 思考流程一行内刷新（打字机效果由 CSS 过渡承担）。
      setReasoningLine((prev) => (payload.text.length > 120 ? payload.text.slice(-120) : (prev + payload.text).slice(-160)));
    });
    const unsubscribeEnd = window.metis?.onTopicStreamEnd?.((payload) => {
      backgroundRunsRef.current.delete(payload.sessionId);
      if (payload.sessionId !== sessionIdRef.current) return;
      setStreaming(false);
      setStreamTail('');
      setToolEvents([]);
      setReasoningLine('');
      void loadSessionRef.current?.(payload.sessionId);
    });
    return () => {
      unsubscribe?.();
      unsubscribeTools?.();
      unsubscribeReasoning?.();
      unsubscribeEnd?.();
    };
  }, []);

  const buildPackage = React.useCallback((): string | null => buildTopicContextPackage({
    hasSession: Boolean(session),
    sessionTitle: session?.title ?? null,
    sessionStatus: session ? (SESSION_STATUS_LABELS[session.status] ?? session.status) : null,
    candidates: candidates.map((candidate) => ({
      title: candidate.title,
      status: CANDIDATE_STATUS_LABELS[candidate.status] ?? candidate.status,
    })),
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    // P0-4：进入 LLM Context 的引用必须与当前工作区 scope 完全一致——
    // loading/error/旧 scope 状态下一律不带 externalReferences。
    externalReferences: externalRefsState.status === 'ready'
      && externalRefsState.scopeKey === externalRefsScopeKey(session?.sourceProjectId ?? null, sessionIdRef.current)
      ? externalRefsState.refs.map((ref) => ({ model: ref.model, quotedText: ref.quotedText }))
      : [],
  }), [session, candidates, messages, externalRefsState, externalRefsScopeKey]);

  const handleReferenceConfirmed = React.useCallback((reference: ExternalModelReference, duplicate: boolean) => {
    setExternalRefsState((current) => {
      const scopeKey = externalRefsScopeKey(session?.sourceProjectId ?? null, sessionIdRef.current);
      if (current.scopeKey !== scopeKey) return current; // scope 已切换：新引用属于旧 scope，丢弃
      if (current.refs.some((item) => item.contextDigest === reference.contextDigest)) return current;
      return { ...current, status: 'ready', refs: [reference, ...current.refs] };
    });
    setMessages((current) => [...current, {
      id: `extref-${reference.id}`,
      role: 'assistant',
      content: [
        `外部参考·非证据｜来源：${reference.model}（${reference.url}）`,
        reference.quotedText.length > 600 ? `${reference.quotedText.slice(0, 600)}…` : reference.quotedText,
        duplicate ? '（内容指纹重复，未重复入库）' : '已存入外部参考库（external_references）。该内容不进入证据链，仅供选题论证参考。',
      ].join('\n'),
    }]);
  }, []);

  // 删除(右键菜单/条目 × 共用):二次确认;后端为软删除(归档),列表不再显示。
  const deleteSessionWithConfirm = async (item: TopicSessionDto) => {
    if (!window.confirm(`确定删除选题会话「${item.title}」?删除后不再出现在列表中。`)) return;
    await window.metis?.topicDeleteSession?.(item.id);
    if (activeSessionId === item.id) {
      setActiveSessionId(null);
      setSession(null);
      setCandidates([]);
      setMessages([]);
    }
    await refreshSessions();
  };

  // 重命名/移动分类：作用于任意会话（右键菜单），不限于当前打开的会话。
  const submitRename = async (sessionId: string) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title) return;
    await window.metis?.topicUpdateSession?.({ sessionId, patch: { title } });
    await refreshSessions();
    if (sessionId === activeSessionId) await loadSession(sessionId);
  };

  const categorizeSession = async (sessionId: string, category: string | null) => {
    await window.metis?.topicUpdateSession?.({ sessionId, patch: { category } });
    await refreshSessions();
    if (sessionId === activeSessionId) await loadSession(sessionId);
  };

  const sendFirstMessage = async (id: string, intent: string) => {
    setStreaming(true);
    setStreamingSessionId(id);
    setStreamTail('');
    try {
      const result = await window.metis?.topicChat?.({ sessionId: id, message: intent });
      if (result?.ok) {
        await loadSession(id);
        setNotice('');
      } else {
        setNotice(`选题研究轮未完成:${result?.message ?? result?.code ?? '未知原因'}。已记录的内容已保留。`);
        await loadSession(id);
      }
    } finally {
      setStreaming(false);
      setStreamTail('');
    }
  };

  const send = async () => {
    const message = input.trim();
    if (!message || streaming) return;
    // 刘总 2026-09：没有会话时直接输入即创建——文本就是选题意图。
    if (!activeSessionId) {
      setInput('');
      const result = await window.metis?.topicCreateSession?.({ initialIntent: message });
      if (result?.ok && result.session) {
        const created = result.session as unknown as TopicSessionDto;
        // 发出首条消息即自动命名（刘总 2026-09）：标题取意图前 24 字。
        const autoTitle = message.length > 24 ? `${message.slice(0, 24)}…` : message;
        void window.metis?.topicUpdateSession?.({ sessionId: created.id, patch: { title: autoTitle } });
        await refreshSessions();
        setActiveSessionId(created.id);
        await loadSession(created.id);
        void sendFirstMessage(created.id, message);
      } else {
        setNotice(result?.code === 'persistence_unavailable' ? '持久化暂不可用,无法创建选题会话。' : '创建选题会话失败,请重试。');
      }
      return;
    }
    setInput('');
    setMessages((current) => [...current, { id: makeId('local'), role: 'user', content: message }]);
    setStreaming(true);
    setStreamingSessionId(activeSessionId);
    setStreamTail('');
    setToolEvents([]);
    setReasoningLine('');
    try {
      const result = await window.metis?.topicChat?.({ sessionId: activeSessionId, message });
      if (result?.ok) {
        await loadSession(activeSessionId);
        setNotice('');
      } else {
        setNotice(`本轮未完成:${result?.message ?? result?.code ?? '未知原因'}。已收到的研究内容已保留,可直接重发或继续。`);
        await loadSession(activeSessionId);
      }
    } finally {
      setStreaming(false);
      setStreamTail('');
    }
  };

  const updateCandidateStatus = async (candidateId: string, status: 'shortlisted' | 'rejected' | 'candidate') => {
    if (!activeSessionId) return;
    await window.metis?.topicUpdateCandidate?.({ sessionId: activeSessionId, candidateId, patch: { status } });
    await loadSession(activeSessionId);
  };

  const confirmSelection = async (candidate: TopicCandidateDto) => {
    if (!activeSessionId) return;
    const result = await window.metis?.topicSelectCandidate?.({ sessionId: activeSessionId, candidateId: candidate.id });
    if (result?.ok) {
      await loadSession(activeSessionId);
      await refreshSessions();
      setNotice('选题已确认。可以基于选题构建场景,或直接创建科研项目。');
    } else {
      setNotice(`确认选题失败:${result?.code ?? '未知原因'}`);
    }
  };

  const activeCandidate = candidates.find((candidate) => candidate.id === activeCandidateId) ?? candidates.find((candidate) => candidate.status === 'selected') ?? null;
  const selectedCandidate = candidates.find((candidate) => candidate.status === 'selected') ?? null;

  const buildScenario = async () => {
    if (!selectedCandidate || !session) return;
    // 优先后端生成的正式结构化 Brief;不可用时回退为前端最小 Brief(不阻塞 handoff)。
    let brief: TopicResearchBrief;
    try {
      const stored = await window.metis?.topicGetBrief?.(session.id) as TopicResearchBrief | null | undefined;
      brief = stored ?? {
        source: 'topic', topicSessionId: session.id, candidateId: selectedCandidate.id,
        title: selectedCandidate.title, originalIntent: session.initialIntent,
        researchQuestion: selectedCandidate.researchQuestion, discipline: session.discipline,
        researchBackground: selectedCandidate.summary, rationale: selectedCandidate.rationale,
        literatureLandscape: '', mainResearchStreams: selectedCandidate.theoreticalAngles,
        majorDebates: [], researchGap: selectedCandidate.researchGap,
        closestStudies: selectedCandidate.closestStudies, theoreticalAngles: selectedCandidate.theoreticalAngles,
        methodologySuggestions: selectedCandidate.methodOptions, dataSuggestions: selectedCandidate.dataOptions,
        constraints: session.constraints, risks: selectedCandidate.risks,
        targetPublication: session.constraints?.targetPublications ?? [],
        evidenceRefs: selectedCandidate.evidenceRefs, userDecisions: '', createdAt: Date.now(),
      };
    } catch {
      return;
    }
    setPendingScenarioHandoff({ title: selectedCandidate.title, brief });
    window.dispatchEvent(new CustomEvent('metis:open-personalization'));
  };

  const createProjectDirectly = async () => {
    if (!selectedCandidate || !session || projectCreating) return;
    setProjectCreating(true);
    try {
      const projectId = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const result = await researchWorkspaceStore.getState().createProject({
        projectId,
        title: selectedCandidate.title.slice(0, 120),
        originalIntent: session.initialIntent.slice(0, 4000),
        researchQuestion: selectedCandidate.researchQuestion.slice(0, 1500),
        methodology: selectedCandidate.methodOptions.join('、').slice(0, 800),
        discipline: session.discipline.slice(0, 100),
      });
      if (result.success && result.resourceId) {
        // Scenario 绑定:沿用当前项目创建的偏好写入方式(任务3多对话架构将正式化为 defaultScenarioId)。
        await window.metis?.topicMarkConverted?.({ candidateId: selectedCandidate.id, projectId: result.resourceId });
        researchWorkspaceStore.getState().setActiveProject(result.resourceId);
        window.dispatchEvent(new CustomEvent('metis:navigate-projects'));
        setNotice('科研项目已创建,已进入项目工作台。');
      } else {
        setNotice('科研项目创建失败。选题与场景数据均保留,可重试。');
      }
    } catch {
      setNotice('科研项目创建失败。选题与场景数据均保留,可重试。');
    } finally {
      setProjectCreating(false);
    }
  };

  const workspaceNode = (
    <div className={`topic-workspace${chatbotOpen ? ' topic-workspace--collab' : ''}`} data-testid="topic-workspace">
      {/* 刘总 2026-09：会话记录回左侧竖排列表（按分类分组），不再用顶部 tab。 */}
      <aside className="topic-workspace__sessionlist" aria-label="选题会话" style={{ width: leftWidth, flex: `0 0 ${leftWidth}px` }}>
        <header>
          <span>选题会话</span>
          {/* 新选题 = 清空当前会话并聚焦输入框，输入即创建（刘总 2026-09）。 */}
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              setActiveSessionId(null);
              setSession(null);
              setCandidates([]);
              setMessages([]);
              composerRef.current?.focus();
            }}
            data-testid="topic-new"
          >
            <Plus size={13} /> 新选题
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            data-testid="topic-new-category"
            title="新建分类，把当前会话归入该分类"
            onClick={() => {
              const name = window.prompt('新分类名称：');
              if (name?.trim() && activeSessionId) {
                void window.metis?.topicUpdateSession?.({ sessionId: activeSessionId, patch: { category: name.trim() } }).then(() => refreshSessions());
              } else if (name?.trim()) {
                setNewCategoryFilter(name.trim());
              }
            }}
          >
            <Plus size={13} /> 新分类
          </button>
        </header>
        <div className="topic-workspace__sessionlist-scroll">
          {sessionGroups.map((group) => (
            <div key={group.name ?? 'uncategorized'} className="topic-workspace__sessionlist-group">
              {group.name && (
                <span
                  className={`topic-workspace__sessionlist-group-label${selectedCategory === group.name ? ' selected' : ''}`}
                  data-testid={`topic-category-${group.name}`}
                  title="点击选中过滤；右键重命名/删除分类"
                  onClick={() => setSelectedCategory(selectedCategory === group.name ? null : group.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const name = group.name;
                    if (!name) return;
                    const action = window.prompt(`分类「${name}」操作：输入 R 重命名 / D 删除`, 'R');
                    if (action?.toUpperCase() === 'R') {
                      const newName = window.prompt('新分类名：', name);
                      if (newName?.trim() && newName.trim() !== name) {
                        void Promise.all(visibleSessions.filter((item) => item.category?.trim() === name).map((item) =>
                          window.metis?.topicUpdateSession?.({ sessionId: item.id, patch: { category: newName.trim() } }),
                        )).then(() => { if (selectedCategory === name) setSelectedCategory(newName.trim()); void refreshSessions(); });
                      }
                    } else if (action?.toUpperCase() === 'D') {
                      void Promise.all(visibleSessions.filter((item) => item.category?.trim() === name).map((item) =>
                        window.metis?.topicUpdateSession?.({ sessionId: item.id, patch: { category: null } }),
                      )).then(() => { if (selectedCategory === name) setSelectedCategory(null); void refreshSessions(); });
                    }
                  }}
                >
                  {group.name}
                </span>
              )}
              {group.items.map((item) => (
                <span key={item.id} className={`topic-workspace__session-item${item.id === activeSessionId ? ' active' : ''}`}>
                  {renamingId === item.id ? (
                    <input
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') void submitRename(item.id); if (event.key === 'Escape') setRenamingId(null); }}
                      onBlur={() => void submitRename(item.id)}
                      data-testid="topic-session-rename-input"
                    />
                  ) : (
                    <button
                      type="button"
                      title={`${item.title} · ${SESSION_STATUS_LABELS[item.status] ?? item.status}`}
                      data-session-id={item.id}
                      onClick={() => { setActiveSessionId(item.id); void loadSession(item.id); }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSessionMenu({ sessionId: item.id, x: event.clientX, y: event.clientY });
                      }}
                      data-testid={`topic-session-${item.id}`}
                    >
                      {item.title}
                    </button>
                  )}
                  <button
                    type="button"
                    className="topic-workspace__session-close"
                    aria-label={`删除 ${item.title}`}
                    onClick={() => void deleteSessionWithConfirm(item)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ))}
          {visibleSessions.length === 0 && <p className="topic-workspace__sessionlist-empty">还没有选题会话。</p>}
        </div>
        <footer>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setChatbotOpen(true)}
            data-testid="topic-open-chatbot"
            title="打开 Chatbot 协作面板：与其他 AI 并排讨论，内容仅作外部参考（非证据）"
          >
            打开 Chatbot
          </button>
        </footer>
      </aside>
      {/* 会话右键菜单：重命名 / 移动分类 / 删除（刘总 2026-09）。 */}
      {sessionMenu && (
        <div className="topic-session-menu__backdrop" role="presentation" onClick={() => { setSessionMenu(null); setMenuNewCategory(false); }}>
          <div
            className="topic-session-menu"
            role="menu"
            style={{ left: sessionMenu.x, top: sessionMenu.y }}
            data-testid="topic-session-menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => {
              const target = visibleSessions.find((entry) => entry.id === sessionMenu.sessionId);
              setRenameDraft(target?.title ?? '');
              setRenamingId(sessionMenu.sessionId);
              setSessionMenu(null);
            }}>重命名</button>
            <button type="button" role="menuitem" onClick={() => { void categorizeSession(sessionMenu.sessionId, null); setSessionMenu(null); }}>移出分类</button>
            {categories.map((name) => (
              <button key={name} type="button" role="menuitem" onClick={() => { void categorizeSession(sessionMenu.sessionId, name); setSessionMenu(null); }}>
                移到「{name}」
              </button>
            ))}
            {menuNewCategory ? (
              <input
                autoFocus
                value={categoryDraft}
                placeholder="新分类名"
                onChange={(event) => setCategoryDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && categoryDraft.trim()) { void categorizeSession(sessionMenu.sessionId, categoryDraft.trim()); setSessionMenu(null); setMenuNewCategory(false); }
                  if (event.key === 'Escape') { setMenuNewCategory(false); }
                }}
                data-testid="topic-session-menu-new-category"
              />
            ) : (
              <button type="button" role="menuitem" onClick={() => { setCategoryDraft(''); setMenuNewCategory(true); }}>＋新建分类…</button>
            )}
            <button type="button" role="menuitem" className="topic-session-menu__danger" onClick={() => {
              const target = visibleSessions.find((entry) => entry.id === sessionMenu.sessionId);
              setSessionMenu(null);
              if (target) void deleteSessionWithConfirm(target);
            }}>删除</button>
          </div>
        </div>
      )}
      <div
        className="topic-workspace__col-resize topic-workspace__col-resize--left"
        onMouseDown={startDrag('left')}
        data-testid="topic-resize-left"
        role="separator"
        aria-orientation="vertical"
      />
      <section className="topic-workspace__main" aria-label="选题研究过程">
        {session && (session.status === 'selected' || session.status === 'converted') && (
          <div className="topic-workspace__selected-banner" data-testid="topic-selected-banner">
            <span>选题已确定:《{selectedCandidate?.title ?? session.title}》</span>
            <span className="topic-workspace__banner-actions">
              <button type="button" className="btn-primary btn-sm" onClick={() => void buildScenario()} data-testid="topic-build-scenario">基于选题构建场景</button>
              <button type="button" className="btn-secondary btn-sm" disabled={projectCreating} onClick={() => void createProjectDirectly()} data-testid="topic-create-project">直接创建科研项目</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => window.metis?.topicUpdateSession?.({ sessionId: session.id, patch: { status: 'comparing' } }).then(() => loadSession(session.id))}>继续完善</button>
            </span>
          </div>
        )}
        {notice && <div className="topic-workspace__notice" role="status">{notice}</div>}
        <div className="topic-workspace__messages">
          {messages.length === 0 && !session && (
            <div className="topic-workspace__intro">
              <h2>选题</h2>
              <p>从一个模糊的研究兴趣开始，METIS 会真实检索中英文文献，和你一起比较候选、确认选题。</p>
              <p className="topic-workspace__intro-note">直接在下方输入你的研究兴趣，回车即开始新的选题会话。</p>
            </div>
          )}
          {messages.map((message) => (
            message.role === 'user'
              ? <UserTurn key={message.id} message={{ id: message.id, role: 'user', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
              : <AssistantTurn key={message.id} message={{ id: message.id, role: 'assistant', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
          ))}
          {(streaming || toolEvents.length > 0) && (
            <div className="topic-tool-strip" data-testid="topic-tool-strip">
              {toolEvents.map((event) => (
                <div key={event.id} className={`topic-tool-row topic-tool-row--${event.state}`} data-testid="topic-tool-row">
                  <span className={`topic-tool-row__dot topic-tool-row__dot--${event.state}`} aria-hidden />
                  <span className="topic-tool-row__name">{event.tool ?? '工具调用'}</span>
                  {event.summary && <span className="topic-tool-row__summary">{event.summary}</span>}
                </div>
              ))}
              {streaming && (
                <div className="topic-reasoning-line" data-testid="topic-reasoning-line" title="思考流程">
                  <span className="topic-reasoning-line__label">思考中</span>
                  <span className="topic-reasoning-line__text">{reasoningLine || '分析研究意图……'}</span>
                </div>
              )}
            </div>
          )}
          {streaming && (
            <div className="conv-assistant" data-status="streaming">
              <div className="conv-assistant__body">
                {streamTail
                  ? <StreamingMarkdown text={streamTail} streaming locale="zh" />
                  : <span style={{ color: 'var(--conversation-muted)', fontSize: 13 }}>正在检索与研究……</span>}
                <span className="conv-caret" aria-hidden>▌</span>
              </div>
            </div>
          )}
        </div>
        <footer className="topic-workspace__input">
          {/* 刘总 2026-09：选题对话与研究对话一样支持选择模型与思考强度；
              无会话时输入直接创建新会话（文本即选题意图）。 */}
          <div className="topic-workspace__input-tools">
            <ModelThinkingSelector zh labeled disabled={streaming} />
          </div>
          <div className="topic-workspace__input-row">
            <textarea
              ref={composerRef}
              rows={2}
              value={input}
              placeholder={session ? '继续讨论:例如「A 和 C 哪个更好?」「我没有企业数据」「就这个。」' : '直接输入你的研究兴趣，回车即开始新的选题会话。'}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
              disabled={streaming}
              data-testid="topic-input"
            />
            {streaming ? (
              <button
                type="button"
                className="btn-danger btn-sm"
                data-testid="topic-interrupt"
                title="中断当前研究轮（已收到的内容会保留）"
                onClick={() => { if (streamingSessionId) void window.metis?.topicAbort?.({ sessionId: streamingSessionId }); }}
              >
                ■ 中断
              </button>
            ) : (
              <button type="button" className="btn-primary btn-sm" disabled={!input.trim()} onClick={() => void send()} data-testid="topic-send">{session ? '发送' : '开始选题'}</button>
            )}
          </div>
        </footer>
      </section>

      {!rightCollapsed && (
        <div
          className="topic-workspace__col-resize topic-workspace__col-resize--right"
          onMouseDown={startDrag('right')}
          data-testid="topic-resize-right"
          role="separator"
          aria-orientation="vertical"
        />
      )}
      <aside className={`topic-workspace__candidates${rightCollapsed ? ' collapsed' : ''}`} aria-label="候选选题池" style={rightCollapsed ? undefined : { width: rightWidth, flex: `0 0 ${rightWidth}px` }}>
        <header>
          <strong>候选选题({candidates.length})</strong>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setRightCollapsed((value) => !value)} aria-label={rightCollapsed ? '展开候选池' : '折叠候选池'}>
            <ChevronRight size={13} className={rightCollapsed ? undefined : 'rotated'} />
          </button>
        </header>
        {!rightCollapsed && (
          <>
            <ul className="topic-workspace__candidate-list">
              {candidates.map((candidate) => (
                <li key={candidate.id} className={candidate.id === activeCandidateId ? 'active' : undefined}>
                  <button type="button" onClick={() => setActiveCandidateId(candidate.id)} data-testid={`topic-candidate-${candidate.id}`}>
                    <strong>{candidate.title}</strong>
                    <small>{CANDIDATE_STATUS_LABELS[candidate.status] ?? candidate.status}{candidate.noveltyAnalysis ? ` · ${candidate.noveltyAnalysis.slice(0, 40)}` : ''}</small>
                  </button>
                </li>
              ))}
              {candidates.length === 0 && <li className="topic-workspace__empty">检索完成后,候选选题会出现在这里。</li>}
            </ul>
            {activeCandidate && (
              <div className="topic-workspace__candidate-detail" data-testid="topic-candidate-detail">
                <h3>{activeCandidate.title}</h3>
                {activeCandidate.researchQuestion && <p><strong>研究问题:</strong>{activeCandidate.researchQuestion}</p>}
                {activeCandidate.summary && <p>{activeCandidate.summary}</p>}
                {activeCandidate.rationale && <p><strong>选题理由:</strong>{activeCandidate.rationale}</p>}
                {activeCandidate.existingResearch && <p><strong>已有研究:</strong>{activeCandidate.existingResearch}</p>}
                {activeCandidate.researchGap && <p><strong>研究空间:</strong>{activeCandidate.researchGap}</p>}
                {activeCandidate.theoreticalAngles.length > 0 && <p><strong>理论切口:</strong>{activeCandidate.theoreticalAngles.join(';')}</p>}
                {activeCandidate.methodOptions.length > 0 && <p><strong>方法选项:</strong>{activeCandidate.methodOptions.join(';')}</p>}
                {activeCandidate.dataOptions.length > 0 && <p><strong>数据选项:</strong>{activeCandidate.dataOptions.join(';')}</p>}
                {activeCandidate.noveltyAnalysis && <p><strong>创新空间:</strong>{activeCandidate.noveltyAnalysis}</p>}
                {activeCandidate.feasibilityAnalysis && <p><strong>可行性:</strong>{activeCandidate.feasibilityAnalysis}</p>}
                {activeCandidate.risks.length > 0 && <p><strong>风险:</strong>{activeCandidate.risks.join(';')}</p>}
                <EvidenceList refs={activeCandidate.evidenceRefs} />
                <div className="topic-workspace__candidate-actions">
                  {activeCandidate.status === 'candidate' && (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'shortlisted')}>收藏</button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'rejected')}>排除</button>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void confirmSelection(activeCandidate)} data-testid="topic-confirm-candidate">确定这个选题</button>
                    </>
                  )}
                  {activeCandidate.status === 'shortlisted' && (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'candidate')}>取消收藏</button>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void confirmSelection(activeCandidate)}>确定这个选题</button>
                    </>
                  )}
                  {activeCandidate.status === 'rejected' && (
                    <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'candidate')}>恢复候选</button>
                  )}
                  {activeCandidate.status === 'selected' && <span className="topic-workspace__selected-tag">已选定</span>}
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );

  if (!chatbotOpen) return workspaceNode;

  return (
    <div className="topic-collab" data-testid="topic-collab" ref={collabWrapRef}>
      {workspaceNode}
      <SplitHandle
        label="拖动调整 Chatbot 面板宽度（40%–45%）"
        testId="chatbot-split-handle"
        onDragStart={() => { void window.metis?.collabHide?.(); }}
        onDrag={(clientX) => applySplitFromClientX(clientX)}
        onDragEnd={() => syncChatbotBounds()}
        onKeyDelta={(delta) => {
          const rect = collabWrapRef.current?.getBoundingClientRect();
          const width = rect && rect.width > 0 ? rect.width : 1;
          setChatbotSplit((ratio) => Math.min(0.45, Math.max(0.4, ratio + delta / width)));
        }}
      />
      <ChatbotCollabPanel
        zh
        buildContextPackage={buildPackage}
        projectId={session?.sourceProjectId ?? null}
        sessionId={activeSessionId}
        splitRatio={chatbotSplit}
        onSplitRatioChange={setChatbotSplit}
        onReferenceConfirmed={handleReferenceConfirmed}
        onClose={() => setChatbotOpen(false)}
      />
    </div>
  );
}
