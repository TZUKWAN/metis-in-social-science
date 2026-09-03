/**
 * ProjectsPage — 科研项目工作台。
 *
 * 科研项目（原「研究写作」）的新形态：左侧直接展示科研项目列表，
 * 主区域为三个模式页签：聊天 / 任务看板 / 资料。
 * 九分区（项目设计/资料来源/…）按产品决定暂不暴露。
 *
 * 聊天内容由 App 层常驻的 ChatPage 提供（renderLayout 注入），
 * 因此切换模式或导航不会丢失对话草稿。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { Button, Input, Select } from '../components/ui';
import TaskBoardPage from './TaskBoardPage';
import LibraryPage from './LibraryPage';
import ProjectHomeBanner from '../components/ProjectHomeBanner';
import SplitHandle from '../components/SplitHandle';

export type ProjectViewMode = 'chat' | 'kanban' | 'materials';

export interface ProjectsPageProps {
  /** Active project-center mode (controlled by the app shell). */
  mode: ProjectViewMode;
  onModeChange: (mode: ProjectViewMode) => void;
  /** Chat workspace content — owned by the app-level ChatPage. */
  chatContent: ReactNode;
  /** Chat right panel — owned by the app-level ChatPage. */
  chatRightPanel: ReactNode;
  /** 生成物预览栏（2026-08-31 刘总布局重构）：非空即在最右侧以整列呈现，
   *  并联动：项目清单自动收缩、聊天区弹性让位（窗口缩放自适应）。 */
  previewPanel?: ReactNode;
}

