/**
 * TaskBoardPage — kanban board for research goals/tasks.
 *
 * Six columns (Backlog / To do / In progress / In review / Done / Cancelled)
 * mapped from Goal status. Cards show title, priority badge, and age. Drag
 * between columns to change status; click a card for the detail panel.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore';
import './TaskBoardPage.css';

type GoalStatus = 'draft' | 'planning' | 'ready' | 'running' | 'paused' | 'completed' | 'failed';
type Priority = 'low' | 'medium' | 'high' | 'urgent';

interface KanbanGoal {
  id: string;
  description: string;
  status: GoalStatus;
  priority?: Priority;
  createdAt: number;
  projectId?: string;
}

// Map Goal status to kanban column.
type ColumnId = 'backlog' | 'todo' | 'inprogress' | 'inreview' | 'done' | 'cancelled';

function statusToColumn(status: GoalStatus): ColumnId {
  switch (status) {
    case 'draft': return 'backlog';
    case 'planning': case 'ready': return 'todo';
    case 'running': return 'inprogress';
    // GoalEngine has no distinct review status. Paused is presented honestly as
    // "waiting", rather than pretending a review column survives reload.
    case 'paused': return 'inreview';
    case 'completed': return 'done';
    case 'failed': return 'cancelled';
    default: return 'todo';
  }
}

function columnToStatus(column: ColumnId): GoalStatus {
  switch (column) {
    case 'backlog': return 'draft';
    case 'todo': return 'ready';
    case 'inprogress': return 'running';
    case 'inreview': return 'paused';
    case 'done': return 'completed';
    case 'cancelled': return 'failed';
    default: return 'ready';
  }
}

const COLUMNS: Array<{ id: ColumnId; labelKey: string; color: string }> = [
  { id: 'backlog', labelKey: 'kanban.backlog', color: 'var(--text-muted)' },
  { id: 'todo', labelKey: 'kanban.todo', color: 'var(--primary)' },
  { id: 'inprogress', labelKey: 'kanban.inprogress', color: 'var(--accent-warm)' },
  { id: 'inreview', labelKey: 'kanban.inreview', color: 'var(--status-failed)' },
  { id: 'done', labelKey: 'kanban.done', color: 'var(--status-completed)' },
  { id: 'cancelled', labelKey: 'kanban.cancelled', color: 'var(--text-muted)' },
];

const PRIORITY_COLORS: Record<Priority, string> = {
  low: 'var(--text-muted)',
  medium: 'var(--primary)',
  high: 'var(--accent-warm)',
  urgent: 'var(--status-failed)',
};

function formatAge(ts: number, locale: string): string {
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return locale === 'zh' ? '今天' : 'today';
  if (days === 1) return locale === 'zh' ? '昨天' : 'yesterday';
  return locale === 'zh' ? `${days} 天前` : `${days}d ago`;
}

export interface TaskBoardPageProps {
  /** Initial project filter applied to the board (e.g. the active research project). */
  defaultProjectFilter?: string;
}

