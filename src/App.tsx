import { useState, useEffect, Suspense, lazy } from 'react'
import './App.css'
import ChatPage from './pages/ChatPage'
import { useTranslation } from './i18n'
import type { Page, TopLevelEntry, ThemeMode } from './store'
import { useMetisStore } from './store'
import GlobalSearch from './components/GlobalSearch'
import ShortcutsHelp from './components/ShortcutsHelp'
import ErrorBoundary from './components/ErrorBoundary'
import type { WorkspaceMode } from './shell/ProjectShell'
import { getTopLevelNav } from './shell/navConfig'
import { getDiagnosticMode, setDiagnosticMode, type UIMode } from '../engine/capabilities/DiagnosticMode'
import type { FirstRunSetupClient } from './components/FirstRunWizard'
import { useResearchWorkspaceStore } from './research/researchWorkspaceStore'
import { setPendingChatIntent } from './lib/chatIntent'

// 鈹€鈹€鈹€ Lazy-loaded pages to reduce initial bundle size 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const PapersPage = lazy(() => import('./pages/PapersPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ProjectShell = lazy(() => import('./shell/ProjectShell'));
const NotesPage = lazy(() => import('./pages/NotesPage'));
const ExperimentsPage = lazy(() => import('./pages/ExperimentsPage'));
const KnowledgeGraphPage = lazy(() => import('./pages/KnowledgeGraphPage'));
const ResearchTimelinePage = lazy(() => import('./pages/ResearchTimelinePage'));
const LatexPreviewPage = lazy(() => import('./pages/LatexPreviewPage'));
const PdfReaderPage = lazy(() => import('./pages/PdfReaderPage'));
const GoalPage = lazy(() => import('./pages/GoalPage'));
const CollectionsPage = lazy(() => import('./pages/CollectionsPage'));
const TagsPage = lazy(() => import('./pages/TagsPage'));
const FirstRunWizard = lazy(() => import('./components/FirstRunWizard'));
const ProjectWorkspaceSidebar = lazy(() => import('./research/ProjectWorkspaceSidebar'));
const ResearchInspectorPanels = lazy(() => import('./research/ResearchInspectorPanels'));
const ResearchExportCenter = lazy(() => import('./export/ResearchExportCenter'));
const ScenarioLauncher = lazy(() => import('./research/ScenarioLauncher'));
const PersonalizationCenter = lazy(() => import('./personalization/PersonalizationCenter'));
import SettingsPanel from './components/SettingsPanel';

const firstRunSetupClient: FirstRunSetupClient = {
  probe: (request, onProgress) => window.metis?.setupProbe(request as never, (event) => onProgress?.(event))
    ?? Promise.resolve(null),
  save: (request, onProgress) => window.metis?.setupSave(request, (event) => onProgress?.(event))
    ?? Promise.resolve(null),
  abort: (request) => window.metis?.setupAbort(request) ?? Promise.resolve(null),
};

// 鈹€鈹€鈹€ Theme Toggle Component 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const THEME_CYCLE: ThemeMode[] = ['light', 'dark', 'system'];

