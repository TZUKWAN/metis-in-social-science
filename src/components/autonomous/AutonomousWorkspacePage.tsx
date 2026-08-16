/**
 * AutonomousWorkspacePage — 自主科研工作台（重构 R3 主容器）。
 *
 * 「AI 在独立工作，用户随时进来看它做到哪里」：
 * 顶部精简启动条 + 4 指标；三栏 = 左项目导航 / 中研究内容直展 / 右 AI LIVE。
 * 运行事件流来自既有引擎（onAutonomousStep/Reflection/Progress）；
 * 项目内容来自 autoWorkspace 真实数据 IPC。无任何审批节点。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../../research/researchWorkspaceStore';
import AiLiveRail, { type LiveFeed } from './AiLiveRail';
import WorkspaceCenter, { type CenterSection } from './WorkspaceCenter';
import './autonomousWorkspace.css';

type OverviewData = Awaited<ReturnType<NonNullable<typeof window.metis>['getAutoWorkspaceOverview']>>;
type DetailData = NonNullable<Awaited<ReturnType<NonNullable<typeof window.metis>['getAutoWorkspaceDetail']>>>;

const SUBNAV = [
  { id: 'overview', labelKey: 'autoWs.navOverview' },
  { id: 'findings', labelKey: 'autoWs.navFindings' },
  { id: 'theory', labelKey: 'autoWs.navTheory' },
  { id: 'evidence', labelKey: 'autoWs.navEvidence' },
  { id: 'data', labelKey: 'autoWs.navData' },
  { id: 'trail', labelKey: 'autoWs.navTrail' },
] as const;

export default function AutonomousWorkspacePage({ onOpenConsole }: { onOpenConsole: () => void }) {
  const { t, locale } = useTranslation();
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [subNav, setSubNav] = useState<string>('overview');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(3);
  const [method, setMethod] = useState<'any' | 'quantitative' | 'qualitative' | 'mixed'>('any');
  const [output, setOutput] = useState<'journal_article' | 'report'>('journal_article');
  const [mode, setMode] = useState<'single' | 'continuous'>('single');
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [generating, setGenerating] = useState(false);
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  const [runningProjectId, setRunningProjectId] = useState<string | null>(null);

  const reloadOverview = useCallback(async (runningIds: string[] = []) => {
    const data = await window.metis?.getAutoWorkspaceOverview?.(runningIds);
    if (data) setOverview(data);
  }, []);

  const reloadDetail = useCallback(async (projectId: string | null) => {
    if (!projectId) { setDetail(null); return; }
    const data = await window.metis?.getAutoWorkspaceDetail?.(projectId);
    setDetail(data ?? null);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.metis?.getAutoWorkspaceOverview?.([]).then((data) => {
      if (alive && data) setOverview(data);
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    if (activeProjectId) {
      void window.metis?.getAutoWorkspaceDetail?.(activeProjectId).then((data) => {
        if (alive) setDetail(data ?? null);
      });
    }
    return () => { alive = false; };
  }, [activeProjectId]);
  useEffect(() => {
    const timer = setInterval(() => {
      void window.metis?.getAutoWorkspaceOverview?.(runningProjectId ? [runningProjectId] : []).then((data) => {
        if (data) setOverview(data);
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [runningProjectId]);

  // 引擎事件流 → LIVE feed + 运行状态。
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onAutonomousStep) return;
    const offStep = metis.onAutonomousStep((event) => {
      setRunningProjectId((current) => current ?? null);
      setFeed((prev) => ({
        step: { type: event.type, phase: event.phase, stepName: event.stepName, output: event.output, at: Date.now() },
        reflection: prev?.reflection ?? null,
        progress: prev?.progress ?? null,
        running: true,
      }));
    });
    const offReflection = metis.onAutonomousReflection?.((event) => {
      setFeed((prev) => ({
        step: prev?.step ?? null,
        reflection: { type: 'reflection', phase: event.phase, decision: event.decision, reasoning: event.reasoning, revisionNote: event.revisionNote, at: Date.now() },
        progress: prev?.progress ?? null,
        running: true,
      }));
    }) ?? (() => {});
    const offProgress = metis.onAutonomousProgress?.((event) => {
      setFeed((prev) => ({
        step: prev?.step ?? null,
        reflection: prev?.reflection ?? null,
        progress: { completedPhases: event.completedPhases, totalPhases: event.totalPhases, currentPhase: event.currentPhase },
        running: true,
      }));
    }) ?? (() => {});
    const offCompleted = metis.onAutonomousCompleted?.(() => {
      setFeed({ step: null, reflection: null, progress: null, running: false });
      setRunningProjectId(null);
      void reloadOverview([]);
      void reloadDetail(activeProjectId);
      // 连续模式：完成后自动推进议程中的下一个自主选题。
      if (modeRef.current === 'continuous') {
        void (async () => {
          const agendaState = await window.metis?.getAgendaState?.();
          const head = agendaState?.queue?.[0];
          const decision = await window.metis?.decideAgendaNext?.();
          if (decision?.action === 'run_next' && head?.autonomous === true && head.goalPrompt) {
            await window.metis?.autonomousStart?.({ goal: head.goalPrompt, projectId: head.projectId ?? undefined });
          }
        })();
      }
    }) ?? (() => {});
    return () => { offStep(); offReflection(); offProgress(); offCompleted(); };
  }, [reloadOverview, reloadDetail, activeProjectId]);

  const startBatch = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.generateAutonomousBatch || !prompt.trim() || generating) return;
    setGenerating(true);
    const result = await metis.generateAutonomousBatch({ prompt: prompt.trim(), count, method, output });
    setGenerating(false);
    if (result.ok) {
      setPrompt('');
      void reloadOverview([]);
    }
  }, [prompt, count, generating, reloadOverview]);

  const projects = overview?.projects ?? [];
  const metrics = overview?.metrics ?? { running: 0, decisions24h: 0, evidenceToday: 0, newFindings7d: 0 };

  const centerSection: CenterSection | null = useMemo(() => {
    if (!detail) return null;
    return {
      question: detail.question,
      coreJudgments: detail.coreJudgments,
      newFindings: detail.newFindings,
      uncertainties: detail.uncertainties,
      artifacts: detail.artifacts,
      stats: detail.stats,
    };
  }, [detail]);

  return (
    <div className="aw-page" data-testid="aw-page">
      <div className="aw-topbar">
        <input
          className="settings-input aw-topbar__input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void startBatch(); }}
          placeholder={t('autoWs.startPlaceholder')}
          data-testid="aw-start-input"
        />
        <select className="settings-input aw-topbar__select" value={mode} onChange={(event) => setMode(event.target.value as 'single' | 'continuous')} aria-label={t('autoWs.modeLabel')} data-testid="aw-start-mode">
          <option value="single">{t('autoWs.modeSingle')}</option>
          <option value="continuous">{t('autoWs.modeContinuous')}</option>
        </select>
        <select className="settings-input aw-topbar__select" value={method} onChange={(event) => setMethod(event.target.value as 'any' | 'quantitative' | 'qualitative' | 'mixed')} aria-label={t('autoWs.methodLabel')} data-testid="aw-start-method">
          <option value="any">{t('autoWs.methodAny')}</option>
          <option value="quantitative">{t('autoWs.methodQuantitative')}</option>
          <option value="qualitative">{t('autoWs.methodQualitative')}</option>
          <option value="mixed">{t('autoWs.methodMixed')}</option>
        </select>
        <select className="settings-input aw-topbar__select" value={output} onChange={(event) => setOutput(event.target.value as 'journal_article' | 'report')} aria-label={t('autoWs.outputLabel')} data-testid="aw-start-output">
          <option value="journal_article">{t('autoWs.outputJournal')}</option>
          <option value="report">{t('autoWs.outputReport')}</option>
        </select>
        <select className="settings-input aw-topbar__select" value={count} onChange={(event) => setCount(Number(event.target.value))} aria-label={t('autoWs.countLabel')} data-testid="aw-start-count">
          {[1, 2, 3, 4, 5].map((value) => (
            <option key={value} value={value}>{t('autoWs.countOption', { count: value })}</option>
          ))}
        </select>
        <button type="button" className="btn-primary btn-sm" disabled={!prompt.trim() || generating} onClick={() => void startBatch()} data-testid="aw-start-button">
          {generating ? t('common.testing') : t('autoWs.startButton')}
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={onOpenConsole} data-testid="aw-open-console" title={t('autoWs.consoleHint')}>
          {t('autoWs.consoleButton')}
        </button>
      </div>

      <div className="aw-metrics" data-testid="aw-metrics">
        <div className="aw-metric"><span className="aw-metric__value">{metrics.running}</span><span className="aw-metric__label">{t('autoWs.metricRunning')}</span></div>
        <div className="aw-metric"><span className="aw-metric__value">{metrics.decisions24h}</span><span className="aw-metric__label">{t('autoWs.metricDecisions')}</span></div>
        <div className="aw-metric"><span className="aw-metric__value">{metrics.evidenceToday}</span><span className="aw-metric__label">{t('autoWs.metricEvidence')}</span></div>
        <div className="aw-metric"><span className="aw-metric__value">{metrics.newFindings7d}</span><span className="aw-metric__label">{t('autoWs.metricFindings')}</span></div>
      </div>

      <div className="aw-layout">
        <aside className="aw-side" data-testid="aw-side">
          <div className="aw-side__section">
            <h2 className="aw-side__title">{t('autoWs.projectsTitle')}</h2>
            {projects.length === 0 ? (
              <p className="aw-block__empty">{t('autoWs.projectsEmpty')}</p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={`aw-proj ${activeProjectId === project.id ? 'aw-proj--active' : ''}`}
                  onClick={() => void researchWorkspaceStore.getState().setActiveProject(project.id)}
                  data-testid="aw-proj-item"
                >
                  <span className="aw-proj__title">{project.title}</span>
                  <span className="aw-proj__meta">
                    <span className={`aw-proj__status aw-proj__status--${project.status}`}>
                      {project.status === 'running' ? t('autoWs.statusRunning') : project.status === 'completed' ? t('autoWs.statusCompleted') : t('autoWs.statusIdle')}
                    </span>
                    <span className="aw-proj__bar"><span style={{ width: `${project.progressPercent}%` }} /></span>
                    <span>{project.progressPercent}%</span>
                  </span>
                </button>
              ))
            )}
          </div>
          {activeProjectId && (
            <div className="aw-side__section">
              <h2 className="aw-side__title">{t('autoWs.navTitle')}</h2>
              <nav className="aw-subnav" aria-label={t('autoWs.navTitle')}>
                {SUBNAV.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={subNav === item.id ? 'aw-subnav--active' : ''}
                    onClick={() => setSubNav(item.id)}
                    data-testid={`aw-subnav-${item.id}`}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </nav>
            </div>
          )}
        </aside>

        <main className="aw-main">
          {!activeProjectId ? (
            <div className="aw-block"><p className="aw-block__empty">{t('autoWs.selectProject')}</p></div>
          ) : !centerSection ? (
            <div className="aw-block"><p className="aw-block__empty">{t('common.loading')}</p></div>
          ) : (
            <>
              {subNav === 'trail' ? (
                <section className="aw-block" data-testid="aw-trail">
                  <div className="aw-block__head"><h2>{t('autoWs.trailTitle')}</h2></div>
                  <ul className="aw-live__timeline" style={{ listStyle: 'none', padding: 0 }}>
                    {(detail?.timeline ?? []).map((item, index) => (
                      <li key={index} className="aw-live__tl-item">
                        <span className="aw-live__tl-time">{new Date(item.at).toLocaleString(locale)}</span>
                        <span className="aw-live__tl-text">{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : (
                <WorkspaceCenter section={centerSection} />
              )}
              <details className="aw-audit" data-testid="aw-audit">
                <summary>{t('autoWs.auditTitle')}</summary>
                <div className="aw-audit__body">{t('autoWs.auditBody')}</div>
              </details>
            </>
          )}
        </main>

        <AiLiveRail feed={feed} decisions={detail?.decisions ?? []} timeline={detail?.timeline ?? []} />
      </div>
    </div>
  );
}
