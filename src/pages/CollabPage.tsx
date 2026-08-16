/**
 * CollabPage — 协同对话工作区。
 *
 * 左侧：第三方 AI 网页版标签页（icon 标签 + 用户可增删改，本地持久化），
 * 通过主进程 WebContentsView 嵌入，登录态独立持久化。
 * 右侧：METIS 自己的研究对话（由常驻 ChatPage 经 renderLayout 注入），
 * 会话列表与任务/生成物面板以抽屉形式按需展开。
 *
 * 设计意图：一边与其他 AI 交流思路，一边让 METIS 基于项目资料干活。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import SplitHandle from '../components/SplitHandle';
import './CollabPage.css';

export interface CollabSite {
  id: string;
  name: string;
  url: string;
}

const DEFAULT_SITES: CollabSite[] = [
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/' },
  { id: 'glm', name: '智谱 GLM', url: 'https://chatglm.cn/' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
];

const SITES_STORAGE_KEY = 'metis-collab-sites-v1';
const LAST_AI_KEY = 'metis-collab-ai';
const SPLIT_STORAGE_KEY = 'metis-collab-split';
const SPLIT_DEFAULT = 0.52;
const SPLIT_MIN = 0.25;
const SPLIT_MAX = 0.75;

function loadSplitRatio(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value)) : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}

function loadSites(): CollabSite[] {
  try {
    const raw = window.localStorage.getItem(SITES_STORAGE_KEY);
    // 从未编辑过 → 默认列表；编辑过（哪怕删空）→ 尊重用户选择。
    if (raw === null) return DEFAULT_SITES;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_SITES;
    return parsed
      .filter((item): item is CollabSite => (
        typeof item === 'object' && item !== null
        && typeof (item as CollabSite).id === 'string'
        && typeof (item as CollabSite).name === 'string'
        && typeof (item as CollabSite).url === 'string'
        && /^https?:/i.test((item as CollabSite).url)
      ))
      .slice(0, 24);
  } catch {
    return DEFAULT_SITES;
  }
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

interface SiteDraft {
  id?: string;
  name: string;
  url: string;
}

export interface CollabPageProps {
  /** METIS 对话工作区（ChatPage workspace 插槽）。 */
  chatContent: ReactNode;
  /** METIS 会话列表（ChatPage leftPanel 插槽）。 */
  sessionPanel: ReactNode;
  /** METIS 右侧面板（ChatPage rightPanel 插槽）。 */
  rightPanel: ReactNode;
}

