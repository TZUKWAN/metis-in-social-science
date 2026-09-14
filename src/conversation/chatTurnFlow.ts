/**
 * 聊天回合主流程构造器（2026-09-15 拆分）。
 *
 * 从 ChatPage 迁出四个回合级主流程：handleChatFlow（普通聊天/场景轮，含
 * V2 流式权威结算）、runSendTurn（发送路由：斜杠拦截/会话自动创建/场景
 * 匹配/任务判定/「继续」接续）、handleSlashCommand（斜杠命令分发）与
 * handleRegenerate（O16 fork 重生成）。它们共享 isLoading、活动请求票据、
 * 执行事件缓冲与 fork 侧表等宿主状态，全部通过 deps 对象显式注入；留在
 * 宿主的引导/打断/Goal 流程回调同样以依赖注入。每次渲染重建构造器，闭包
 * 语义与迁出前的内联函数声明一致（任务/场景触发判定与 runActivity 等纯
 * 函数随迁）。纯移动，行为语义不变。
 */
import type { RefObject, SetStateAction } from 'react';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { loadForkMap, saveForkMap } from '../../engine/core/MessageFork.js';
import {
  decodeAgentResponse,
  type AgentResponse,
} from '../../engine/runtime/ChatRuntimeContract';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract';
import type { SessionListItem } from '../../engine/runtime/SessionRuntimeContract';
import type { TranslateFn } from '../i18n';
import { matchSlashCommand, SLASH_COMMANDS } from '../lib/slashCommands';
import {
  createAssistantMessageParts,
  normalizeAssistantEvent,
  reduceAssistantMessagePartsBatch,
  type AssistantMessageParts,
} from '../lib/assistantMessagePartsReducer';
import { presentExecutionError } from '../presentation/executionPresentation';
import { scrubPresentationProtocol } from '../presentation/presentationProtocolScrubber';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore';
import { useMetisStore } from '../store';
import type { ChatMessage } from '../pages/ChatPage';
import type { ConversationController } from './runtime/ConversationController.js';

/** 终端事件展示上限（迁出自 ChatPage 常量）。 */
export const AGENT_EXECUTION_EVENT_LIMIT = 256;

/** 无自定义场景时的兜底场景 id（迁出自 ChatPage 常量）。 */
export const DEFAULT_SCENARIO_ID = '';

/** 场景选择偏好持久化键（迁出自 ChatPage 常量）。 */
export const ACTIVE_SCENARIO_KEY = 'metis:active-scenario-id';

/** 回合请求票据：渲染端生成的身份键（token/turnId/会话代际/项目快照）。 */
export interface ChatTurnRequestTicket {
  token: symbol;
  turnId: string;
  sessionId: string;
  generation: number;
  projectId: string;
  startedAt: number;
}

function now(): number {
  return Date.now();
}

/** Renderer-owned run IDs let the execution event stream join an in-flight turn. */
function createAgentTurnId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `chat-${globalThis.crypto.randomUUID()}`;
  }
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `chat-${Date.now().toString(36)}-${randomPart || 'run'}`;
}

// ─── Scenario trigger matching（迁出自 ChatPage）──────────────

const triggerWordCharacterPattern = /[\p{Script=Latin}\p{N}_]/u;
const triggerLetterPattern = /\p{L}/u;
const triggerNumberPattern = /\p{N}/u;
const triggerLatinLetterPattern = /\p{Script=Latin}/u;

function requiresTriggerWordBoundaries(phrase: string): boolean {
  let hasLatinLetterOrNumber = false;
  for (const character of phrase) {
    if (triggerNumberPattern.test(character)) {
      hasLatinLetterOrNumber = true;
    } else if (triggerLetterPattern.test(character)) {
      if (!triggerLatinLetterPattern.test(character)) return false;
      hasLatinLetterOrNumber = true;
    }
  }
  return hasLatinLetterOrNumber;
}

function includesScenarioTrigger(content: string, phrase: string): boolean {
  if (!requiresTriggerWordBoundaries(phrase)) return content.includes(phrase);

  let searchFrom = 0;
  while (searchFrom <= content.length - phrase.length) {
    const matchIndex = content.indexOf(phrase, searchFrom);
    if (matchIndex === -1) return false;
    const before = Array.from(content.slice(0, matchIndex)).at(-1);
    const after = Array.from(content.slice(matchIndex + phrase.length))[0];
    const hasLeftBoundary = before === undefined || !triggerWordCharacterPattern.test(before);
    const hasRightBoundary = after === undefined || !triggerWordCharacterPattern.test(after);
    if (hasLeftBoundary && hasRightBoundary) return true;
    searchFrom = matchIndex + 1;
  }
  return false;
}

function matchScenarioTrigger(
  content: string,
  scenarios: readonly ScenarioDefinition[],
): ScenarioDefinition | undefined {
  const normalized = content.trim().toLocaleLowerCase();
  if (!normalized) return undefined;
  return scenarios
    .flatMap((scenario) => scenario.triggerPhrases.map((phrase) => ({
      scenario,
      phrase: phrase.trim().toLocaleLowerCase(),
    })))
    .filter((candidate) => candidate.phrase.length > 0 && includesScenarioTrigger(normalized, candidate.phrase))
    .sort((left, right) => right.phrase.length - left.phrase.length
      || left.scenario.name.localeCompare(right.scenario.name))[0]?.scenario;
}

