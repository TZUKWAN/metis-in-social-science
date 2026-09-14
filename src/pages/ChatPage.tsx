import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect, type ReactNode } from 'react';
import { useMetisStore } from '../store';
import { autoResizeTextarea } from '../lib/textareaAutosize.js';
import { showToast } from '../lib/toast';
import ModelThinkingSelector from '../components/ModelThinkingSelector';

import { ConversationController } from '../conversation/runtime/ConversationController.js';
import { ingestChatStreamChunk } from '../conversation/runtime/chatStreamAdapter.js';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import {
  clearPendingChatIntent,
  consumePendingChatIntent,
  peekPendingChatIntent,
} from '../lib/chatIntent.js';
import { PaperclipIcon, TagIcon } from '../components/Icons';
import VoiceMicButton from '../components/VoiceMicButton';
import { useChatMessageQueue } from '../conversation/useChatMessageQueue';
import { useChatToolRows } from '../conversation/useChatToolRows';
import { useSlashCommands } from '../conversation/useSlashCommands';
import { createGoalRunFlow } from '../conversation/goalRunFlow';
import { useArtifactPreview } from '../conversation/artifactPreviewActions';
import {
  createChatTurnFlow,
  AGENT_EXECUTION_EVENT_LIMIT,
  DEFAULT_SCENARIO_ID,
  ACTIVE_SCENARIO_KEY,
} from '../conversation/chatTurnFlow';
import { stripEmoji } from '../conversation/chatMarkdown';
import type { GoalCardData } from '../components/GoalCardInline';
import { isInternalExecutionCopy } from '../presentation/executionCopy';
import type { AgentActivityEvent, AgentActivityStatus } from '../components/AgentActivityTimeline';
import {
  createAssistantMessageParts,
  normalizeAssistantEvent,
  reduceAssistantMessageParts,
  type AssistantMessageParts,
  type LegacyAssistantToolCall,
} from '../lib/assistantMessagePartsReducer';
import RightPanel, { type RightPanelTab } from '../components/RightPanel';
import ChatSessionSidebar from '../components/chat/ChatSessionSidebar';
import ChatMessageList from '../components/chat/ChatMessageList';
import ArtifactPreviewPane from '../components/ArtifactPreviewPane';
import { getDiagnosticMode, type UIMode } from '../../engine/capabilities/DiagnosticMode';
import {
  presentDiagnosticText,
  presentExecutionError,
} from '../presentation/executionPresentation';
import { presentSafeMarkdownText } from '../presentation/SafeMarkdown';
import { scrubPresentationProtocol } from '../presentation/presentationProtocolScrubber';
import { useFollowScroll } from '../hooks/useFollowScroll';
import { extractCitations, extractDoiCitations } from '../../engine/core/Citation.js';
import { toggleForkActive, loadForkMap, type ForkRecord } from '../../engine/core/MessageFork.js';
import {
  AgentExecutionEventSchema,
  AgentPresentationEventSchema,
  decodeHistoryPayload,
  RuntimeIdSchema,
  type AgentExecutionEvent,
  type GoalSnapshot,
} from '../../engine/runtime/ChatRuntimeContract';
import {
  decodeArtifactListPayload,
  type ArtifactListItem,
} from '../../engine/runtime/ArtifactRuntimeContract';
import {
  FILE_CAPABILITY_LIMITS,
  type FileCapabilityDescriptor,
} from '../../engine/runtime/FileCapabilityContract';
import './ChatPage.css';
import {
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionListPayload,
  decodeSessionUpdateRequest,
  type SessionListItem,
} from '../../engine/runtime/SessionRuntimeContract';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract';

// ToolCallCard 随消息渲染迁至 components/chat/ChatMessageList.tsx（2026-09-15
// 拆分）；保留本模块的具名导出，既有 `import { ToolCallCard } from
// '../pages/ChatPage'` 的测试与调用方不受影响。
export { ToolCallCard } from '../components/chat/ChatMessageList';


// ─── Types ────────────────────────────────────────────────────

type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'goal';

export interface ChatMessage {
  /** Stable render id, assigned when the message enters state (React key). */
  id?: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  /** Legacy role=tool boundary; rendered through the same canonical tool-part shape. */
  toolCall?: LegacyAssistantToolCall;
  /**
   * Public execution information returned by the existing AgentResponse
   * contract. It is deliberately separate from final answer content so an
   * assistant message can present a compact execution timeline first.
   */
  run?: {
    status: AgentActivityStatus;
    events: AgentActivityEvent[];
    parts?: AssistantMessageParts;
    turnId?: string;
    historyIncomplete?: boolean;
  };
  goalCard?: GoalCardData;
  /** True while model tokens are still streaming into this message. */
  streaming?: boolean;
  /** Wall-clock start of the generating turn (for the elapsed timer). */
  startedAt?: number;
  /** Total generation time once the turn settles. */
  durationMs?: number;
  /** Reasoning/thinking tokens streamed by the model, if any. */
  reasoning?: string;
  /**
   * O8: citations for the answer. Each entry links a piece of the answer to a
   * concrete source (library paper / DOI / URL) so the user can trace the claim.
   */
  citations?: import('../../engine/core/Citation.js').Citation[];
  /**
   * O16: message branch/fork. When a user regenerates an answer, the previous
   * answer is kept as an inactive sibling branch rather than deleted, letting
   * the user flip between alternative takes. forkId groups siblings; activeFork
   * marks which sibling is currently displayed.
   */
  forkId?: string;
  /** Zero-based index of this sibling within its fork group. */
  forkIndex?: number;
  /** Total siblings in the fork group (including this one). */
  forkCount?: number;
  /** True when this sibling is the currently displayed one in its group. */
  forkActive?: boolean;
  /**
   * O15: 多模型对比标记——该回答来自哪个 provider profile（展示用标签，
   * 如 "Kimi · kimi-k2"）。仅对比模式下由渲染端打上；普通回答不带此字段。
   */
  modelLabel?: string;
  /**
   * O15: 对比轮次分组 id。同一轮多模型对比的各模型回答共享它，渲染时
   * 并排展示。仅对比模式打上。
   */
  compareGroup?: string;
  /**
   * UX-CHAT-002: 回合失败/中断/取消时留下的未完成草稿标记。流式占位消息在
   * 非成功结算时保留部分内容并打上此标记；空内容则直接删除。
   */
  incomplete?: boolean;
}



function toGoalCardData(goal: GoalSnapshot): GoalCardData | null {
  if (goal.phase === 'unknown') return null;
  const stepStatuses: GoalCardData['stepStatuses'] = {};
  for (const [stepId, status] of Object.entries(goal.stepStatuses)) {
    if (status.status === 'unknown') return null;
    stepStatuses[stepId] = {
      stepId: status.stepId,
      stepName: status.stepName,
      status: status.status,
      output: status.output,
    };
  }
  return {
    ...goal,
    phase: goal.phase,
    stepStatuses,
  };
}

/**
 * Map a persisted goal status (source of truth on the engine side) to the
 * inline card phase. Used when a goal card is opened from the board or when
 * a board move broadcasts goal:changed.
 */
function goalStatusToCardPhase(status: string): GoalCardData['phase'] {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'running': return 'executing';
    case 'paused': return 'paused';
    default: return 'plan_ready';
  }
}

function reduceExecutionEnvelope(
  state: AssistantMessageParts,
  payload: AgentExecutionEvent,
  replayed = false,
): AssistantMessageParts {
  const event = {
    ...payload.event,
    eventId: payload.eventId,
    sequence: payload.sequence,
  } as AgentActivityEvent;
  return reduceAssistantMessageParts(state, normalizeAssistantEvent(event, replayed));
}

function partsFromExecutionEnvelopes(
  envelopes: readonly AgentExecutionEvent[],
  replayed = false,
): AssistantMessageParts {
  return envelopes.reduce(
    (state, payload) => reduceExecutionEnvelope(state, payload, replayed),
    createAssistantMessageParts(),
  );
}

function isAgentRunStatus(value: unknown): value is AgentActivityStatus {
  return value === 'completed'
    || value === 'interrupted'
    || value === 'cancelled'
    || value === 'error'
    || value === 'context_exhausted'
    || value === 'max_turns_reached'
    || value === 'unknown'
    || value === 'running';
}

type Session = SessionListItem;

function chatPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type ArtifactItemType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'md' | 'latex' | 'other';
type RightPanelTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

function toRightPanelTaskStatus(status: string): RightPanelTaskStatus {
  return status === 'running' || status === 'completed' || status === 'failed'
    ? status
    : 'pending';
}

interface ArtifactItem {
  id: string;
  name: string;
  type: ArtifactItemType;
  sourceCapability?: FileCapabilityDescriptor;
  size?: string;
  createdAt: number;
  contentAvailable: boolean;
}
const validArtifactTypes: ArtifactItemType[] = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'latex', 'other'];
const SCENARIO_CATALOG_MAX_ATTEMPTS = 2;
const SCENARIO_CATALOG_RETRY_DELAY_MS = 150;
const AGENT_EXECUTION_TURN_BUFFER_LIMIT = 64;

// ─── Timestamp helper (avoids Date.now() in render) ───────────

function now(): number {
  return Date.now();
}

// ─── Goal feedback heuristic ──────────────────────────────────

function isLikelyGoalFeedback(content: string): boolean {
  const patterns = [
    /\b(change|modify|update|fix|adjust|instead|rather|redo|add|remove|include|exclude|also)\b/i,
    /(修改|更改|调整|换成|不要|重做|再试|加上|去掉|还有|换成)/,
  ];
  return patterns.some(p => p.test(content));
}

// ─── Message Component（迁出至 components/chat/ChatMessageList.tsx，2026-09-15 拆分）───

// ─── Main Chat Page ───────────────────────────────────────────

export interface ChatPageLayoutSlots {
  leftPanel: ReactNode;
  workspace: ReactNode;
  rightPanel: ReactNode;
  /** 生成物预览栏（2026-08-31 布局重构）：projects 模式渲染为最右整列。 */
  previewPanel?: ReactNode;
}

export interface ChatPageProps {
  renderLayout: (slots: ChatPageLayoutSlots) => ReactNode;
  uiMode?: UIMode;
  /** pane：预览走独立预览栏（projects 模式）；inline：右栏内联小卡片（其余模式）。 */
  previewMode?: 'pane' | 'inline';
  intentRevision?: number;
}

