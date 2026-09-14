/**
 * ChatSessionSidebar — 会话侧栏（2026-09-13 拆分）。
 *
 * 从 ChatPage 迁出的自包含渲染组件：会话按「今天 / 昨天 / 更早」分组展示，
 * 支持新建、选择、进行中/归档过滤、双击重命名、归档与删除。数据与回调
 * 全部由宿主显式注入，组件不感知会话加载/持久化逻辑。
 */
import { useState } from 'react';
import type { SessionListItem } from '../../../engine/runtime/SessionRuntimeContract';
import { useTranslation } from '../../i18n';
import { presentSafeMarkdownText, type SafeMarkdownMode } from '../../presentation/SafeMarkdown';

type Session = SessionListItem;

export default function ChatSessionSidebar({
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
