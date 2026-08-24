/**
 * ProjectsPage — 科研项目工作台。
 *
 * 科研项目（原「研究写作」）的新形态：左侧直接展示科研项目列表，
 * 主区域为三个模式页签：聊天 / 任务看板 / 研究成果。
 * 九分区（项目设计/资料来源/…）按产品决定暂不暴露。
 *
 * 聊天内容由 App 层常驻的 ChatPage 提供（renderLayout 注入），
 * 因此切换模式或导航不会丢失对话草稿。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import TaskBoardPage from './TaskBoardPage';
import ArtifactsCenter from './ArtifactsCenter';
import LibraryPage from './LibraryPage';
import ProjectHomeBanner from '../components/ProjectHomeBanner';
import SplitHandle from '../components/SplitHandle';

export type ProjectViewMode = 'chat' | 'kanban' | 'materials' | 'artifacts';

export interface ProjectsPageProps {
  /** Active project-center mode (controlled by the app shell). */
  mode: ProjectViewMode;
  onModeChange: (mode: ProjectViewMode) => void;
  /** Chat workspace content — owned by the app-level ChatPage. */
  chatContent: ReactNode;
  /** Chat right panel — owned by the app-level ChatPage. */
  chatRightPanel: ReactNode;
}

const MODES: Array<{ id: ProjectViewMode; labelKey: string; testId: string }> = [
  { id: 'chat', labelKey: 'projects.modeChat', testId: 'projects-mode-chat' },
  { id: 'kanban', labelKey: 'projects.modeKanban', testId: 'projects-mode-kanban' },
  { id: 'materials', labelKey: 'projects.modeMaterials', testId: 'projects-mode-materials' },
  { id: 'artifacts', labelKey: 'projects.modeArtifacts', testId: 'projects-mode-artifacts' },
];

function makeProjectId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `project-${crypto.randomUUID()}`;
    }
  } catch {
    // Fall through to a bounded renderer-only identifier.
  }
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SIDEBAR_KEY = 'metis-projects-sidebar-width';
const CHAT_RIGHT_KEY = 'metis-projects-chat-right-width';

function loadWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function saveWidth(key: string, value: number): void {
  try { window.localStorage.setItem(key, String(Math.round(value))); } catch { /* best-effort */ }
}