function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useMetisStore((s) => s.theme)
  const setTheme = useMetisStore((s) => s.setTheme)

  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme || 'light') + 1) % THEME_CYCLE.length]!;
  const label = theme === 'system' ? t('common.themeSystem') : theme === 'dark' ? t('common.dark') : t('common.light');
  const icon = theme === 'system' ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ) : theme === 'dark' ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
  );

  return (
    <button
      className="theme-toggle"
      onClick={() => setTheme(nextTheme)}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

// 鈹€鈹€鈹€ Navigation 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

interface NavItem { id: TopLevelEntry; labelKey: string; icon: React.ReactNode }

const dashboardIcon = <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
const papersIcon = <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
const settingsIcon = <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>

const TOP_LEVEL_ICONS: Record<TopLevelEntry, React.ReactNode> = {
  projects: dashboardIcon,
  library: papersIcon,
  settings: settingsIcon,
};

const NAV_ITEMS: NavItem[] = getTopLevelNav().map((entry) => ({
  id: entry.id as TopLevelEntry,
  labelKey: entry.labelKey,
  icon: TOP_LEVEL_ICONS[entry.id as TopLevelEntry],
}));

function legacyPageToEntry(page: Page): { entry: TopLevelEntry; mode: WorkspaceMode } {
  switch (page) {
    case 'papers':
    case 'collections':
    case 'tags':
    case 'library':
      return { entry: 'library', mode: 'read' };
    case 'settings':
      return { entry: 'settings', mode: 'converse' };
    case 'pdf':
      return { entry: 'projects', mode: 'read' };
    case 'graph':
    case 'timeline':
    case 'experiments':
      return { entry: 'projects', mode: 'analyze' };
    case 'latex':
    case 'notes':
      return { entry: 'projects', mode: 'write' };
    default:
      return { entry: 'projects', mode: 'converse' };
  }
}

// 鈹€鈹€鈹€ Evals Page 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

type StandalonePage = 'dashboard' | 'goal' | 'collections' | 'tags' | 'timeline' | 'latex' | 'experiments' | 'evals';

function resolveStandalonePage(page: Page, diagnosticMode: boolean): StandalonePage | null {
  switch (page) {
    case 'dashboard':
    case 'goal':
    case 'collections':
    case 'tags':
    case 'timeline':
    case 'latex':
    case 'experiments':
      return page;
    case 'evals':
      return diagnosticMode ? page : null;
    default:
      return null;
  }
}

function EvalsPage() {
  const { t } = useTranslation();
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<'dev' | 'candidate' | 'release'>('dev')
  const [suiteResult, setSuiteResult] = useState<{
    summary?: { taskCount: number; passed: number; failed: number; successRate: number };
    gate?: { passed: boolean; profile: string; failures: string[]; failedTasks: string[] };
    results?: Array<{
      taskId: string;
      success: boolean;
      status: string;
      turnsUsed: number;
      toolCalls: number;
      latencyMs: number;
      toolFailures: number;
      qualityFailures: number;
      errors: string[];
    }>;
  } | null>(null)
  const [lastRun, setLastRun] = useState<string | null>(null)

  const handleRunSuite = async () => {
    if (isRunning) return
    setIsRunning(true)
    setError(null)

    try {
      const metis = window.metis
      if (!metis || !metis.runEvalSuite) {
        throw new Error('Eval API not available')
      }
      const response = await metis.runEvalSuite(profile)
      if (response.status === 'error' || response.status === 'cancelled') {
        throw new Error(response.code || 'Eval failed')
      }
      setSuiteResult({
        summary: response.summary,
        gate: { passed: response.gate.passed, profile: response.gate.profile, failures: response.gate.failedTaskIds, failedTasks: response.gate.failedTaskIds },
        results: response.results.map((r) => ({ ...r, errors: [] as string[] })),
      })
      setLastRun(new Date().toLocaleString())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="placeholder-page">
      <h2>{t('evals.pageTitle')}</h2>
      <p>{t('evals.pageDescription')}</p>

      <div className="action-bar" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <select
          className="select-field"
          value={profile}
          onChange={(e) => setProfile(e.target.value as 'dev' | 'candidate' | 'release')}
          disabled={isRunning}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
        >
          <option value="dev">{t('evals.profileDev')}</option>
          <option value="candidate">{t('evals.profileCandidate')}</option>
          <option value="release">{t('evals.profileRelease')}</option>
        </select>
        <button className="btn-primary" onClick={handleRunSuite} disabled={isRunning}>
          {isRunning ? t('evals.running') : t('evals.runSuite')}
        </button>
        {lastRun && (
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {t('evals.lastRun', { time: lastRun })}
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 6, background: 'var(--status-failed-bg, #fef2f2)', color: 'var(--status-failed)', border: '1px solid var(--status-failed)' }}>
          {error}
        </div>
      )}

      {suiteResult && suiteResult.summary && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 8 }}>{t('evals.summaryTitle')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('evals.summaryTasks', { count: suiteResult.summary.taskCount })}</div>
            </div>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--status-completed)' }}>{t('evals.summaryPassed', { count: suiteResult.summary.passed })}</div>
            </div>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--status-failed)' }}>{t('evals.summaryFailed', { count: suiteResult.summary.failed })}</div>
            </div>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{t('evals.summaryRate', { rate: suiteResult.summary.successRate.toFixed(1) })}</div>
            </div>
          </div>

          {suiteResult.gate && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 6,
                background: suiteResult.gate.passed ? 'var(--status-completed-bg, #f0fdf4)' : 'var(--status-failed-bg, #fef2f2)',
                color: suiteResult.gate.passed ? 'var(--status-completed)' : 'var(--status-failed)',
                border: `1px solid ${suiteResult.gate.passed ? 'var(--status-completed)' : 'var(--status-failed)'}`,
              }}
            >
              <strong>{suiteResult.gate.passed ? t('evals.gatePassed') : t('evals.gateFailed')}</strong>
              <span style={{ marginLeft: 12, fontSize: 13 }}>
                {t('evals.gateProfile', { profile: suiteResult.gate.profile })}
              </span>
              {suiteResult.gate.failures.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  {t('evals.gateFailures')}: {suiteResult.gate.failures.join(', ')}
                </div>
              )}
            </div>
          )}

          {suiteResult.results && suiteResult.results.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskId')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskStatus')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskTurns')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskTools')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskLatency')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskErrors')}</th>
                </tr>
              </thead>
              <tbody>
                {suiteResult.results.map((r) => (
                  <tr key={r.taskId}>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.taskId}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13, color: r.success ? 'var(--status-completed)' : 'var(--status-failed)' }}>
                      {r.success ? t('evals.statusPass') : t('evals.statusFail')}
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.turnsUsed}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.toolCalls}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.latencyMs}ms</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13, color: r.errors.length > 0 ? 'var(--status-failed)' : 'inherit' }}>
                      {r.errors.length > 0 ? r.errors.join('; ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!suiteResult && !isRunning && !error && (
        <div style={{ marginTop: 24, padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
          {t('evals.noResults')}
        </div>
      )}
    </div>
  )
}
function App({ initialPage = 'projects' as Page }: { initialPage?: Page } = {}) {
  const { t, locale } = useTranslation();
  const initialLocation = legacyPageToEntry(initialPage);
  const [currentEntry, setCurrentEntry] = useState<TopLevelEntry>(initialLocation.entry)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(initialLocation.mode)
  const [uiMode, setUIMode] = useState<UIMode>(() => getDiagnosticMode())
  const [standalonePage, setStandalonePage] = useState<StandalonePage | null>(() =>
    resolveStandalonePage(initialPage, getDiagnosticMode() === 'diagnostic'))
  const [projectLeftCollapsed, setProjectLeftCollapsed] = useState(false)
  const [projectRightCollapsed, setProjectRightCollapsed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [personalizationOpen, setPersonalizationOpen] = useState(false)
  const [chatIntentRevision, setChatIntentRevision] = useState(0)
  const [setupState, setSetupState] = useState<'checking' | 'required' | 'ready'>('checking')
  const [setupInitialConfig, setSetupInitialConfig] = useState<{ baseUrl?: string; model?: string }>({})
  const isHydrated = useMetisStore((s) => s.isHydrated)
  const hydrateFromPersistence = useMetisStore((s) => s.hydrateFromPersistence)
  const unreadPapers = useMetisStore((s) => s.papers.filter((p) => p.readStatus === 'unread').length)
  const activeResearchProjectId = useResearchWorkspaceStore((state) => state.activeProjectId)
  const activeResearchSection = useResearchWorkspaceStore((state) => state.activeSection)

  useEffect(() => {
    const metis = window.metis
    if (!metis?.getSettings) {
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initialization
      setSetupState('ready')
      return
    }
    metis.getSettings().then((settings) => {
      if (settings?.baseUrl || settings?.model) {
        setSetupInitialConfig({
          baseUrl: settings.baseUrl || undefined,
          model: settings.model || undefined,
        })
      }
      setSetupState(settings?.configured && settings.hasApiKey ? 'ready' : 'required')
    }).catch(() => {
      setSetupState('required')
    })
  }, [])

  // Hydrate from SQLite on mount
  useEffect(() => {
    const metis = window.metis
    if (metis && metis.loadAllData) {
      metis.loadAllData().then((data) => {
        hydrateFromPersistence({
          papers: data.papers ?? [],
          notes: data.notes ?? [],
          experiments: data.experiments ?? [],
          collections: data.collections ?? [],
        })
        // Restore theme and reading goal from settings
        if (metis.getSettings) {
          metis.getSettings().then((settings) => {
            if (settings?.theme) {
              useMetisStore.getState().setTheme(settings.theme as ThemeMode)
            }
            if (typeof settings?.weeklyReadingGoal === 'number') {
              useMetisStore.getState().setWeeklyReadingGoal(settings.weeklyReadingGoal)
            }
          }).catch(() => {})
        }
      }).catch((err: unknown) => {
        console.error('Failed to hydrate from persistence:', err)
        hydrateFromPersistence({ papers: [], notes: [], experiments: [] })
      })
      // Listen for OS theme changes when in 'system' mode
      const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
      if (mq) {
        const handler = () => {
          if (useMetisStore.getState().theme === 'system') {
            document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
          }
        };
        mq.addEventListener('change', handler);
        return () => { mq.removeEventListener('change', handler); };
      }
    } else {
      // Not in Electron 鈥?mark as hydrated immediately without wiping in-memory state
      useMetisStore.setState({ isHydrated: true })
    }
  }, [hydrateFromPersistence])

  // Global search keyboard shortcut (Cmd/Ctrl+K)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        if (document.querySelector('[aria-modal="true"]')) return
        e.preventDefault()
        setSearchOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Shortcuts help (Shift+/)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === '?' && e.shiftKey) {
        if (document.querySelector('[aria-modal="true"]')) return
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return
        }
        e.preventDefault()
        setShortcutsOpen(true)
      }
      if (e.key === 'Escape' && shortcutsOpen) {
        setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcutsOpen])

  function updateUIMode(mode: UIMode) {
    setDiagnosticMode(mode);
    setUIMode(mode);
  }

  function navigateLegacy(page: Page) {
    const location = legacyPageToEntry(page);
    setPersonalizationOpen(false);
    setCurrentEntry(location.entry);
    setWorkspaceMode(location.mode);
    setStandalonePage(resolveStandalonePage(page, uiMode === 'diagnostic'));
  }

  function navigateWorkspaceMode(mode: WorkspaceMode) {
    setPersonalizationOpen(false);
    setStandalonePage(null);
    setWorkspaceMode(mode);
  }

  function activatePersonalizationScenario(scenarioId: string) {
    setPendingChatIntent({
      scenarioId,
      projectId: activeResearchProjectId ?? 'global',
      message: '',
      autoSend: false,
    });
    setChatIntentRevision((revision) => revision + 1);
    navigateWorkspaceMode('converse');
  }

  function projectShellStateProps() {
    return {
      leftCollapsed: projectLeftCollapsed,
      rightCollapsed: projectRightCollapsed,
      onLeftCollapsedChange: setProjectLeftCollapsed,
      onRightCollapsedChange: setProjectRightCollapsed,
    };
  }

  function renderNonChatWorkspace() {
    switch (workspaceMode) {
      case 'read': return <PdfReaderPage uiMode={uiMode} />;
      case 'analyze': return <KnowledgeGraphPage />;
      case 'write': return <NotesPage uiMode={uiMode} onNavigate={(page) => navigateLegacy(page as Page)} />;
      case 'converse': return null;
    }
  }

  function renderStandalonePage() {
    switch (standalonePage) {
      case 'dashboard': return <DashboardPage onNavigate={navigateLegacy} />;
      case 'goal': return <GoalPage onNavigate={(page) => navigateLegacy(page as Page)} />;
      case 'collections': return <CollectionsPage onNavigate={navigateLegacy} />;
      case 'tags': return <TagsPage onNavigate={navigateLegacy} />;
      case 'timeline': return <ResearchTimelinePage />;
      case 'latex': return <LatexPreviewPage />;
      case 'experiments': return <ExperimentsPage />;
      case 'evals': return uiMode === 'diagnostic' ? <EvalsPage /> : null;
      default: return null;
    }
  }

  function renderPage() {
    if (personalizationOpen) {
      return <PersonalizationCenter onActivateScenario={activatePersonalizationScenario} />;
    }
    const standalone = renderStandalonePage();
    if (standalone) return standalone;
    if (currentEntry === 'settings') {
      return <SettingsPanel uiMode={uiMode} onUIModeChange={updateUIMode} />;
    }
    if (currentEntry === 'library') {
      return <PapersPage uiMode={uiMode} onNavigate={(page) => navigateLegacy(page as Page)} />;
    }

    return (
      <ChatPage
        uiMode={uiMode}
        intentRevision={chatIntentRevision}
        renderLayout={({ leftPanel, workspace, rightPanel }) => {
          const isConversation = workspaceMode === 'converse';
          return (
            <ProjectShell
              {...projectShellStateProps()}
              mode={workspaceMode}
              onModeChange={navigateWorkspaceMode}
              leftPanel={isConversation ? leftPanel : (
                <div className="research-shell-navigation">
                  <ProjectWorkspaceSidebar />
                </div>
              )}
              rightPanel={isConversation ? rightPanel : undefined}
              inspector={isConversation ? undefined : {
                metis: (
                  <div className="research-shell-inspector-stack">
                    <ResearchInspectorPanels />
                    {activeResearchProjectId && activeResearchSection === 'artifacts' && (
                      <ResearchExportCenter projectId={activeResearchProjectId} />
                    )}
                  </div>
                ),
                plan: (
                  <ScenarioLauncher
                    projectId={activeResearchProjectId ?? undefined}
                    onOpenPersonalization={() => { setPersonalizationOpen(true); setStandalonePage(null); }}
                  />
                ),
                evidence: <ResearchInspectorPanels />,
              }}
              workspaceClassName={isConversation ? 'shell-workspace--chat' : undefined}
            >
              {isConversation ? workspace : renderNonChatWorkspace()}
            </ProjectShell>
          );
        }}
      />
    );
  }

  // First-run setup is a hard gate: research execution is unavailable until a
  // real provider probe succeeds and the key is stored by OS secure storage.
  if (setupState === 'required') {
    return (
      <div className="app-layout" data-ui-mode={uiMode}>
        <Suspense fallback={<div className="hydration-loading"><div className="hydration-spinner" /><p>{t('common.loading')}</p></div>}>
          <FirstRunWizard
            client={firstRunSetupClient}
            initialConfig={setupInitialConfig}
            onComplete={() => setSetupState('ready')}
          />
        </Suspense>
      </div>
    )
  }

  // Show loading state while checking setup and hydrating local research data.
  if (setupState === 'checking' || !isHydrated) {
    return (
      <div className="app-layout" data-ui-mode="loading">
        <div className="hydration-loading">
          <div className="hydration-spinner" />
          <p>{t('common.loading') || 'Loading...'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-layout" data-ui-mode={uiMode}>
      <nav className="sidebar" aria-label={t('app.title')}>
          <div className="sidebar-header">
            <h1 className="app-title">{t('app.title')}</h1>
            <span className="app-subtitle">{t('app.subtitle')}</span>
            <button
              className="global-search-trigger"
              onClick={() => setSearchOpen(true)}
              title={t('globalSearch.placeholder')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span>{t('common.search')}</span>
              <kbd>{/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '鈱楰' : 'Ctrl K'}</kbd>
            </button>
          </div>
          <ul className="nav-list">
            {NAV_ITEMS.map((item) => (
              <li key={item.id}>
                <button
                  className={`nav-item ${!personalizationOpen && currentEntry === item.id ? 'active' : ''}`}
                  onClick={() => { setPersonalizationOpen(false); setCurrentEntry(item.id); }}
                  aria-current={!personalizationOpen && currentEntry === item.id ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  title={t(item.labelKey)}
                  data-nav-id={item.id}
                >
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  <span className="nav-label">{t(item.labelKey)}</span>
                  {item.id === 'library' && unreadPapers > 0 && (
                    <span className="nav-badge" aria-label={t('dashboard.statPapersNeedAttention')}>{unreadPapers}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 'auto', paddingBottom: 8 }}>
            <div className="sidebar-personalization-row">
              <ThemeToggle />
              <button
                className={`personalization-trigger ${personalizationOpen ? 'active' : ''}`}
                onClick={() => { setPersonalizationOpen(true); setStandalonePage(null); }}
                aria-current={personalizationOpen ? 'page' : undefined}
                aria-label={locale === 'zh' ? '个性化' : 'Personalization'}
                title={locale === 'zh' ? '个性化' : 'Personalization'}
                data-testid="personalization-trigger"
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" />
                  <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" />
                  <line x1="4" y1="18" x2="20" y2="18" /><circle cx="11" cy="18" r="2" />
                </svg>
                <span>{locale === 'zh' ? '个性化' : 'Personalization'}</span>
              </button>
            </div>
            <button
              className="nav-item"
              onClick={() => setShortcutsOpen(true)}
              title={t('shortcuts.title')}
              style={{ width: '100%', justifyContent: 'center', marginTop: 8, fontSize: 12 }}
            >
              <span className="nav-icon" aria-hidden="true" style={{ opacity: 0.8 }}>?</span>
              <span className="nav-label" style={{ opacity: 0.8 }}>{t('shortcuts.title')}</span>
            </button>
          </div>
        </nav>
      <main className="main-content">
        <ErrorBoundary
          showDetails={uiMode === 'diagnostic'}
          onReset={() => { setPersonalizationOpen(false); setCurrentEntry('projects'); setWorkspaceMode('converse'); setStandalonePage(null); }}
        >
          <Suspense fallback={<div className="hydration-loading"><div className="hydration-spinner" /><p>{t('common.loading')}</p></div>}>
            {renderPage()}
          </Suspense>
        </ErrorBoundary>
      </main>
      {searchOpen && (
        <GlobalSearch
          onNavigate={navigateLegacy}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  )
}

export default App