export default function TaskBoardPage({ defaultProjectFilter = '' }: TaskBoardPageProps = {}) {
  const { t, locale } = useTranslation();
  const [goals, setGoals] = useState<KanbanGoal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState(defaultProjectFilter);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);
  const [newTaskColumn, setNewTaskColumn] = useState<ColumnId | null>(null);
  const [newTaskText, setNewTaskText] = useState('');
  // UX-KANBAN-002: 新建任务的项目归属。null=未选择（禁止静默创建）；''=未关联；
  // 其他值为具体项目 id。打开创建区时优先继承当前活动项目或明确的项目筛选值。
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);

  const loadGoals = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.listGoals) return;
    setLoading(true);
    try {
      const result = await metis.listGoals();
      if (result.success) {
        if (metis.listProjects) {
          const projectResult = await metis.listProjects();
          if (projectResult.success) {
            setProjects(projectResult.projects.map((project) => ({ id: project.id, title: project.title || project.id })));
          }
        }
        setGoals((result.goals ?? []).map((g) => ({
          id: g.goalId,
          description: g.label,
          status: g.status as GoalStatus,
          priority: (g as unknown as { priority?: Priority }).priority,
          createdAt: g.createdAt,
          projectId: g.projectId,
        })));
      }
    } catch {
      setError(t('kanban.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loadGoals sets loading state synchronously before its first await
  useEffect(() => { void loadGoals(); }, [loadGoals]);

  // Live sync: any goal change from the chat side (create / plan / execute /
  // pause) refreshes the board without polling.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onGoalChanged) return;
    let stale = false;
    const unsubscribe = metis.onGoalChanged(() => { if (!stale) void loadGoals(); });
    return () => { stale = true; unsubscribe(); };
  }, [loadGoals]);

  // Board focus handoff from a chat goal card ("open this task on the board").
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = window.sessionStorage.getItem('metis-pending-goal-focus');
    if (pending) {
      pendingFocusRef.current = pending;
      window.sessionStorage.removeItem('metis-pending-goal-focus');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time handoff initialization; the filter must not hide the focused card
      setFilterText('');
    }
  }, []);
  useEffect(() => {
    const goalId = pendingFocusRef.current;
    if (!goalId || !goals.some((g) => g.id === goalId)) return;
    pendingFocusRef.current = null;
    setSelectedId(goalId);
    requestAnimationFrame(() => {
      const card = document.querySelector(`[data-goal-id="${goalId}"]`);
      if (card && typeof (card as HTMLElement).scrollIntoView === 'function') {
        (card as HTMLElement).scrollIntoView({ block: 'center' });
      }
    });
  }, [goals]);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return goals.filter((g) => {
      if (q && !g.description.toLowerCase().includes(q)) return false;
      if (priorityFilter && g.priority !== priorityFilter) return false;
      if (projectFilter === 'unbound') return !g.projectId;
      if (projectFilter && g.projectId !== projectFilter) return false;
      return true;
    });
  }, [goals, filterText, priorityFilter, projectFilter]);

  const byColumn = useMemo(() => {
    const map = new Map<ColumnId, KanbanGoal[]>();
    for (const col of COLUMNS) map.set(col.id, []);
    for (const goal of filtered) {
      const col = statusToColumn(goal.status);
      map.get(col)?.push(goal);
    }
    return map;
  }, [filtered]);

  const selected = goals.find((g) => g.id === selectedId) ?? null;

  // ── Drag and drop ──

  const handleDragStart = useCallback((e: React.DragEvent, goalId: string) => {
    setDraggingId(goalId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(columnId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  // Keyboard equivalent of drag-and-drop: focus a card, then move it with
  // ArrowLeft / ArrowRight between adjacent columns.
  const moveGoalToColumn = useCallback(async (goalId: string, columnId: ColumnId) => {
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return;
    const newStatus = columnToStatus(columnId);
    if (goal.status === newStatus) return;
    const metis = window.metis;
    if (!metis?.updateGoalStatus) return;
    const result = await metis.updateGoalStatus({ goalId, status: newStatus });
    if (result.ok) await loadGoals();
  }, [goals, loadGoals]);

  const handleDrop = useCallback(async (e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    setDragOverColumn(null);
    if (!draggingId) return;
    await moveGoalToColumn(draggingId, columnId);
    setDraggingId(null);
  }, [draggingId, moveGoalToColumn]);

  const handleCardKeyDown = useCallback((e: React.KeyboardEvent, goalId: string, currentColumn: ColumnId) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const currentIndex = COLUMNS.findIndex((column) => column.id === currentColumn);
    const nextIndex = e.key === 'ArrowRight' ? currentIndex + 1 : currentIndex - 1;
    const target = COLUMNS[nextIndex];
    if (!target) return;
    void moveGoalToColumn(goalId, target.id);
  }, [moveGoalToColumn]);

  // ── Card actions ──

  const handleDelete = useCallback(async (goalId: string) => {
    const metis = window.metis;
    if (!metis?.deleteGoal) return;
    const result = await metis.deleteGoal(goalId);
    if (result.ok) {
      setSelectedId(null);
      await loadGoals();
    }
  }, [loadGoals]);

  const handleSetPriority = useCallback(async (goalId: string, priority: Priority) => {
    const metis = window.metis;
    if (!metis?.updateGoalPriority) return;
    await metis.updateGoalPriority({ goalId, priority });
    await loadGoals();
  }, [loadGoals]);

  // UX-KANBAN-002: 新建任务的默认归属——优先继承当前活动项目，其次明确的项目
  // 筛选值（含「未关联」筛选）；两者都没有时必须显式选择，绝不静默创建全局任务。
  const defaultTaskProject = useCallback((): string | null => {
    if (projectFilter === 'unbound') return '';
    if (projectFilter) return projectFilter;
    return researchWorkspaceStore.getState().activeProjectId ?? null;
  }, [projectFilter]);

  const handleCreateTask = useCallback(async (columnId: ColumnId) => {
    const metis = window.metis;
    if (!metis?.createGoal || !newTaskText.trim()) return;
    // 归属未显式选择时不允许提交——用户必须先在下拉框里做出选择。
    if (newTaskProject === null) return;
    const status = columnToStatus(columnId);
    const projectId = newTaskProject === '' ? undefined : newTaskProject;
    const result = await metis.createGoal(
      newTaskText.trim(),
      undefined,
      projectId,
    );
    if (result.success && result.goalId) {
      await metis.updateGoalStatus?.({ goalId: result.goalId, status });
      await loadGoals();
      setNewTaskColumn(null);
      setNewTaskText('');
      setNewTaskProject(null);
    }
  }, [loadGoals, newTaskText, newTaskProject]);

  return (
    <div className="kanban-page">
      <div className="kanban-header">
        <h2>{t('kanban.pageTitle')}</h2>
        <button className="btn-toggle" onClick={() => void loadGoals()} disabled={loading}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>

      {/* Filter bar */}
      <div className="kanban-filterbar">
        <input
          type="text"
          className="search-input"
          placeholder={t('kanban.searchPlaceholder')}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ width: 200 }}
        />
        <select
          className="btn-sm"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          aria-label={t('kanban.filterProject')}
          data-testid="kanban-project-filter"
        >
          <option value="">{t('kanban.allProjects')}</option>
          <option value="unbound">{t('kanban.unboundProjects')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.title}</option>
          ))}
        </select>
        <select
          className="btn-sm"
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          aria-label={t('kanban.filterPriority')}
        >
          <option value="">{t('kanban.allPriorities')}</option>
          <option value="urgent">{t('kanban.priorityUrgent')}</option>
          <option value="high">{t('kanban.priorityHigh')}</option>
          <option value="medium">{t('kanban.priorityMedium')}</option>
          <option value="low">{t('kanban.priorityLow')}</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {t('kanban.totalCount', { count: filtered.length })}
        </span>
      </div>

      {error && <div className="kanban-error" role="alert">{error}</div>}

      {/* Board */}
      <div className="kanban-board" data-testid="kanban-board">
        {COLUMNS.map((col) => {
          const columnGoals = byColumn.get(col.id) ?? [];
          return (
            <div
              key={col.id}
              className={`kanban-column ${dragOverColumn === col.id ? 'kanban-column--dragover' : ''}`}
              data-testid={`kanban-column-${col.id}`}
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => void handleDrop(e, col.id)}
            >
              <div className="kanban-column__header" style={{ borderTopColor: col.color }}>
                <span className="kanban-column__title">{t(col.labelKey)}</span>
                <span className="kanban-column__count">{columnGoals.length}</span>
                <button
                  className="kanban-column__add"
                  data-testid={`kanban-add-${col.id}`}
                  onClick={() => {
                    setNewTaskColumn(newTaskColumn === col.id ? null : col.id);
                    setNewTaskText('');
                    setNewTaskProject(defaultTaskProject());
                  }}
                  title={t('kanban.addTask')}
                >
                  +
                </button>
              </div>

              {/* Inline new-task input */}
              {newTaskColumn === col.id && (
                <div className="kanban-new-task">
                  <input
                    className="settings-input"
                    data-testid={`kanban-new-task-input-${col.id}`}
                    value={newTaskText}
                    onChange={(e) => setNewTaskText(e.target.value)}
                    placeholder={t('kanban.newTaskPlaceholder')}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateTask(col.id); if (e.key === 'Escape') setNewTaskColumn(null); }}
                  />
                  <select
                    className="btn-sm"
                    value={newTaskProject === null ? '' : (newTaskProject === '' ? '__unbound__' : newTaskProject)}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === '__unbound__') setNewTaskProject('');
                      else if (value === '') setNewTaskProject(null);
                      else setNewTaskProject(value);
                    }}
                    data-testid="kanban-new-task-project"
                    aria-label={t('kanban.taskProject')}
                  >
                    {newTaskProject === null && <option value="" disabled>{t('kanban.selectProject')}</option>}
                    <option value="__unbound__">{t('kanban.unboundProjects')}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.title}</option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <button className="btn-primary btn-sm" data-testid={`kanban-create-${col.id}`} onClick={() => void handleCreateTask(col.id)}>{t('common.save')}</button>
                    <button className="btn-secondary btn-sm" onClick={() => setNewTaskColumn(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              )}

              <div className="kanban-column__cards">
                {columnGoals.map((goal) => (
                  <div
                    key={goal.id}
                    className={`kanban-card ${selectedId === goal.id ? 'kanban-card--selected' : ''} ${draggingId === goal.id ? 'kanban-card--dragging' : ''}`}
                    data-testid="kanban-card"
                    data-goal-id={goal.id}
                    draggable
                    role="button"
                    tabIndex={0}
                    aria-label={`${goal.description}，${t(`kanban.status_${goal.status}`)}`}
                    onDragStart={(e) => handleDragStart(e, goal.id)}
                    onClick={() => setSelectedId(goal.id)}
                    onKeyDown={(e) => handleCardKeyDown(e, goal.id, col.id)}
                  >
                    <div className="kanban-card__title">{goal.description}</div>
                    <div className="kanban-card__meta">
                      {goal.priority && (
                        <span className="kanban-card__priority" style={{ color: PRIORITY_COLORS[goal.priority] }}>
                          {t(`kanban.priority${goal.priority.charAt(0).toUpperCase() + goal.priority.slice(1)}`)}
                        </span>
                      )}
                      <span className="kanban-card__age">{formatAge(goal.createdAt, locale)}</span>
                    </div>
                  </div>
                ))}
                {columnGoals.length === 0 && !newTaskColumn && (
                  <div className="kanban-column__empty">{t('kanban.columnEmpty')}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail panel — dialog semantics with keyboard close */}
      {selected && (
        <div
          className="kanban-detail"
          data-testid="kanban-detail"
          role="dialog"
          aria-modal="true"
          aria-label={selected.description}
          onKeyDown={(e) => { if (e.key === 'Escape') setSelectedId(null); }}
        >
          <div className="kanban-detail__header">
            <h3>{selected.description}</h3>
            <button className="btn-sm btn-secondary" autoFocus onClick={() => setSelectedId(null)} aria-label={t('common.close') ?? '关闭'}>×</button>
          </div>
          <div className="kanban-detail__body">
            <div className="kanban-detail__row">
              <span className="kanban-detail__label">{t('kanban.detailStatus')}</span>
              <span className="kanban-detail__value">{t(`kanban.status_${selected.status}`)}</span>
            </div>
            <div className="kanban-detail__row">
              <span className="kanban-detail__label">{t('kanban.detailPriority')}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['low', 'medium', 'high', 'urgent'] as Priority[]).map((p) => (
                  <button
                    key={p}
                    className={`btn-sm ${selected.priority === p ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => void handleSetPriority(selected.id, p)}
                  >
                    {t(`kanban.priority${p.charAt(0).toUpperCase() + p.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="kanban-detail__row">
              <span className="kanban-detail__label">{t('kanban.detailCreated')}</span>
              <span className="kanban-detail__value">{new Date(selected.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</span>
            </div>
            <div className="kanban-detail__actions">
              <button
                className="btn-sm btn-primary"
                data-testid="kanban-discuss-in-chat"
                onClick={() => {
                  setSelectedId(null);
                  window.dispatchEvent(new CustomEvent('metis:open-goal', { detail: { goalId: selected.id } }));
                }}
              >
                {t('kanban.discussInChat')}
              </button>
              <button
                className="btn-sm"
                data-testid="kanban-delete"
                onClick={() => void handleDelete(selected.id)}
                style={{ color: 'var(--status-failed)' }}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