// ─── Task detection heuristics（迁出自 ChatPage）──────────────

/**
 * UX-CHAT-003: 任务意图判定从「单关键词命中」收紧为「动作 + 交付物/持续执行
 * 信号」。疑问、讨论、列举研究问题等默认直接回答；显式 /goal、/task 命令和
 * 自主科研入口在路由层直接执行，不经过这里。
 */
const TASK_ACTION_ZH = /(帮我|请|创建|构建|写|撰写|起草|生成|准备|分析|研究|总结|比较|评审|设计|实现|开发|翻译|核对|核查|验证|检索|收集|整理|制定|规划|梳理|调查|执行)/u;
const TASK_DELIVERABLE_ZH = /(报告|论文|综述|大纲|方案|计划|表格|清单|列表|文档|文章|笔记|摘要|流程|代码|实验|项目|数据库|档案集|目录)/u;
const TASK_LONG_RUNNING_ZH = /(完成|执行|跑完|整个|从头到尾|分阶段|逐步|持续|整理成|输出为)/u;
const TASK_ACTION_EN = /\b(create|build|write|draft|generate|prepare|analyze|research|summarize|compare|review|design|implement|develop|conduct|perform|verify|collect|compile|organize)\b/i;
const TASK_DELIVERABLE_EN = /\b(report|paper|outline|plan|list|document|article|summary|task|workflow|code|experiment|project|analysis|review|database|archive)\b/i;
const TASK_LONG_RUNNING_EN = /\b(complete|execute|run|finish|entire|step by step|phase|deliverable)\b/i;

/** 宽松旧规则：只要命中「研究/分析/写/总结」等宽泛词就算任务（误判源）。 */
const OLD_BROAD_TASK_PATTERNS = [
  /\b(help me|create|build|write|analyze|research|generate|prepare|draft|summarize|compare|review|design|implement|develop|conduct|perform)\b/i,
  /(帮我|创建|构建|写|分析|研究|生成|准备|起草|总结|比较|评审|设计|实现|开发|翻译)/,
];

function isQuestionLike(trimmed: string): boolean {
  // 疑问句：以问号结尾，或以典型疑问词开头。
  if (/[?？]$/u.test(trimmed)) return true;
  return /^(什么|谁|何时|哪里|为什么|怎么|如何|是否|能否|哪些|哪个|请(问|教)|what|who|when|where|why|how|is|are|can|could|would|do|does|did)(?:\b)?/iu.test(trimmed);
}

/** 讨论/列举类表达：默认直接回答，不进入任务链路。 */
function isDiscussionLike(trimmed: string): boolean {
  return /(提出|列出|列举|讨论|谈谈|分析一下|请分析|总结一下|介绍一下|梳理一下).{0,30}(问题|观点|看法|思路|方向|建议|想法|议题)/u.test(trimmed);
}

function isTaskLike(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  // 显式命令（防御性；正常路由层已先行处理）。
  if (/^\/(goal|task|autonomous)\b/u.test(trimmed)) return true;
  // 疑问与讨论默认是聊天。
  if (isQuestionLike(trimmed)) return false;
  if (isDiscussionLike(trimmed)) return false;

  const zhAction = TASK_ACTION_ZH.test(trimmed);
  const zhSignal = TASK_DELIVERABLE_ZH.test(trimmed) || TASK_LONG_RUNNING_ZH.test(trimmed);
  if (zhAction && zhSignal) return true;

  const enAction = TASK_ACTION_EN.test(trimmed);
  const enSignal = TASK_DELIVERABLE_EN.test(trimmed) || TASK_LONG_RUNNING_EN.test(trimmed);
  if (enAction && enSignal) return true;

  return false;
}

/**
 * 低置信度任务表达：旧宽泛规则命中、但新规则判定为直接回答的输入。
 * 用于在回答旁提供非阻塞的「转为研究任务」操作，不新增确认弹窗。
 */
function isTaskAmbiguous(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (isQuestionLike(trimmed)) return false;
  return OLD_BROAD_TASK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ─── Execution activity trace（迁出自 ChatPage）───────────────

function runActivity(
  response: AgentResponse,
  initialParts: AssistantMessageParts = createAssistantMessageParts(),
): NonNullable<ChatMessage['run']> {
  // The final response owns the activity trace. Keep canonical live/replay tool
  // parts as supplemental detail because the terminal response may omit the
  // presenter-sanitized result/source payloads emitted by the live bridge.
  const base: AssistantMessageParts = {
    ...initialParts,
    run: {
      ...initialParts.run,
      phases: [...initialParts.run.phases],
      events: response.events.length > 0
        ? initialParts.run.events.filter((event) => event.type === 'tool_result')
        : [...initialParts.run.events],
    },
    tools: [...initialParts.tools],
    seenEventIds: [...initialParts.seenEventIds],
    seenSequences: [...initialParts.seenSequences],
    seenEventKeys: [...initialParts.seenEventKeys],
  };
  const parts = reduceAssistantMessagePartsBatch(
    response.events.map((event) => normalizeAssistantEvent(event)),
    base,
  );
  return {
    status: response.status,
    events: parts.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT),
    parts,
    turnId: response.turnId,
  };
}

