/**
 * ChatMessageList — 消息时间线（2026-09-15 拆分）。
 *
 * 从 ChatPage 迁出的自包含渲染组件：消息气泡（ChatMessageItem）、Goal 卡
 * （renderGoal + buildGoalCardActions 接线）、O15 多模型对比并排分组、
 * O16 fork 隐藏分支、运行中时间线占位与「回到最新」按钮。render 支持件
 * （Markdown 渲染、代码块工厂、emoji 过滤、ToolCallCard、elapsed 计时器）
 * 随迁；数据与回调全部由宿主显式注入。纯移动，DOM 结构与语义不变。
 */
import { memo, useCallback, useEffect, useState, type ReactNode, type RefObject } from 'react';
import type { Components } from 'react-markdown';
import { useTranslation } from '../../i18n';
import { CodeBlock } from '../CodeBlock';
import { ScenarioStepCard, parseScenarioStepCard, type ScenarioStepCardData } from '../ScenarioStepCard';
import { ScenarioStepCardWithActions } from '../../conversation/ScenarioStepCardWithActions';
import GoalCardInline, { type GoalCardData } from '../GoalCardInline';
import ToolExecutionCard from '../ToolExecutionCard';
import AgentActivityTimeline from '../AgentActivityTimeline';
import { assistantToolPartFromLegacy, type AssistantMessageParts, type AssistantToolPart } from '../../lib/assistantMessagePartsReducer';
import { presentDiagnosticText } from '../../presentation/executionPresentation';
import { SafeMarkdown, type SafeMarkdownMode } from '../../presentation/SafeMarkdown';
import { StreamingMarkdown } from '../../presentation/StreamingMarkdown';
import { presentReasoningDiagnostic, presentReasoningSummary } from '../../presentation/reasoningPresentation';
import { buildGoalCardActions } from '../../conversation/goalCardActions';
import { stripEmoji, transformChatMarkdown } from '../../conversation/chatMarkdown';
import { showToast } from '../../lib/toast';
import { ClockIcon } from '../Icons';
import type { ChatMessage } from '../../pages/ChatPage';
import type { UIMode } from '../../../engine/capabilities/DiagnosticMode';

// ─── Inline SVG Icons ─────────────────────────────────────────


const editIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const regenerateIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.5 2v6h-6M2.5 22v-6h6" />
    <path d="M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" />
  </svg>
);

const copyIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

// ─── Markdown Renderer ────────────────────────────────────────

/**
 * Module-level code renderer factory so the `code` component keeps a stable
 * identity across renders (a per-render closure would defeat memoization).
 * While `streaming` is true, fenced blocks skip Prism highlighting and render
 * as plain text; the settled path highlights as before.
 */
/** T3：metadata.stepCard 消息的渲染协议（非 Markdown 围栏；content 前缀承载）。 */
function parseStepCardPrefix(content: string): ScenarioStepCardData | null {
  if (!content.startsWith('__STEP_CARD__')) return null;
  try {
    const value = JSON.parse(content.slice('__STEP_CARD__'.length)) as ScenarioStepCardData;
    return value && typeof value === 'object' && typeof value.runId === 'string' ? value : null;
  } catch {
    return null;
  }
}

