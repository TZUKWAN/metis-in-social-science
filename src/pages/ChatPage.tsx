import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useMetisStore } from '../store';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-latex';
import { useTranslation } from '../i18n';
import { consumePendingChatIntent } from '../lib/chatIntent.js';
import { PaperclipIcon, TerminalIcon } from '../components/Icons';
import GoalCardInline, { type GoalCardData } from '../components/GoalCardInline';
import TerminalPanel from '../components/TerminalPanel';
import RightPanel, { type RightPanelTab } from '../components/RightPanel';
import { getDiagnosticMode, type UIMode } from '../../engine/capabilities/DiagnosticMode';
import {
  presentDiagnosticText,
  presentExecutionAction,
  presentExecutionError,
} from '../presentation/executionPresentation';
import {
  SafeMarkdown,
  presentSafeMarkdownText,
  type SafeMarkdownMode,
} from '../presentation/SafeMarkdown';
import {
  decodeAgentResponse,
  decodeHistoryPayload,
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

// ─── Types ────────────────────────────────────────────────────

type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'goal';

interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  toolCall?: { name: string; arguments: string; result?: string; status: 'running' | 'completed' | 'error' };
  goalCard?: GoalCardData;
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

type Session = SessionListItem;

type ArtifactItemType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'md' | 'latex' | 'other';
interface ArtifactItem {
  id: string;
  name: string;
  type: ArtifactItemType;
  sourceCapability?: FileCapabilityDescriptor;
  size?: string;
  createdAt: number;
}
const validArtifactTypes: ArtifactItemType[] = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'latex', 'other'];

// ─── Timestamp helper (avoids Date.now() in render) ───────────

function now(): number {
  return Date.now();
}

// ─── Task detection heuristics ────────────────────────────────

function isTaskLike(content: string): boolean {
  const trimmed = content.trim();
  // Short questions are probably questions
  if (trimmed.length < 15 && (trimmed.includes('?') || trimmed.includes('？'))) return false;
  // Question starters → treat as chat
  const questionStarters = /^(what|who|when|where|why|how|is|are|can|could|would|do|does|did|什么|谁|何时|哪里|为什么|怎么|是否|能|可以)/i;
  if (questionStarters.test(trimmed)) return false;
  // Task keywords
  const taskPatterns = [
    /\b(help me|create|build|write|analyze|research|generate|prepare|draft|summarize|compare|review|design|implement|develop|conduct|perform)\b/i,
    /(帮我|创建|构建|写|分析|研究|生成|准备|起草|总结|比较|评审|设计|实现|开发|翻译)/,
  ];
  return taskPatterns.some(p => p.test(content));
}

function isLikelyGoalFeedback(content: string): boolean {
  const patterns = [
    /\b(change|modify|update|fix|adjust|instead|rather|redo|add|remove|include|exclude|also)\b/i,
    /(修改|更改|调整|换成|不要|重做|再试|加上|去掉|还有|换成)/,
  ];
  return patterns.some(p => p.test(content));
}

// ─── Inline SVG Icons ─────────────────────────────────────────

const toolIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.3-3.3a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0z" />
    <path d="m3 21 7.6-7.6" />
    <path d="m11.6 11.6 2.1-2.1" />
  </svg>
);

const chevronUpIcon = (
  <svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m18 15-6-6-6 6" />
  </svg>
);

const chevronDownIcon = (
  <svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

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

// ─── Code Block Component ─────────────────────────────────────

function CodeBlock({ language, code }: { language: string; code: string }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (ref.current) {
      Prism.highlightElement(ref.current);
    }
  }, [code, language]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-language">{language || 'text'}</span>
        <button className="code-copy-btn" onClick={handleCopy}>
          {copied ? t('chat.copied') : t('chat.copy')}
        </button>
      </div>
      <pre className="code-pre">
        <code ref={ref} className={`language-${language || 'text'}`}>{code}</code>
      </pre>
    </div>
  );
}

// ─── Emoji filter — keeps the UI free of emoji anywhere ─────────

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}]/gu;

function stripEmoji(text: string): string {
  return text.replace(EMOJI_REGEX, '').replace(/\s{2,}/g, ' ').trim();
}

// ─── Markdown Renderer ────────────────────────────────────────