export default function ChatPage({ renderLayout, uiMode, intentRevision = 0, previewMode = 'inline' }: ChatPageProps) {
  const { t, locale } = useTranslation();
  const resolvedUIMode = uiMode ?? getDiagnosticMode();

  // Message citation → open the paper inside Metis: local library match first,
  // otherwise open the DOI page in the research browser.
  const openPaperByDoi = useCallback((doi: string) => {
    const normalized = doi.replace(/^https?:\/\/doi\.org\//i, '');
    const local = useMetisStore.getState().papers.find(
      (paper) => paper.doi && paper.doi.toLowerCase() === normalized.toLowerCase(),
    );
    if (local) {
      window.dispatchEvent(new CustomEvent('metis:open-paper', { detail: { paperId: local.id } }));
      return;
    }
    window.dispatchEvent(new CustomEvent('metis:open-browser-url', { detail: { url: `https://doi.org/${normalized}` } }));
  }, []);
  const diagnosticMode = resolvedUIMode === 'diagnostic';
  const [sessions, setSessions] = useState<Session[]>([]);
  // UX-CHAT-003: 低置信度任务表达被直接回答时，提供非阻塞「转为研究任务」建议。
  const [goalSuggestion, setGoalSuggestion] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const messageIdRef = useRef(0);
  const nextMessageId = useCallback(() => {
    messageIdRef.current += 1;
    return `msg-${messageIdRef.current}`;
  }, []);
  // Central id assignment: every message that enters state gets a stable
  // render id so the list can key by identity instead of array index.
  const setMessages: typeof setMessagesState = useCallback((update) => {
    setMessagesState((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      let assigned = false;
      const withIds = next.map((msg) => {
        if (msg.id) return msg;
        assigned = true;
        messageIdRef.current += 1;
        return { ...msg, id: `msg-${messageIdRef.current}` };
      });
      return assigned ? withIds : next;
    });
  }, []);
  const [input, setInput] = useState('');
  // T3 二期：Step 卡 Target Context（提出意见/修改这步）
  const [stepTarget, setStepTarget] = useState<Extract<import('../conversation/types').ConversationTarget, { type: 'scenario_step' }> | null>(null);
  const [stepTargetMode, setStepTargetMode] = useState<'comment' | 'modify'>('comment');
  const openStepCardComment = useCallback((card: import('../components/ScenarioStepCard').ScenarioStepCardData, mode: 'comment' | 'modify') => {
    setStepTarget({ type: 'scenario_step', runId: card.runId, stepId: card.stepId, revision: card.iteration, title: card.stepName });
    setStepTargetMode(mode);
  }, []);
  const handleStepCardComment = useMemo(() => openStepCardComment, [openStepCardComment]);
  const [isLoading, setIsLoading] = useState(false);
  // Live control state: 'idle' until the user requests an interrupt, 'interrupting'
  // while the active run is draining, back to 'idle' when the run settles.
  // METIS-F11：打断请求已受理、等待 run 结算的过渡态（按钮防重复+如实反馈）。
  const [controlState, setControlState] = useState<'idle' | 'interrupting'>('idle');
  const [historyReady, setHistoryReady] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);

  const normalizeArtifact = useCallback((a: ArtifactListItem): ArtifactItem => {
    return {
      id: a.id,
      name: a.name,
      type: validArtifactTypes.includes(a.type as ArtifactItem['type']) ? (a.type as ArtifactItem['type']) : 'other',
      size: a.size,
      sourceCapability: a.sourceCapability,
      createdAt: a.createdAt,
      contentAvailable: a.contentAvailable,
    };
  }, []);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  const historyReadyRef = useRef(false);
  // dsh-style scroll ledger: programmatic pins are instant and recorded; any
  // scroll position deviating from the ledger is attributed to the user.
  const {
    atBottom: isFollowingLatest,
    atBottomRef: isFollowingLatestRef,
    pinToBottom: pinChatToBottom,
    engageFollow,
  } = useFollowScroll({ containerRef: chatMessagesRef, trackingReadyRef: historyReadyRef });
  // P0 2026-09-05：对话流式 V2 运行时——累积权威、attempt 身份、3 帧合并发布、
  // immediate 权威结算全部由 ConversationController 承担（见 conversation/runtime/）。
  const chatStreamControllerRef = useRef<ConversationController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 输入框随内容自动增高，最多约 10 行，超出后内部滚动查看。
  useEffect(() => {
    if (inputRef.current) autoResizeTextarea(inputRef.current);
  }, [input]);
  // 斜杠命令建议状态机（迁出自 ChatPage，2026-09-13 拆分）：
  // 建议过滤/键盘导航/补全集中在 useSlashCommands。
  const {
    slashSuggestions,
    slashMenuOpen,
    activeSlashIndex,
    setSlashActiveIndex,
    completeSlashCommand,
    handleSlashKeyDown,
    resetSlashTracking,
  } = useSlashCommands({ input, setInput, inputRef });
  useEffect(() => {
    historyReadyRef.current = historyReady;
  }, [historyReady]);
  const activeSessionIdRef = useRef('');

  // 2.5 消息队列（迁出自 ChatPage）：状态与 FIFO 补发逻辑集中管理。
  const queue = useChatMessageQueue({ send: (text, opts) => handleSend(text, undefined, opts) });
  const { queuedMessages } = queue;
  // 2.4 工具行（迁出自 ChatPage）：订阅 + run 结算收起。
  const { liveToolRows, clearToolRows } = useChatToolRows(activeSessionIdRef, isLoading);
  const sessionGenerationRef = useRef(0);
  // P0（2026-09-12）：历史局部损坏的一次性 toast 防重——记录上次提示过的会话，
  // 避免 StrictMode 双跑 effect 或来回切换会话时重复弹「部分历史加载失败」。
  const partialRecoveryToastRef = useRef<string | null>(null);
  const activeChatRequestRef = useRef<{
    token: symbol;
    turnId: string;
    sessionId: string;
    generation: number;
    projectId: string;
    startedAt: number;
  } | null>(null);
  /** Index of the assistant message currently receiving streamed tokens. */
  const streamingIndexRef = useRef(-1);
  /** Live and replayed public Agent events are scoped by a renderer-provided turn ID. */
  const agentExecutionPartsBufferRef = useRef<Map<string, AssistantMessageParts>>(new Map());
  const agentExecutionEventIdentityRef = useRef<Map<string, { eventIds: Set<string>; sequences: Set<number>; contiguousSequence: number }>>(new Map());
  const agentExecutionReplayInFlightRef = useRef<Set<string>>(new Set());
  const activeRunPartsRef = useRef<AssistantMessageParts>(createAssistantMessageParts());
  const [activeRunParts, setActiveRunParts] = useState<AssistantMessageParts>(createAssistantMessageParts);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Skills
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; category: string }>>([]);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [scenarioLoadState, setScenarioLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [scenarioLoadRevision, setScenarioLoadRevision] = useState(0);
  // 目录重试计数跨 effect 重跑保持(多对话架构 2026-09-05)。
  const catalogAttemptRef = useRef(0);
  const revisionTokenRef = useRef(-1);
  const catalogLastOutcomeRef = useRef<'loading' | 'failed' | 'ready' | null>(null);
  const [activeScenarioId, setActiveScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const activeResearchProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const workspaceProjectsLoading = useResearchWorkspaceStore((state) => state.loading.projects);
  const currentProjectId = activeResearchProjectId ?? 'global';
  const [projectScenarioRun, setProjectScenarioRun] = useState<{
    status: string;
    steps: Array<{ stepId: string; name: string; status: string; prompt?: string }>;
  } | null>(null);

  // Goal integration
  const [activeGoalId, setActiveGoalId] = useState<string | null>(null);
  const activeGoalIdRef = useRef<string | null>(null);
  const goalCardIndexMapRef = useRef<Map<string, number>>(new Map());
  const goalStepElementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const sendInFlightRef = useRef(false);
  const goalEventSequenceRef = useRef<Map<string, number>>(new Map());

  const [dragOver, setDragOver] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // 预览内容/标题/来源生成物状态由 useArtifactPreview 管理（2026-09-13 拆分）。
  const [artifactError, setArtifactError] = useState('');
  const [activeRightPanelTab, setActiveRightPanelTab] =
    useState<RightPanelTab>('tasks');
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);


  useEffect(() => {
    let alive = true;
    if (!activeResearchProjectId || !window.metis?.getScenarioRunForProject) {
      setProjectScenarioRun(null);
      return () => { alive = false; };
    }
    const loadRun = async () => {
      const result = await window.metis?.getScenarioRunForProject?.(activeResearchProjectId);
      if (!alive) return;
      setProjectScenarioRun(result?.ok && result.status && result.steps?.length
        ? { status: result.status, steps: result.steps }
        : null);
    };
    void loadRun();
    const interval = window.setInterval(() => { void loadRun(); }, 2_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [activeResearchProjectId]);

  const hasActiveScenarioRun = projectScenarioRun?.status === 'running';

  // 会话代际校验与生成物列表刷新上移到预览 hook 之前（预览 hook 的图表重做
  // 回调依赖刷新回调；2026-09-13 拆分时的定义顺序调整，行为不变）。
  const isCurrentSessionGeneration = useCallback((
    sessionId: string,
    generation: number,
  ) => (
    activeSessionIdRef.current === sessionId
    && sessionGenerationRef.current === generation
  ), []);

  const refreshArtifactsForSession = useCallback(async (
    sessionId: string,
    generation: number,
  ) => {
    const listArtifacts = window.metis?.listArtifacts;
    if (!listArtifacts) return;
    try {
      const decoded = decodeArtifactListPayload(await listArtifacts(sessionId));
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      if (decoded.success) {
        setArtifacts(decoded.items.map(normalizeArtifact));
        setArtifactError('');
      } else {
        setArtifactError(locale === 'zh' ? '暂时无法加载本会话的生成物，请稍后重试。' : 'Artifacts could not be loaded. Please try again.');
      }
    } catch {
      if (isCurrentSessionGeneration(sessionId, generation)) {
        setArtifactError(locale === 'zh' ? '暂时无法加载本会话的生成物，请稍后重试。' : 'Artifacts could not be loaded. Please try again.');
      }
    }
  }, [isCurrentSessionGeneration, locale, normalizeArtifact]);

  // 生成物预览动作（迁出自 ChatPage，2026-09-13 拆分）：预览状态、
  // openPreview、handleArtifactClick 与预览栏图表重做/导出接线集中在
  // conversation/artifactPreviewActions.ts。
  const {
    previewContent,
    previewTitle,
    openPreview,
    handleArtifactClick,
    resetPreview,
    closePreview,
    onChartAdjust,
    onExportDocx,
  } = useArtifactPreview({
    locale,
    activeSessionIdRef,
    sessionGenerationRef,
    activeResearchProjectId,
    isCurrentSessionGeneration,
    refreshArtifactsForSession,
    setArtifactError,
    setActiveRightPanelTab,
  });

  const acceptGoalEvent = useCallback((goalId: string, sequence: number) => {
    if (activeGoalIdRef.current !== goalId) return false;
    const previous = goalEventSequenceRef.current.get(goalId) ?? -1;
    if (sequence <= previous) return false;
    goalEventSequenceRef.current.set(goalId, sequence);
    return true;
  }, []);

  const updateGoalCard = useCallback((
    index: number,
    updater: (card: GoalCardData) => GoalCardData,
  ) => {
    setMessages((prev) => prev.map((msg, i) => {
      if (i === index && msg.goalCard) {
        return { ...msg, goalCard: updater(msg.goalCard) };
      }
      return msg;
    }));
  }, []);

  /**
   * Resolve the message index of a goal card. Cards restored from session
   * history never re-enter goalCardIndexMapRef (only goals launched in this
   * app session register there), so fall back to scanning the live message
   * list; otherwise 重试/继续/暂停/取消 on a restored card would silently
   * no-op after a restart.
   */
  const findGoalCardIndex = useCallback((goalId: string): number | undefined => {
    const mapped = goalCardIndexMapRef.current.get(goalId);
    if (mapped !== undefined) return mapped;
    const index = messagesRef.current.findIndex((msg) => msg.goalCard?.goalId === goalId);
    return index >= 0 ? index : undefined;
  }, []);

  /**
   * Hydrate the chat card from the persisted Goal/Workflow view. Live IPC
   * events still own subsequent state transitions; this call only prevents a
   * board-to-chat handoff from degrading real step names into button labels.
   */
  const syncGoalCardWorkflow = useCallback(async (goalId: string, index: number) => {
    const ownerSessionId = currentSessionId;
    const ownerGeneration = sessionGenerationRef.current;
    const result = await window.metis?.getGoalWorkflow?.(goalId);
    if (!result?.success) return;
    // The workflow read may finish after the user has opened another session.
    // Indexes are only meaningful for the session/generation that started it.
    if (activeSessionIdRef.current !== ownerSessionId
      || sessionGenerationRef.current !== ownerGeneration) return;
    // Restored cards are not in the index map; only reject when a *different*
    // index is registered, and verify unregistered cards against the message
    // list so history cards still receive workflow hydration.
    const registeredIndex = goalCardIndexMapRef.current.get(goalId);
    if (registeredIndex !== undefined && registeredIndex !== index) return;
    if (registeredIndex === undefined && messagesRef.current[index]?.goalCard?.goalId !== goalId) return;
    const steps = result.workflow.steps.map((step) => ({
      id: step.id,
      name: step.name,
      description: step.description,
    }));
    const stepStatuses: GoalCardData['stepStatuses'] = Object.fromEntries(steps.map((step) => {
      const resultForStep = result.stepResults[step.id];
      return [step.id, {
        stepId: step.id,
        stepName: step.name,
        status: resultForStep?.status ?? 'pending',
        output: resultForStep?.output ?? '',
      }];
    }));
    updateGoalCard(index, (card) => {
      if (card.goalId !== goalId) return card;
      return {
        ...card,
        planName: result.workflow.name,
        planDescription: result.workflow.description,
        steps,
        stepStatuses,
        progress: {
          completed: Object.values(stepStatuses).filter((step) => step.status === 'completed').length,
          total: steps.length,
          currentStep: Object.values(stepStatuses).find((step) => step.status === 'running')?.stepId ?? card.progress.currentStep,
        },
      };
    });
  }, [currentSessionId, updateGoalCard]);

  // Goal 卡步骤元素登记（消息列表迁出后由宿主以稳定回调提供；读写都在
  // 事件回调里发生，与迁出前 registerStepElement 内联闭包语义一致）。
  const registerGoalStepElement = useCallback((goalId: string, stepId: string, element: HTMLElement | null) => {
    const key = `${goalId}\u0000${stepId}`;
    if (element) goalStepElementRefs.current.set(key, element);
    else goalStepElementRefs.current.delete(key);
  }, []);

  // 焦点回输入框（Goal 卡调整动作预填草稿后调用；与迁出前的内联闭包等价）。
  const focusComposer = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const activateSession = useCallback((sessionId: string) => {
    sessionGenerationRef.current += 1;
    activeSessionIdRef.current = sessionId;
    activeChatRequestRef.current = null;
    streamingIndexRef.current = -1;
    agentExecutionPartsBufferRef.current.clear();
    agentExecutionEventIdentityRef.current.clear();
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    setGoalSuggestion(null);
    setCurrentSessionId(sessionId);
    setMessages([]);
    setHistoryReady(false);
    setArtifacts([]);
    resetPreview();
    setIsLoading(false);
    setActiveGoalId(null);
    activeGoalIdRef.current = null;
    goalEventSequenceRef.current.clear();
    goalCardIndexMapRef.current.clear();
    clearToolRows();
  }, [resetPreview]);

  // 项目联动视图：有当前科研项目时，会话列表只显示该项目的会话与未关联的
  // 旧会话；其他项目的会话不混入（协同对话与项目聊天即「当前项目的对话」）。
  const projectScopedSessions = useMemo(() => {
    if (!activeResearchProjectId) return sessions;
    return sessions.filter((session) => !session.projectId || session.projectId === activeResearchProjectId);
  }, [sessions, activeResearchProjectId]);

  // 切换科研项目时：若当前会话属于其他项目，自动切到当前项目的最近会话；
  // 当前项目还没有会话时回到空白态（首次发送会自动建会话并绑定项目）。
  // 空会话同样走 activateSession 的受保护过渡（布局所有权不变量）。
  useEffect(() => {
    if (!activeResearchProjectId || !currentSessionId) return;
    const current = sessions.find((session) => session.id === currentSessionId);
    if (current && (!current.projectId || current.projectId === activeResearchProjectId)) return;
    const firstInProject = sessions.find((session) => session.projectId === activeResearchProjectId);
    activateSession(firstInProject?.id ?? '');
  }, [activeResearchProjectId, sessions, currentSessionId, activateSession]);

  const isCurrentChatRequest = useCallback((request: {
    token: symbol;
    turnId: string;
    sessionId: string;
    generation: number;
    projectId: string;
  }) => (
    activeChatRequestRef.current?.token === request.token
    && isCurrentSessionGeneration(request.sessionId, request.generation)
    && (researchWorkspaceStore.getState().activeProjectId ?? 'global') === request.projectId
  ), [isCurrentSessionGeneration]);

  const partsForAgentTurn = useCallback((turnId: string): AssistantMessageParts => (
    agentExecutionPartsBufferRef.current.get(turnId) ?? createAssistantMessageParts()
  ), []);

  const hydrateAgentRunHistory = useCallback(async (
    sessionId: string,
    runId: string,
    generation: number,
    status: AgentActivityStatus,
    initialHistoryIncomplete = false,
  ): Promise<ChatMessage['run'] | undefined> => {
    const metis = window.metis;
    if (!metis?.replayAgentEvents) {
      return {
        status,
        events: [],
        parts: createAssistantMessageParts(),
        turnId: runId,
        ...(initialHistoryIncomplete ? { historyIncomplete: true } : {}),
      };
    }
    const replay = await metis.replayAgentEvents({
      version: 1,
      sessionId,
      runId,
      afterSequence: -1,
      limit: 256,
    });
    if (!isCurrentSessionGeneration(sessionId, generation) || !replay) {
      return {
        status,
        events: [],
        parts: createAssistantMessageParts(),
        turnId: runId,
        ...(initialHistoryIncomplete ? { historyIncomplete: true } : {}),
      };
    }
    const envelopes = replay.events
      .filter((event) => event.sessionId === sessionId && event.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
    const parts = partsFromExecutionEnvelopes(envelopes, true);
    return {
      status,
      turnId: runId,
      events: parts.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT),
      parts,
      ...((initialHistoryIncomplete || replay.retentionGap) ? { historyIncomplete: true } : {}),
    };
  }, [isCurrentSessionGeneration]);

  const applyAgentExecutionEnvelope = useCallback((payload: AgentExecutionEvent, replayed = false) => {
    const turnId = payload.turnId;
    const identity = agentExecutionEventIdentityRef.current.get(turnId) ?? {
      eventIds: new Set<string>(),
      sequences: new Set<number>(),
      contiguousSequence: -1,
    };
    if (identity.eventIds.has(payload.eventId) || identity.sequences.has(payload.sequence)) {
      return { accepted: false, contiguousSequence: identity.contiguousSequence, gap: false };
    }
    identity.eventIds.add(payload.eventId);
    identity.sequences.add(payload.sequence);
    while (identity.sequences.has(identity.contiguousSequence + 1)) identity.contiguousSequence += 1;
    agentExecutionEventIdentityRef.current.set(turnId, identity);

    const current = agentExecutionPartsBufferRef.current.get(turnId) ?? createAssistantMessageParts();
    const parts = reduceExecutionEnvelope(current, payload, replayed);
    if (!agentExecutionPartsBufferRef.current.has(turnId)
      && agentExecutionPartsBufferRef.current.size >= AGENT_EXECUTION_TURN_BUFFER_LIMIT) {
      const oldestTurnId = agentExecutionPartsBufferRef.current.keys().next().value;
      if (oldestTurnId) {
        agentExecutionPartsBufferRef.current.delete(oldestTurnId);
        agentExecutionEventIdentityRef.current.delete(oldestTurnId);
      }
    }
    agentExecutionPartsBufferRef.current.set(turnId, parts);

    const request = activeChatRequestRef.current;
    if (request && request.turnId === turnId && isCurrentChatRequest(request)) {
      activeRunPartsRef.current = parts;
      setActiveRunParts(parts);
      setMessages((previous) => previous.map((message) => (
        message.run?.turnId === turnId
          ? { ...message, run: { ...message.run, parts, events: parts.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT) } }
          : message
      )));
    }
    return {
      accepted: true,
      contiguousSequence: identity.contiguousSequence,
      gap: Array.from(identity.sequences).some((sequence) => sequence > identity.contiguousSequence),
    };
  }, [isCurrentChatRequest]);

  // UX-CHAT-002: 失败/中断/取消时结算当前流式占位消息。空内容 → 删除空气泡；
  // 已有部分内容 → 停止流式并标记为「未完成草稿」，避免空气泡与错误气泡并存。
  const settleStreamingPlaceholder = useCallback((
    request: { startedAt: number },
    completedRun?: ChatMessage['run'],
  ) => {
    const streamedIndex = streamingIndexRef.current;
    if (streamedIndex < 0) return false;
    const durationMs = Date.now() - request.startedAt;
    streamingIndexRef.current = -1;
    setMessages((prev) => {
      const target = prev[streamedIndex];
      if (!target) return prev;
      if (!target.content.trim() && !target.reasoning) {
        return prev.filter((_, index) => index !== streamedIndex);
      }
      return prev.map((message, index) => (index === streamedIndex
        ? { ...message, streaming: false, durationMs, incomplete: true, ...(completedRun ? { run: completedRun } : {}) }
        : message));
    });
    return true;
  }, []);

  // UX-CHAT-004: 回合结算后从持久层刷新会话摘要（消息数与最后活动时间），
  // 让侧栏计数与权威值一致，而不是停留在挂载时的旧快照。
  const refreshSessionSummaries = useCallback(() => {
    const metis = window.metis;
    if (!metis?.listSessions) return;
    void metis.listSessions().then((payload) => {
      const decoded = decodeSessionListPayload(payload);
      if (decoded.success) setSessions(decoded.sessions);
    }).catch(() => { /* 摘要刷新是尽力而为，不影响回合结果 */ });
  }, []);

  // A project change invalidates the renderer-side owner of any in-flight
  // response. The main-process request keeps its original project snapshot,
  // while this view becomes ready for a new project-scoped request.
  useEffect(() => {
    activeChatRequestRef.current = null;
    streamingIndexRef.current = -1;
    agentExecutionPartsBufferRef.current.clear();
    agentExecutionEventIdentityRef.current.clear();
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    setIsLoading(false);
  }, [currentProjectId]);

  // P0-2: "Ask Metis about this selection" — detect text selection in the messages area.
  useEffect(() => {
    const handler = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (text.length < 3) { setSelectionMenu(null); return; }
      // Only trigger within the messages container.
      const range = sel?.getRangeAt(0);
      const container = range?.startContainer.parentElement?.closest('.chat-messages, .artifact-preview-body');
      if (!container) { setSelectionMenu(null); return; }
      const rect = range?.getBoundingClientRect();
      if (rect) {
        const horizontalMargin = 104;
        const verticalMargin = 40;
        const x = Math.min(
          Math.max(rect.left + rect.width / 2, horizontalMargin),
          Math.max(horizontalMargin, window.innerWidth - horizontalMargin),
        );
        const y = Math.min(
          Math.max(rect.top - 10, verticalMargin),
          Math.max(verticalMargin, window.innerHeight - verticalMargin),
        );
        setSelectionMenu({ text, x, y });
      }
    };
    const closeMenu = () => setSelectionMenu(null);
    document.addEventListener('mouseup', handler);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('mouseup', handler);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, []);

  // Load skills on mount
  useEffect(() => {
    if (!diagnosticMode) return;
    const metis = window.metis;
    if (metis?.listSkills) {
      metis.listSkills().then((s) => {
        setSkills(s.map((sk: { id: string; name: string; description: string; category: string }) => ({ id: sk.id, name: sk.name, description: sk.description, category: sk.category })));
      }).catch(() => {});
    }
    if (metis?.getActiveSkill) {
      metis.getActiveSkill().then((r) => {
        if (r.active) setActiveSkillId(r.active);
      }).catch(() => {});
    }
  }, [diagnosticMode]);

  // Load executable scenarios for every UI mode. The selected scenario is
  // revalidated by preload and main; localStorage only remembers the user's
  // preference and is never an authority boundary.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const metis = window.metis;
    // 多对话架构(2026-09-05):同一 revision 下重试已耗尽的 failed 态跨 effect
    // 重跑保持(会话切换重解析不再把失败态冲回 loading,交接提示不闪失)。
    if (revisionTokenRef.current === scenarioLoadRevision && catalogLastOutcomeRef.current === 'failed') {
      setScenarios([]);
      setScenarioLoadState('failed');
      return () => { cancelled = true; };
    }
    setScenarioLoadState('loading');
    if (!metis?.listPersonalization) {
      setScenarios([]);
      setScenarioLoadState('failed');
      return () => { cancelled = true; };
    }
    const loadCatalog = (attempt: number) => {
      void metis.listPersonalization({ contractVersion: 1, kind: 'scenario', includeDisabled: false })
        .then(async (response) => {
          if (cancelled) return;
          const available = response.definitions.filter((definition): definition is ScenarioDefinition => (
            definition.kind === 'scenario'
            && definition.enabled
            && definition.capability !== 'presentation_reserved'
            && definition.provenance.origin !== 'builtin'
          ));
          setScenarios(available);
          // 项目级场景优先（2026-08-29 刘总要求：新建项目可选择场景）：
          // 先读 metis:project-scenario:<projectId>，缺失时退回全局偏好。
          let remembered = DEFAULT_SCENARIO_ID;
          try {
            // 多对话架构(2026-09-04 刘总要求):解析优先级
            // 当前会话的 scenarioId(正式持久化) > 项目默认场景(Project.defaultScenarioId)
            // > legacy localStorage(首次读取即迁移进正式层) > 无场景。
            const currentSession = currentSessionId
              ? projectScopedSessions.find((item) => item.id === currentSessionId) ?? sessions.find((item) => item.id === currentSessionId)
              : undefined;
            if (currentSession?.scenarioId && available.some((scenario) => scenario.id === currentSession.scenarioId)) {
              remembered = currentSession.scenarioId;
            } else if (activeResearchProjectId) {
              let projectDefault: string | null = null;
              try {
                const response = await window.metis?.getDefaultScenario?.(activeResearchProjectId);
                projectDefault = response?.scenarioId ?? null;
              } catch { projectDefault = null; }
              const legacyProject = window.localStorage.getItem(`metis:project-scenario:${activeResearchProjectId}`);
              const legacyValue = projectDefault ?? legacyProject;
              if (legacyValue && available.some((scenario) => scenario.id === legacyValue)) {
                remembered = legacyValue;
                // legacy 迁移:写入正式层后清理旧键(此后以正式持久化为唯一真源)。
                void window.metis?.setDefaultScenario?.(activeResearchProjectId, legacyValue);
                window.localStorage.removeItem(`metis:project-scenario:${activeResearchProjectId}`);
              }
            } else {
              remembered = window.localStorage.getItem(ACTIVE_SCENARIO_KEY) ?? DEFAULT_SCENARIO_ID;
            }
          } catch { /* use factory default */ }
          setActiveScenarioId(remembered === DEFAULT_SCENARIO_ID
            ? DEFAULT_SCENARIO_ID
            : (available.some((scenario) => scenario.id === remembered)
                ? remembered
                : DEFAULT_SCENARIO_ID));
          catalogAttemptRef.current = 0;
          catalogLastOutcomeRef.current = 'ready';
          setScenarioLoadState('ready');
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < SCENARIO_CATALOG_MAX_ATTEMPTS) {
            retryTimer = window.setTimeout(
              () => { catalogAttemptRef.current = attempt; loadCatalog(attempt + 1); },
              SCENARIO_CATALOG_RETRY_DELAY_MS,
            );
            return;
          }
          catalogAttemptRef.current = attempt;
          catalogLastOutcomeRef.current = 'failed';
          setScenarios([]);
          setScenarioLoadState('failed');
        });
    };
    // 多对话架构(2026-09-05):effect 因会话切换重跑时,重试计数跨重跑保持,
    // 避免会话就绪把有限重试变成无限重试;手动「重新加载场景」按钮负责清零。
    if (revisionTokenRef.current !== scenarioLoadRevision) {
      catalogAttemptRef.current = 0;
      revisionTokenRef.current = scenarioLoadRevision;
    }
    // 重试上限已达时,effect 重跑(会话切换)不再自动调用,保持失败态等待手动重试。
    if (catalogAttemptRef.current >= SCENARIO_CATALOG_MAX_ATTEMPTS) {
      setScenarios([]);
      setScenarioLoadState('failed');
      return () => { cancelled = true; };
    }
    loadCatalog(catalogAttemptRef.current + 1);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  // currentSessionId 入依赖:切换对话时按该会话正式绑定的 scenarioId 恢复场景选择(2026-09-04 多对话架构)。
  }, [scenarioLoadRevision, activeResearchProjectId, currentSessionId, sessions]);

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
  }, []);

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


  function inferArtifactType(name: string): typeof artifacts[number]['type'] {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf') return 'pdf';
    if (['doc', 'docx'].includes(ext)) return 'docx';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'xlsx';
    if (['ppt', 'pptx'].includes(ext)) return 'pptx';
    if (['md', 'markdown'].includes(ext)) return 'md';
    if (['tex', 'latex'].includes(ext)) return 'latex';
    return 'other';
  }

  async function handleFileUpload() {
    const sessionId = activeSessionIdRef.current;
    const generation = sessionGenerationRef.current;
    if (!sessionId) return;
    try {
      const picked = await window.metis?.selectFileCapability('artifact-attachment');
      if (!picked?.success) return;
      const fileName = picked.capability.displayName;
      // Compatibility for the legacy diagnostic copy below: this is an opaque
      // capability identifier, never a local filesystem path.
      const filePath = picked.capability.capabilityId;

      const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const artifactType = inferArtifactType(fileName);
      if (window.metis?.createArtifact) {
        const result = await window.metis.createArtifact({
          id: artifactId,
          sessionId,
          name: fileName,
          type: artifactType,
          sourceCapabilityId: picked.capability.capabilityId,
          size: '',
        });
        if (!result.success) return;
      } else {
        return;
      }
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      setArtifacts((prev) => [{
        id: artifactId,
        name: fileName,
        type: artifactType,
        sourceCapability: picked.capability,
        size: '',
        createdAt: Date.now(),
        contentAvailable: false,
      }, ...prev.filter((item) => item.id !== artifactId)]);

      setMessages((prev) => [...prev, {
        role: 'system',
        content: diagnosticMode
          ? `[附件] **${fileName}** 已导入。\n路径: \`${filePath}\`\n你现在可以让 Metis 处理该文件。`
          : t('chat.attachmentImported', { name: fileName }),
        timestamp: now(),
      }]);
    } catch (err: unknown) {
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      setMessages((prev) => [...prev, {
        role: 'system',
        content: t('chat.importFailed', {
          message: presentExecutionError(err, locale, resolvedUIMode),
        }),
        timestamp: now(),
      }]);
    }
  }

  // Load sessions on mount
  useEffect(() => {
    const metis = window.metis;
    if (metis?.listSessions) {
      metis.listSessions().then((payload) => {
        const decoded = decodeSessionListPayload(payload);
        if (!decoded.success) {
          setSessions([]);
          return;
        }
        const normalized = decoded.sessions;
        setSessions(normalized);
        if (normalized.length > 0 && normalized[0]) {
          activateSession(normalized[0].id);
        }
      }).catch(() => {});
    }
  }, [activateSession]);

  // Listen for artifact creation events from other processes and refresh the list
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onArtifactCreated) return;
    const unsub = metis.onArtifactCreated(({ sessionId }) => {
      const generation = sessionGenerationRef.current;
      if (sessionId === activeSessionIdRef.current) {
        void refreshArtifactsForSession(sessionId, generation);
      }
    });
    return () => { unsub(); };
  }, [refreshArtifactsForSession]);


  // Load messages and artifacts when session changes
  useEffect(() => {
    if (!currentSessionId) return;
    const sessionId = currentSessionId;
    const generation = sessionGenerationRef.current;
    const metis = window.metis;
    if (metis?.getMessages) {
      metis.getMessages(sessionId).then(async (msgs) => {
        if (!isCurrentSessionGeneration(sessionId, generation)) return;
        // O16: rehydrate fork siblings from the side table. The main-process
        // history only kept the final answer; older branches come back here.
        const decodedHistoryItems = decodeHistoryPayload(msgs);
        // P0（2026-09-12）：recovery 占位规模统计——局部损坏走「静默丢弃 +
        // 一次性 toast」；整个历史全部无法解码才落错误占位（error 状态）。
        const recoveryTotal = decodedHistoryItems.reduce(
          (count, item) => (item.kind === 'recovery' ? count + 1 : count),
          0,
        );
        let skippedRecoveryCount = 0;
        const restored = decodedHistoryItems.map((item): ChatMessage | null => {
          if (item.kind === 'message') {
            const metadata = item.metadata;
            const runId = typeof metadata?.runId === 'string' ? metadata.runId : undefined;
            const turnId = typeof metadata?.turnId === 'string' ? metadata.turnId : undefined;
            const runStatus = metadata?.status;
            const historyIncomplete = metadata?.eventsPruned === true;
            const run = runId && isAgentRunStatus(runStatus) && runStatus !== 'unknown'
              ? {
                status: runStatus,
                events: [],
                parts: createAssistantMessageParts(),
                turnId: turnId ?? runId,
                ...(historyIncomplete ? { historyIncomplete: true } : {}),
              }
              : undefined;
            const stepCard = metadata?.stepCard;
            // T3 全局对话体验重构：新消息的 stepCard 在 metadata（结构化协议），
            // content 已是人话摘要；渲染经 __STEP_CARD__ 前缀走 ScenarioStepCard，
            // 与历史围栏消息同一渲染出口，但不再生成 Markdown 围栏协议。
            const content = stepCard && typeof stepCard === 'object'
              ? `__STEP_CARD__${JSON.stringify(stepCard)}`
              : item.role === 'assistant'
                ? scrubPresentationProtocol(item.content)
                : item.content;
            return {
              role: item.role,
              content,
              timestamp: now(),
              ...(run ? { run } : {}),
              // O8: citations persist on message metadata; rehydrate so chips
              // survive reload, not just the live turn.
              ...(extractCitations(metadata).length > 0 ? { citations: extractCitations(metadata) } : {}),
            };
          }
          if (item.kind === 'goal') {
            const goalCard = toGoalCardData(item.goal);
            if (goalCard) {
              return { role: 'goal', content: '', timestamp: now(), goalCard };
            }
          }
          const recoveryCode = item.kind === 'recovery'
            ? item.code
            : 'goal_snapshot_unavailable';
          // 单条历史记录损坏的占位（history_item_unavailable）连成片刷屏，
          // 内容反正不可恢复——正常模式直接丢弃（计数后统一 toast 一次），
          // 诊断模式保留技术码逐条展示。
          if (item.kind === 'recovery' && item.code === 'history_item_unavailable' && !diagnosticMode) {
            skippedRecoveryCount += 1;
            return null;
          }
          return {
            role: 'system',
            content: diagnosticMode
              ? presentDiagnosticText(recoveryCode)
              : t('chat.historyRecoveryFailed'),
            timestamp: now(),
          };
        }).filter((message): message is ChatMessage => message !== null);
        // P0（2026-09-12 刘总截图）收尾反馈，仅正常模式、且仍是当前会话时：
        // 1) 部分损坏（混有正常消息）：一次性 error toast，不逐条刷占位；
        // 2) 全部损坏（restored 为空）：落一条错误占位，而不是空白对话流。
        // history_unavailable（整个 payload 解码失败）已在上方产出一条系统
        // 消息，restored 非空，自然落到分支 2 之外，不会重复。
        if (!diagnosticMode && isCurrentSessionGeneration(sessionId, generation)) {
          if (recoveryTotal > 0 && recoveryTotal === decodedHistoryItems.length && restored.length === 0) {
            restored.push({
              role: 'system',
              content: t('chat.historyRecoveryFailed'),
              timestamp: now(),
            });
          } else if (skippedRecoveryCount > 0 && partialRecoveryToastRef.current !== sessionId) {
            partialRecoveryToastRef.current = sessionId;
            showToast({
              kind: 'error',
              text: t('chat.historyPartialLoadFailed'),
              durationMs: 8000,
            });
          }
        }
        const hydrated = await Promise.all(restored.map(async (message) => {
          if (message.role !== 'assistant' || !message.run?.turnId) return message;
          const run = await hydrateAgentRunHistory(
            sessionId,
            message.run.turnId,
            generation,
            message.run.status,
            message.run.historyIncomplete,
          );
          return run ? { ...message, run } : message;
        }));
        // 卡片 phase 以引擎真实状态为准（2026-08-29 刘总截图问题）：持久化
        // 卡片停留在暂停前的 executing，而 checkpoint 步骤状态已是「已暂停」
        // ——重开会话后「暂停」按钮点下去只会被引擎拒绝，「继续」永远不
        // 出现。恢复时必须用 getGoal 的真实状态校正 phase，让按钮区与
        // checkpoint 一致（paused → 显示「继续」）。
        const goalCorrected = await Promise.all(hydrated.map(async (message) => {
          if (message.role !== 'goal' || !message.goalCard) return message;
          try {
            const goalState = await metis.getGoal?.(message.goalCard.goalId);
            if (!goalState?.success || !goalState.goal) return message;
            const phase = goalStatusToCardPhase(goalState.goal.status);
            if (phase === message.goalCard.phase) return message;
            return { ...message, goalCard: { ...message.goalCard, phase, pauseRequested: false } };
          } catch { return message; }
        }));
        if (!isCurrentSessionGeneration(sessionId, generation)) return;
        setMessages((prev) => {
          const current = prev.length > 0 ? prev : goalCorrected;
          if (!currentSessionId) return current;
          const forkMap = loadForkMap(currentSessionId, localStorage);
          if (forkMap.size === 0) return current;
          // Group persisted siblings by forkId.
          const siblingsByFork = new Map<string, ForkRecord[]>();
          for (const record of forkMap.values()) {
            const list = siblingsByFork.get(record.forkId) ?? [];
            list.push(record);
            siblingsByFork.set(record.forkId, list);
          }
          const out: ChatMessage[] = [];
          for (const msg of current) {
            out.push(msg);
            if (msg.role !== 'assistant') continue;
            // Is this message the final sibling of some fork group?
            const matching = [...siblingsByFork.values()].find((records) =>
              records.some((r) => r.content === msg.content),
            );
            if (!matching) continue;
            const forkId = matching[0]!.forkId;
            // The final sibling is the one whose content matches; older ones
            // become inactive branches right after it.
            const finalIdx = matching.findIndex((r) => r.content === msg.content);
            matching.forEach((record, idx) => {
              if (idx === finalIdx) return;
              out.push({
                role: 'assistant',
                content: record.content,
                timestamp: record.timestamp,
                forkId,
                forkIndex: record.forkIndex,
                forkCount: record.forkCount,
                forkActive: false,
              });
            });
          }
          return out;
        });
        setHistoryReady(true);
      }).catch(() => {
        if (isCurrentSessionGeneration(sessionId, generation)) {
          setMessages([]);
          setHistoryReady(true);
        }
      });
    } else {
      setHistoryReady(true);
    }
    void refreshArtifactsForSession(sessionId, generation);
    // 多对话架构第二期:恢复该会话的输入草稿与当前工作对象。
    try {
      const draftMap = JSON.parse(window.localStorage.getItem('metis:chat-drafts') || '{}') as Record<string, string>;
      setInput(typeof draftMap[sessionId] === 'string' ? draftMap[sessionId] : '');
    } catch { setInput(''); }
    try {
      const storedArtifacts = window.localStorage.getItem(`metis:session-artifacts:${sessionId}`);
      setActiveArtifactIds(storedArtifacts ? (JSON.parse(storedArtifacts) as string[]) : []);
    } catch { setActiveArtifactIds([]); }
  }, [currentSessionId, diagnosticMode, hydrateAgentRunHistory, isCurrentSessionGeneration, refreshArtifactsForSession, t]);

  // Follow the latest message only while the user is near the bottom. Once the
  // user scrolls upward, incoming tokens remain readable instead of hijacking
  // the viewport; the explicit control below restores the lock. The scroll
  // listener itself lives in useFollowScroll (ledger-based user attribution).

  // 会话历史就绪后立即定位到最新消息（2026-08-28 刘总要求：进入聊天应看到
  // 最新的消息在底部，而不是停留在最顶部）。使用瞬时滚动，避免 smooth 动画
  // 期间触发的 scroll 事件把跟随锁误判为关闭。
  useEffect(() => {
    if (!historyReady) return;
    const element = messagesEndRef.current;
    if (!element || typeof element.scrollIntoView !== 'function') return;
    engageFollow();
    element.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [historyReady, currentSessionId, engageFollow]);

  const scrollToLatest = useCallback(() => {
    engageFollow();
    const element = messagesEndRef.current;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({
        behavior: chatPrefersReducedMotion() ? 'auto' : 'smooth',
        block: 'end',
      });
    }
  }, [engageFollow]);

  // Streaming follow-scroll: instant pin per committed flow update, only while
  // the user is pinned to the bottom. Instant (not smooth) so rapid token
  // frames never restart a smooth-scroll animation mid-flight.
  useLayoutEffect(() => {
    if (!isFollowingLatestRef.current) return;
    pinChatToBottom();
  }, [messages, isLoading, activeRunParts, isFollowingLatestRef, pinChatToBottom]);

  // Goal IPC event listeners. Raw model stream events are intentionally not
  // exposed by preload, so renderer code cannot accidentally present them.
  useEffect(() => {
    const metis = window.metis;
    if (!metis) return;
    const unsubs: Array<() => void> = [];

    // Goal step start
    if (metis.onGoalStepStart) {
      unsubs.push(metis.onGoalStepStart(({ goalId, sequence, stepId, stepName }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const existing = card.stepStatuses[stepId];
          return {
            ...card,
            stepStatuses: {
              ...card.stepStatuses,
              [stepId]: {
                stepId,
                stepName: existing?.stepName ?? stepName,
                status: 'running',
                output: '',
              },
            },
          };
        });
      }));
    }

    // Goal step complete
    if (metis.onGoalStepComplete) {
      unsubs.push(metis.onGoalStepComplete(({ goalId, sequence, stepId, stepName, output }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const existing = card.stepStatuses[stepId];
          return {
            ...card,
            stepStatuses: {
              ...card.stepStatuses,
              [stepId]: {
                stepId,
                stepName: existing?.stepName ?? stepName,
                status: 'completed',
                output: presentDiagnosticText(output),
              },
            },
          };
        });
      }));
    }

    // Goal step failed
    if (metis.onGoalStepFailed) {
      unsubs.push(metis.onGoalStepFailed(({ goalId, sequence, stepId, stepName, error }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const existing = card.stepStatuses[stepId];
          const safeError = presentDiagnosticText(error);
          return {
            ...card,
            stepStatuses: {
              ...card.stepStatuses,
              [stepId]: {
                stepId,
                stepName: existing?.stepName ?? stepName,
                status: 'failed',
                output: safeError,
              },
            },
            phase: 'failed',
            error: safeError,
          };
        });
      }));
    }

    // Goal progress
    if (metis.onGoalProgress) {
      unsubs.push(metis.onGoalProgress(({ goalId, sequence, completed, total, currentStep }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => ({
          ...card,
          progress: { completed, total, currentStep: presentDiagnosticText(currentStep) },
          phase: completed >= total ? 'completed' : 'executing',
        }));
      }));
    }

    // Goal state changed from another surface (kanban moves, plan updates,
    // execution completion): refresh the matching card's phase so both views
    // stay in sync. Execution step events above still own step-level detail.
    if (metis.onGoalChanged) {
      unsubs.push(metis.onGoalChanged((payload) => {
        const { goalId, status } = payload;
        // 多对话架构(2026-09-05):非当前项目的目标变更直接忽略,防跨项目串扰。
        const eventProjectId = (payload as { projectId?: string }).projectId;
        if (eventProjectId && activeResearchProjectId && eventProjectId !== activeResearchProjectId) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const phase = goalStatusToCardPhase(status);
          return { ...card, phase, ...(phase === 'executing' ? {} : { pauseRequested: false }) };
        });
      }));
    }

    return () => { for (const u of unsubs) u(); };
  }, [acceptGoalEvent, isCurrentChatRequest, updateGoalCard, activeResearchProjectId]);

  // Public Agent execution events are emitted by main while the same request
  // is in flight. A renderer-generated turnId is the only join key: delayed
  // events for a previous turn stay buffered and never enter this session.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onAgentExecutionEvent) return;
    return metis.onAgentExecutionEvent((payload) => {
      const decoded = AgentExecutionEventSchema.safeParse(payload);
      if (!decoded.success) {
        // Compatibility for older renderer test doubles and pre-envelope bridges.
        // The production preload only emits strict AgentExecutionEvent envelopes.
        const turn = RuntimeIdSchema.safeParse(payload?.turnId);
        const event = AgentPresentationEventSchema.safeParse(payload?.event);
        if (!turn.success || !event.success) return;
        const existingIdentity = agentExecutionEventIdentityRef.current.get(turn.data);
        const sequence = existingIdentity && existingIdentity.sequences.size > 0
          ? Math.max(...existingIdentity.sequences) + 1
          : 0;
        const syntheticEnvelope: AgentExecutionEvent = {
          version: 1,
          eventId: `${turn.data}:${sequence}`,
          runId: turn.data,
          sessionId: activeChatRequestRef.current?.sessionId ?? 'legacy-session',
          turnId: turn.data,
          sequence,
          correlationId: turn.data,
          event: event.data,
        };
        applyAgentExecutionEnvelope(syntheticEnvelope);
        return;
      }
      const result = applyAgentExecutionEnvelope(decoded.data);
      const request = activeChatRequestRef.current;
      if (!request || request.turnId !== decoded.data.turnId || !isCurrentChatRequest(request)) return;
      if (!result.gap || !metis.replayAgentEvents || agentExecutionReplayInFlightRef.current.has(request.turnId)) return;
      agentExecutionReplayInFlightRef.current.add(request.turnId);
      void metis.replayAgentEvents({
        version: decoded.data.version,
        sessionId: request.sessionId,
        runId: request.turnId,
        afterSequence: result.contiguousSequence,
        limit: 256,
      }).then((replay) => {
        if (!replay || replay.runId !== request.turnId || replay.sessionId !== request.sessionId) return;
        for (const replayEvent of replay.events) {
          if (replayEvent.turnId === request.turnId) applyAgentExecutionEnvelope(replayEvent, true);
        }
      }).finally(() => {
        agentExecutionReplayInFlightRef.current.delete(request.turnId);
      });
    });
  }, [applyAgentExecutionEnvelope, isCurrentChatRequest]);

  // Streamed model tokens: the V2 conversation runtime (2026-09-05 P0) owns the
  // accumulation authority — chunks flow into the ConversationController
  // (attempt identity + dense index + resync self-heal), publications are
  // coalesced across three animation frames, and settlement publishes
  // immediately with the authoritative payload. This effect bridges controller
  // publications onto the existing messages array so the list renderer stays
  // untouched while cadence/content/settlement all become V2-authoritative.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onChatStreamChunk) return;

    const flushFromController = () => {
      const request = activeChatRequestRef.current;
      if (!request || !isCurrentChatRequest(request)) return;
      const node = chatStreamControllerRef.current?.nodeSource(request.turnId).get();
      if (!node || node.status === 'abandoned') return;
      const finished = node.status !== 'streaming';

      if (streamingIndexRef.current < 0) {
        // UX-CHAT-002: empty terminal events must not create an air bubble.
        if (!node.content && !node.reasoning) return;
        const message: ChatMessage = {
          id: nextMessageId(),
          role: 'assistant',
          content: node.content,
          timestamp: now(),
          startedAt: request.startedAt,
          streaming: !finished,
          run: {
            status: finished ? 'completed' : 'running',
            events: activeRunPartsRef.current.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT),
            parts: activeRunPartsRef.current,
            turnId: request.turnId,
          },
          reasoning: node.reasoning || undefined,
          ...(finished ? { durationMs: Date.now() - request.startedAt } : {}),
          ...(finished ? { citations: extractDoiCitations(node.content) } : {}),
        };
        const index = messagesRef.current.length;
        messagesRef.current = [...messagesRef.current, message];
        setMessages((prev) => [...prev, message]);
        streamingIndexRef.current = index;
        return;
      }

      const streamedIndex = streamingIndexRef.current;
      const nextMessages = messagesRef.current.map((message, index) => {
        if (index !== streamedIndex) return message;
        return {
          ...message,
          content: node.content,
          reasoning: node.reasoning || undefined,
          streaming: !finished,
          ...(finished ? { durationMs: Date.now() - request.startedAt } : {}),
          ...(finished ? { citations: extractDoiCitations(node.content) } : {}),
        };
      });
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
    };

    const controller = new ConversationController({ onPublish: flushFromController });
    chatStreamControllerRef.current = controller;

    const handleStreamChunk = (data: {
      turnId: string;
      sessionId: string;
      content: string;
      reasoning?: string;
      isFinished: boolean;
    }) => {
      const request = activeChatRequestRef.current;
      if (!request
        || data.turnId !== request.turnId
        || data.sessionId !== request.sessionId
        || !isCurrentChatRequest(request)) return;
      // isFinished 只代表流通道关闭；权威结算由 chat 响应回调通过 settleTurn 完成。
      ingestChatStreamChunk(controller, data);
    };

    const unsubscribe = metis.onChatStreamChunk(handleStreamChunk);
    return () => {
      controller.dispose();
      chatStreamControllerRef.current = null;
      unsubscribe();
    };
  }, [isCurrentChatRequest, nextMessageId]);

  // Board → chat handoff: focus a goal as an inline card. App navigates to the
  // conversation first; a sessionStorage fallback covers the case where this
  // page was not mounted when the event fired.
  const focusGoalFromBoard = useCallback(async (goalId: string) => {
    const metis = window.metis;
    if (!metis?.getGoal) return;
    const result = await metis.getGoal(goalId);
    if (!result.success || !result.goal) return;
    const card: GoalCardData = {
      goalId,
      description: result.goal.label,
      phase: goalStatusToCardPhase(result.goal.status),
      steps: [],
      stepStatuses: {},
      progress: { completed: 0, total: 0, currentStep: '' },
      canRefine: false,
    };
    const goalMsg: ChatMessage = { role: 'goal', content: '', timestamp: now(), goalCard: card };
    const goalMsgIndex = messages.length;
    setMessages((prev) => [...prev, goalMsg]);
    goalCardIndexMapRef.current.set(goalId, goalMsgIndex);
    const acceptsLiveEvents = result.goal.status === 'running';
    setActiveGoalId(acceptsLiveEvents ? goalId : null);
    activeGoalIdRef.current = acceptsLiveEvents ? goalId : null;
    goalEventSequenceRef.current.delete(goalId);
    void syncGoalCardWorkflow(goalId, goalMsgIndex);
    if (metis.appendMessage) {
      void metis.appendMessage(currentSessionId, 'goal', `__GOAL_CARD__${JSON.stringify(card)}`);
    }
    // UX-CHAT-004: Goal 卡已持久化，侧栏计数同步刷新。
    refreshSessionSummaries();
    requestAnimationFrame(() => {
      const element = messagesEndRef.current;
      if (element && typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }, [currentSessionId, messages.length, refreshSessionSummaries, syncGoalCardWorkflow]);

  useEffect(() => {
    const pending = window.sessionStorage.getItem('metis-pending-goal');
    if (pending) {
      window.sessionStorage.removeItem('metis-pending-goal');
      void focusGoalFromBoard(pending);
    }
    const handler = (event: Event) => {
      const goalId = (event as CustomEvent<{ goalId?: string }>).detail?.goalId;
      if (goalId) {
        // Consume the handoff marker so the mount-effect fallback never
        // inserts the card a second time after this listener re-runs.
        window.sessionStorage.removeItem('metis-pending-goal');
        void focusGoalFromBoard(goalId);
      }
    };
    window.addEventListener('metis:goal-focus', handler);
    return () => window.removeEventListener('metis:goal-focus', handler);
  }, [focusGoalFromBoard]);

  // ─── Normal chat flow（迁出至 conversation/chatTurnFlow.ts，2026-09-15 拆分）───

  // ─── Goal flow（迁出至 conversation/goalRunFlow.ts，2026-09-13 拆分）───
  const {
    handleGoalFlow,
    handlePauseGoal,
    handleCancelGoal,
    handleResumeGoal,
    handleStartPlannedGoal,
  } = createGoalRunFlow({
    metis: window.metis,
    locale,
    uiMode: resolvedUIMode,
    t,
    currentSessionId,
    activeResearchProjectId,
    messagesLength: messages.length,
    setMessages,
    setIsLoading,
    setActiveGoalId,
    activeGoalIdRef,
    goalEventSequenceRef,
    goalCardIndexMapRef,
    updateGoalCard,
    findGoalCardIndex,
    syncGoalCardWorkflow,
    refreshSessionSummaries,
    flushNext: queue.flushNext,
  });

  // ─── Interjection flow ─────────────────────────────────────

  async function handleInterjection(content: string, sessionIdOverride?: string) {
    const metis = window.metis;
    const sessionId = sessionIdOverride ?? currentSessionId;
    if (!metis || !activeGoalId) {
      await handleChatFlow(content, undefined, sessionIdOverride);
      return;
    }

    if (isLikelyGoalFeedback(content)) {
      setIsLoading(true);
      if (metis.appendMessage) {
        void metis.appendMessage(sessionId, 'user', content);
      }
      const idx = goalCardIndexMapRef.current.get(activeGoalId);
      try {
        await metis.cancelGoal(activeGoalId);
        if (idx !== undefined) updateGoalCard(idx, (card) => ({ ...card, phase: 'planning' }));

        const planResult = await metis.refinePlan(activeGoalId, content);
        if (!planResult.success) throw new Error(planResult.code);
        const steps = planResult.steps.map((step) => ({
          id: step.stepId,
          name: t('rightPanel.researchStep', { number: step.ordinal }),
          description: '',
        }));

        if (idx !== undefined) updateGoalCard(idx, (card) => ({
          ...card, phase: 'executing',
          steps,
          planName: t('chat.researchPlan'),
          planDescription: undefined,
          stepStatuses: Object.fromEntries(steps.map((s) => [s.id, { stepId: s.id, stepName: s.name, status: 'pending' as const, output: '' }])),
          progress: { completed: 0, total: steps.length, currentStep: '' },
          error: undefined,
        }));

        const execution = await metis.executeGoal(activeGoalId);
        if (!execution.success) throw new Error(execution.code ?? 'goal_execution_failed');
        if (idx !== undefined) updateGoalCard(idx, (card) => ({ ...card, phase: 'completed' }));
      } catch {
        if (idx !== undefined) {
          updateGoalCard(idx, (card) => ({
            ...card,
            phase: 'failed',
            error: 'goal_execution_failed',
          }));
        }
      } finally {
        setActiveGoalId(null);
        activeGoalIdRef.current = null;
        goalEventSequenceRef.current.clear();
        setIsLoading(false);
        // UX-CHAT-004: 反馈消息已持久化，刷新会话摘要。
        refreshSessionSummaries();
      }
    } else {
      // Unrelated question — answer as normal chat while goal continues in background
      await handleChatFlow(content, undefined, sessionIdOverride);
    }
  }

  // ─── Send message (router) ────────────────────────────────

  async function handleLiveInstruction(
    content: string,
    options?: { userBubbleVisible?: boolean; fallback?: () => Promise<void> },
  ) {
    const userBubbleVisible = options?.userBubbleVisible ?? false;
    const metis = window.metis;
    if (!metis?.agentControl) {
      setMessages((prev) => [...prev, {
        role: 'system',
        content: presentExecutionError('live_steering_unavailable', locale, resolvedUIMode),
        timestamp: now(),
      }]);
      return;
    }
    const response = await metis.agentControl({
      contractVersion: 1,
      operationId: `steer-${crypto.randomUUID()}`,
      sessionId: currentSessionId,
      action: 'instruction',
      content,
    });
    if (!response.ok) {
      // 中断恢复（2026-08-29 刘总报告「中断之后直接无法继续」）：应用重启后
      // 内存运行注册表为空而数据库状态仍是 running，no_active_run 不该报错了
      // 事——自动降级为正常场景轮，主进程发现内存无 run 且数据库有可恢复
      // 断点时会自动续跑，而不是把用户堵死在死路上。
      if (response.code === 'no_active_run' && options?.fallback) {
        setMessages(() => [
          ...(userBubbleVisible ? [] : [{ role: 'user', content, timestamp: now() } as ChatMessage]),
          {
            role: 'system',
            content: locale === 'zh'
              ? '检测到运行已中断（应用可能刚重启过），正在从断点恢复…'
              : 'The run was interrupted (the app may have just restarted); resuming from the checkpoint…',
            timestamp: now(),
          },
        ]);
        if (!userBubbleVisible) setInput('');
        await options.fallback();
        return;
      }
      setMessages((prev) => [...prev, {
        role: 'system',
        content: presentExecutionError(response.code, locale, resolvedUIMode),
        timestamp: now(),
      }]);
      return;
    }
    // Success receipt: confirm to the user that the instruction reached the run.
    // 用户气泡只在还没显示时补上（调用点可能已把气泡渲染过，避免重复）。
    setMessages(() => [
      ...(userBubbleVisible ? [] : [{ role: 'user', content, timestamp: now() } as ChatMessage]),
      { role: 'system', content: t('chat.steerReceipt'), timestamp: now() },
    ]);
    if (!userBubbleVisible) setInput('');
  }

  async function handleInterrupt() {
    const response = await window.metis?.agentControl?.({
      contractVersion: 1,
      operationId: `interrupt-${crypto.randomUUID()}`,
      sessionId: currentSessionId,
      action: 'interrupt',
      reason: locale === 'zh' ? '用户主动打断当前任务' : 'User interrupted the current run',
    });
    if (!response?.ok) {
      setMessages((prev) => [...prev, {
        role: 'system',
        content: presentExecutionError(response?.code ?? 'live_interrupt_unavailable', locale, resolvedUIMode),
        timestamp: now(),
      }]);
      return;
    }
    // Success receipt: the request is queued; the run settles at its next safe point.
    setControlState('interrupting');
    setMessages((prev) => [...prev, {
      role: 'system',
      content: t('chat.interruptReceipt'),
      timestamp: now(),
    }]);
  }

  /** Execute a slash command（迁出至 conversation/chatTurnFlow.ts，2026-09-15 拆分）。 */

  // 场景选择持久化兜底（2026-08-29 刘总要求：显示选中就必须走场景）。
  // React state 恢复是异步的——项目刚打开立刻发送时 state 可能还是空，
  // 导致明明显示已选场景却静默走了 Goal。这里直接读持久化偏好兜底。
  function readPersistedScenarioId(): string | null {
    try {
      // 多对话架构(2026-09-04):当前会话正式绑定的场景优先(随会话切换恢复)。
      const currentSession = currentSessionId
        ? projectScopedSessions.find((item) => item.id === currentSessionId) ?? sessions.find((item) => item.id === currentSessionId)
        : undefined;
      if (currentSession?.scenarioId) return currentSession.scenarioId;
      const projectPreferred = activeResearchProjectId
        ? window.localStorage.getItem(`metis:project-scenario:${activeResearchProjectId}`)
        : null;
      return projectPreferred ?? window.localStorage.getItem(ACTIVE_SCENARIO_KEY);
    } catch { return null; }
  }

  async function handleSend(overrideContent?: string, scenarioOverride?: string, options?: { fromQueue?: boolean; immediate?: boolean }) {
    let raw = stripEmoji((overrideContent || input).trim());
    if (!raw) return;
    // 2.5 运行中入队：AI 工作时用户发送的消息自动排队（不打断当前 run）。
    if (isLoading && !options?.fromQueue && !options?.immediate && !overrideContent) {
      queue.enqueue(raw);
      setInput('');
      return;
    }
    // 队列自动补发撞上新一轮 run：放回队首而不是变成实时引导——排队语义
    // 必须保持 FIFO。小条上的「立即发送」（immediate）是显式插队，仍走引导。
    if (isLoading && options?.fromQueue && !options?.immediate) {
      queue.requeueFront(raw);
      return;
    }
    // T3 二期：Step Target Context——结构化上下文随消息进 Runtime（禁裸「针对步骤6」）。
    if (stepTarget) {
      const contextLines = [
        '【对话目标（结构化上下文）】',
        'targetType: scenario_step',
        `runId: ${stepTarget.runId}`,
        `stepId: ${stepTarget.stepId}`,
        ...(stepTarget.revision !== undefined ? [`stepRevision: ${stepTarget.revision}`] : []),
        ...(stepTarget.title ? [`stepTitle: ${stepTarget.title}`] : []),
        ...(stepTargetMode === 'modify' ? ['instruction: 基于当前步骤结果修改并生成新版本（旧版本保留）'] : []),
      ];
      raw = `${contextLines.join('\n')}\n\n【用户反馈】\n${raw}`;
      setStepTarget(null);
    }
    // 运行中的消息是实时引导（steering），必须放行；防重入只针对空闲态
    // 双击（2026-08-29 刘总要求：消灭同秒双发竞态，同时不拦引导）。
    // 引导若撞上 no_active_run（运行已被中断），降级为断点恢复轮。
    if (isLoading) {
      await handleLiveInstruction(raw, {
        fallback: () => handleChatFlow(
          raw,
          activeScenarioId || readPersistedScenarioId() || DEFAULT_SCENARIO_ID,
          currentSessionId || undefined,
        ),
      });
      return;
    }
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      await runSendTurn(raw, scenarioOverride);
    } finally {
      sendInFlightRef.current = false;
    }
  }

  // 步骤卡「继续」事件（2026-09-01 刘总方案二期）：ScenarioStepCard 落库成功后
  // 派发该事件，这里补发「继续」触发断点恢复；跨会话的事件忽略。
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const currentSessionIdForContinueRef = useRef(currentSessionId);
  currentSessionIdForContinueRef.current = currentSessionId;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId && currentSessionIdForContinueRef.current
        && detail.sessionId !== currentSessionIdForContinueRef.current) return;
      void handleSendRef.current('继续');
    };
    window.addEventListener('metis:scenario-continue', listener);
    return () => window.removeEventListener('metis:scenario-continue', listener);
  }, []);

  // 多对话架构第二期(2026-09-05):左侧栏 Conversation 树点击对话行 → typed 事件切换会话。
  useEffect(() => {
    const handler = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId || sessionId === currentSessionId) return;
      if (sessions.some((item) => item.id === sessionId)) activateSession(sessionId);
    };
    window.addEventListener('metis:switch-session', handler);
    return () => window.removeEventListener('metis:switch-session', handler);
  }, [currentSessionId, sessions, activateSession]);

  // 项目工作台侧栏可右键删除会话（ProjectsPage, 2026-09-12）：同步移除本地
  // 列表；若删除的正是当前打开的会话，自动切到剩余最近会话（或清空），
  // 避免界面停留在已删除的「幽灵会话」上继续发送消息。
  useEffect(() => {
    const handler = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId) return;
      setSessions((prev) => prev.filter((item) => item.id !== sessionId));
      if (sessionId === currentSessionId) {
        const remaining = sessions.filter((item) => item.id !== sessionId);
        if (remaining.length > 0 && remaining[0]) activateSession(remaining[0].id);
        else activateSession('');
      }
    };
    window.addEventListener('metis:session-deleted', handler);
    return () => window.removeEventListener('metis:session-deleted', handler);
  }, [currentSessionId, sessions, activateSession]);

  // runSendTurn（发送路由，迁出至 conversation/chatTurnFlow.ts，2026-09-15 拆分）。

  // Consume a cross-page handoff only after the target session history and the
  // authoritative scenario list are both ready. Full Access launch intents may
  // auto-send once; ordinary paper/note intents remain editable drafts.
  useEffect(() => {
    const pendingPeek = peekPendingChatIntent();
    // 只有 autoSend 需要已就绪的会话与历史（直接发送）；场景/技能选择类交接
    // 在全新环境（尚无任何会话）也必须消费，否则场景永远无法交接。
    if (pendingPeek?.autoSend && (!currentSessionId || !historyReady)) return;
    // 项目上下文仍在加载时挂起交接消费：挂载竞态下 currentProjectId 会短暂
    // 读到 'global'，立即消费会把合法的项目场景交接误判为项目不匹配。
    if (workspaceProjectsLoading) return;
    const pendingIntent = peekPendingChatIntent();
    if (!pendingIntent) {
      if (!currentSessionId || !historyReady) return;
      // Preserve the legacy cleanup behavior for malformed stored values.
      consumePendingChatIntent();
      return;
    }
    // A failed catalog load is not authoritative evidence that a scenario is
    // missing. Keep scenario handoffs pending so a later Chat mount can retry.
    // Ordinary handoffs do not depend on the scenario catalog and remain usable.
    if (pendingIntent.scenarioId && scenarioLoadState !== 'ready') return;
    clearPendingChatIntent();
    const intent = pendingIntent;
    const rejectHandoff = (key: 'chat.handoffRejectedProject' | 'chat.handoffRejectedSession' | 'chat.handoffRejectedScenario') => {
      setMessages((previous) => [...previous, {
        role: 'system',
        content: t(key),
        timestamp: now(),
      }]);
    };
    if (intent.projectId && intent.projectId !== currentProjectId) {
      rejectHandoff('chat.handoffRejectedProject');
      return;
    }
    if (intent.sessionId && intent.sessionId !== currentSessionId) {
      rejectHandoff('chat.handoffRejectedSession');
      return;
    }
    if (intent.skillId && skills.some((skill) => skill.id === intent.skillId)) {
      setActiveSkillId(intent.skillId);
      window.metis?.setActiveSkill?.(intent.skillId).catch(() => {});
    }
    if (intent.scenarioId && !scenarios.some((scenario) => scenario.id === intent.scenarioId)) {
      rejectHandoff('chat.handoffRejectedScenario');
      return;
    }
    const requestedScenario = intent.scenarioId ?? activeScenarioId;
    if (requestedScenario !== activeScenarioId) {
      setActiveScenarioId(requestedScenario);
    }
    if (intent.scenarioId) {
      try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, requestedScenario); } catch { /* preference only */ }
    }
    if (intent.autoSend) {
      void handleSend(intent.message, requestedScenario);
    } else {
      setInput(intent.message);
      inputRef.current?.focus();
    }
    // handleSend intentionally consumes the state snapshot guarded by
    // historyReady; re-subscribing to its function identity would replay work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScenarioId, currentProjectId, currentSessionId, historyReady, intentRevision, locale, scenarioLoadState, scenarios, skills, workspaceProjectsLoading]);

  // O16: switch which sibling of a regenerated-answer fork is displayed.
  function handleSwitchFork(forkId: string, targetIndex: number) {
    setMessages((prev) => toggleForkActive(prev, forkId, targetIndex));
  }

  // handleRegenerate（O16 fork 重生成，迁出至 conversation/chatTurnFlow.ts，2026-09-15 拆分）。

  function handleEditMessage(index: number, newContent: string) {
    // Truncate messages after the edited one, then send the new content
    const truncated = messages.slice(0, index);
    setMessages(truncated);
    // Use a microtask to ensure state is updated before handleSend reads messages
    setTimeout(() => {
      void handleSend(newContent);
    }, 0);
  }

  // Referentially stable per-message callbacks for the memoized
  // ChatMessageItem: the refs always point at the latest closures, so memo
  // comparison never sees a fresh function identity per render.
  const editMessageHandlerRef = useRef<(index: number, content: string) => void>(() => {});
  editMessageHandlerRef.current = (index, content) => handleEditMessage(index, content);
  const handleEditMessageAtIndex = useCallback((index: number, content: string) => {
    editMessageHandlerRef.current(index, content);
  }, []);
  const regenerateHandlerRef = useRef<() => void>(() => {});
  regenerateHandlerRef.current = () => { void handleRegenerate(); };
  const stableRegenerate = useCallback(() => {
    regenerateHandlerRef.current();
  }, []);
  const switchForkHandlerRef = useRef<(forkId: string, targetIndex: number) => void>(() => {});
  switchForkHandlerRef.current = (forkId, targetIndex) => handleSwitchFork(forkId, targetIndex);
  const stableSwitchFork = useCallback((forkId: string, targetIndex: number) => {
    switchForkHandlerRef.current(forkId, targetIndex);
  }, []);

  // Handle the slash listbox before Enter-to-send. Shift+Enter always preserves a newline.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (handleSlashKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }


  // Build right-panel task list from active goal card if any
  const activeGoalCard = messages.find((m) => m.role === 'goal' && m.goalCard)?.goalCard;
  const rightPanelTasks = projectScenarioRun?.steps.length
    ? projectScenarioRun.steps.map((step) => ({
        id: step.stepId,
        title: step.name,
        status: toRightPanelTaskStatus(step.status),
        progress: undefined,
        // 步骤提示词随清单下发（2026-08-29 刘总要求：点击可展开查看）。
        detail: step.prompt || undefined,
      }))
    : activeGoalCard
      ? activeGoalCard.steps.map((step, index) => {
          const rawStatus = activeGoalCard.stepStatuses[step.id]?.status;
          const status = toRightPanelTaskStatus(rawStatus ?? 'pending');
          // 隐私边界与 GoalCardInline 同规则（pages.test「Runtime Tool Step」
          // 泄露断言）：内部执行文案（AgentLoop/MCP/Runtime 等）在普通模式
          // 回退为「研究步骤 N」，真实业务步骤名照常显示。
          const internalName = isInternalExecutionCopy(step.name);
          const internalDetail = isInternalExecutionCopy(step.description);
          return {
            id: step.id,
            // 具体步骤名（2026-08-29 刘总要求）：不再用"研究步骤N"遮挡真实标题。
            title: step.name && !internalName
              ? step.name
              : t('rightPanel.researchStep', { number: index + 1 }),
            status,
            progress: activeGoalCard.progress && activeGoalCard.progress.total > 0
              ? Math.round((activeGoalCard.progress.completed / activeGoalCard.progress.total) * 100)
              : undefined,
            detail: step.description && !internalDetail ? step.description : undefined,
          };
        })
      : [];

  const [projectOutcomes, setProjectOutcomes] = useState<Array<{
    id: string;
    title: string;
    type: ArtifactItemType;
    updatedAt: number;
  }>>([]);
  // ── 多对话架构第二期(2026-09-04/05 刘总要求)──
  const [activeArtifactIds, setActiveArtifactIds] = useState<string[]>([]);

  // ─── 聊天回合主流程（迁出至 conversation/chatTurnFlow.ts，2026-09-15 拆分）───
  // handleChatFlow / runSendTurn / handleRegenerate 共享的宿主快照、refs 与
  // 回调全部显式注入；每渲染重建构造器，与原内联函数声明等价。（handleSlashCommand
  // 由 chatTurnFlow 内部的 runSendTurn 使用，宿主无需解构。）
  const {
    handleChatFlow,
    runSendTurn,
    handleRegenerate,
  } = createChatTurnFlow({
    metis: window.metis,
    locale,
    uiMode: resolvedUIMode,
    t,
    currentSessionId,
    currentProjectId,
    hasActiveScenarioRun,
    messages,
    sessions,
    scenarios,
    activeScenarioId,
    activeSkillId,
    activeGoalId,
    isLoading,
    activeArtifactIds,
    projectOutcomes,
    sessionGenerationRef,
    streamingIndexRef,
    activeChatRequestRef,
    agentExecutionPartsBufferRef,
    agentExecutionEventIdentityRef,
    agentExecutionReplayInFlightRef,
    activeRunPartsRef,
    chatStreamControllerRef,
    setMessages,
    setInput,
    setActiveRunParts,
    setIsLoading,
    setControlState,
    setGoalSuggestion,
    setActiveScenarioId,
    isCurrentChatRequest,
    partsForAgentTurn,
    settleStreamingPlaceholder,
    openPreview,
    refreshArtifactsForSession,
    refreshSessionSummaries,
    flushNext: queue.flushNext,
    createNewSession,
    renameSession: handleRenameSession,
    readPersistedScenarioId,
    handleGoalFlow,
    handleResumeGoal,
    handleInterjection,
    handleLiveInstruction,
    handleInterrupt,
  });
  const writeSessionDraft = (sessionId: string, value: string): void => {
    try {
      const map = JSON.parse(window.localStorage.getItem('metis:chat-drafts') || '{}') as Record<string, string>;
      if (value) map[sessionId] = value.slice(0, 8000);
      else delete map[sessionId];
      window.localStorage.setItem('metis:chat-drafts', JSON.stringify(map));
    } catch { /* best-effort */ }
  };

  useEffect(() => {
    let alive = true;
    if (!activeResearchProjectId || !window.metis?.listOutcomes) {
      setProjectOutcomes([]);
      return () => { alive = false; };
    }
    void window.metis.listOutcomes({ projectId: activeResearchProjectId, query: '' }).then((items: Array<{
      id: string;
      title: string;
      kind: string;
      updatedAt: number;
    }>) => {
      if (!alive) return;
      setProjectOutcomes(items.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.kind === 'word' ? 'docx'
          : item.kind === 'ppt' ? 'pptx'
            : item.kind === 'spreadsheet' ? 'xlsx'
              : item.kind === 'pdf' ? 'pdf'
                : item.kind === 'other' ? 'other'
                  : 'other',
        updatedAt: item.updatedAt,
      })));
    }).catch(() => {
      if (alive) setProjectOutcomes([]);
    });
    return () => { alive = false; };
  }, [activeResearchProjectId, isLoading]);

  // 全局对话体验重构（T3）：按逻辑成果聚合——同名（含轮次后缀规整）只保留
  // 最新一条，轮次计数进 size 标注（历史版本在成果页 VersionPanel 保留，
  // 不破坏真实版本历史，仅改善 Presentation）。
  const rightPanelArtifacts = (() => {
    const normalizeName = (name: string) => name.replace(/[(（]第\s*\d+\s*轮[)）]/gu, '').replace(/\s*v\d+$/iu, '').trim();
    const merged = [
      ...projectOutcomes.map((outcome) => ({
        id: `outcome:${outcome.id}`,
        name: outcome.title,
        type: outcome.type,
        createdAt: outcome.updatedAt,
        contentAvailable: true,
      })),
      ...artifacts.filter((artifact) => !projectOutcomes.some((outcome) => outcome.title === artifact.name)),
    ];
    const byName = new Map<string, { id: string; name: string; type: (typeof merged)[number]['type']; createdAt: number; contentAvailable: boolean; versions: number }>();
    for (const item of merged) {
      const key = normalizeName(item.name);
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { ...item, versions: 1 });
        continue;
      }
      existing.versions += 1;
      if (item.createdAt > existing.createdAt) {
        existing.id = item.id;
        existing.name = item.name;
        existing.type = item.type;
        existing.createdAt = item.createdAt;
        existing.contentAvailable = item.contentAvailable;
      }
    }
    return [...byName.values()]
      .map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        createdAt: item.createdAt,
        contentAvailable: item.contentAvailable,
        size: item.versions > 1 ? `${item.versions} 个版本` : undefined,
      }))
      .sort((left, right) => right.createdAt - left.createdAt);
  })();

  const leftPanel = (
    <ChatSessionSidebar
      sessions={projectScopedSessions}
      currentSessionId={currentSessionId}
      onSelect={activateSession}
      onNew={createNewSession}
      onDelete={handleDeleteSession}
      onRename={handleRenameSession}
      onArchive={handleArchiveSession}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
      uiMode={resolvedUIMode}
    />
  );

  const selectionAskButton = selectionMenu ? (
    <button
      type="button"
      className="selection-ask-btn"
      style={{ left: selectionMenu.x, top: selectionMenu.y }}
      onClick={() => {
        const quoted = `> ${selectionMenu.text}\n\n${t('chat.selectionPrompt')}`;
        setInput(quoted);
        setSelectionMenu(null);
        inputRef.current?.focus();
      }}
    >
      {t('chat.askAboutSelection')}
    </button>
  ) : null;

  const workspace = (
    <div className="chat-main" data-testid="chat-page">
        {/* 项目内多对话切换（2026-08-29 刘总要求）：一个项目支持多个对话，
            可在此选择进入某个对话或新建对话；协同对话布局另有完整侧栏。 */}
        {(projectScopedSessions.length > 0 || currentSessionId) && (
          <div className="chat-session-bar" data-testid="chat-session-bar">
            <label>
              <span>{locale === 'zh' ? '对话' : 'Conversation'}</span>
              <select
                value={(() => {
                  const visible = projectScopedSessions.filter((s) => !s.archived);
                  const index = visible.findIndex((s) => s.id === currentSessionId);
                  // 隐私边界：会话 id 不得进入 DOM（含属性），下拉用 index 寻址。
                  return String(index >= 0 ? index : visible.length);
                })()}
                onChange={(event) => {
                  const target = projectScopedSessions.filter((s) => !s.archived)[Number(event.target.value)];
                  if (target) activateSession(target.id);
                }}
                aria-label={locale === 'zh' ? '切换对话' : 'Switch conversation'}
              >
                {projectScopedSessions.filter((s) => !s.archived).map((s, index) => (
                  // 隐私边界（pages.test 会话 id 泄露断言）：会话 id 不得出现在
                  // DOM 文本或属性里；无标题会话显示通用名而不是裸 id。
                  <option key={s.id} value={String(index)}>{presentSafeMarkdownText(s.title || t('chat.newSessionTitle'), 'normal', locale)}</option>
                ))}
                {currentSessionId && projectScopedSessions.filter((s) => !s.archived).every((s) => s.id !== currentSessionId) && (
                  <option value={String(projectScopedSessions.filter((s) => !s.archived).length)}>{t('chat.newSessionTitle')}</option>
                )}
              </select>
            </label>
            <button
              type="button"
              className="btn-sm btn-secondary"
              onClick={() => void createNewSession()}
            >
              {locale === 'zh' ? '+ 新对话' : '+ New'}
            </button>
            {/* 场景选择（2026-08-29 刘总要求）：选定后任务类消息直接按该场景
                工作流执行；项目级偏好优先，全局偏好兜底。目录加载中禁用、
                失败后保留交接并给出显式重试（旧场景选择器的语义在新下拉中
                必须完整保留，2026-08-29 回归修复）。 */}
            <label>
              <span>{locale === 'zh' ? '场景' : 'Scenario'}</span>
              <select
                value={activeScenarioId}
                disabled={scenarioLoadState === 'loading' || scenarioLoadState === 'failed'}
                onChange={(event) => {
                  const scenarioId = event.target.value;
                  setActiveScenarioId(scenarioId);
                  // 多对话架构(2026-09-04):场景绑定当前会话,正式持久化;切换对话互不影响。
                  if (currentSessionId) {
                    void window.metis?.updateSession?.(currentSessionId, { scenarioId: scenarioId || null });
                  }
                  try {
                    window.localStorage.setItem(ACTIVE_SCENARIO_KEY, scenarioId);
                    if (activeResearchProjectId) {
                      if (scenarioId) window.localStorage.setItem(`metis:project-scenario:${activeResearchProjectId}`, scenarioId);
                      else window.localStorage.removeItem(`metis:project-scenario:${activeResearchProjectId}`);
                    }
                  } catch { /* preference persistence is best-effort */ }
                }}
                aria-label={t('chat.activeScenario')}
              >
                {scenarioLoadState === 'loading' && (
                  <option value="">{t('chat.scenarioLoadingOption')}</option>
                )}
                {scenarioLoadState === 'failed' && (
                  <option value="">{t('chat.scenarioUnavailableOption')}</option>
                )}
                {scenarioLoadState === 'ready' && (
                  <option value="">{t('chat.noCustomScenario')}</option>
                )}
                {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
              </select>
            </label>
            {/* 多对话架构第二期(2026-09-05):当前工作对象——正式持久化到 session,发送时注入模型上下文 */}
            {activeResearchProjectId && projectOutcomes.length > 0 && (
              <label>
                <span>{locale === 'zh' ? '当前成果' : 'Artifact'}</span>
                <select
                  value={activeArtifactIds[0] ?? ''}
                  onChange={(event) => {
                    const next = event.target.value ? [event.target.value] : [];
                    setActiveArtifactIds(next);
                    try {
                      if (currentSessionId) {
                        void window.metis?.updateSession?.(currentSessionId, { activeArtifactIds: next });
                        window.localStorage.setItem(`metis:session-artifacts:${currentSessionId}`, JSON.stringify(next));
                      }
                    } catch { /* best-effort */ }
                  }}
                  aria-label={locale === 'zh' ? '当前工作对象' : 'Active artifact'}
                  data-testid="chat-active-artifact"
                >
                  <option value="">{locale === 'zh' ? '不指定' : 'None'}</option>
                  {projectOutcomes.map((outcome) => <option key={outcome.id} value={outcome.id}>{outcome.title}</option>)}
                </select>
              </label>
            )}
            {scenarioLoadState === 'loading' && (
              <div role="status" className="chat-scenario-catalog-status">{t('chat.scenarioLoading')}</div>
            )}
            {scenarioLoadState === 'failed' && (
              <div role="alert" className="chat-scenario-catalog-status">
                {t('chat.scenarioLoadFailed')}
                <button
                  type="button"
                  className="btn-sm btn-secondary"
                  aria-label={t('chat.retryScenarioLoading')}
                  onClick={() => setScenarioLoadRevision((revision) => revision + 1)}
                >
                  {t('chat.retry')}
                </button>
              </div>
            )}
          </div>
        )}
        {/* 消息时间线（迁出至 components/chat/ChatMessageList.tsx，2026-09-15 拆分）：
            气泡、Goal 卡、O15 对比分组、fork 隐藏与 pending 时间线由组件注入。 */}
        <ChatMessageList
          messages={messages}
          isLoading={isLoading}
          activeGoalId={activeGoalId}
          streamPending={streamingIndexRef.current < 0}
          activeRunParts={activeRunParts}
          activeRunStartedAt={activeChatRequestRef.current?.startedAt}
          uiMode={resolvedUIMode}
          isFollowingLatest={isFollowingLatest}
          onReturnToLatest={scrollToLatest}
          chatMessagesRef={chatMessagesRef}
          messagesEndRef={messagesEndRef}
          onOpenPaper={openPaperByDoi}
          onEditMessage={handleEditMessageAtIndex}
          onRegenerate={stableRegenerate}
          onSwitchFork={stableSwitchFork}
          onStepCardComment={handleStepCardComment}
          onRegisterStepElement={registerGoalStepElement}
          updateGoalCard={updateGoalCard}
          findGoalCardIndex={findGoalCardIndex}
          syncGoalCardWorkflow={syncGoalCardWorkflow}
          createNewSession={createNewSession}
          renameSession={handleRenameSession}
          pauseGoal={handlePauseGoal}
          cancelGoal={handleCancelGoal}
          resumeGoal={handleResumeGoal}
          startPlannedGoal={handleStartPlannedGoal}
          setInput={setInput}
          onFocusComposer={focusComposer}
        />
        {selectionAskButton}
        <div
          className={`chat-input-area ${dragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOver(false);
            const sessionId = activeSessionIdRef.current;
            const generation = sessionGenerationRef.current;
            if (!sessionId) return;
            // Import dropped bytes into the main-process managed attachment area;
            // renderer code never receives or forwards a local filesystem path.
            const files = e.dataTransfer.files;
            if (!files?.length) return;
            for (const file of Array.from(files)) {
              if (!isCurrentSessionGeneration(sessionId, generation)) break;
              try {
                if (file.size <= 0 || file.size > FILE_CAPABILITY_LIMITS.maxImportBytes) continue;
                const imported = await window.metis?.importFileCapability({
                  purpose: 'artifact-attachment',
                  displayName: file.name,
                  mime: file.type || 'application/octet-stream',
                  data: new Uint8Array(await file.arrayBuffer()),
                });
                if (!imported?.success) continue;
                const filePath = imported.capability.capabilityId;
                const sizeStr = file.size > 1024 * 1024
                  ? `${(file.size / 1024 / 1024).toFixed(1)}MB`
                  : `${(file.size / 1024).toFixed(1)}KB`;
                const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const artifactType = inferArtifactType(file.name);
                if (window.metis?.createArtifact) {
                  const result = await window.metis.createArtifact({
                    id: artifactId,
                    sessionId,
                    name: file.name,
                    type: artifactType,
                    sourceCapabilityId: imported.capability.capabilityId,
                    size: sizeStr,
                  });
                  if (!result.success) continue;
                } else {
                  continue;
                }
                if (!isCurrentSessionGeneration(sessionId, generation)) break;
                setArtifacts((prev) => [{
                  id: artifactId,
                  name: file.name,
                  type: artifactType,
                  sourceCapability: imported.capability,
                  size: sizeStr,
                  createdAt: Date.now(),
                  contentAvailable: false,
                }, ...prev.filter((item) => item.id !== artifactId)]);
                setMessages((prev) => [...prev, {
                  role: 'system',
                  content: diagnosticMode
                    ? `[附件] **${file.name}** (${sizeStr}) 已导入。\n路径: \`${filePath}\``
                    : t('chat.attachmentImportedWithSize', {
                        name: file.name,
                        size: sizeStr,
                      }),
                  timestamp: now(),
                }]);
              } catch (err: unknown) {
                if (!isCurrentSessionGeneration(sessionId, generation)) break;
                setMessages((prev) => [...prev, {
                  role: 'system',
                  content: t('chat.importFailed', {
                    message: presentExecutionError(err, locale, resolvedUIMode),
                  }),
                  timestamp: now(),
                }]);
              }
            }
          }}
        >
          {goalSuggestion && !hasActiveScenarioRun && (
            <div className="chat-goal-suggestion" data-testid="goal-suggestion-bar">
              <span>{locale === 'zh' ? '这个请求适合作为长期研究任务执行。' : 'This request could run as a long-running research task.'}</span>
              <button
                type="button"
                className="btn-sm btn-primary"
                data-testid="goal-suggestion-button"
                disabled={isLoading}
                onClick={() => {
                  const text = goalSuggestion;
                  setGoalSuggestion(null);
                  if (text) void handleGoalFlow(text);
                }}
              >
                {locale === 'zh' ? '转为研究任务' : 'Turn into research task'}
              </button>
            </div>
          )}
          {stepTarget && (
            <div className="chat-target-chip" role="status" data-testid="chat-step-target">
              <span>{locale === 'zh' ? '针对' : 'Target'}: {stepTarget.title ? `步骤 · ${stepTarget.title}` : stepTarget.stepId}{stepTargetMode === 'modify' ? (locale === 'zh' ? '（修改模式）' : ' (modify)') : ''}</span>
              <button type="button" onClick={() => setStepTarget(null)} aria-label={locale === 'zh' ? '清除对话目标' : 'Clear target'}>×</button>
            </div>
          )}
          <div className="chat-input-grid">
            <div className="chat-input-maincol">
              <div className="chat-input-topbar" data-testid="chat-toolbar-row">
                {/* 学习技能按钮已按刘总要求移除（2026-09）。 */}
                <button
                  className="chat-top-tool"
                  onClick={handleAutoNameSession}
                  title={t('chat.autoName')}
                  aria-label={t('chat.autoName')}
                  data-testid="auto-name-session"
                  disabled={isLoading || messages.length === 0}
                >
                  <TagIcon size={14} />
                  <span>{locale === 'zh' ? '命名对话' : 'Name'}</span>
                </button>
                <ModelThinkingSelector zh={locale === 'zh'} labeled disabled={isLoading} />
              </div>
          {isLoading && liveToolRows.length > 0 && (
            <div className="chat-tool-strip" data-testid="chat-tool-strip" aria-live="polite">
              {liveToolRows.slice(-4).map((row) => (
                <div key={row.key} className={`chat-tool-row chat-tool-row--${row.state}`} data-testid="chat-tool-row">
                  <span className="chat-tool-row__dot" aria-hidden />
                  <span className="chat-tool-row__name">{row.tool ?? (locale === 'zh' ? '工具调用' : 'tool')}</span>
                  {row.summary && <span className="chat-tool-row__summary" title={row.summary}>{row.summary}</span>}
                </div>
              ))}
            </div>
          )}
          {queuedMessages.length > 0 && (
            <div className="chat-queue-strip" data-testid="chat-queue-strip" role="list" aria-label={locale === 'zh' ? '排队消息' : 'Queued messages'}>
              <span className="chat-queue-strip__label">{locale === 'zh' ? `排队中 (${queuedMessages.length})` : `Queued (${queuedMessages.length})`}</span>
              {queuedMessages.map((queued) => (
                <div key={queued.id} className="chat-queue-item" role="listitem" data-testid="chat-queue-item">
                  <span className="chat-queue-item__text" title={queued.text}>{queued.text.slice(0, 80)}{queued.text.length > 80 ? '…' : ''}</span>
                  <span className="chat-queue-item__actions">
                    <button type="button" className="chat-queue-item__btn" data-testid="chat-queue-send" title={locale === 'zh' ? '立即插队发送（作为实时引导下发给当前 run）' : 'Send now'} onClick={() => {
                      queue.remove(queued.id);
                      queue.sendNow(queued.text);
                    }}>{locale === 'zh' ? '立即发送' : 'Send now'}</button>
                    <button type="button" className="chat-queue-item__btn" data-testid="chat-queue-edit" title={locale === 'zh' ? '放回输入框编辑' : 'Edit in composer'} onClick={() => {
                      queue.takeForEdit(queued.id);
                      setInput(queued.text);
                      inputRef.current?.focus();
                    }}>{locale === 'zh' ? '编辑' : 'Edit'}</button>
                    <button type="button" className="chat-queue-item__btn chat-queue-item__btn--danger" data-testid="chat-queue-delete" title={locale === 'zh' ? '删除' : 'Delete'} onClick={() => {
                      queue.remove(queued.id);
                    }}>×</button>
                  </span>
                </div>
              ))}
            </div>
          )}
              <div className="chat-input-row">
                <button
                  className="chat-tool-icon chat-side-upload"
                  onClick={handleFileUpload}
                  title="上传文件"
                  aria-label="上传文件"
                  disabled={isLoading}
                >
                  <PaperclipIcon size={16} />
                </button>
                <VoiceMicButton disabled={isLoading} onTranscript={(voiceText) => {
                  setInput((current) => (current ? `${current} ${voiceText}` : voiceText));
                  inputRef.current?.focus();
                }} />
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (currentSessionId) writeSessionDraft(currentSessionId, e.target.value);
                    resetSlashTracking();
                  }}
                  onKeyDown={handleKeyDown}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={slashMenuOpen}
                  aria-controls={slashMenuOpen ? 'slash-command-listbox' : undefined}
                  aria-activedescendant={slashMenuOpen ? `slash-command-option-${activeSlashIndex}` : undefined}
                  placeholder={isLoading
                    ? (locale === 'zh'
                      ? '任务运行中 · 发送的消息将自动排队，当前轮结束后依序执行'
                      : 'A run is active · messages are queued and sent in order when it settles')
                    : t('chat.placeholder')}
                  className="chat-textarea"
                  rows={1}
                />
                {isLoading && <button
                  type="button"
                  onClick={() => void handleInterrupt()}
                  className="chat-interrupt"
                  disabled={controlState === 'interrupting'}
                  aria-label={locale === 'zh' ? '打断当前任务' : 'Interrupt active run'}
                >{controlState === 'interrupting' ? (locale === 'zh' ? '打断中…' : 'Stopping…') : (locale === 'zh' ? '打断' : 'Stop')}</button>}
                <button
                  onClick={() => handleSend()}
                  className="chat-send"
                  disabled={!input.trim()}
                >
                  {isLoading ? (locale === 'zh' ? '排队' : 'Queue') : t('common.send')}
                </button>
              </div>
            </div>
          </div>
          {slashMenuOpen && (
            <div
              id="slash-command-listbox"
              className="slash-command-menu"
              data-testid="slash-command-menu"
              role="listbox"
              aria-label={locale === 'zh' ? '斜杠命令建议' : 'Slash command suggestions'}
            >
              {slashSuggestions.slice(0, 8).map((command, index) => (
                <button
                  key={command.name}
                  id={`slash-command-option-${index}`}
                  className={`slash-command-item ${index === activeSlashIndex ? 'slash-command-item--active' : ''}`}
                  data-testid={`slash-cmd-${command.name}`}
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  onMouseEnter={() => setSlashActiveIndex(index)}
                  onClick={() => completeSlashCommand(index)}
                >
                  <strong>/{command.name}</strong> <span className="slash-command-item__desc">{command.description}</span>
                </button>
              ))}
             </div>
           )}
         </div>
    </div>
  );

  const rightPanel = (
    <RightPanel
      activeTab={activeRightPanelTab}
      onActiveTabChange={setActiveRightPanelTab}
      tasks={rightPanelTasks}
      artifacts={rightPanelArtifacts}
      previewContent={previewContent}
      previewTitle={previewContent ? previewTitle : undefined}
      artifactError={artifactError}
      uiMode={resolvedUIMode}
      embedded
      suppressInlinePreview={previewMode === 'pane'}
      onArtifactClick={(item) => void handleArtifactClick(item)}
      onTaskClick={(id) => {
        if (!activeGoalCard) return;
        const el = goalStepElementRefs.current.get(`${activeGoalCard.goalId} ${id}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}
    />
  );

  // 预览栏（2026-08-31 刘总布局重构）：projects 模式下预览内容以独立整列
  // 呈现在最右侧，由 ProjectsPage 做布局联动；其余模式仍走右栏内联预览。
  const previewPanel = previewMode === 'pane' && previewContent ? (
    <ArtifactPreviewPane
      title={previewTitle}
      content={previewContent}
      uiMode={resolvedUIMode}
      locale={locale}
      onClose={closePreview}
      onChartAdjust={onChartAdjust}
      onExportDocx={onExportDocx}
    />
  ) : null;

  return renderLayout({
    leftPanel,
    workspace,
    rightPanel,
    previewPanel,
  });
}