function createChatCodeComponent(streaming: boolean): Components['code'] {
  return function ChatMarkdownCode({ className, children, ...props }) {
    const match = /language-([\w-]+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');
    if (match && match[1] === 'metis-step-card') {
      // 步骤卡（2026-09-01 刘总方案）：场景工作流步骤的结构化卡片，
      // 解析失败（旧消息/坏数据）降级为普通代码块展示。
      const card = parseScenarioStepCard(code);
      if (card) return <ScenarioStepCard card={card} />;
    }
    if (match && match[1]) {
      return <CodeBlock language={match[1]} code={code} streaming={streaming} />;
    }
    return <code className="inline-code" {...props}>{children}</code>;
  };
}

const settledChatCodeComponent = createChatCodeComponent(false);
const streamingChatCodeComponent = createChatCodeComponent(true);

const MarkdownContent = memo(function MarkdownContent({
  content,
  uiMode,
  locale,
  onOpenPaper,
}: {
  content: string;
  uiMode: SafeMarkdownMode;
  locale: 'en' | 'zh';
  onOpenPaper?: (doi: string) => void;
}) {
  return (
    <SafeMarkdown
      content={transformChatMarkdown(content)}
      uiMode={uiMode}
      locale={locale}
      onOpenPaper={onOpenPaper}
      codeComponent={settledChatCodeComponent}
    />
  );
});

// ─── Tool Call Card ───────────────────────────────────────────

export function ToolCallCard({
  toolCall,
  tool,
  diagnosticMode,
}: {
  toolCall?: ChatMessage['toolCall'];
  tool?: AssistantToolPart;
  diagnosticMode: boolean;
}) {
  const { locale } = useTranslation();
  const canonicalTool = tool ?? (toolCall ? assistantToolPartFromLegacy(toolCall) : undefined);
  return canonicalTool
    ? <ToolExecutionCard tool={canonicalTool} diagnosticMode={diagnosticMode} locale={locale} className="tool-call-card" />
    : null;
}

// ─── Message Component ────────────────────────────────────────

// Memoized at the module level so a token flush re-renders only the bubble
// whose message object actually changed.
const MemoizedAgentActivityTimeline = memo(AgentActivityTimeline);

// Live elapsed timer for the streaming bubble. Isolated in its own component
// so the 500ms ticker re-renders this span only, not the whole bubble.
function MessageElapsed({
  startedAt,
  durationMs,
  streaming,
}: {
  startedAt?: number;
  durationMs?: number;
  streaming?: boolean;
}) {
  const [elapsedMs, setElapsedMs] = useState(durationMs ?? 0);
  useEffect(() => {
    if (streaming && startedAt) {
      const timer = window.setInterval(() => {
        setElapsedMs(Date.now() - (startedAt ?? Date.now()));
      }, 500);
      return () => window.clearInterval(timer);
    }
    // Settle the timer once streaming stops; deferred so the effect body
    // stays free of synchronous setState.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setElapsedMs(durationMs ?? 0);
    });
    return () => { cancelled = true; };
  }, [streaming, startedAt, durationMs]);
  return (
    <span className="message-elapsed" data-testid="message-elapsed">
      <ClockIcon size={12} /> {(elapsedMs / 1000).toFixed(1)}s
    </span>
  );
}