const MODES: Array<{ id: ProjectViewMode; labelKey: string; testId: string }> = [
  { id: 'chat', labelKey: 'projects.modeChat', testId: 'projects-mode-chat' },
  { id: 'kanban', labelKey: 'projects.modeKanban', testId: 'projects-mode-kanban' },
  { id: 'materials', labelKey: 'projects.modeMaterials', testId: 'projects-mode-materials' },
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
const PREVIEW_KEY = 'metis-projects-preview-width';
const SIDEBAR_COLLAPSED_KEY = 'metis-projects-sidebar-collapsed';

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

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
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

export default function ProjectsPage({ mode, onModeChange, chatContent, chatRightPanel, previewPanel }: ProjectsPageProps) {
  const { t, locale } = useTranslation();
  const projects = useResearchWorkspaceStore((s) => s.projects);
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const loadingProjects = useResearchWorkspaceStore((s) => s.loading.projects);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [projectDir, setProjectDir] = useState('');
  // 新建项目绑定场景（2026-08-29 刘总要求）：科研项目页的内联创建表单
  // 同样提供场景下拉；创建后写入全局与项目级偏好。
  const [createScenarioOptions, setCreateScenarioOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [createScenarioId, setCreateScenarioId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadWidth(SIDEBAR_KEY, 248, 180, 420));
  const [chatRightWidth, setChatRightWidth] = useState(() => loadWidth(CHAT_RIGHT_KEY, 320, 240, 560));
  // 预览栏与项目清单折叠（2026-08-31 刘总布局重构）：预览打开时清单自动
  // 收缩，给预览留足空间；手动拖拽调宽全部保留。
  const [previewWidth, setPreviewWidth] = useState(() => loadWidth(PREVIEW_KEY, 520, 360, 800));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadBool(SIDEBAR_COLLAPSED_KEY, false));
  const [showArchived, setShowArchived] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const collapsedBeforePreviewRef = useRef<boolean | null>(null);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;

  const previewOpen = Boolean(previewPanel);

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

  const handlePreviewDrag = useCallback((clientX: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPreviewWidth(Math.min(800, Math.max(360, rect.right - clientX)));
  }, []);

  // 预览开合联动（2026-08-31 刘总要求，窗口缩放自适应修正）：打开时项目清单
  // 自动收缩（记住打开前的折叠态，关闭时恢复）。聊天区保持 flex:1 弹性填充
  // ——预览栏（固定像素、可拖宽）之外的剩余空间全部归聊天区，窗口放大/缩小
  // 时 flex 自动重排，不再出现"打开预览后窗口变大留下大片空白"的问题。
  // 此前实现是预览打开瞬间实测聊天宽度钉成固定像素（flex:none），窗口尺寸
  // 变化后没有任何列跟随伸缩。
  useEffect(() => {
    if (previewOpen) {
      if (collapsedBeforePreviewRef.current === null) {
        collapsedBeforePreviewRef.current = sidebarCollapsedRef.current;
        setSidebarCollapsed(true);
      }
      return;
    }
    if (collapsedBeforePreviewRef.current !== null) {
      setSidebarCollapsed(collapsedBeforePreviewRef.current);
      collapsedBeforePreviewRef.current = null;
    }
  }, [previewOpen]);

  // 宽度持久化放 effect：拖动结束时读到的是最新值。
  useEffect(() => { saveWidth(SIDEBAR_KEY, sidebarWidth); }, [sidebarWidth]);
  useEffect(() => { saveWidth(CHAT_RIGHT_KEY, chatRightWidth); }, [chatRightWidth]);
  useEffect(() => { saveWidth(PREVIEW_KEY, previewWidth); }, [previewWidth]);
  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0'); } catch { /* best-effort */ }
  }, [sidebarCollapsed]);

  useEffect(() => {
    void researchWorkspaceStore.getState().loadProjects();
  }, []);

  // 展开创建表单时加载可选场景清单。
  useEffect(() => {
    if (!creating) return;
    const metis = window.metis;
    if (!metis?.listPersonalization) { setCreateScenarioOptions([]); return; }
    void metis.listPersonalization({ contractVersion: 1, kind: 'scenario', includeDisabled: false })
      .then((response) => {
        setCreateScenarioOptions(response.definitions
          .filter((definition) => definition.kind === 'scenario'
            && definition.enabled
            && definition.provenance.origin !== 'builtin')
          .map((definition) => ({ id: definition.id, name: definition.name })));
      })
      .catch(() => setCreateScenarioOptions([]));
  }, [creating]);

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
    const newProjectId = result.success ? result.resourceId : null;
    if (result.success && createScenarioId && newProjectId) {
      try {
        window.localStorage.setItem('metis:active-scenario-id', createScenarioId);
        window.localStorage.setItem(`metis:project-scenario:${newProjectId}`, createScenarioId);
      } catch { /* preference persistence is best-effort */ }
    }
    setCreateBusy(false);
    if (result.success) {
      setNewTitle('');
      setProjectDir('');
      setCreateScenarioId('');
      setCreating(false);
    }
  };

  const pickProjectDir = async () => {
    const picked = await window.metis?.openDirectoryDialog?.();
    if (picked) setProjectDir(picked);
  };

  return (
    <div className="projects-page" data-testid="projects-page" ref={pageRef}>
      {sidebarCollapsed ? (
        <div className="projects-page__sidebar-rail" data-testid="projects-sidebar-rail">
          <button
            type="button"
            className="projects-page__rail-btn"
            title={locale === 'zh' ? '展开项目清单' : 'Expand project list'}
            aria-label={locale === 'zh' ? '展开项目清单' : 'Expand project list'}
            data-testid="projects-sidebar-expand"
            onClick={() => setSidebarCollapsed(false)}
          >
            »
          </button>
        </div>
      ) : (
      <aside
        className="projects-page__sidebar"
        aria-label={t('projects.projectListTitle')}
        style={{ width: sidebarWidth }}
      >
        <header className="projects-page__sidebar-header">
          <h2>{t('projects.projectListTitle')}</h2>
          <button
            type="button"
            className="projects-page__collapse-btn"
            title={locale === 'zh' ? '收起项目清单' : 'Collapse project list'}
            aria-label={locale === 'zh' ? '收起项目清单' : 'Collapse project list'}
            data-testid="projects-sidebar-collapse"
            onClick={() => setSidebarCollapsed(true)}
          >
            «
          </button>
          <Button
            variant="secondary"
            size="sm"
            className="projects-page__new"
            data-testid="projects-new-project"
            onClick={() => setCreating((value) => !value)}
          >
            {t('projects.newProject')}
          </Button>
          <Button
            variant={showArchived ? 'primary' : 'secondary'}
            size="sm"
            className="projects-page__new"
            title={t('projects.archivedTitle')}
            data-testid="projects-toggle-archived"
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? t('projects.activeTitle') : t('projects.archivedButton')}
          </Button>
        </header>
        {creating && (
          <div className="projects-page__create" data-testid="projects-create-form">
            <Input
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
            <Select
              className="settings-input"
              data-testid="projects-scenario-select"
              value={createScenarioId}
              onChange={(event) => setCreateScenarioId(event.target.value)}
              aria-label={t('projects.scenarioBinding')}
            >
              <option value="">{t('projects.scenarioNone')}</option>
              {createScenarioOptions.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
              ))}
            </Select>
            <div className="projects-page__create-actions">
              <Button
                variant="primary"
                size="sm"
                data-testid="projects-create-submit"
                disabled={createBusy || !newTitle.trim()}
                onClick={() => void handleCreate()}
              >
                {t('projects.create')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setCreating(false); setNewTitle(''); setProjectDir(''); }}
              >
                {t('projects.cancel')}
              </Button>
            </div>
            <div className="projects-page__create-dir" data-testid="projects-create-dir">
              <Input
                className="settings-input"
                placeholder={t('projects.projectDirPlaceholder')}
                value={projectDir}
                onChange={(event) => setProjectDir(event.target.value)}
                data-testid="projects-dir-input"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void pickProjectDir()}
                data-testid="projects-dir-browse"
              >
                {t('projects.browse')}
              </Button>
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
                    <Button
                      variant="secondary"
                      size="sm"
                      title={t('projects.restore')}
                      data-testid="projects-restore"
                      onClick={() => void handleRestore(project.id)}
                    >
                      {t('projects.restore')}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      title={t('projects.archive')}
                      data-testid="projects-archive"
                      onClick={() => void handleArchive(project.id)}
                    >
                      {t('projects.archive')}
                    </Button>
                  )}
                  <Button
                    variant={deleteConfirmId === project.id ? 'danger' : 'secondary'}
                    size="sm"
                    title={t('projects.delete')}
                    data-testid="projects-delete"
                    onClick={() => void handleDelete(project.id)}
                  >
                    {deleteConfirmId === project.id ? t('projects.confirmDelete') : t('projects.delete')}
                  </Button>
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
      )}

      {!sidebarCollapsed && (
      <SplitHandle
        label={locale === 'zh' ? '拖动调整项目列表宽度' : 'Drag to resize the project list'}
        testId="projects-split-sidebar"
        onDrag={handleSidebarDrag}
        onKeyDelta={(delta) => {
          setSidebarWidth((current) => Math.min(420, Math.max(180, current + delta)));
        }}
      />
      )}

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
              <div
                className="projects-page__chat-workspace"
                style={previewOpen ? { minWidth: 360 } : undefined}
              >{chatContent}</div>
              <SplitHandle
                label={locale === 'zh' ? '拖动调整右侧面板宽度' : 'Drag to resize the side panel'}
                testId="projects-split-chat-right"
                onDrag={handleChatRightDrag}
                onKeyDelta={(delta) => {
                  setChatRightWidth((current) => Math.min(560, Math.max(240, current - delta)));
                }}
              />
              <div className="projects-page__chat-right" style={{ width: chatRightWidth }}>{chatRightPanel}</div>
              {previewOpen && (
                <>
                  <SplitHandle
                    label={locale === 'zh' ? '拖动调整预览栏宽度' : 'Drag to resize the preview pane'}
                    testId="projects-split-preview"
                    onDrag={handlePreviewDrag}
                    onKeyDelta={(delta) => {
                      setPreviewWidth((current) => Math.min(800, Math.max(360, current - delta)));
                    }}
                  />
                  <div
                    className="projects-page__preview"
                    style={{ width: previewWidth, maxWidth: 'calc(100% - 680px)' }}
                  >{previewPanel}</div>
                </>
              )}
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
        </div>
      </div>
    </div>
  );
}