// ─── Deps ─────────────────────────────────────────────────────

export interface ChatTurnFlowDeps {
  /** preload 桥接（生产传 window.metis；显式注入以便测试替换）。 */
  metis: typeof window.metis;
  locale: 'zh' | 'en';
  uiMode: UIMode;
  t: TranslateFn;
  /** 宿主快照（每渲染重建构造器，与原内联闭包一致）。 */
  currentSessionId: string;
  currentProjectId: string;
  /** 场景运行是否正在执行（projectScenarioRun?.status === 'running'）。 */
  hasActiveScenarioRun: boolean;
  messages: ChatMessage[];
  sessions: SessionListItem[];
  scenarios: readonly ScenarioDefinition[];
  activeScenarioId: string;
  activeSkillId: string | null;
  activeGoalId: string | null;
  /** /status 等回执文案需要知道运行状态。 */
  isLoading: boolean;
  /** 多对话架构第二期：当前工作对象（发送时注入模型上下文）。 */
  activeArtifactIds: string[];
  projectOutcomes: Array<{ id: string; title: string }>;
  // 回合身份与执行事件缓冲（宿主 refs）。
  sessionGenerationRef: RefObject<number>;
  streamingIndexRef: RefObject<number>;
  activeChatRequestRef: RefObject<ChatTurnRequestTicket | null>;
  agentExecutionPartsBufferRef: RefObject<Map<string, AssistantMessageParts>>;
  agentExecutionEventIdentityRef: RefObject<Map<string, { eventIds: Set<string>; sequences: Set<number>; contiguousSequence: number }>>;
  agentExecutionReplayInFlightRef: RefObject<Set<string>>;
  activeRunPartsRef: RefObject<AssistantMessageParts>;
  chatStreamControllerRef: RefObject<ConversationController | null>;
  // 宿主状态写入器。
  setMessages: (update: SetStateAction<ChatMessage[]>) => void;
  setInput: (value: string) => void;
  setActiveRunParts: (parts: AssistantMessageParts) => void;
  setIsLoading: (value: boolean) => void;
  setControlState: (value: 'idle' | 'interrupting') => void;
  setGoalSuggestion: (value: string | null) => void;
  setActiveScenarioId: (value: string) => void;
  // 宿主持有的回合配套回调。
  isCurrentChatRequest: (request: ChatTurnRequestTicket) => boolean;
  partsForAgentTurn: (turnId: string) => AssistantMessageParts;
  settleStreamingPlaceholder: (
    request: { startedAt: number },
    completedRun?: ChatMessage['run'],
  ) => boolean;
  openPreview: (content: string, title?: string) => void;
  refreshArtifactsForSession: (sessionId: string, generation: number) => Promise<void>;
  refreshSessionSummaries: () => void;
  /** 2.5 队列补发：run 结算后消费排队消息。 */
  flushNext: () => void;
  // 会话与 Goal / 引导 / 打断（留在宿主的流程）。
  createNewSession: () => Promise<string | null>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** 场景选择持久化兜底（handleSend 的 isLoading 分支同样使用，留在宿主）。 */
  readPersistedScenarioId: () => string | null;
  handleGoalFlow: (description: string, sessionIdOverride?: string) => Promise<void>;
  handleResumeGoal: (goalId: string) => Promise<void>;
  handleInterjection: (content: string, sessionIdOverride?: string) => Promise<void>;
  handleLiveInstruction: (
    content: string,
    options?: { userBubbleVisible?: boolean; fallback?: () => Promise<void> },
  ) => Promise<void>;
  handleInterrupt: () => Promise<void>;
}