function MarkdownContent({
  content,
  uiMode,
  locale,
}: {
  content: string;
  uiMode: SafeMarkdownMode;
  locale: 'en' | 'zh';
}) {
  return (
    <SafeMarkdown
      content={stripEmoji(content)}
      uiMode={uiMode}
      locale={locale}
      codeComponent={({ className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || '');
          const code = String(children).replace(/\n$/, '');
          if (match && match[1]) {
            return <CodeBlock language={match[1]} code={code} />;
          }
          return <code className="inline-code" {...props}>{children}</code>;
      }}
    />
  );
}

// ─── Tool Call Card ───────────────────────────────────────────

export function ToolCallCard({
  toolCall,
  diagnosticMode,
}: {
  toolCall: ChatMessage['toolCall'];
  diagnosticMode: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t, locale } = useTranslation();
  if (!toolCall) return null;

  const statusColor = {
    running: 'var(--status-running)',
    completed: 'var(--status-completed)',
    error: 'var(--status-failed)',
  }[toolCall.status];

  const statusLabel: Record<string, string> = {
    running: t('chat.statusRunning'),
    completed: t('chat.statusCompleted'),
    error: t('chat.statusError'),
  };

  const headerContent = (
    <>
      <span className="tool-call-icon">{toolIcon}</span>
      <span className="tool-call-name">
        {presentExecutionAction(toolCall.name, locale)}
      </span>
      <span className="tool-call-status" style={{ color: statusColor }}>
        {statusLabel[toolCall.status] ?? toolCall.status}
      </span>
      {diagnosticMode && (
        <span className="tool-call-toggle">{expanded ? chevronUpIcon : chevronDownIcon}</span>
      )}
    </>
  );

  return (
    <div className="tool-call-card">
      {diagnosticMode ? (
        <button
          className="tool-call-header"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {headerContent}
        </button>
      ) : (
        <div className="tool-call-header">{headerContent}</div>
      )}
      {expanded && diagnosticMode && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <h4>{t('chat.technicalAction')}</h4>
            <pre className="tool-call-code">{presentDiagnosticText(toolCall.name)}</pre>
          </div>
          <div className="tool-call-section">
            <h4>{t('chat.arguments')}</h4>
            <pre className="tool-call-code">{presentDiagnosticText(toolCall.arguments)}</pre>
          </div>
          {toolCall.result && (
            <div className="tool-call-section">
              <h4>{t('chat.result')}</h4>
              <pre className="tool-call-code">{presentDiagnosticText(toolCall.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Message Component ────────────────────────────────────────

function ChatMessageItem({
  msg,
  onEdit,
  onRegenerate,
  isLast,
  diagnosticMode,
}: {
  msg: ChatMessage;
  onEdit?: (content: string) => void;
  onRegenerate?: () => void;
  isLast?: boolean;
  diagnosticMode: boolean;
}) {
  const { t, locale } = useTranslation();
  const messageUIMode: SafeMarkdownMode = diagnosticMode ? 'diagnostic' : 'normal';
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(stripEmoji(msg.content));

  const handleEditSubmit = () => {
    const cleaned = stripEmoji(editValue).trim();
    if (cleaned && onEdit) {
      onEdit(cleaned);
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

  return (
    <div className={`chat-message ${msg.role}`}>
      <div className="message-avatar">
        {avatarLabel}
      </div>
      <div className="message-body">
        {msg.role === 'tool' ? (
          msg.toolCall ? (
            <ToolCallCard toolCall={msg.toolCall} diagnosticMode={diagnosticMode} />
          ) : (
            <div className="message-content">
              {diagnosticMode
                ? <MarkdownContent content={presentDiagnosticText(msg.content)} uiMode={messageUIMode} locale={locale} />
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
            <MarkdownContent content={msg.content} uiMode={messageUIMode} locale={locale} />
          </div>
        )}
        {!editing && (
          <div className="message-actions">
            <span className="message-time">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
            {msg.role === 'user' && onEdit && (
              <button className="message-action-btn" onClick={() => setEditing(true)} title="编辑">
                {editIcon}
              </button>
            )}
            {msg.role === 'assistant' && isLast && onRegenerate && (
              <button className="message-action-btn" onClick={onRegenerate} title="重新生成">
                {regenerateIcon}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Session Sidebar ──────────────────────────────────────────

function SessionSidebar({
  sessions,
  currentSessionId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onArchive,
  showArchived,
  onToggleArchived,
  uiMode,
}: {
  sessions: Session[];
  currentSessionId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  uiMode: SafeMarkdownMode;
}) {
  const { t, locale } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const visibleSessions = sessions.filter((s) => (showArchived ? s.archived : !s.archived));

  // Group by date relative to today
  const today = new Date().setHours(0, 0, 0, 0);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const groups: { label: string; items: Session[] }[] = [];
  const todayItems: Session[] = [];
  const yesterdayItems: Session[] = [];
  const earlierItems: Session[] = [];
  for (const s of visibleSessions) {
    const d = new Date(s.lastActivity).setHours(0, 0, 0, 0);
    if (d >= today) todayItems.push(s);
    else if (d >= yesterday) yesterdayItems.push(s);
    else earlierItems.push(s);
  }
  if (todayItems.length) groups.push({ label: t('chat.today') ?? '今天', items: todayItems });
  if (yesterdayItems.length) groups.push({ label: t('chat.yesterday') ?? '昨天', items: yesterdayItems });
  if (earlierItems.length) groups.push({ label: t('chat.earlier') ?? '更早', items: earlierItems });

  const startRename = (s: Session) => {
    setEditingId(s.id);
    setEditValue(presentSafeMarkdownText(s.title || t('chat.newSessionTitle'), uiMode, locale));
  };

  const submitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <button className="btn-primary btn-full" onClick={onNew}>
          {t('chat.newSession')}
        </button>
      </div>
      <div className="chat-sidebar-toolbar">
        <button
          className={`chat-sidebar-filter ${!showArchived ? 'active' : ''}`}
          onClick={() => { if (showArchived) onToggleArchived(); }}
        >
          {t('chat.activeSessions') ?? '进行中'}
        </button>
        <button
          className={`chat-sidebar-filter ${showArchived ? 'active' : ''}`}
          onClick={() => { if (!showArchived) onToggleArchived(); }}
        >
          {t('chat.archivedSessions') ?? '归档'}
        </button>
      </div>
      <div className="chat-sidebar-list">
        {groups.length === 0 && (
          <div className="chat-sidebar-empty">{t('chat.noSessions')}</div>
        )}
        {groups.map((group) => (
          <div key={group.label} className="chat-session-group">
            <div className="chat-session-group-label">{group.label}</div>
            {group.items.map((s) => {
              const safeTitle = presentSafeMarkdownText(
                s.title || t('chat.newSessionTitle'),
                uiMode,
                locale,
              );
              const safeMessageCount = Number.isFinite(s.messageCount)
                ? Math.max(0, Math.trunc(s.messageCount))
                : 0;
              const activityDate = Number.isFinite(s.lastActivity)
                ? new Date(s.lastActivity)
                : null;
              const safeDate = activityDate && !Number.isNaN(activityDate.getTime())
                ? activityDate.toLocaleDateString()
                : '';
              return (
              <div
                key={s.id}
                className={`chat-session-item ${s.id === currentSessionId ? 'active' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                {editingId === s.id ? (
                  <input
                    className="chat-session-title-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={submitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setEditingId(null); }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <div
                      className="chat-session-title"
                      onDoubleClick={(e) => { e.stopPropagation(); startRename(s); }}
                      title={t('chat.doubleClickRename') ?? '双击重命名'}
                    >
                      {safeTitle}
                    </div>
                    <div className="chat-session-meta">
                      {t('chat.sessionMeta', { count: safeMessageCount, date: safeDate })}
                    </div>
                    <div className="chat-session-actions">
                      <button
                        className="chat-session-action"
                        onClick={(e) => { e.stopPropagation(); onArchive(s.id); }}
                        title={s.archived ? t('chat.unarchive') ?? '取消归档' : t('chat.archive') ?? '归档'}
                      >
                        {s.archived ? '↩' : '↩'}
                      </button>
                      <button
                        className="chat-session-action chat-session-delete"
                        onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                        title={t('chat.deleteSession')}
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Chat Page ───────────────────────────────────────────

export interface ChatPageLayoutSlots {
  leftPanel: ReactNode;
  workspace: ReactNode;
  rightPanel: ReactNode;
}

export interface ChatPageProps {
  renderLayout: (slots: ChatPageLayoutSlots) => ReactNode;
  uiMode?: UIMode;
}

export default function ChatPage({ renderLayout, uiMode }: ChatPageProps) {
  const { t, locale } = useTranslation();
  const resolvedUIMode = uiMode ?? getDiagnosticMode();
  const diagnosticMode = resolvedUIMode === 'diagnostic';
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);

  const normalizeArtifact = useCallback((a: ArtifactListItem): ArtifactItem => {
    return {
      id: a.id,
      name: a.name,
      type: validArtifactTypes.includes(a.type as ArtifactItem['type']) ? (a.type as ArtifactItem['type']) : 'other',
      size: a.size,
      sourceCapability: a.sourceCapability,
      createdAt: a.createdAt,
    };
  }, []);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeSessionIdRef = useRef('');
  const sessionGenerationRef = useRef(0);
  const activeChatRequestRef = useRef<{
    token: symbol;
    sessionId: string;
    generation: number;
  } | null>(null);

  // Skills
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; category: string }>>([]);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);

  // Goal integration
  const [activeGoalId, setActiveGoalId] = useState<string | null>(null);
  const activeGoalIdRef = useRef<string | null>(null);
  const goalCardIndexMapRef = useRef<Map<string, number>>(new Map());
  const goalStepElementRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const goalEventSequenceRef = useRef<Map<string, number>>(new Map());

  const [terminalVisible, setTerminalVisible] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const [activeRightPanelTab, setActiveRightPanelTab] =
    useState<RightPanelTab>('tasks');
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);

  const openPreview = useCallback((content: string) => {
    setPreviewContent(content);
    setActiveRightPanelTab('artifacts');
  }, []);

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

  const activateSession = useCallback((sessionId: string) => {
    sessionGenerationRef.current += 1;
    activeSessionIdRef.current = sessionId;
    activeChatRequestRef.current = null;
    setCurrentSessionId(sessionId);
    setMessages([]);
    setArtifacts([]);
    setPreviewContent('');
    setIsLoading(false);
    setActiveGoalId(null);
    activeGoalIdRef.current = null;
    goalEventSequenceRef.current.clear();
    goalCardIndexMapRef.current.clear();
  }, []);

  const isCurrentSessionGeneration = useCallback((
    sessionId: string,
    generation: number,
  ) => (
    activeSessionIdRef.current === sessionId
    && sessionGenerationRef.current === generation
  ), []);

  const isCurrentChatRequest = useCallback((request: {
    token: symbol;
    sessionId: string;
    generation: number;
  }) => (
    activeChatRequestRef.current?.token === request.token
    && isCurrentSessionGeneration(request.sessionId, request.generation)
  ), [isCurrentSessionGeneration]);

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

  // Consume cross-page chat intent (e.g., "AI Review" from paper detail)
  useEffect(() => {
    if (skills.length === 0 || !currentSessionId) return;
    const intent = consumePendingChatIntent();
    if (!intent) return;
    if (skills.some((s) => s.id === intent.skillId)) {
      setActiveSkillId(intent.skillId);
      window.metis?.setActiveSkill?.(intent.skillId).catch(() => {});
    }
    setInput(intent.message);
    inputRef.current?.focus();
  }, [skills, currentSessionId]);

  // Helper: create a new session (defined before useEffect that calls it)
  async function createNewSession() {
    const ts = now();
    const id = `session_${ts}`;
    const request = decodeSessionCreateRequest({ sessionId: id });
    if (!request.ok) return;
    const metis = window.metis;
    if (metis?.createSession) {
      const result = await metis.createSession(id).catch(() => null);
      if (!result?.success) return;
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
      },
      ...prev,
    ]);
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
  async function handleRenameSession(id: string, title: string) {
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
  }

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
    try {
      const picked = await window.metis?.selectFileCapability('artifact-attachment');
      if (!picked?.success) return;
      const fileName = picked.capability.displayName;
      // Compatibility for the legacy diagnostic copy below: this is an opaque
      // capability identifier, never a local filesystem path.
      const filePath = picked.capability.capabilityId;

      const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const artifactType = inferArtifactType(fileName);
      if (currentSessionId && window.metis?.createArtifact) {
        const result = await window.metis.createArtifact({
          id: artifactId,
          sessionId: currentSessionId,
          name: fileName,
          type: artifactType,
          sourceCapabilityId: picked.capability.capabilityId,
          size: '',
        });
        if (!result.success) return;
      } else {
        return;
      }
      setArtifacts((prev) => [{
        id: artifactId,
        name: fileName,
        type: artifactType,
        sourceCapability: picked.capability,
        size: '',
        createdAt: Date.now(),
      }, ...prev.filter((item) => item.id !== artifactId)]);

      setMessages((prev) => [...prev, {
        role: 'system',
        content: diagnosticMode
          ? `[附件] **${fileName}** 已导入。\n路径: \`${filePath}\`\n你现在可以让 Metis 处理该文件。`
          : t('chat.attachmentImported', { name: fileName }),
        timestamp: now(),
      }]);
    } catch (err: unknown) {
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
      if (sessionId === activeSessionIdRef.current && metis.listArtifacts) {
        metis.listArtifacts(sessionId).then((payload) => {
          if (isCurrentSessionGeneration(sessionId, generation)) {
            const decoded = decodeArtifactListPayload(payload);
            setArtifacts(decoded.success ? decoded.items.map(normalizeArtifact) : []);
          }
        }).catch(() => {});
      }
    });
    return () => { unsub(); };
  }, [isCurrentSessionGeneration, normalizeArtifact]);

  // Load messages and artifacts when session changes
  useEffect(() => {
    if (!currentSessionId) return;
    const sessionId = currentSessionId;
    const generation = sessionGenerationRef.current;
    const metis = window.metis;
    if (metis?.getMessages) {
      metis.getMessages(sessionId).then((msgs) => {
        if (!isCurrentSessionGeneration(sessionId, generation)) return;
        setMessages(decodeHistoryPayload(msgs).map((item): ChatMessage => {
          if (item.kind === 'message') {
            return { role: item.role, content: item.content, timestamp: now() };
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
          return {
            role: 'system',
            content: diagnosticMode
              ? presentDiagnosticText(recoveryCode)
              : t('chat.historyRecoveryFailed'),
            timestamp: now(),
          };
        }));
      }).catch(() => {
        if (isCurrentSessionGeneration(sessionId, generation)) setMessages([]);
      });
    }
    if (metis?.listArtifacts) {
      metis.listArtifacts(sessionId).then((payload) => {
        if (isCurrentSessionGeneration(sessionId, generation)) {
          const decoded = decodeArtifactListPayload(payload);
          setArtifacts(decoded.success ? decoded.items.map(normalizeArtifact) : []);
        }
      }).catch(() => {
        if (isCurrentSessionGeneration(sessionId, generation)) setArtifacts([]);
      });
    }
  }, [currentSessionId, isCurrentSessionGeneration, normalizeArtifact, diagnosticMode, t]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

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

    return () => { for (const u of unsubs) u(); };
  }, [acceptGoalEvent, isCurrentChatRequest, updateGoalCard]);

  // ─── Normal chat flow (extracted from old handleSend) ──────

  async function handleChatFlow(content: string) {
    const request = {
      token: Symbol('chat-request'),
      sessionId: currentSessionId,
      generation: sessionGenerationRef.current,
    };
    activeChatRequestRef.current = request;
    setIsLoading(true);

    const metis = window.metis;
    try {
      if (!metis) throw new Error('Metis API not available');

      const history = messages.concat({ role: 'user', content, timestamp: now() }).map((m) => ({
        role: (m.role === 'tool' || m.role === 'goal') ? 'assistant' : m.role,
        content: m.content,
      }));

      const response = decodeAgentResponse(await metis.agentChat(
        request.sessionId,
        history,
        activeSkillId ?? undefined,
        { mode: 'send' },
      ));
      if (!isCurrentChatRequest(request)) return;

      if (response.status !== 'completed') {
        const diagnosticCode = response.diagnostics[0]?.code ?? response.status;
        const errorMsg: ChatMessage = {
          role: 'assistant',
          content: presentExecutionError(diagnosticCode, locale, resolvedUIMode),
          timestamp: now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } else if (response.answer) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: response.answer,
          timestamp: now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        if (response.answer.length > 200 || /^#|^\*|\|.*\||```/.test(response.answer)) {
          openPreview(response.answer);
        }
      }
    } catch (err) {
      if (!isCurrentChatRequest(request)) return;
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: presentExecutionError(err, locale, resolvedUIMode),
        timestamp: now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      if (isCurrentChatRequest(request)) {
        activeChatRequestRef.current = null;
        setIsLoading(false);
      }
    }
  }

  // ─── Goal flow ─────────────────────────────────────────────

  async function handleGoalFlow(description: string) {
    setIsLoading(true);
    const metis = window.metis;
    if (metis?.appendMessage) {
      void metis.appendMessage(currentSessionId, 'user', description);
    }
    if (!metis?.createGoal) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: presentExecutionError('Research task service not available', locale, resolvedUIMode),
        timestamp: now(),
      }]);
      setIsLoading(false);
      return;
    }

    // 1. Insert GoalCard message
    const goalCard: GoalCardData = {
      goalId: '', description, phase: 'creating',
      steps: [], stepStatuses: {},
      progress: { completed: 0, total: 0, currentStep: '' },
      canRefine: false,
    };
    const goalMsg: ChatMessage = { role: 'goal', content: '', timestamp: now(), goalCard };
    // Index: messages.length is the user msg just pushed; +1 is the goal card
    const goalMsgIndex = messages.length + 1;

    setMessages((prev) => [...prev, goalMsg]);

    try {
      // 2. Create Goal
      const goal = await metis.createGoal(description);
      if (!goal.success) throw new Error(goal.code);
      const goalId = goal.goalId;
      updateGoalCard(goalMsgIndex, (card) => ({ ...card, goalId, phase: 'planning' }));
      setActiveGoalId(goalId);
      activeGoalIdRef.current = goalId;
      goalEventSequenceRef.current.delete(goalId);
      goalCardIndexMapRef.current.set(goalId, goalMsgIndex);

      // 3. Generate Plan
      const planResult = await metis.generatePlan(goalId);
      if (!planResult.success) throw new Error(planResult.code);
      const steps = planResult.steps.map((step) => ({
        id: step.stepId,
        name: t('rightPanel.researchStep', { number: step.ordinal }),
        description: '',
      }));
      const executingCard: GoalCardData = {
        ...goalCard,
        goalId,
        phase: 'executing',
        planName: t('chat.researchPlan'),
        steps,
        stepStatuses: Object.fromEntries(steps.map((s) => [s.id, { stepId: s.id, stepName: s.name, status: 'pending' as const, output: '' }])),
        progress: { completed: 0, total: steps.length, currentStep: '' },
        canRefine: false,
      };
      updateGoalCard(goalMsgIndex, () => executingCard);

      // 4. Persist goal card state
      if (metis.appendMessage) {
        void metis.appendMessage(currentSessionId, 'goal', `__GOAL_CARD__${JSON.stringify(executingCard)}`);
      }

      // 5. Auto-execute
      const execution = await metis.executeGoal(goalId);
      if (!execution.success) throw new Error(execution.code ?? 'goal_execution_failed');

      // 6. Mark completed
      updateGoalCard(goalMsgIndex, (card) => ({ ...card, phase: 'completed' }));
    } catch {
      updateGoalCard(goalMsgIndex, (card) => ({
        ...card,
        phase: 'failed',
        error: 'goal_execution_failed',
      }));
    } finally {
      setActiveGoalId(null);
      activeGoalIdRef.current = null;
      goalEventSequenceRef.current.clear();
      setIsLoading(false);
    }
  }

  // ─── Interjection flow ─────────────────────────────────────

  async function handleInterjection(content: string) {
    const metis = window.metis;
    if (!metis || !activeGoalId) {
      await handleChatFlow(content);
      return;
    }

    if (isLikelyGoalFeedback(content)) {
      setIsLoading(true);
      if (metis.appendMessage) {
        void metis.appendMessage(currentSessionId, 'user', content);
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
      }
    } else {
      // Unrelated question — answer as normal chat while goal continues in background
      await handleChatFlow(content);
    }
  }

  // ─── Send message (router) ────────────────────────────────

  async function handleSend(overrideContent?: string) {
    const raw = stripEmoji((overrideContent || input).trim());
    if (!raw || isLoading) return;

    // Force plain chat with prefix
    const forceChat = raw.startsWith('/chat ') || raw.startsWith('? ');
    const content = forceChat ? raw.replace(/^(\/chat |\? )/, '') : raw;

    // Append user message
    const userMsg: ChatMessage = { role: 'user', content, timestamp: now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    // Normal chat persistence is owned by the main process so each message is
    // committed once. Goal-only messages still use appendMessage below.
    const hasActiveGoal = activeGoalId !== null;

    if (!forceChat && !hasActiveGoal && isTaskLike(content)) {
      await handleGoalFlow(content);
    } else if (hasActiveGoal && !forceChat) {
      await handleInterjection(content);
    } else {
      await handleChatFlow(content);
    }
  }

  // Regenerate last assistant response
  async function handleRegenerate() {
    const lastUserIndex = [...messages].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIndex === -1) return;
    const actualIndex = messages.length - 1 - lastUserIndex;
    const history = messages.slice(0, actualIndex + 1);
    const request = {
      token: Symbol('regenerate-request'),
      sessionId: currentSessionId,
      generation: sessionGenerationRef.current,
    };
    activeChatRequestRef.current = request;
    setMessages(history);
    setIsLoading(true);

    try {
      const metis = window.metis;
      if (!metis) throw new Error('Metis API not available');

      const response = decodeAgentResponse(await metis.agentChat(
        request.sessionId,
        history.map((m) => ({ role: (m.role === 'tool' || m.role === 'goal') ? 'assistant' : m.role, content: m.content })),
        activeSkillId ?? undefined,
        { mode: 'regenerate' },
      ));
      if (!isCurrentChatRequest(request)) return;

      if (response.status !== 'completed') {
        const diagnosticCode = response.diagnostics[0]?.code ?? response.status;
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: presentExecutionError(diagnosticCode, locale, resolvedUIMode),
          timestamp: now(),
        }]);
      } else if (response.answer) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: response.answer,
          timestamp: now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        // Live preview: if the response is substantial (artifact-length), render it in the
        // right panel's preview area (Claude-Artifacts-style split view).
        if (response.answer.length > 200 || /^#|^\*|\|.*\||```/.test(response.answer)) {
          openPreview(response.answer);
        }
      }
    } catch (err) {
      if (!isCurrentChatRequest(request)) return;
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: presentExecutionError(err, locale, resolvedUIMode),
        timestamp: now(),
      }]);
    } finally {
      if (isCurrentChatRequest(request)) {
        activeChatRequestRef.current = null;
        setIsLoading(false);
      }
    }
  }

  // Edit a user message and resend
  function handleEditMessage(index: number, newContent: string) {
    // Truncate messages after the edited one, then send the new content
    const truncated = messages.slice(0, index);
    setMessages(truncated);
    // Use a microtask to ensure state is updated before handleSend reads messages
    setTimeout(() => {
      void handleSend(newContent);
    }, 0);
  }

  // Handle Enter to send, Shift+Enter for newline
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }


  // Build right-panel task list from active goal card if any
  const activeGoalCard = messages.find((m) => m.role === 'goal' && m.goalCard)?.goalCard;
  const rightPanelTasks = activeGoalCard
    ? activeGoalCard.steps.map((step, index) => {
        const rawStatus = activeGoalCard.stepStatuses[step.id]?.status;
        const status: 'pending' | 'running' | 'completed' | 'failed' =
          rawStatus === 'running' || rawStatus === 'completed' || rawStatus === 'failed'
            ? rawStatus
            : 'pending';
        return {
          id: step.id,
          title: diagnosticMode ? step.name : t('rightPanel.researchStep', { number: index + 1 }),
          status,
          progress: activeGoalCard.progress && activeGoalCard.progress.total > 0
            ? Math.round((activeGoalCard.progress.completed / activeGoalCard.progress.total) * 100)
            : undefined,
        };
      })
    : [];

  const rightPanelArtifacts = artifacts;

  // Build notes list from global store for the right panel
  const allNotes = useMetisStore((s) => s.notes);
  const rightPanelNotes = allNotes
    .slice(0, 20)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((n) => ({
      id: n.id,
      title: n.title || t('notes.untitled'),
      preview: n.content.slice(0, 80),
      updatedAt: n.updatedAt,
    }));

  const leftPanel = (
    <SessionSidebar
      sessions={sessions}
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

  const workspace = (
    <div className="chat-main">
        {diagnosticMode && skills.length > 0 && (
          <div
            data-testid="diagnostic-skill-controls"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
              borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('chat.skill')}</span>
            <select
              value={activeSkillId ?? ''}
              onChange={(e) => {
                const id = e.target.value || null;
                setActiveSkillId(id);
                const metis = window.metis;
                if (metis?.setActiveSkill) {
                  void metis.setActiveSkill(id);
                }
              }}
              style={{
                fontSize: 13, padding: '4px 8px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">{t('chat.defaultNoSkill')}</option>
              {Object.entries(
                skills.reduce<Record<string, typeof skills>>((acc, sk) => {
                  (acc[sk.category] ??= []).push(sk);
                  return acc;
                }, {})
              )
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([category, items]) => (
                  <optgroup key={category} label={category.charAt(0).toUpperCase() + category.slice(1)}>
                    {items.map((sk) => (
                      <option key={sk.id} value={sk.id}>{sk.name}</option>
                    ))}
                  </optgroup>
                ))}
            </select>
            {activeSkillId && (
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {skills.find((s) => s.id === activeSkillId)?.description}
              </span>
            )}
          </div>
        )}
        {diagnosticMode && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '4px 16px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
          }}>
            <button
              className="terminal-panel-toggle"
              data-testid="diagnostic-terminal-toggle"
              onClick={() => setTerminalVisible(!terminalVisible)}
              style={{
                fontSize: 12, padding: '3px 10px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--bg-primary)',
                color: 'var(--text-secondary)', cursor: 'pointer',
              }}
              title="切换终端"
            >
              <TerminalIcon size={12} /> 终端
            </button>
          </div>
        )}
        <div className="chat-messages">
          {messages.length === 0 && !isLoading && (
            <div className="chat-empty">
              <h2>{t('chat.emptyTitle')}</h2>
              <p>{t('chat.emptyDescription')}</p>
            </div>
          )}
          {messages.map((msg, i) => {
            // Goal card messages render as inline GoalCardInline
            if (msg.role === 'goal' && msg.goalCard) {
              return (
                <GoalCardInline
                  key={i}
                  data={msg.goalCard}
                  uiMode={resolvedUIMode}
                  registerStepElement={(stepId, element) => {
                    const key = `${msg.goalCard!.goalId}\u0000${stepId}`;
                    if (element) goalStepElementRefs.current.set(key, element);
                    else goalStepElementRefs.current.delete(key);
                  }}
                />
              );
            }
            return (
              <ChatMessageItem
                key={i}
                msg={msg}
                isLast={i === messages.length - 1}
                diagnosticMode={diagnosticMode}
                onEdit={msg.role === 'user' ? (content) => handleEditMessage(i, content) : undefined}
                onRegenerate={msg.role === 'assistant' ? handleRegenerate : undefined}
              />
            );
          })}
          {isLoading && (
            <div className="chat-message assistant">
              <div className="message-avatar">A</div>
              <div className="message-body">
                <div className="message-content">
                  <em className="typing-indicator">{t('chat.typing') || '思考中…'}</em>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        {/* P0-2: "Ask Metis about this" floating button on text selection */}
        {selectionMenu && (
          <button
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
        )}
        <div
          className={`chat-input-area ${dragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOver(false);
            // Import dropped bytes into the main-process managed attachment area;
            // renderer code never receives or forwards a local filesystem path.
            const files = e.dataTransfer.files;
            if (!files?.length) return;
            for (const file of Array.from(files)) {
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
                if (currentSessionId && window.metis?.createArtifact) {
                  const result = await window.metis.createArtifact({
                    id: artifactId,
                    sessionId: currentSessionId,
                    name: file.name,
                    type: artifactType,
                    sourceCapabilityId: imported.capability.capabilityId,
                    size: sizeStr,
                  });
                  if (!result.success) continue;
                } else {
                  continue;
                }
                setArtifacts((prev) => [{
                  id: artifactId,
                  name: file.name,
                  type: artifactType,
                  sourceCapability: imported.capability,
                  size: sizeStr,
                  createdAt: Date.now(),
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
          <button
            className="chat-upload-btn"
            onClick={handleFileUpload}
            title="导入文件"
            disabled={isLoading}
          >
            <PaperclipIcon size={18} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('chat.placeholder')}
            className="chat-textarea"
            rows={1}
            disabled={isLoading}
          />
          <button
            onClick={() => handleSend()}
            className="chat-send"
            disabled={!input.trim() || isLoading}
          >
            {t('common.send')}
          </button>
        </div>
        {diagnosticMode && (
          <TerminalPanel
            visible={terminalVisible}
            onToggle={() => setTerminalVisible(!terminalVisible)}
          />
        )}
    </div>
  );

  const rightPanel = (
    <RightPanel
      activeTab={activeRightPanelTab}
      onActiveTabChange={setActiveRightPanelTab}
      tasks={rightPanelTasks}
      artifacts={rightPanelArtifacts}
      notes={rightPanelNotes}
      previewContent={previewContent}
      previewTitle={previewContent ? 'AI 生成预览' : undefined}
      uiMode={resolvedUIMode}
      embedded
      onTaskClick={(id) => {
        if (!activeGoalCard) return;
        const el = goalStepElementRefs.current.get(`${activeGoalCard.goalId}\u0000${id}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}
    />
  );

  return renderLayout({
    leftPanel,
    workspace,
    rightPanel,
  });
}