function formatUpdated(ts: number, locale: string): string {
  const date = new Date(ts);
  const now = Date.now();
  const diffDays = Math.floor((now - ts) / 86_400_000);
  if (diffDays <= 0) return locale === 'zh' ? '今天' : 'today';
  if (diffDays === 1) return locale === 'zh' ? '昨天' : 'yesterday';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function ProjectsPage({ mode, onModeChange, chatContent, chatRightPanel }: ProjectsPageProps) {
  const { t, locale } = useTranslation();
  const projects = useResearchWorkspaceStore((s) => s.projects);
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const loadingProjects = useResearchWorkspaceStore((s) => s.loading.projects);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadWidth(SIDEBAR_KEY, 248, 180, 420));
  const [chatRightWidth, setChatRightWidth] = useState(() => loadWidth(CHAT_RIGHT_KEY, 320, 240, 560));
  const [showArchived, setShowArchived] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const handleArchive = useCallback(async (projectId: string) => {
    const result = await window.metis?.archiveProject?.(projectId);
    if (result?.ok) {
      if (activeProjectId === projectId) await researchWorkspaceStore.getState().setActiveProject(null);
    }
    await researchWorkspaceStore.getState().loadProjects();
  }, [activeProjectId]);

  const handleRestore = useCallback(async (projectId: string) => {
    await window.metis?.restoreProject?.(projectId);
    await researchWorkspaceStore.getState().loadProjects();
  }, []);

  const handleDelete = useCallback(async (projectId: string) => {
    // 两段式确认：第一次点击进入确认态，再次点击执行。
    if (deleteConfirmId === projectId) {
      await window.metis?.deleteProject?.(projectId);
      if (activeProjectId === projectId) await researchWorkspaceStore.getState().setActiveProject(null);
      setDeleteConfirmId(null);
      await researchWorkspaceStore.getState().loadProjects();
      return;
    }
    setDeleteConfirmId(projectId);
    // 5 秒后自动退出确认态，避免误触累积。
    setTimeout(() => setDeleteConfirmId((current) => (current === projectId ? null : current)), 5000);
  }, [deleteConfirmId, activeProjectId]);

  const handleSidebarDrag = useCallback((clientX: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSidebarWidth(Math.min(420, Math.max(180, clientX - rect.left)));
  }, []);

  const handleChatRightDrag = useCallback((clientX: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setChatRightWidth(Math.min(560, Math.max(240, rect.right - clientX)));
  }, []);

  // 宽度持久化放 effect：拖动结束时读到的是最新值。
  useEffect(() => { saveWidth(SIDEBAR_KEY, sidebarWidth); }, [sidebarWidth]);
  useEffect(() => { saveWidth(CHAT_RIGHT_KEY, chatRightWidth); }, [chatRightWidth]);

  useEffect(() => {
    void researchWorkspaceStore.getState().loadProjects();
  }, []);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title || createBusy) return;
    setCreateBusy(true);
    const result = await researchWorkspaceStore.getState().createProject({
      projectId: makeProjectId(),
      title,
    });
    // 创建后若指定了自定义目录，写入 metadata.projectDir（PDF 归档位置）。
    if (result.success && projectDir && result.resourceId) {
      await window.metis?.setProjectDir?.(result.resourceId, projectDir);
    }
    setCreateBusy(false);
    if (result.success) {
      setNewTitle('');
      setProjectDir('');
      setCreating(false);
    }
  };

  const pickProjectDir = async () => {
    const picked = await window.metis?.openDirectoryDialog?.();
    if (picked) setProjectDir(picked);
  };

  return (
    <div className="projects-page" data-testid="projects-page" ref={pageRef}>
      <aside
        className="projects-page__sidebar"
        aria-label={t('projects.projectListTitle')}
        style={{ width: sidebarWidth }}
      >
        <header className="projects-page__sidebar-header">
          <h2>{t('projects.projectListTitle')}</h2>
          <button
            type="button"
            className="btn-secondary projects-page__new"
            data-testid="projects-new-project"
            onClick={() => setCreating((value) => !value)}
          >
            + {t('projects.newProject')}
          </button>
          <button
            type="button"
            className={`btn-secondary projects-page__new ${showArchived ? 'projects-page__new--active' : ''}`}
            title={t('projects.archivedTitle')}
            data-testid="projects-toggle-archived"
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? t('projects.activeTitle') : t('projects.archivedButton')}
          </button>
        </header>
        {creating && (
          <div className="projects-page__create" data-testid="projects-create-form">
            <input
              className="settings-input"
              data-testid="projects-new-project-input"
              value={newTitle}
              placeholder={t('projects.newProjectPlaceholder')}
              onChange={(event) => setNewTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate();
                if (event.key === 'Escape') { setCreating(false); setNewTitle(''); }
              }}
            />
            <div className="projects-page__create-actions">
              <button
                type="button"
                className="btn-primary"
                data-testid="projects-create-submit"
                disabled={createBusy || !newTitle.trim()}
                onClick={() => void handleCreate()}
              >
                {t('projects.create')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => { setCreating(false); setNewTitle(''); setProjectDir(''); }}
              >
                {t('projects.cancel')}
              </button>
            </div>
            <div className="projects-page__create-dir" data-testid="projects-create-dir">
              <input
                className="settings-input"
                placeholder={t('projects.projectDirPlaceholder')}
                value={projectDir}
                onChange={(event) => setProjectDir(event.target.value)}
                data-testid="projects-dir-input"
              />
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => void pickProjectDir()}
                data-testid="projects-dir-browse"
              >
                {t('projects.browse')}
              </button>
            </div>
            <p className="projects-page__create-hint">{t('projects.projectDirHint')}</p>
          </div>
        )}
        <ul className="projects-page__list">
          {projects
            .filter((project) => (showArchived ? project.lifecycle === 'archived' : project.lifecycle !== 'archived'))
            .map((project) => (
              <li key={project.id} className="projects-page__item-row">
                <button
                  type="button"
                  className={`projects-page__item ${activeProjectId === project.id ? 'active' : ''}`}
                  data-testid="projects-project-item"
                  data-project-id={project.id}
                  aria-current={activeProjectId === project.id ? 'page' : undefined}
                  onClick={() => void researchWorkspaceStore.getState().setActiveProject(project.id)}
                >
                  <span className="projects-page__item-title">{project.title}</span>
                  <span className="projects-page__item-meta">
                    {showArchived
                      ? t('projects.archivedAt', { time: formatUpdated(project.archivedAt ?? project.updatedAt, locale) })
                      : t('projects.projectUpdated', { time: formatUpdated(project.updatedAt, locale) })}
                  </span>
                </button>
                <div className="projects-page__item-actions">
                  {showArchived ? (
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      title={t('projects.restore')}
                      data-testid="projects-restore"
                      onClick={() => void handleRestore(project.id)}
                    >
                      {t('projects.restore')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      title={t('projects.archive')}
                      data-testid="projects-archive"
                      onClick={() => void handleArchive(project.id)}
                    >
                      {t('projects.archive')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn-sm ${deleteConfirmId === project.id ? 'btn-primary' : 'btn-secondary'}`}
                    title={t('projects.delete')}
                    data-testid="projects-delete"
                    onClick={() => void handleDelete(project.id)}
                  >
                    {deleteConfirmId === project.id ? t('projects.confirmDelete') : t('projects.delete')}
                  </button>
                </div>
              </li>
            ))}
          {projects.filter((project) => (showArchived ? project.lifecycle === 'archived' : project.lifecycle !== 'archived')).length === 0 && !loadingProjects && (
            <li className="projects-page__empty">
              {showArchived ? t('projects.noArchived') : t('projects.emptyProjects')}
            </li>
          )}
        </ul>
      </aside>

      <SplitHandle
        label={locale === 'zh' ? '拖动调整项目列表宽度' : 'Drag to resize the project list'}
        testId="projects-split-sidebar"
        onDrag={handleSidebarDrag}
        onKeyDelta={(delta) => {
          setSidebarWidth((current) => Math.min(420, Math.max(180, current + delta)));
        }}
      />

      <div className="projects-page__main">
        {activeProjectId ? <ProjectHomeBanner /> : (
          !loadingProjects && projects.length > 0 ? (
            <div className="projects-page__hint" data-testid="projects-select-hint">{t('projects.selectHint')}</div>
          ) : null
        )}
        <div className="projects-page__tabs" role="tablist" aria-label={t('projects.pageTitle')}>
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={`projects-page__tab ${mode === entry.id ? 'active' : ''}`}
              aria-selected={mode === entry.id}
              data-testid={entry.testId}
              onClick={() => onModeChange(entry.id)}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
        <div className="projects-page__content">
          {mode === 'chat' && (
            <div className="projects-page__chat">
              <div className="projects-page__chat-workspace">{chatContent}</div>
              <SplitHandle
                label={locale === 'zh' ? '拖动调整右侧面板宽度' : 'Drag to resize the side panel'}
                testId="projects-split-chat-right"
                onDrag={handleChatRightDrag}
                onKeyDelta={(delta) => {
                  setChatRightWidth((current) => Math.min(560, Math.max(240, current - delta)));
                }}
              />
              <div className="projects-page__chat-right" style={{ width: chatRightWidth }}>{chatRightPanel}</div>
            </div>
          )}
          {mode === 'kanban' && (
            <TaskBoardPage
              key={activeProjectId ?? 'no-project'}
              defaultProjectFilter={activeProjectId ?? undefined}
            />
          )}
          {mode === 'materials' && (
            <LibraryPage
              key={activeProjectId ?? 'no-project'}
              projectId={activeProjectId}
            />
          )}
          {mode === 'artifacts' && (
            <ArtifactsCenter
              key={activeProjectId ?? 'no-project'}
              projectId={activeProjectId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