export default function CollabPage({ chatContent, sessionPanel, rightPanel }: CollabPageProps) {
  const { t, locale } = useTranslation();
  const zh = locale === 'zh';
  const hostRef = useRef<HTMLDivElement>(null);
  const [sites, setSites] = useState<CollabSite[]>(loadSites);
  const [activeAiId, setActiveAiId] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(LAST_AI_KEY);
      const list = loadSites();
      return list.some((site) => site.id === saved) ? (saved as string) : (list[0]?.id ?? '');
    } catch {
      return DEFAULT_SITES[0]!.id;
    }
  });
  const [externalHidden, setExternalHidden] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [manageMode, setManageMode] = useState(false);
  const [editing, setEditing] = useState<SiteDraft | null>(null);
  const [editError, setEditError] = useState('');
  const [splitRatio, setSplitRatio] = useState<number>(loadSplitRatio);
  const pageRef = useRef<HTMLDivElement>(null);
  const projects = useResearchWorkspaceStore((state) => state.projects);
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);

  // 右侧 Metis 对话直接链接到当前科研项目：加载项目列表供切换。
  useEffect(() => {
    const store = researchWorkspaceStore.getState();
    if (store.projects.length === 0) void store.loadProjects();
  }, []);

  const handleProjectSwitch = useCallback((projectId: string) => {
    if (projectId) void researchWorkspaceStore.getState().setActiveProject(projectId);
  }, []);

  const handleOpenProjects = useCallback(() => {
    window.dispatchEvent(new CustomEvent('metis:navigate-projects'));
  }, []);

  const activeSite = sites.find((site) => site.id === activeAiId) ?? sites[0] ?? null;

  const applySplitFromClientX = useCallback((clientX: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (clientX - rect.left) / (rect.width || 1);
    setSplitRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)));
  }, []);

  // 宽度持久化放在 effect 里：拖动结束时读到的是最新值（事件回调闭包会拿旧值）。
  useEffect(() => {
    try { window.localStorage.setItem(SPLIT_STORAGE_KEY, String(splitRatio)); } catch { /* best-effort */ }
  }, [splitRatio]);

  // 拖动分隔条时先隐藏原生嵌入视图（它覆盖在页面上方会吞掉指针事件），
  // 松手后按新尺寸重新显示。
  const handleSplitDragStart = useCallback(() => {
    void window.metis?.collabHide?.();
  }, []);

  const handleSplitDragEnd = useCallback(() => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (rect && rect.width >= 4 && rect.height >= 4) {
      void window.metis?.collabShow?.({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
  }, []);

  const handleSplitKeyDelta = useCallback((delta: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    const width = rect && rect.width > 0 ? rect.width : 1;
    const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, splitRatio + delta / width));
    setSplitRatio(next);
  }, [splitRatio]);

  const persistSites = useCallback((next: CollabSite[]) => {
    setSites(next);
    try { window.localStorage.setItem(SITES_STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  }, []);

  // Sync the host rect to the main-process WebContentsView.
  useEffect(() => {
    if (externalHidden || !activeSite) return;
    const host = hostRef.current;
    const metis = window.metis;
    if (!host || !metis?.collabShow) return;

    const report = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      void metis.collabSetBounds?.({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    report();
    const rect = host.getBoundingClientRect();
    void metis.collabShow({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    const observer = new ResizeObserver(report);
    observer.observe(host);
    window.addEventListener('resize', report);
    // 全局弹层关闭后恢复嵌入视图（App 在弹层打开时统一隐藏）。
    const restore = () => {
      const next = host.getBoundingClientRect();
      if (next.width >= 4 && next.height >= 4) {
        void metis.collabShow({ x: next.left, y: next.top, width: next.width, height: next.height });
      }
    };
    window.addEventListener('metis:restore-embedded-views', restore);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('metis:restore-embedded-views', restore);
      void window.metis?.collabHide?.();
    };
  }, [externalHidden, activeSite]);

  // Navigate when the active site changes.
  useEffect(() => {
    if (externalHidden || !activeSite) return;
    const metis = window.metis;
    if (!metis?.collabNavigate) return;
    void metis.collabNavigate(activeSite.url);
    try { window.localStorage.setItem(LAST_AI_KEY, activeSite.id); } catch { /* best-effort */ }
  }, [activeSite, externalHidden]);

  const toggleExternal = useCallback(() => {
    setExternalHidden((hidden) => {
      if (!hidden) void window.metis?.collabHide?.();
      return !hidden;
    });
  }, []);

  const handleDeleteSite = useCallback((id: string) => {
    persistSites(sites.filter((site) => site.id !== id));
    if (editing?.id === id) setEditing(null);
  }, [sites, persistSites, editing]);

  const openEditor = useCallback((draft: SiteDraft) => {
    setEditing(draft);
    setEditError('');
  }, []);

  const saveEditing = useCallback(() => {
    if (!editing) return;
    const name = editing.name.trim().slice(0, 16);
    const url = normalizeUrl(editing.url);
    if (!name || !url) {
      setEditError(t('collab.invalidSite'));
      return;
    }
    if (editing.id) {
      persistSites(sites.map((site) => (site.id === editing.id ? { ...site, name, url } : site)));
    } else {
      const id = `custom-${Date.now().toString(36)}`;
      persistSites([...sites, { id, name, url }]);
      setActiveAiId(id);
    }
    setEditing(null);
    setEditError('');
  }, [editing, sites, persistSites, t]);

  const resetDefaults = useCallback(() => {
    persistSites(DEFAULT_SITES);
    setEditing(null);
  }, [persistSites]);

  return (
    <div className="collab-page" data-testid="collab-page" role="region" aria-label="Metis 研究工作台" ref={pageRef}>
      {!externalHidden && (
        <section
          className="collab-external"
          aria-label={zh ? '第三方 AI 对话' : 'External AI chat'}
          style={{ flex: `0 0 ${(splitRatio * 100).toFixed(2)}%` }}
        >
          <header className="collab-external__header">
            <div className="collab-external__tabs" role="tablist" aria-label={zh ? '选择 AI' : 'Choose AI'}>
              {sites.map((site) => (
                <div key={site.id} className="collab-site">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeSite?.id === site.id}
                    className={`collab-external__tab ${activeSite?.id === site.id ? 'active' : ''}`}
                    data-testid={`collab-ai-${site.id}`}
                    title={manageMode ? t('collab.editSite') : site.url}
                    onClick={() => (manageMode ? openEditor({ id: site.id, name: site.name, url: site.url }) : setActiveAiId(site.id))}
                  >
                    {site.name}
                  </button>
                  {manageMode && (
                    <button
                      type="button"
                      className="collab-site__remove"
                      aria-label={t('collab.deleteSite')}
                      data-testid={`collab-remove-${site.id}`}
                      onClick={() => handleDeleteSite(site.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {manageMode && (
                <button
                  type="button"
                  className="collab-external__tab collab-external__tab--add"
                  data-testid="collab-add"
                  onClick={() => openEditor({ name: '', url: '' })}
                >
                  {t('collab.addAi')}
                </button>
              )}
            </div>
            <div className="collab-external__header-actions">
              {manageMode && (
                <button
                  type="button"
                  className="collab-pane-toggle"
                  onClick={resetDefaults}
                  data-testid="collab-reset-sites"
                >
                  {t('collab.resetDefaults')}
                </button>
              )}
              <button
                type="button"
                className={`collab-pane-toggle ${manageMode ? 'active' : ''}`}
                onClick={() => { setManageMode((on) => !on); setEditing(null); setEditError(''); }}
                aria-expanded={manageMode}
                data-testid="collab-manage"
              >
                {manageMode ? t('collab.doneManage') : t('collab.manage')}
              </button>
              <button
                type="button"
                className="collab-pane-toggle"
                onClick={toggleExternal}
                title={zh ? '收起第三方 AI' : 'Hide external AI'}
                aria-label={zh ? '收起第三方 AI' : 'Hide external AI'}
                data-testid="collab-hide-external"
              >
                ‹
              </button>
            </div>
          </header>
          {editing && (
            <div className="collab-site-form" data-testid="collab-site-form">
              <label>
                <span>{t('collab.siteName')}</span>
                <input
                  className="settings-input"
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  placeholder={zh ? '例如：豆包' : 'e.g. Doubao'}
                  data-testid="collab-site-name-input"
                />
              </label>
              <label>
                <span>{t('collab.siteUrl')}</span>
                <input
                  className="settings-input"
                  value={editing.url}
                  onChange={(event) => setEditing({ ...editing, url: event.target.value })}
                  placeholder="https://…"
                  data-testid="collab-site-url-input"
                />
              </label>
              <div className="collab-site-form__actions">
                <button type="button" className="btn-primary btn-sm" onClick={saveEditing} data-testid="collab-site-save">
                  {t('common.save')}
                </button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => { setEditing(null); setEditError(''); }}>
                  {t('common.cancel')}
                </button>
              </div>
              {editError && <p className="collab-site-form__error" role="alert">{editError}</p>}
            </div>
          )}
          {activeSite ? (
            <div className="collab-external__host" ref={hostRef} data-testid="collab-host" />
          ) : (
            <div className="collab-external__empty">
              <p>{t('collab.noSites')}</p>
            </div>
          )}
          <p className="collab-external__hint">{t('collab.loginHint')}</p>
        </section>
      )}

      {!externalHidden && (
        <SplitHandle
          label={zh ? '拖动调整分屏宽度' : 'Drag to resize panes'}
          testId="collab-split-handle"
          onDragStart={handleSplitDragStart}
          onDrag={applySplitFromClientX}
          onDragEnd={handleSplitDragEnd}
          onKeyDelta={handleSplitKeyDelta}
        />
      )}

      <section className="collab-metis" aria-label={zh ? 'METIS 对话' : 'METIS chat'}>
        <header className="collab-metis__header">
          <span className="collab-metis__title">Metis</span>
          <label className="collab-metis__project" htmlFor="collab-project-select">
            <span className="collab-metis__project-label">{t('collab.linkedProject')}</span>
            <select
              id="collab-project-select"
              className="collab-project-select"
              value={activeProjectId ?? ''}
              onChange={(event) => handleProjectSwitch(event.target.value)}
              data-testid="collab-project-select"
            >
              <option value="">{t('collab.noProject')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.title}</option>
              ))}
            </select>
          </label>
          <div className="collab-metis__actions">
            <button
              type="button"
              className={`collab-pane-toggle ${sessionsOpen ? 'active' : ''}`}
              onClick={() => setSessionsOpen((open) => !open)}
              aria-expanded={sessionsOpen}
              data-testid="collab-toggle-sessions"
            >
              {t('collab.sessions')}
            </button>
            <button
              type="button"
              className={`collab-pane-toggle ${panelOpen ? 'active' : ''}`}
              onClick={() => setPanelOpen((open) => !open)}
              aria-expanded={panelOpen}
              data-testid="collab-toggle-panel"
            >
              {t('collab.panel')}
            </button>
            {externalHidden && (
              <button
                type="button"
                className="collab-pane-toggle"
                onClick={toggleExternal}
                data-testid="collab-show-external"
              >
                {t('collab.showExternal')}
              </button>
            )}
          </div>
        </header>
        <div className="collab-metis__body">
          {!activeProjectId && (
            <div className="collab-metis__no-project" data-testid="collab-no-project" role="note">
              <span>{t('collab.noProjectHint')}</span>
              <button type="button" className="btn-secondary btn-sm" onClick={handleOpenProjects} data-testid="collab-open-projects">
                {t('collab.openProjects')}
              </button>
            </div>
          )}
          {sessionsOpen && (
            <div className="collab-metis__sessions" data-testid="collab-sessions-drawer">
              {sessionPanel}
            </div>
          )}
          <div className="collab-metis__chat">{chatContent}</div>
          {panelOpen && (
            <div className="collab-metis__panel" data-testid="collab-panel-drawer">
              {rightPanel}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