export function createChatTurnFlow(deps: ChatTurnFlowDeps) {
  const {
    metis,
    locale,
    uiMode,
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
    flushNext,
    createNewSession,
    renameSession: handleRenameSession,
    readPersistedScenarioId,
    handleGoalFlow,
    handleResumeGoal,
    handleInterjection,
    handleLiveInstruction,
    handleInterrupt,
  } = deps;

  // ─── Normal chat flow (extracted from old handleSend) ──────

  async function handleChatFlow(content: string, scenarioId = activeScenarioId, sessionIdOverride?: string) {
    const request: ChatTurnRequestTicket = {
      token: Symbol('chat-request'),
      turnId: createAgentTurnId(),
      sessionId: sessionIdOverride ?? currentSessionId,
      generation: sessionGenerationRef.current,
      projectId: currentProjectId,
      startedAt: Date.now(),
    };
    activeChatRequestRef.current = request;
    agentExecutionPartsBufferRef.current.delete(request.turnId);
    agentExecutionEventIdentityRef.current.delete(request.turnId);
    agentExecutionReplayInFlightRef.current.delete(request.turnId);
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    setIsLoading(true);
    streamingIndexRef.current = -1;

    try {
      if (!metis) throw new Error('Metis API not available');

      const history = messages.concat({ role: 'user', content, timestamp: now() }).map((m) => ({
        role: (m.role === 'tool' || m.role === 'goal') ? 'assistant' : m.role,
        content: m.content,
      }));
      // 多对话架构第二期(2026-09-05):当前工作对象注入(真实进入模型上下文)。
      if (activeArtifactIds.length > 0) {
        const artifactTitles = activeArtifactIds
          .map((artifactId) => projectOutcomes.find((outcome) => outcome.id === artifactId || `outcome:${outcome.id}` === artifactId)?.title)
          .filter((title): title is string => Boolean(title));
        if (artifactTitles.length > 0) {
          history.unshift({ role: 'system', content: `[当前工作对象] ${artifactTitles.join('、')}。用户说"这篇文章/当前成果/这份PPT"等时指上述对象;对它的修改请使用对应的成果编辑能力。` });
        }
      }

      const response = decodeAgentResponse(await metis.agentChat(
        request.sessionId,
        history,
        activeSkillId ?? undefined,
        { mode: 'send', turnId: request.turnId, ...(scenarioId ? { scenarioId } : {}), projectId: request.projectId },
      ));
      if (!isCurrentChatRequest(request)) return;

      // P0 V2：以持久层权威内容结算流式 attempt（immediate 发布——不等帧）。
      // interrupted/error 路径同样结算：保留已生成的部分内容并标记终态（规格四十六/四十七）。
      const v2Controller = chatStreamControllerRef.current;
      if (v2Controller && (streamingIndexRef.current >= 0 || v2Controller.nodeSource(request.turnId).get())) {
        const v2Status = response.status === 'completed'
          ? 'completed'
          : (response.status === 'interrupted' || response.status === 'cancelled')
            ? 'interrupted'
            : 'failed';
        // 空 answer（如 unverified/error）沿用流式累积内容作为终态呈现。
        const accumulated = v2Controller.nodeSource(request.turnId).get();
        v2Controller.settleTurn(request.turnId, scrubPresentationProtocol(response.answer || accumulated?.content || ''), '', v2Status);
      }

      if (response.status !== 'completed') {
        // UX-CHAT-002: 先结算流式占位消息（空内容删除、部分内容标记草稿），
        // 再追加明确收据；不残留空白气泡与错误气泡并存的序列。
        const terminalRun = runActivity(
          response,
          response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts(),
        );
        const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
        if (response.status === 'interrupted' || response.status === 'cancelled') {
          // User-initiated stop: an explicit receipt, never an error presentation.
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: t('chat.interruptedNotice'),
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs: Date.now() - request.startedAt,
            ...(retainedStreamDraft ? {} : { run: terminalRun }),
          }]);
        } else {
          const diagnosticCode = response.diagnostics[0]?.code ?? response.status;
          const errorMsg: ChatMessage = {
            role: 'assistant',
            content: presentExecutionError(diagnosticCode, locale, uiMode),
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs: Date.now() - request.startedAt,
            ...(retainedStreamDraft ? {} : { run: terminalRun }),
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
      } else if (response.answer) {
        const safeAnswer = scrubPresentationProtocol(response.answer);
        const streamedIndex = streamingIndexRef.current;
        const durationMs = Date.now() - request.startedAt;
        if (streamedIndex >= 0) {
          // The stream already rendered the answer live; settle the message
          // with the authoritative payload and the measured elapsed time.
          // Settle dedupe: when the authoritative answer is byte-identical to
          // the accumulated stream, keep the content field untouched so the
          // bubble does not re-parse the full document a second time.
          setMessages((prev) => prev.map((m, i) => i === streamedIndex
            ? { ...m, ...(m.content === safeAnswer ? {} : { content: safeAnswer }), streaming: false, durationMs, run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()), ...(response.citations?.length ? { citations: response.citations } : {}) }
            : m));
        } else {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: safeAnswer,
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs,
            run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()),
            ...(response.citations?.length ? { citations: response.citations } : {}),
          };
          setMessages((prev) => [...prev, assistantMsg]);
          if (safeAnswer.length > 200 || /^#|^\*|\|.*\||```/.test(safeAnswer)) {
            openPreview(safeAnswer);
          }
        }
      }
      if (response.status === 'completed') {
        void refreshArtifactsForSession(request.sessionId, request.generation);
      }
    } catch (err) {
      if (!isCurrentChatRequest(request)) return;
      // UX-CHAT-002: 异常路径同样结算流式占位消息。
      const terminalRun: ChatMessage['run'] = {
        status: 'error',
        events: partsForAgentTurn(request.turnId).run.events,
        parts: partsForAgentTurn(request.turnId),
        turnId: request.turnId,
      };
      const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: presentExecutionError(err, locale, uiMode),
        timestamp: now(),
        startedAt: request.startedAt,
        durationMs: Date.now() - request.startedAt,
        ...(retainedStreamDraft ? {} : { run: terminalRun }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      if (isCurrentChatRequest(request)) {
        streamingIndexRef.current = -1;
        activeChatRequestRef.current = null;
        agentExecutionPartsBufferRef.current.delete(request.turnId);
        activeRunPartsRef.current = createAssistantMessageParts();
        setActiveRunParts(createAssistantMessageParts());
        setIsLoading(false);
        setControlState('idle');
        // UX-CHAT-004: 主进程已在回合内持久化消息，刷新权威会话摘要。
        refreshSessionSummaries();
        // 2.5: run 结束后自动发送队列中的下一条（保持时序）。
        flushNext();
      }
    }
  }

  /** Execute a slash command. Each maps to an existing system capability. */
  async function handleSlashCommand(name: string, arg: string) {
    const reply = (text: string) => {
      setMessages((prev) => [...prev, {
        role: 'user',
        content: `/${name}${arg ? ' ' + arg : ''}`,
        timestamp: now(),
      }, {
        role: 'system',
        content: text,
        timestamp: now(),
      }]);
    };
    setInput('');

    switch (name) {
      case 'chat': {
        if (!arg) { reply('用法：/chat <内容>'); return; }
        // Dispatch as normal chat — keeps the active scenario (bypasses
        // auto-match but does not clear an explicitly selected scenario).
        setMessages((prev) => [...prev, { role: 'user', content: arg, timestamp: now() }]);
        await handleChatFlow(arg, activeScenarioId || DEFAULT_SCENARIO_ID);
        return;
      }
      case 'goal':
      case 'task': {
        if (!arg) { reply('用法：/' + name + ' <描述>'); return; }
        await handleGoalFlow(arg);
        return;
      }
      case 'autonomous': {
        if (!arg) { reply('用法：/autonomous <研究目标>'); return; }
        try {
          const projectId = researchWorkspaceStore.getState().activeProjectId ?? undefined;
          const result = await metis?.autonomousStart?.({ goal: arg, projectId });
          if (result?.ok) {
            reply(`🚀 已启动自主科研（目标：${arg}${projectId ? ` · 项目：${projectId}` : ''}）。请打开顶部「自主科研」面板查看 idea→实验→分析→论文 的实时进度，或用 /stop 中断。`);
          } else {
            reply(`启动失败：${result?.error ?? '未知错误'}。可能已有任务在运行，或引擎未就绪。`);
          }
        } catch (err) {
          reply(`启动异常：${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case 'scenario': {
        if (!arg) { reply('用法：/scenario <名称>'); return; }
        const matched = matchScenarioTrigger(arg, scenarios);
        if (matched) {
          setActiveScenarioId(matched.id);
          try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, matched.id); } catch { /* preference persistence */ }
          reply(`已切换到场景：${matched.name}`);
        } else {
          reply(`未找到匹配的场景「${arg}」。可用场景：${scenarios.map((s) => s.name).join('、')}`);
        }
        return;
      }
      case 'search': {
        // Open the global search overlay (App-level state) through a bus event.
        window.dispatchEvent(new CustomEvent('metis:open-search'));
        reply(locale === 'zh' ? `已打开全局搜索${arg ? `，正在搜索「${arg}」` : ''}。` : `Global search opened${arg ? ` for “${arg}”` : ''}.`);
        return;
      }
      case 'paper': {
        if (!arg) { reply('用法：/paper <标题或 DOI>'); return; }
        const projectId = researchWorkspaceStore.getState().activeProjectId ?? undefined;
        const paper = {
          id: `paper_slash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          title: arg, authors: [] as string[], year: new Date().getFullYear(),
          venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread' as const,
          rating: 0, referenceIds: [], addedAt: Date.now(), projectId,
        };
        const result = await useMetisStore.getState().addPaper(paper);
        if (projectId && result.paper.id) {
          await metis?.linkPaperToProject?.({ paperId: result.paper.id, projectId, link: true });
        }
        reply(projectId
          ? `已添加文献并关联当前项目：${arg}`
          : `已添加到资料库：${arg}`);
        return;
      }
      case 'note': {
        if (!arg) { reply('用法：/note <内容>'); return; }
        await useMetisStore.getState().addNote({
          id: `note_slash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          title: arg.slice(0, 40), content: arg, tags: [], linkedPaperIds: [],
          linkedNoteIds: [], updatedAt: Date.now(),
        });
        reply(`已添加笔记：${arg.slice(0, 40)}`);
        return;
      }
      case 'export': {
        const format = arg.trim().toLowerCase() || 'chat';
        if (format === 'chat') {
          const md = messages.map((m) => m.role === 'user' ? `\n## 我\n${m.content}` : m.role === 'system' ? `\n> ${m.content}` : `\n## AI\n${m.content}`).join('\n');
          const blob = new Blob([md], { type: 'text/markdown' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `chat-${currentSessionId.slice(0, 8)}.md`;
          a.click();
          URL.revokeObjectURL(a.href);
          reply('会话已导出为 Markdown。');
        } else {
          reply(`文献库导出请在设置页操作（格式：${format}）。`);
        }
        return;
      }
      case 'stop': {
        await handleInterrupt();
        return;
      }
      case 'skill': {
        // /skill [意图描述] — learn from the current conversation and install
        // a reusable skill. The conversation history is sent to the AI which
        // distills it into a structured systemPrompt + tool allow-list.
        if (messages.length === 0) { reply('当前没有对话可学习。'); return; }
        const convo = messages
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
          .map((m) => ({ role: m.role, content: m.content }));
        if (convo.length < 2) { reply('对话太短，至少需要一轮问答才能学习。'); return; }
        reply(`正在从 ${convo.length} 条对话中提取技能…`);
        try {
          const result = await metis?.generateSkillFromConversation?.({ messages: convo, userIntent: arg || undefined });
          if (result?.ok && result.skill) {
            const s = result.skill;
            reply([
              `技能「${s.name}」已生成并安装！`,
              `用途：${s.description}`,
              `工具：${s.allowedTools.length > 0 ? s.allowedTools.join(', ') : '（无）'}`,
              `回合预算：${s.maxTurns}`,
              `提取依据：${s.rationale}`,
              ``,
              `下次对话时在技能选择器中选择「${s.name}」即可复用这个工作流。`,
            ].join('\n'));
          } else {
            reply(`技能生成失败：${result?.error ?? '未知错误'}`);
          }
        } catch (err) {
          reply(`技能生成异常：${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case 'pause': {
        if (!activeGoalId) { reply('当前没有运行中的目标任务。'); return; }
        const result = await metis?.pauseGoal?.(activeGoalId) as { success?: boolean; code?: string } | undefined;
        reply(result?.success
          ? '已请求暂停，当前步骤完成后会保存断点并停止。'
          : '当前目标无法暂停，可能已经结束或没有活动运行。');
        return;
      }
      case 'resume': {
        if (!activeGoalId) { reply('当前没有暂停的目标任务。'); return; }
        await metis?.resumeGoal?.(activeGoalId);
        reply('目标已恢复运行。');
        return;
      }
      case 'status': {
        const parts: string[] = [];
        parts.push(`项目：${researchWorkspaceStore.getState().activeProjectId ?? '未选择'}`);
        parts.push(`场景：${scenarios.find((s) => s.id === activeScenarioId)?.name ?? '默认'}`);
        parts.push(`目标：${activeGoalId ? '运行中' : '无'}`);
        parts.push(`状态：${isLoading ? '正在处理' : '空闲'}`);
        reply(parts.join('\n'));
        return;
      }
      case 'help': {
        const lines = SLASH_COMMANDS.map((c) => `/${c.name}${c.hasArg ? ' <参数>' : ''} — ${c.description}`);
        reply('可用命令：\n' + lines.join('\n'));
        return;
      }
      default:
        reply(`未知命令：/${name}。输入 /help 查看可用命令。`);
    }
  }

  // ─── Send message (router) ────────────────────────────────

  async function runSendTurn(raw: string, scenarioOverride?: string) {

    // Slash commands: intercept before scenario matching / task detection.
    const slashMatch = matchSlashCommand(raw);
    if (slashMatch) {
      await handleSlashCommand(slashMatch.command.name, slashMatch.arg);
      return;
    }

    // Force plain chat with prefix
    const forceChat = raw.startsWith('/chat ') || raw.startsWith('? ');
    const content = forceChat ? raw.replace(/^(\/chat |\? )/, '') : raw;

    // Auto-create a session on first send: previously, messages sent without
    // clicking 「新会话」 first were never persisted — the sidebar kept showing
    // 无会话 and the whole conversation vanished on reload. The first message
    // now implicitly creates (and persists) a session, matching what the UI
    // already displays.
    let sessionIdForTurn = currentSessionId;
    let createdThisTurn = false;
    if (!sessionIdForTurn) {
      const created = await createNewSession();
      if (created) {
        sessionIdForTurn = created;
        createdThisTurn = true;
      }
    }

    // Append user message
    const userMsg: ChatMessage = { role: 'user', content, timestamp: now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    // Auto-title a fresh session from its first user message so the sidebar
    // distinguishes conversations instead of showing multiple "新会话".
    const currentSession = sessions.find((session) => session.id === currentSessionId);
    const defaultTitle = t('chat.newSessionTitle');
    const trimmed = content.trim();
    if (createdThisTurn && trimmed) {
      // The session was just created, so it is not in `sessions` state yet —
      // rename it directly from this first message.
      void handleRenameSession(
        sessionIdForTurn,
        trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed,
      );
    } else if (currentSession && (!currentSession.title || currentSession.title === defaultTitle) && trimmed) {
      void handleRenameSession(
        currentSessionId,
        trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed,
      );
    }

    // Normal chat persistence is owned by the main process so each message is
    // committed once. Goal-only messages still use appendMessage below.
    const hasActiveGoal = activeGoalId !== null;

    // UX-CHAT-003（2026-08-29 刘总要求）：已选场景时步骤规定明确，不再建议
    // "转为研究任务"——任务直接按场景工作流执行；仅无场景时保留 Goal 兜底建议。
    setGoalSuggestion(!forceChat && !activeScenarioId && isTaskAmbiguous(content) ? content : null);

    // 场景选择持久化兜底统一走 readPersistedScenarioId（handleSend 的
    // isLoading 兜底同样需要，2026-08-31 修复作用域断裂）。
    const persistedScenarioId = readPersistedScenarioId();
    const selectedScenarioId = scenarioOverride ?? (activeScenarioId || persistedScenarioId || '');
    const matchedScenario = selectedScenarioId ? undefined : matchScenarioTrigger(content, scenarios);
    const scenarioForTurn = selectedScenarioId || matchedScenario?.id || DEFAULT_SCENARIO_ID;
    if (matchedScenario) {
      setActiveScenarioId(matchedScenario.id);
      try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, matchedScenario.id); } catch { /* preference persistence is best-effort */ }
    }


    void metis?.rendererLog?.(`route: user=${JSON.stringify(content.slice(0, 40))} activeScenarioId=${JSON.stringify(activeScenarioId)} persisted=${JSON.stringify(persistedScenarioId ?? null)} selected=${JSON.stringify(selectedScenarioId)} scenarioForTurn=${JSON.stringify(scenarioForTurn)} hasActiveScenarioRun=${hasActiveScenarioRun} hasActiveGoal=${hasActiveGoal} isTaskLike=${isTaskLike(content)} forceChat=${forceChat}`);
    // 「继续」的系统级语义（2026-08-30 刘总点破：关闭后继续总是重开新任务）：
    // 场景运行的可恢复断点由主进程自动 resume（场景绑定轮走 handleChatFlow，
    // getRecoverableScenarioRun 会接上 interrupted/paused/running 的 checkpoint）；
    // 没有场景运行时，「继续」必须接回最近一个 paused 的研究任务（Goal），
    // 而不是当作新输入被普通聊天吞掉。
    if (!hasActiveScenarioRun && !hasActiveGoal && !forceChat && !scenarioForTurn
      && /^(继续|接着做|接着干|继续执行|continue|resume)[\s!！。.]*$/i.test(content.trim())) {
      try {
        const goalsResult = await metis?.listGoals?.();
        // 选择策略与场景恢复同规（系统性教训：不能按列表顺序取第一个）：
        // 优先当前项目的 paused 任务，再取最近创建的——「继续」必须接上
        // 用户最可能指的那条工作，而不是任意一条。
        const pausedGoals = (goalsResult?.goals ?? []).filter((goal) => goal.status === 'paused');
        const resumableGoal = pausedGoals
          .filter((goal) => !goal.projectId || goal.projectId === currentProjectId)
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
          ?? pausedGoals.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
        if (resumableGoal) {
          await handleResumeGoal(resumableGoal.goalId);
          return;
        }
      } catch { /* goal 列表失败则按普通输入处理 */ }
    }
    if (hasActiveScenarioRun && !forceChat) {
      // 场景工作流执行中（2026-08-29 刘总要求）：随时引导，新消息实时注入
      // 当前运行，而不是当作新任务被"已有任务在执行"拒绝。若运行其实已被
      // 中断（应用重启等），no_active_run 会自动降级为断点恢复轮。
      await handleLiveInstruction(content, {
        userBubbleVisible: true,
        fallback: () => handleChatFlow(content, scenarioForTurn, sessionIdForTurn || undefined),
      });
      return;
    }
    if (scenarioForTurn) {
      await handleChatFlow(content, scenarioForTurn, sessionIdForTurn || undefined);
    } else if (!forceChat && !hasActiveGoal && isTaskLike(content)) {
      await handleGoalFlow(content, sessionIdForTurn || undefined);
    } else if (hasActiveGoal && !forceChat) {
      await handleInterjection(content, sessionIdForTurn || undefined);
    } else {
      await handleChatFlow(content, DEFAULT_SCENARIO_ID, sessionIdForTurn || undefined);
    }
  }

  // Regenerate last assistant response
  async function handleRegenerate() {
    const lastUserIndex = [...messages].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIndex === -1) return;
    const actualIndex = messages.length - 1 - lastUserIndex;
    const forkId = `fork-${Date.now()}`;
    const history = messages.slice(0, actualIndex + 1);
    const request: ChatTurnRequestTicket = {
      token: Symbol('regenerate-request'),
      turnId: createAgentTurnId(),
      sessionId: currentSessionId,
      generation: sessionGenerationRef.current,
      projectId: currentProjectId,
      startedAt: Date.now(),
    };
    activeChatRequestRef.current = request;
    agentExecutionPartsBufferRef.current.delete(request.turnId);
    agentExecutionEventIdentityRef.current.delete(request.turnId);
    agentExecutionReplayInFlightRef.current.delete(request.turnId);
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    // O16: keep the previous answer as an inactive sibling branch. If it is
    // already part of a fork group, extend that group (3rd, 4th regenerate…);
    // otherwise start a new fork. Older siblings keep their original indexes.
    const priorAssistant = messages[actualIndex + 1];
    const existingForkId = priorAssistant?.forkId;
    const priorForkCount = priorAssistant?.forkCount ?? 1;
    const markedHistory = priorAssistant?.role === 'assistant'
      ? [
        ...history,
        {
          ...priorAssistant,
          // Only promote the *old* answer to fork state when it isn't already
          // in a group; if it is, it stays at its index and the new one gets
          // the next index below.
          ...(priorAssistant.forkId ? {} : { forkId, forkIndex: 0 }),
          forkCount: existingForkId ? priorForkCount + 1 : 2,
          forkActive: false,
        },
      ]
      : history;
    // O16: persist the fork bookkeeping (including sibling contents) so all
    // branches survive a reload — the main-process history only keeps the
    // final answer, so old siblings live in this side table.
    if (priorAssistant?.role === 'assistant' && currentSessionId) {
      const map = loadForkMap(currentSessionId, localStorage);
      const targetForkId = existingForkId ?? forkId;
      // Re-anchor any previously persisted siblings under the same forkId.
      const siblings = [...map.values()]
        .filter((r) => r.forkId === targetForkId)
        .map((r) => ({ ...r, forkCount: priorForkCount + 1 }));
      siblings.forEach((r) => map.set(r.forkId, r));
      map.set(targetForkId, {
        forkId: targetForkId,
        forkIndex: existingForkId ? (priorAssistant.forkIndex ?? 0) : 0,
        forkCount: existingForkId ? priorForkCount + 1 : 2,
        content: priorAssistant.content,
        timestamp: priorAssistant.timestamp,
      });
      saveForkMap(currentSessionId, map, localStorage);
    }
    setMessages(markedHistory);
    setIsLoading(true);
    streamingIndexRef.current = -1;

    try {
      if (!metis) throw new Error('Metis API not available');

      const response = decodeAgentResponse(await metis.agentChat(
        request.sessionId,
        history.map((m) => ({ role: (m.role === 'tool' || m.role === 'goal') ? 'assistant' : m.role, content: m.content })),
        activeSkillId ?? undefined,
        { mode: 'regenerate', turnId: request.turnId, ...(activeScenarioId ? { scenarioId: activeScenarioId } : {}), projectId: request.projectId },
      ));
      if (!isCurrentChatRequest(request)) return;

      if (response.status !== 'completed') {
        const terminalRun = runActivity(
          response,
          response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts(),
        );
        const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
        const diagnosticCode = response.diagnostics[0]?.code ?? response.status;
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: response.status === 'interrupted' || response.status === 'cancelled'
            ? t('chat.interruptedNotice')
            : presentExecutionError(diagnosticCode, locale, uiMode),
          timestamp: now(),
          startedAt: request.startedAt,
          durationMs: Date.now() - request.startedAt,
          ...(retainedStreamDraft ? {} : { run: terminalRun }),
        }]);
      } else if (response.answer) {
        const safeAnswer = scrubPresentationProtocol(response.answer);
        const streamedIndex = streamingIndexRef.current;
        const durationMs = Date.now() - request.startedAt;
        if (streamedIndex >= 0) {
          // Settle dedupe identical to handleChatFlow: skip the content
          // replacement when the authoritative answer matches the stream.
          setMessages((prev) => prev.map((m, i) => i === streamedIndex
            ? { ...m, ...(m.content === safeAnswer ? {} : { content: safeAnswer }), streaming: false, durationMs, run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()), ...(response.citations?.length ? { citations: response.citations } : {}) }
            : m));
        } else {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: safeAnswer,
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs,
            run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()),
            ...(response.citations?.length ? { citations: response.citations } : {}),
            // O16: the regenerated answer is the newest active sibling in its
            // fork group (existing group extends, or a fresh group is born).
            ...(priorAssistant?.role === 'assistant'
              ? { forkId: existingForkId ?? forkId, forkIndex: existingForkId ? priorForkCount : 1, forkCount: existingForkId ? priorForkCount + 1 : 2, forkActive: true }
              : {}),
          };
          setMessages((prev) => [...prev, assistantMsg]);
        }
        // Live preview: if the response is substantial (artifact-length), render it in the
        // right panel's preview area (Claude-Artifacts-style split view).
        if (safeAnswer.length > 200 || /^#|^\*|\|.*\||```/.test(safeAnswer)) {
          openPreview(safeAnswer);
        }
      }
      if (response.status === 'completed') {
        void refreshArtifactsForSession(request.sessionId, request.generation);
      }
    } catch (err) {
      if (!isCurrentChatRequest(request)) return;
      const terminalRun: ChatMessage['run'] = {
        status: 'error',
        events: partsForAgentTurn(request.turnId).run.events,
        parts: partsForAgentTurn(request.turnId),
        turnId: request.turnId,
      };
      const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: presentExecutionError(err, locale, uiMode),
        timestamp: now(),
        startedAt: request.startedAt,
        durationMs: Date.now() - request.startedAt,
        ...(retainedStreamDraft ? {} : { run: terminalRun }),
      }]);
    } finally {
      if (isCurrentChatRequest(request)) {
        streamingIndexRef.current = -1;
        activeChatRequestRef.current = null;
        agentExecutionPartsBufferRef.current.delete(request.turnId);
        activeRunPartsRef.current = createAssistantMessageParts();
        setActiveRunParts(createAssistantMessageParts());
        setIsLoading(false);
        setControlState('idle');
      }
    }
  }

  return {
    handleChatFlow,
    handleSlashCommand,
    runSendTurn,
    handleRegenerate,
  };
}