const ChatMessageItem = memo(function ChatMessageItem({
  msg,
  index,
  onEdit,
  onRegenerate,
  onSwitchFork,
  isLast,
  diagnosticMode,
  onOpenPaper,
  onStepCardComment,
}: {
  msg: ChatMessage;
  /** Source index in the messages array, forwarded to onEdit. */
  index: number;
  onEdit?: (index: number, content: string) => void;
  onRegenerate?: () => void;
  /** O16: switch which fork sibling is displayed. */
  onSwitchFork?: (forkId: string, targetIndex: number) => void;
  /** T3 二期：Step 卡三操作——提出意见/修改这步 打开 Composer Target Context。 */
  onStepCardComment?: (card: ScenarioStepCardData, mode: 'comment' | 'modify') => void;
  isLast?: boolean;
  onOpenPaper?: (doi: string) => void;
  diagnosticMode: boolean;
}) {
  const { t, locale } = useTranslation();
  const messageUIMode: SafeMarkdownMode = diagnosticMode ? 'diagnostic' : 'normal';
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(stripEmoji(msg.content));
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const content = msg.content || msg.reasoning || '';
    if (!content) return;
    const fallback = () => {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch { /* clipboard unavailable */ }
      document.body.removeChild(textarea);
      setCopied(true);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(
        () => setCopied(true),
        () => fallback(),
      );
    } else {
      fallback();
    }
    window.setTimeout(() => setCopied(false), 1500);
  }, [msg.content, msg.reasoning]);

  const handleEditSubmit = () => {
    const cleaned = stripEmoji(editValue).trim();
    if (cleaned && onEdit) {
      onEdit(index, cleaned);
    }
    setEditing(false);
  };

  const avatarLabel = msg.role === 'user'
    ? 'U'
    : diagnosticMode && msg.role === 'tool'
      ? 'T'
      : diagnosticMode && msg.role === 'goal'
        ? 'G'
        : 'M';

  // dsh-style live reasoning summary: while streaming a multi-line reasoning
  // trace, the latest line surfaces next to the label. Single-line traces
  // skip it so the summary never duplicates the body verbatim.
  const reasoningSummary = msg.reasoning
    ? presentReasoningSummary(msg.reasoning, locale)
    : '';
  const diagnosticReasoning = diagnosticMode && msg.reasoning
    ? presentReasoningDiagnostic(msg.reasoning, locale)
    : '';

  return (
    <div className={`chat-message ${msg.role}`}>
      <div className="message-avatar">
        {avatarLabel}
      </div>
      <div className="message-body">
        {msg.role === 'assistant' && msg.run && (
          <MemoizedAgentActivityTimeline
            status={msg.run.status}
            events={msg.run.events}
            parts={msg.run.parts}
            startedAt={msg.startedAt}
            durationMs={msg.durationMs}
            locale={locale}
            diagnosticMode={diagnosticMode}
            historyIncomplete={msg.run.historyIncomplete}
            pendingLabel={msg.run.historyIncomplete
              ? (locale === 'zh' ? '执行历史已部分裁剪' : 'Execution history is partially pruned')
              : undefined}
          />
        )}
        {msg.role === 'tool' ? (
          msg.run?.parts?.tools[0] || msg.toolCall ? (
            <ToolCallCard
              tool={msg.run?.parts?.tools[0]}
              toolCall={msg.toolCall}
              diagnosticMode={diagnosticMode}
            />
          ) : (
            <div className="message-content">
              {diagnosticMode
                ? <MarkdownContent content={presentDiagnosticText(msg.content)} uiMode={messageUIMode} locale={locale} onOpenPaper={onOpenPaper} />
                : t('chat.researchOperationCompleted')}
            </div>
          )
        ) : editing ? (
          <div className="message-edit">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              rows={3}
              autoFocus
            />
            <div className="message-edit-actions">
              <button className="btn-sm" onClick={() => setEditing(false)}>{t('chat.cancel')}</button>
              <button className="btn-sm btn-primary" onClick={handleEditSubmit}>{t('chat.saveResend')}</button>
            </div>
          </div>
        ) : (
          <div className="message-content">
            {msg.role === 'assistant' && reasoningSummary && (
              <details className="chat-reasoning" open={Boolean(msg.streaming)}>
                <summary>
                  {msg.streaming ? t('chat.reasoningThinking') : t('chat.reasoningLabel')}
                  <span className="chat-reasoning__latest">{reasoningSummary}</span>
                </summary>
                {diagnosticReasoning && <div className="chat-reasoning__body">{diagnosticReasoning}</div>}
              </details>
            )}
            {msg.role === 'assistant' && parseStepCardPrefix(msg.content) ? (() => {
              const card = parseStepCardPrefix(msg.content)!;
              return <ScenarioStepCardWithActions card={card} onComment={(c, m) => onStepCardComment?.(c, m)} />;
            })() : msg.role === 'assistant' && msg.streaming ? (
              <StreamingMarkdown
                text={msg.content}
                streaming
                uiMode={messageUIMode}
                locale={locale}
                onOpenPaper={onOpenPaper}
                codeComponent={streamingChatCodeComponent}
                transform={transformChatMarkdown}
              />
            ) : (
              <MarkdownContent content={msg.content} uiMode={messageUIMode} locale={locale} onOpenPaper={onOpenPaper} />
            )}
            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
              <div className="chat-citations" data-testid="chat-citations">
                {msg.citations.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="chat-citation"
                    title={c.quote || c.label}
                    onClick={() => {
                      if (c.paperId) {
                        window.dispatchEvent(new CustomEvent('metis:open-paper', { detail: { paperId: c.paperId, page: c.page } }));
                      } else if (c.doi) {
                        window.dispatchEvent(new CustomEvent('metis:open-browser-url', { detail: { url: `https://doi.org/${c.doi}` } }));
                      } else if (c.url) {
                        window.dispatchEvent(new CustomEvent('metis:open-browser-url', { detail: { url: c.url } }));
                      }
                    }}
                  >
                    <span className="chat-citation__id">[{c.id}]</span>
                    <span className="chat-citation__label">{c.label}</span>
                    {c.page !== undefined && <span className="chat-citation__page">p.{c.page}</span>}
                  </button>
                ))}
              </div>
            )}
            {msg.role === 'assistant' && msg.incomplete && (
              <div className="chat-incomplete-draft" data-testid="incomplete-draft">
                {locale === 'zh' ? '（回答未完成——以上为中断前的草稿）' : '(Incomplete draft — captured before the turn ended)'}
              </div>
            )}
          </div>
        )}
        {!editing && (
          <div className="message-actions">
            {msg.modelLabel && (
              <span
                className="message-model-label"
                data-testid="message-model-label"
                style={{
                  fontSize: 11, padding: '1px 6px', borderRadius: 3,
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  color: 'var(--text-secondary)',
                }}
              >
                {msg.modelLabel}
              </span>
            )}
            <span className="message-time">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
            {msg.role === 'assistant' && (msg.streaming || msg.durationMs !== undefined) && (
              <MessageElapsed startedAt={msg.startedAt} durationMs={msg.durationMs} streaming={msg.streaming} />
            )}
            {msg.role === 'user' && onEdit && (
              <button
                className="message-action-btn"
                onClick={() => setEditing(true)}
                title={t('common.edit')}
                aria-label={t('common.edit')}
              >
                {editIcon}
              </button>
            )}
            {(msg.role === 'user' || msg.role === 'assistant') && (
              <button
                className="message-action-btn"
                onClick={handleCopy}
                title={copied ? t('chat.copied') : t('chat.copy')}
                aria-label={copied ? t('chat.copied') : t('chat.copy')}
                data-testid="copy-message"
              >
                {copied ? '✓' : copyIcon}
              </button>
            )}
            {msg.role === 'assistant' && isLast && onRegenerate && (
              <button
                className="message-action-btn"
                onClick={onRegenerate}
                title={t('chat.regenerate')}
                aria-label={t('chat.regenerate')}
              >
                {regenerateIcon}
              </button>
            )}
            {/* O16: fork switcher — appears when this answer has sibling branches. */}
            {msg.role === 'assistant' && msg.forkId && (msg.forkCount ?? 0) > 1 && onSwitchFork && (
              <span className="fork-switcher" data-testid="fork-switcher">
                <button
                  className="message-action-btn"
                  onClick={() => onSwitchFork(msg.forkId!, (msg.forkIndex ?? 0) - 1)}
                  disabled={(msg.forkIndex ?? 0) <= 0}
                  title={t('chat.forkPrev')}
                  aria-label={t('chat.forkPrev')}
                >◀</button>
                <span className="fork-switcher__label">{(msg.forkIndex ?? 0) + 1}/{msg.forkCount}</span>
                <button
                  className="message-action-btn"
                  onClick={() => onSwitchFork(msg.forkId!, (msg.forkIndex ?? 0) + 1)}
                  disabled={(msg.forkIndex ?? 0) >= (msg.forkCount ?? 1) - 1}
                  title={t('chat.forkNext')}
                  aria-label={t('chat.forkNext')}
                >▶</button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Message List ─────────────────────────────────────────────

export interface ChatMessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  activeGoalId: string | null;
  /**
   * 当前是否存在流式占位消息（宿主渲染期读取 streamingIndexRef.current < 0
   * 的快照；宿主每渲染重建该值，与迁出前在 JSX 中直读 ref 等价）。
   */
  streamPending: boolean;
  /** 当前 run 的执行事件缓冲（pending 时间线展示）。 */
  activeRunParts: AssistantMessageParts;
  /** 当前 run 的发起时刻（原读取 activeChatRequestRef.current?.startedAt）。 */
  activeRunStartedAt: number | undefined;
  uiMode: UIMode;
  /** 用户视口是否跟随最新消息（false 时显示「回到最新消息」按钮）。 */
  isFollowingLatest: boolean;
  onReturnToLatest: () => void;
  chatMessagesRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  // 消息气泡回调（宿主持有稳定引用）。
  onOpenPaper: (doi: string) => void;
  onEditMessage: (index: number, content: string) => void;
  onRegenerate: () => void;
  onSwitchFork: (forkId: string, targetIndex: number) => void;
  onStepCardComment: (card: ScenarioStepCardData, mode: 'comment' | 'modify') => void;
  // Goal 卡接线。
  /**
   * 步骤元素登记（宿主持有 goalStepElementRefs 并在事件回调里读写；
   * 组件渲染期不直接触碰 ref，交由宿主回调完成，行为与迁出前一致）。
   */
  onRegisterStepElement: (goalId: string, stepId: string, element: HTMLElement | null) => void;
  updateGoalCard: (index: number, updater: (card: GoalCardData) => GoalCardData) => void;
  findGoalCardIndex: (goalId: string) => number | undefined;
  syncGoalCardWorkflow: (goalId: string, index: number) => Promise<void>;
  createNewSession: () => Promise<string | null>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  pauseGoal: (goalId: string) => Promise<void>;
  cancelGoal: (goalId: string) => Promise<void>;
  resumeGoal: (goalId: string) => Promise<void>;
  startPlannedGoal: (goalId: string) => Promise<void>;
  // Composer 聚焦 / 草稿预填（聚焦由宿主稳定回调完成，渲染期不触碰 ref）。
  setInput: (value: string) => void;
  onFocusComposer: () => void;
}

export default function ChatMessageList({
  messages,
  isLoading,
  activeGoalId,
  streamPending,
  activeRunParts,
  activeRunStartedAt,
  uiMode,
  isFollowingLatest,
  onReturnToLatest: scrollToLatest,
  chatMessagesRef,
  messagesEndRef,
  onOpenPaper: openPaperByDoi,
  onEditMessage: handleEditMessageAtIndex,
  onRegenerate: stableRegenerate,
  onSwitchFork: stableSwitchFork,
  onStepCardComment: handleStepCardComment,
  onRegisterStepElement,
  updateGoalCard,
  findGoalCardIndex,
  syncGoalCardWorkflow,
  createNewSession,
  renameSession: handleRenameSession,
  pauseGoal: handlePauseGoal,
  cancelGoal: handleCancelGoal,
  resumeGoal: handleResumeGoal,
  startPlannedGoal: handleStartPlannedGoal,
  setInput,
  onFocusComposer,
}: ChatMessageListProps) {
  const { t, locale } = useTranslation();
  const diagnosticMode = uiMode === 'diagnostic';

  return (
    <div className="chat-messages" ref={chatMessagesRef}>
      {messages.length === 0 && !isLoading && (
        <div className="chat-empty">
          <h2>{t('chat.emptyTitle')}</h2>
          <p>{t('chat.emptyDescription')}</p>
          <p className="chat-empty__examples">{t('chat.emptyExamples')}</p>
        </div>
      )}
      {(() => {
        // O15: side-by-side rendering — consecutive assistant messages of
        // the same compareGroup are laid out in a flex row instead of a
        // vertical stack.
        const rendered: ReactNode[] = [];
        let groupBuffer: Array<{ msg: ChatMessage; index: number }> = [];
        let groupId: string | null = null;
        const renderGoal = (msg: ChatMessage, index: number) => (
          <GoalCardInline
            key={msg.id ?? `goal-${index}`}
            data={msg.goalCard!}
            uiMode={uiMode}
            registerStepElement={(stepId, element) => onRegisterStepElement(msg.goalCard!.goalId, stepId, element)}
            onPause={() => {
              const goalId = msg.goalCard!.goalId;
              if (goalId) void handlePauseGoal(goalId);
            }}
            onCancel={() => {
              const goalId = msg.goalCard!.goalId;
              if (goalId) void handleCancelGoal(goalId);
            }}
            onResume={() => {
              const goalId = msg.goalCard!.goalId;
              if (goalId) void handleResumeGoal(goalId);
            }}
            onRetry={() => {
              const goalId = msg.goalCard!.goalId;
              if (goalId) void handleResumeGoal(goalId);
            }}
            onOpenBoard={() => {
              const goalId = msg.goalCard!.goalId;
              if (!goalId) return;
              window.dispatchEvent(new CustomEvent('metis:open-kanban', { detail: { goalId } }));
            }}
            {...buildGoalCardActions({
              msg,
              locale,
              updateGoalCard,
              findGoalCardIndex,
              syncGoalCardWorkflow,
              createNewSession,
              renameSession: handleRenameSession,
              focusComposer: onFocusComposer,
              setComposerDraft: setInput,
              resumeGoal: handleResumeGoal,
              startPlannedGoal: handleStartPlannedGoal,
              showToast,
            })}
            onDeleteTask={() => {
              // 2.6/2.7 删除任务（GoalCardInline 已二次确认）。
              const goalId = msg.goalCard!.goalId;
              if (!goalId) return;
              void window.metis?.deleteGoal?.(goalId);
            }}
            onStepEditTask={(instruction) => {
              // 2.7 编辑任务：refinePlan 才会让模型按自然语言重规划；
              // updatePlan 只接受已结构化的 WorkflowDefinition，不能伪装成
              // “自动调整”。成功后同步权威工作流和当前卡片。
              const goalId = msg.goalCard!.goalId;
              if (!goalId) return;
              const cardIndex = findGoalCardIndex(goalId);
              if (cardIndex === undefined) return;
              void (async () => {
                const metis = window.metis;
                if (!metis?.refinePlan) return;
                const result = await metis.refinePlan(goalId, instruction);
                if (!result.success) {
                  updateGoalCard(cardIndex, (card) => ({
                    ...card,
                    error: locale === 'zh' ? '任务调整未完成，原计划保持不变。' : 'Task adjustment did not complete; the original plan is unchanged.',
                  }));
                  return;
                }
                await syncGoalCardWorkflow(goalId, cardIndex);
              })();
            }}
            onStepStart={() => {
              // 2.7 启动：plan_ready 走 executeGoal（全新 run），
              // paused 走 resumeGoal（引擎要求已存在暂停 run）。
              const goalId = msg.goalCard!.goalId;
              if (!goalId) return;
              if (msg.goalCard!.phase === 'plan_ready') void handleStartPlannedGoal(goalId);
              else void handleResumeGoal(goalId);
            }}
            onStepsReorder={(orderedIds) => {
              // 2.8 拖动排序：以权威 WorkflowDefinition 为基准重排后整体提交
              // updatePlan。卡片上只有 id/name/description 摘要，直接拼凑的
              // 残缺定义会被 GoalPlanner 校验拒绝（缺 dependencies 等字段）。
              const goalId = msg.goalCard!.goalId;
              if (!goalId) return;
              const cardIndex = findGoalCardIndex(goalId);
              if (cardIndex === undefined) return;
              void (async () => {
                const metis = window.metis;
                if (!metis?.getGoalWorkflow || !metis.updatePlan) return;
                const view = await metis.getGoalWorkflow(goalId);
                const workflow = (view as { workflow?: Record<string, unknown> } | undefined)?.workflow;
                if (!workflow) {
                  updateGoalCard(cardIndex, (card) => ({
                    ...card,
                    error: locale === 'zh' ? '暂时无法读取任务计划，排序未生效。' : 'Could not read the plan; reordering was not applied.',
                  }));
                  return;
                }
                const steps = Array.isArray(workflow.steps)
                  ? (workflow.steps as Array<Record<string, unknown>>)
                  : [];
                const position = new Map(orderedIds.map((id, order) => [id, order]));
                const orderedSteps = [...steps].sort((left, right) => (
                  (position.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER)
                  - (position.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER)
                ));
                const result = await metis.updatePlan(goalId, {
                  ...workflow,
                  steps: orderedSteps,
                } as unknown as Record<string, unknown>);
                if (!result || (result as { valid?: boolean }).valid !== true) {
                  const errors = (result as { errors?: string[] } | null | undefined)?.errors ?? [];
                  updateGoalCard(cardIndex, (card) => ({
                    ...card,
                    error: locale === 'zh'
                      ? `排序未保存（${errors[0] ?? 'plan_update_rejected'}）；原顺序保持不变。`
                      : `Reorder was not saved (${errors[0] ?? 'plan_update_rejected'}); the original order is kept.`,
                  }));
                  return;
                }
                await syncGoalCardWorkflow(goalId, cardIndex);
              })();
            }}
          />
        );
        const renderItem = (msg: ChatMessage, index: number) => (
          <ChatMessageItem
            key={msg.id ?? index}
            msg={msg}
            index={index}
            isLast={index === messages.length - 1}
            diagnosticMode={diagnosticMode}
            onOpenPaper={openPaperByDoi}
            onEdit={msg.role === 'user' ? handleEditMessageAtIndex : undefined}
            onRegenerate={msg.role === 'assistant' ? stableRegenerate : undefined}
            onSwitchFork={msg.forkId ? stableSwitchFork : undefined}
            onStepCardComment={handleStepCardComment}
          />
        );
        const flushGroup = () => {
          if (groupBuffer.length === 0) return;
          if (groupId) {
            rendered.push(
              <div className="chat-compare-row" key={`compare-${groupId}`} data-testid={`compare-row-${groupId}`}>
                {groupBuffer.map(({ msg, index }) => renderItem(msg, index))}
              </div>,
            );
          } else {
            for (const { msg, index } of groupBuffer) {
              if (msg.role === 'goal' && msg.goalCard) {
                rendered.push(renderGoal(msg, index));
              } else {
                rendered.push(renderItem(msg, index));
              }
            }
          }
          groupBuffer = [];
          groupId = null;
        };
        messages.forEach((msg, index) => {
          // O16: hide inactive fork siblings.
          if (msg.forkId && msg.forkActive === false) return;
          if (msg.compareGroup) {
            if (groupId !== null && msg.compareGroup !== groupId) flushGroup();
            groupId = msg.compareGroup;
            groupBuffer.push({ msg, index });
          } else {
            flushGroup();
            if (msg.role === 'goal' && msg.goalCard) {
              rendered.push(renderGoal(msg, index));
            } else {
              rendered.push(renderItem(msg, index));
            }
          }
        });
        flushGroup();
        return rendered;
      })()}
      {isLoading && !activeGoalId && streamPending && (
        <div className="chat-message assistant chat-run-pending" data-testid="active-run-timeline">
          <div className="message-avatar">M</div>
          <div className="message-body">
            <MemoizedAgentActivityTimeline
              status="running"
              events={activeRunParts.run.events}
              parts={activeRunParts}
              startedAt={activeRunStartedAt}
              locale={locale}
              diagnosticMode={diagnosticMode}
              pendingLabel={locale === 'zh' ? '运行已发起，等待模型响应' : 'Run started; waiting for model response'}
            />
          </div>
        </div>
      )}
      {!isFollowingLatest && (
        <button
          type="button"
          className="chat-return-latest"
          data-testid="return-to-latest"
          onClick={scrollToLatest}
        >
          {locale === 'zh' ? '回到最新消息' : 'Return to latest'}
        </button>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}
