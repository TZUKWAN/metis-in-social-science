import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useMetisStore } from '../store';
import { matchSlashCommand, SLASH_COMMANDS, filterSlashCommands } from '../lib/slashCommands';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-latex';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import {
  clearPendingChatIntent,
  consumePendingChatIntent,
  peekPendingChatIntent,
} from '../lib/chatIntent.js';
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
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract';

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
  contentAvailable: boolean;
}
const validArtifactTypes: ArtifactItemType[] = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'latex', 'other'];
const DEFAULT_SCENARIO_ID = '';
const ACTIVE_SCENARIO_KEY = 'metis:active-scenario-id';
const SCENARIO_CATALOG_MAX_ATTEMPTS = 2;
const SCENARIO_CATALOG_RETRY_DELAY_MS = 150;

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
              <button
                className="message-action-btn"
                onClick={() => setEditing(true)}
                title={t('common.edit')}
                aria-label={t('common.edit')}
              >
                {editIcon}
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
  intentRevision?: number;
}

export default function ChatPage({ renderLayout, uiMode, intentRevision = 0 }: ChatPageProps) {
  const { t, locale } = useTranslation();
  const resolvedUIMode = uiMode ?? getDiagnosticMode();
  const diagnosticMode = resolvedUIMode === 'diagnostic';
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Live control state: 'idle' until the user requests an interrupt, 'interrupting'
  // while the active run is draining, back to 'idle' when the run settles.
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeSessionIdRef = useRef('');
  const sessionGenerationRef = useRef(0);
  const activeChatRequestRef = useRef<{
    token: symbol;
    sessionId: string;
    generation: number;
    projectId: string;
  } | null>(null);

  // Skills
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; category: string }>>([]);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [scenarioLoadState, setScenarioLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [scenarioLoadRevision, setScenarioLoadRevision] = useState(0);
  const [activeScenarioId, setActiveScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const activeResearchProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const currentProjectId = activeResearchProjectId ?? 'global';

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
  const [previewTitle, setPreviewTitle] = useState('');
  const [artifactError, setArtifactError] = useState('');
  const [activeRightPanelTab, setActiveRightPanelTab] =
    useState<RightPanelTab>('tasks');
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);

  const openPreview = useCallback((
    content: string,
    title = locale === 'zh' ? 'AI 生成预览' : 'AI-generated preview',
  ) => {
    setPreviewContent(content);
    setPreviewTitle(title);
    setArtifactError('');
    setActiveRightPanelTab('artifacts');
  }, [locale]);

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
    setHistoryReady(false);
    setArtifacts([]);
    setPreviewContent('');
    setPreviewTitle('');
    setArtifactError('');
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

  const isCurrentChatRequest = useCallback((request: {
    token: symbol;
    sessionId: string;
    generation: number;
    projectId: string;
  }) => (
    activeChatRequestRef.current?.token === request.token
    && isCurrentSessionGeneration(request.sessionId, request.generation)
    && (researchWorkspaceStore.getState().activeProjectId ?? 'global') === request.projectId
  ), [isCurrentSessionGeneration]);

  // A project change invalidates the renderer-side owner of any in-flight
  // response. The main-process request keeps its original project snapshot,
  // while this view becomes ready for a new project-scoped request.
  useEffect(() => {
    activeChatRequestRef.current = null;
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
    setScenarioLoadState('loading');
    if (!metis?.listPersonalization) {
      setScenarios([]);
      setScenarioLoadState('failed');
      return () => { cancelled = true; };
    }
    const loadCatalog = (attempt: number) => {
      void metis.listPersonalization({ contractVersion: 1, kind: 'scenario', includeDisabled: false })
        .then((response) => {
          if (cancelled) return;
          const available = response.definitions.filter((definition): definition is ScenarioDefinition => (
            definition.kind === 'scenario'
            && definition.enabled
            && definition.capability !== 'presentation_reserved'
            && definition.provenance.origin !== 'builtin'
          ));
          setScenarios(available);
          let remembered = DEFAULT_SCENARIO_ID;
          try { remembered = window.localStorage.getItem(ACTIVE_SCENARIO_KEY) ?? DEFAULT_SCENARIO_ID; } catch { /* use factory default */ }
          setActiveScenarioId(remembered === DEFAULT_SCENARIO_ID
            ? DEFAULT_SCENARIO_ID
            : (available.some((scenario) => scenario.id === remembered)
                ? remembered
                : DEFAULT_SCENARIO_ID));
          setScenarioLoadState('ready');
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < SCENARIO_CATALOG_MAX_ATTEMPTS) {
            retryTimer = window.setTimeout(
              () => loadCatalog(attempt + 1),
              SCENARIO_CATALOG_RETRY_DELAY_MS,
            );
            return;
          }
          setScenarios([]);
          setScenarioLoadState('failed');
        });
    };
    loadCatalog(1);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [scenarioLoadRevision]);

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
  }, [currentSessionId, diagnosticMode, isCurrentSessionGeneration, refreshArtifactsForSession, t]);

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

  async function handleChatFlow(content: string, scenarioId = activeScenarioId) {
    const request = {
      token: Symbol('chat-request'),
      sessionId: currentSessionId,
      generation: sessionGenerationRef.current,
      projectId: currentProjectId,
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
        { mode: 'send', ...(scenarioId ? { scenarioId } : {}), projectId: request.projectId },
      ));
      if (!isCurrentChatRequest(request)) return;

      if (response.status !== 'completed') {
        if (response.status === 'interrupted' || response.status === 'cancelled') {
          // User-initiated stop: an explicit receipt, never an error presentation.
          setMessages((prev) => [...prev, {
            role: 'system',
            content: t('chat.interruptedNotice'),
            timestamp: now(),
          }]);
        } else {
          const diagnosticCode = response.diagnostics[0]?.code ?? response.status;
          const errorMsg: ChatMessage = {
            role: 'assistant',
            content: presentExecutionError(diagnosticCode, locale, resolvedUIMode),
            timestamp: now(),
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
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
      if (response.status === 'completed') {
        void refreshArtifactsForSession(request.sessionId, request.generation);
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
        setControlState('idle');
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

  async function handleLiveInstruction(content: string) {
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
      setMessages((prev) => [...prev, {
        role: 'system',
        content: presentExecutionError(response.code, locale, resolvedUIMode),
        timestamp: now(),
      }]);
      return;
    }
    // Success receipt: confirm to the user that the instruction reached the run.
    setMessages((prev) => [
      ...prev,
      { role: 'user', content, timestamp: now() },
      { role: 'system', content: t('chat.steerReceipt'), timestamp: now() },
    ]);
    setInput('');
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

  /** Execute a slash command. Each maps to an existing system capability. */
  async function handleSlashCommand(name: string, arg: string) {
    const metis = window.metis;
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
        // Open the global search overlay (App-level state).
        reply(`请使用 Ctrl+K 搜索「${arg}」。`);
        return;
      }
      case 'paper': {
        if (!arg) { reply('用法：/paper <标题或 DOI>'); return; }
        const paper = {
          id: `paper_slash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          title: arg, authors: [] as string[], year: new Date().getFullYear(),
          venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread' as const,
          rating: 0, referenceIds: [], addedAt: Date.now(),
        };
        await useMetisStore.getState().addPaper(paper);
        reply(`已添加文献：${arg}`);
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
      case 'pause': {
        if (!activeGoalId) { reply('当前没有运行中的目标任务。'); return; }
        await metis?.pauseGoal?.(activeGoalId);
        reply('目标已暂停。');
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

  async function handleSend(overrideContent?: string, scenarioOverride?: string) {
    const raw = stripEmoji((overrideContent || input).trim());
    if (!raw) return;
    if (isLoading) {
      await handleLiveInstruction(raw);
      return;
    }

    // Slash commands: intercept before scenario matching / task detection.
    const slashMatch = matchSlashCommand(raw);
    if (slashMatch) {
      await handleSlashCommand(slashMatch.command.name, slashMatch.arg);
      return;
    }

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

    const selectedScenarioId = scenarioOverride ?? activeScenarioId;
    const matchedScenario = selectedScenarioId ? undefined : matchScenarioTrigger(content, scenarios);
    const scenarioForTurn = selectedScenarioId || matchedScenario?.id || DEFAULT_SCENARIO_ID;
    if (matchedScenario) {
      setActiveScenarioId(matchedScenario.id);
      try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, matchedScenario.id); } catch { /* preference persistence is best-effort */ }
    }

    if (scenarioForTurn) {
      await handleChatFlow(content, scenarioForTurn);
    } else if (!forceChat && !hasActiveGoal && isTaskLike(content)) {
      await handleGoalFlow(content);
    } else if (hasActiveGoal && !forceChat) {
      await handleInterjection(content);
    } else {
      await handleChatFlow(content, DEFAULT_SCENARIO_ID);
    }
  }

  // Consume a cross-page handoff only after the target session history and the
  // authoritative scenario list are both ready. Full Access launch intents may
  // auto-send once; ordinary paper/note intents remain editable drafts.
  useEffect(() => {
    if (!currentSessionId || !historyReady) return;
    const pendingIntent = peekPendingChatIntent();
    if (!pendingIntent) {
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
  }, [activeScenarioId, currentProjectId, currentSessionId, historyReady, intentRevision, locale, scenarioLoadState, scenarios, skills]);

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
      projectId: currentProjectId,
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
        { mode: 'regenerate', ...(activeScenarioId ? { scenarioId: activeScenarioId } : {}), projectId: request.projectId },
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
      if (response.status === 'completed') {
        void refreshArtifactsForSession(request.sessionId, request.generation);
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
        setControlState('idle');
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

  async function handleArtifactClick(
    item: Pick<ArtifactItem, 'id' | 'name' | 'contentAvailable'>,
  ) {
    if (!item.contentAvailable) return;
    const sessionId = activeSessionIdRef.current;
    const generation = sessionGenerationRef.current;
    const getArtifactContent = window.metis?.getArtifactContent;
    if (!sessionId || !getArtifactContent) return;
    setArtifactError('');
    try {
      const response = await getArtifactContent(sessionId, item.id);
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      if (!response.success || response.sessionId !== sessionId || response.id !== item.id) {
        setPreviewContent('');
        setPreviewTitle('');
        setArtifactError(locale === 'zh' ? '无法打开这个生成物，请重新选择或稍后重试。' : 'This artifact could not be opened. Please try again.');
        return;
      }
      openPreview(response.content, item.name);
    } catch {
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      setPreviewContent('');
      setPreviewTitle('');
      setArtifactError(locale === 'zh' ? '无法打开这个生成物，请重新选择或稍后重试。' : 'This artifact could not be opened. Please try again.');
    }
  }

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
        <div className="chat-scenario-bar" data-testid="chat-scenario-controls">
          <div className="chat-scenario-bar__identity">
            <span>{t('chat.scenarioLabel')}</span>
            <select
              aria-label={t('chat.activeScenario')}
              aria-describedby={scenarioLoadState === 'ready' ? undefined : 'chat-scenario-load-status'}
              disabled={scenarioLoadState !== 'ready'}
              value={activeScenarioId}
              onChange={(event) => {
                const id = event.target.value;
                setActiveScenarioId(id);
                try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, id); } catch { /* preference persistence is best-effort */ }
              }}
            >
              <option value="">
                {scenarioLoadState === 'loading'
                  ? t('chat.scenarioLoadingOption')
                  : scenarioLoadState === 'failed'
                    ? t('chat.scenarioUnavailableOption')
                    : t('chat.noCustomScenario')}
              </option>
              {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
            </select>
            {scenarioLoadState === 'loading' && (
              <span
                id="chat-scenario-load-status"
                className="chat-scenario-bar__status"
                role="status"
                aria-live="polite"
              >
                {t('chat.scenarioLoading')}
              </span>
            )}
            {scenarioLoadState === 'failed' && (
              <div className="chat-scenario-bar__recovery">
                <span
                  id="chat-scenario-load-status"
                  className="chat-scenario-bar__status"
                  role="alert"
                >
                  {t('chat.scenarioLoadFailed')}
                </span>
                <button
                  type="button"
                  className="chat-scenario-bar__retry"
                  onClick={() => setScenarioLoadRevision((revision) => revision + 1)}
                  aria-label={t('chat.retryScenarioLoading')}
                >
                  {t('chat.retry')}
                </button>
              </div>
            )}
          </div>
          <span
            data-testid="chat-policy-status"
            className={`chat-scenario-bar__policy ${controlState === 'interrupting' ? 'chat-scenario-bar__policy--interrupting' : ''}`}
          >
            {controlState === 'interrupting'
              ? t('chat.policyInterrupting')
              : isLoading
                ? t('chat.policyRunning')
                : t('chat.policyIdle')}
          </span>
        </div>
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
              title={t('chat.toggleTerminal')}
            >
              <TerminalIcon size={12} /> {t('chat.terminal')}
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
            placeholder={isLoading
              ? (locale === 'zh' ? '输入新指令，实时引导当前任务…' : 'Send a new instruction to steer the active run…')
              : t('chat.placeholder')}
            className="chat-textarea"
            rows={1}
          />
          {input.startsWith('/') && input.length <= 20 && (() => {
            const prefix = input.slice(1).split(/\s/)[0] ?? '';
            const cmds = filterSlashCommands(prefix);
            if (cmds.length === 0) return null;
            return (
              <div className="slash-command-menu" data-testid="slash-command-menu" style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0,
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: '4px', maxHeight: 240, overflowY: 'auto',
                boxShadow: '0 -4px 12px rgba(0,0,0,0.08)', zIndex: 10,
              }}>
                {cmds.slice(0, 8).map((cmd) => (
                  <button
                    key={cmd.name}
                    className="slash-command-item"
                    data-testid={`slash-cmd-${cmd.name}`}
                    onClick={() => {
                      setInput(`/${cmd.name} `);
                      inputRef.current?.focus();
                    }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '6px 12px', border: 'none', background: 'transparent',
                      cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)',
                    }}
                  >
                    <strong>/{cmd.name}</strong> <span style={{ color: 'var(--text-muted)' }}>{cmd.description}</span>
                  </button>
                ))}
              </div>
            );
          })()}
          {isLoading && <button
            type="button"
            onClick={() => void handleInterrupt()}
            className="chat-interrupt"
            aria-label={locale === 'zh' ? '打断当前任务' : 'Interrupt active run'}
          >{locale === 'zh' ? '打断' : 'Stop'}</button>}
          <button
            onClick={() => handleSend()}
            className="chat-send"
            disabled={!input.trim()}
          >
            {isLoading ? (locale === 'zh' ? '引导' : 'Steer') : t('common.send')}
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
      previewTitle={previewContent ? previewTitle : undefined}
      artifactError={artifactError}
      uiMode={resolvedUIMode}
      embedded
      onArtifactClick={(item) => void handleArtifactClick(item)}
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
