/**
 * AutonomousResearchPage — front-end control surface for the autonomous
 * research engine.
 *
 * Lets the user start a full idea→experiment→analysis→paper run, watch live
 * phase/step/reflection events stream in, and pause/interrupt at any time.
 * Mirrors the GoalPage live-event subscription pattern.
 */

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { showToast } from '../lib/toast';
import ResearchAgendaPanel from '../components/ResearchAgendaPanel';
import AutonomousSetupPanel from '../components/AutonomousSetupPanel';
import './AutonomousResearchPage.css';
import StrategyEditor from '../research/StrategyEditor';
import type { ResearchStrategy, PaperStructureTemplate } from '../../engine/runtime/ResearchStrategyContract';
import type { ResearchPhaseKind } from '../../engine/runtime/AutonomousRuntimeContract';

type PhaseKind = ResearchPhaseKind;

interface PhaseState {
  status: 'pending' | 'running' | 'done' | 'failed';
  iteration: number;
  steps: Array<{ id: string; name: string; status: 'pending' | 'running' | 'done' | 'failed'; output?: string; error?: string }>;
}

interface ReflectionEntry {
  phase: PhaseKind;
  decision: 'advance' | 'redo' | 'rollback' | 'done';
  qualityScore: number;
  reasoning: string;
  revisionNote?: string;
  at: number;
}

interface WorkflowPlanItem {
  phase: PhaseKind;
  name: string;
}

/** idea 阶段的逐步输出（研究空白分析 → 候选 idea → 假设），用于「选题依据」。 */
interface IdeaOutput {
  stepName: string;
  output: string;
}

const ALL_PHASES: PhaseKind[] = [
  'idea', 'experiment', 'paper', 'question_formulation', 'literature_review',
  'source_discovery', 'screening', 'conceptual_analysis', 'source_criticism',
  'research_design', 'data_collection', 'coding', 'data_preparation',
  'statistics', 'analysis', 'triangulation', 'argumentation', 'synthesis',
  'quality_audit', 'writing',
];
const PHASE_LABEL_KEY: Record<PhaseKind, string> = {
  idea: 'autonomous.phaseIdea',
  experiment: 'autonomous.phaseExperiment',
  analysis: 'autonomous.phaseAnalysis',
  paper: 'autonomous.phasePaper',
  question_formulation: 'autonomous.phaseQuestionFormulation',
  literature_review: 'autonomous.phaseLiteratureReview',
  source_discovery: 'autonomous.phaseSourceDiscovery',
  screening: 'autonomous.phaseScreening',
  conceptual_analysis: 'autonomous.phaseConceptualAnalysis',
  source_criticism: 'autonomous.phaseSourceCriticism',
  research_design: 'autonomous.phaseResearchDesign',
  data_collection: 'autonomous.phaseDataCollection',
  coding: 'autonomous.phaseCoding',
  data_preparation: 'autonomous.phaseDataPreparation',
  statistics: 'autonomous.phaseStatistics',
  triangulation: 'autonomous.phaseTriangulation',
  argumentation: 'autonomous.phaseArgumentation',
  writing: 'autonomous.phaseWriting',
  synthesis: 'autonomous.phaseSynthesis',
  quality_audit: 'autonomous.phaseQualityAudit',
};

interface MethodSummary {
  family: 'theoretical' | 'qualitative' | 'historical' | 'quantitative' | 'mixed' | 'general';
  name: string;
  rationale: string;
  confidence: number;
  selectedBy: 'automatic_heuristic' | 'automatic_provider' | 'researcher';
}

interface RecoverableSession {
  sessionId: string;
  goal: string;
  projectId?: string;
  executions: number;
  completedPhases: number;
  savedAt: number;
  state: 'running' | 'paused';
  failureReason?: string;
}

const QUEUE_STORAGE_KEY = 'metis-autonomous-queue';
const CONTINUOUS_STORAGE_KEY = 'metis-autonomous-continuous';

function readQueueFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function readContinuousFromStorage(): boolean {
  try {
    return window.localStorage.getItem(CONTINUOUS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export default function AutonomousResearchPage(): ReactNode {
  const { t } = useTranslation();
  const metis = window.metis;
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const setActiveProject = useResearchWorkspaceStore((state) => state.setActiveProject);
  const projects = useResearchWorkspaceStore((state) => state.projects);
  /** 运行将基于哪个项目的资料；空 = 跟随当前项目（未选择则自动新建）。 */
  const [projectChoice, setProjectChoice] = useState('');
  const [goal, setGoal] = useState('');
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phases, setPhases] = useState<Record<PhaseKind, PhaseState>>(emptyPhases());
  const [phaseOrder, setPhaseOrder] = useState<PhaseKind[]>([]);
  const [workflowPlan, setWorkflowPlan] = useState<WorkflowPlanItem[]>([]);
  const [ideaOutputs, setIdeaOutputs] = useState<IdeaOutput[]>([]);
  const [method, setMethod] = useState<MethodSummary | null>(null);
  const [reflections, setReflections] = useState<ReflectionEntry[]>([]);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [runProjectId, setRunProjectId] = useState<string | null>(null);
  // 议程上报用的最新值（完成回调闭包里读）。
  const runProjectIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [strategies, setStrategies] = useState<ResearchStrategy[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState('');
  const [structures, setStructures] = useState<PaperStructureTemplate[]>([]);
  const [selectedStructureId, setSelectedStructureId] = useState('');
  const [showStrategyEditor, setShowStrategyEditor] = useState(false);
  const [recoverableSessions, setRecoverableSessions] = useState<RecoverableSession[]>([]);
  // 研究目标队列 + 连续运行：用户不打断时，完成当前目标自动开始队列中的下一个。
  const [queue, setQueue] = useState<string[]>(() => readQueueFromStorage());
  const [continuous, setContinuous] = useState<boolean>(() => readContinuousFromStorage());
  const [nextGoalNotice, setNextGoalNotice] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<string[]>(queue);
  const continuousRef = useRef<boolean>(continuous);
  const startRunRef = useRef<(goalText: string) => Promise<void>>(async () => {});
  const chainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainCancelledRef = useRef(false);

  const persistQueue = useCallback((items: string[]) => {
    queueRef.current = items;
    try { window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(items)); } catch { /* best-effort */ }
  }, []);

  const enqueueGoal = useCallback(() => {
    const text = goal.trim();
    if (!text) return;
    setQueue((current) => {
      const next = [...current, text];
      persistQueue(next);
      return next;
    });
    setGoal('');
  }, [goal, persistQueue]);

  const removeQueuedGoal = useCallback((index: number) => {
    setQueue((current) => {
      const next = current.filter((_, i) => i !== index);
      persistQueue(next);
      return next;
    });
  }, [persistQueue]);

  const toggleContinuous = useCallback((value: boolean) => {
    continuousRef.current = value;
    setContinuous(value);
    try { window.localStorage.setItem(CONTINUOUS_STORAGE_KEY, value ? '1' : '0'); } catch { /* best-effort */ }
  }, []);

  // Subscribe to all live event channels once.
  useEffect(() => {
    if (!metis) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(metis.onAutonomousEngineStarted?.((e) => {
      setProgress({ completed: 0, total: e.plan.length });
      setPhaseOrder([...new Set(e.plan.map((item) => item.phase))]);
      setWorkflowPlan(e.plan.map((item) => ({ phase: item.phase, name: item.name })));
      setMethod(e.method ?? null);
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousPhaseStarted?.((e) => {
      setPhaseOrder((current) => (current.includes(e.phase) ? current : [...current, e.phase]));
      setPhases((prev) => ({
        ...prev,
        [e.phase]: {
          ...(prev[e.phase] ?? { status: 'pending', iteration: 0, steps: [] }),
          status: 'running',
          iteration: e.phaseIteration,
          steps: (prev[e.phase]?.steps ?? []).map((s) => ({ ...s, status: 'pending' as const })),
        },
      }));
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousStep?.((e) => {
      // 选题依据：收集 idea 阶段每个步骤的输出（研究空白/候选/假设）。
      if (e.phase === 'idea' && e.type === 'step-complete' && e.output) {
        const stepName = e.stepName;
        const output = e.output;
        setIdeaOutputs((prev) => [...prev, { stepName, output }]);
      }
      setPhases((prev) => {
        const phase = prev[e.phase] ?? { status: 'pending' as const, iteration: 0, steps: [] };
        let found = false;
        const steps = phase.steps.map((s) => {
          if (s.id !== e.stepId) return s;
          found = true;
          if (e.type === 'step-start') return { ...s, status: 'running' as const };
          if (e.type === 'step-complete') return { ...s, status: 'done' as const, output: e.output };
          if (e.type === 'step-failed') return { ...s, status: 'failed' as const, error: e.error };
          return s;
        });
        if (!found) {
          steps.push({
            id: e.stepId,
            name: e.stepName,
            status: e.type === 'step-start' ? 'running' : e.type === 'step-complete' ? 'done' : 'failed',
            ...(e.type === 'step-complete' ? { output: e.output } : {}),
            ...(e.type === 'step-failed' ? { error: e.error } : {}),
          });
        }
        return { ...prev, [e.phase]: { ...phase, steps } };
      });
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousReflection?.((e) => {
      setReflections((prev) => [...prev, {
        phase: e.phase,
        decision: e.decision,
        qualityScore: e.qualityScore,
        reasoning: e.reasoning,
        revisionNote: e.revisionNote,
        at: Date.now(),
      }]);
      if (e.decision === 'advance' || e.decision === 'done') {
        setPhases((prev) => ({
          ...prev,
          [e.phase]: { ...prev[e.phase], status: 'done' },
        }));
      }
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousProgress?.((e) => {
      setProgress({ completed: e.completedPhases, total: e.totalPhases });
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousCompleted?.((e) => {
      setSummary(e.summary);
      setArtifactIds(e.artifactIds);
      setRunning(false);
      setRecoverableSessions((current) => current.filter((item) => item.sessionId !== e.sessionId));
      setPhases((prev) => {
        const next = { ...prev };
        for (const p of ALL_PHASES) if (next[p].status === 'running') next[p] = { ...next[p], status: 'done' };
        return next;
      });
      // 连续运行：完成当前目标且用户未打断时，自动开始队列中的下一个。
      const nextGoal = queueRef.current[0];
      if (continuousRef.current && nextGoal && !chainCancelledRef.current) {
        const remaining = queueRef.current.slice(1);
        setQueue(remaining);
        persistQueue(remaining);
        setNextGoalNotice(nextGoal);
        chainTimerRef.current = setTimeout(() => {
          chainTimerRef.current = null;
          if (chainCancelledRef.current || !continuousRef.current) return;
          void startRunRef.current(nextGoal);
        }, 1500);
      } else if (!chainCancelledRef.current) {
        // 研究议程（T24）：goal 队列空时走项目级接续 —— 上报完成，
        // 由主进程按护栏（每项目上限/冷却）决策；关闭页面则不会推进。
        const finishedProjectId = runProjectIdRef.current;
        if (finishedProjectId) {
          void window.metis?.reportAgendaCompletion?.({ projectId: finishedProjectId, success: true }).then(async (decision) => {
            if (!decision) return;
            showToast({ kind: decision.action === 'project_capped' ? 'info' : 'success', text: decision.note });
            if (decision.action === 'run_next') {
              const head = (await window.metis?.getAgendaState?.())?.queue[0];
              const autonomous = head?.autonomous === true;
              if (autonomous && head) {
                // 自主新项目：先创建项目再运行完整 goal 指令。
                const questionMatch = head.goalPrompt?.match(/研究问题：(.+)/u);
                const created = await window.metis?.createProjectForAutonomous?.({
                  title: head.title,
                  researchQuestion: questionMatch?.[1]?.slice(0, 1000),
                });
                if (created?.ok && created.projectId) {
                  await researchWorkspaceStore.getState().setActiveProject(created.projectId);
                  if (head.goalPrompt) void startRunRef.current(head.goalPrompt);
                }
              } else if (decision.projectId) {
                await researchWorkspaceStore.getState().setActiveProject(decision.projectId).then(() => {
                  const project = researchWorkspaceStore.getState().projects.find((p) => p.id === decision.projectId);
                  const question = project?.researchQuestion?.trim() || project?.title || '';
                  if (question) void startRunRef.current(question);
                });
              }
            } else if (decision.action === 'cooldown' && typeof decision.waitMs === 'number') {
              chainTimerRef.current = setTimeout(() => { chainTimerRef.current = null; }, decision.waitMs);
            }
          });
        }
      }
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousFailed?.((e) => {
      setError(e.reason);
      setRunning(false);
      setPaused(e.recoverable);
      chainCancelledRef.current = true;
      // 失败也上报议程（不计入成功次数，但让议程状态可知）。
      if (runProjectIdRef.current) {
        void window.metis?.reportAgendaCompletion?.({ projectId: runProjectIdRef.current, success: false }).then((decision) => {
          if (decision) showToast({ kind: 'error', text: decision.note });
        });
      }
      setPhases((prev) => {
        const next = { ...prev };
        for (const p of ALL_PHASES) if (next[p].status === 'running') next[p] = { ...next[p], status: 'failed' };
        return next;
      });
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousInterrupted?.(() => {
      setInterrupted(true);
      setRunning(false);
      setPaused(false);
      chainCancelledRef.current = true;
      setNextGoalNotice(null);
    }) ?? (() => {}));

    // Real pause: the loop stops at a phase boundary and persists a checkpoint.
    unsubs.push(metis.onAutonomousPaused?.(() => {
      setPaused(true);
      setRunning(false);
    }) ?? (() => {}));

    // Real resume: the loop continues from the checkpoint without restarting.
    unsubs.push(metis.onAutonomousResumed?.(() => {
      setPaused(false);
      setRunning(true);
    }) ?? (() => {}));

    return () => { for (const u of unsubs) { try { u(); } catch { /* ignore */ } } };
  }, [metis, persistQueue]);

  // Surface durable checkpoints after an application restart or recoverable
  // failure. Continuing one resumes from the last completed phase.
  useEffect(() => {
    if (!metis?.autonomousListSessions) return;
    let cancelled = false;
    void metis.autonomousListSessions().then((result) => {
      if (!cancelled) setRecoverableSessions(result.sessions);
    }).catch(() => {
      if (!cancelled) setRecoverableSessions([]);
    });
    return () => { cancelled = true; };
  }, [metis]);

  // Load user-defined workflow strategies and paper structures.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.strategyList) return;
    let cancelled = false;
    void (async () => {
      try {
        const [strategyResult, structureResult] = await Promise.all([
          metis.strategyList(),
          metis.structureList?.(),
        ]);
        if (cancelled) return;
        if (strategyResult.ok && Array.isArray(strategyResult.strategies)) {
          const list = strategyResult.strategies as unknown as ResearchStrategy[];
          setStrategies(list);
          setSelectedStrategyId((current) => (list.some((s) => s.id === current) ? current : ''));
        }
        if (structureResult?.ok && Array.isArray(structureResult.templates)) {
          setStructures(structureResult.templates as unknown as PaperStructureTemplate[]);
        }
      } catch { /* strategies are optional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load projects for the 资料来源 selector (first-principles: the user must know
  // which project's data the run will build on).
  useEffect(() => {
    const store = researchWorkspaceStore.getState();
    if (store.projects.length === 0) void store.loadProjects();
  }, []);

  // Auto-scroll the reflection log.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [reflections]);

  const startRun = useCallback(async (goalText: string) => {
    const trimmed = goalText.trim();
    if (!metis?.autonomousStart || !trimmed || running) return;
    const effectiveProjectId = (projectChoice || activeProjectId) ?? undefined;
    setError(null);
    setSummary(null);
    setArtifactIds([]);
    setRunProjectId(effectiveProjectId ?? null);
    runProjectIdRef.current = effectiveProjectId ?? null;
    setInterrupted(false);
    setPaused(false);
    setReflections([]);
    setPhases(emptyPhases());
    setPhaseOrder([]);
    setWorkflowPlan([]);
    setIdeaOutputs([]);
    setMethod(null);
    setProgress(null);
    setNextGoalNotice(null);
    chainCancelledRef.current = false;
    setGoal(trimmed);
    setRunning(true);
    try {
      const result = await metis.autonomousStart({
        goal: trimmed,
        projectId: effectiveProjectId,
        strategyId: selectedStrategyId || undefined,
        structureId: selectedStructureId || undefined,
      });
      if (result.ok && result.sessionId) {
        setSessionId(result.sessionId);
        setRunProjectId(result.projectId ?? effectiveProjectId ?? null);
        if (result.projectId && result.projectId !== activeProjectId) {
          void setActiveProject(result.projectId);
        }
      } else {
        setError(t('autonomous.startFailed') + (result.error ? ` (${result.error})` : ''));
        setRunning(false);
      }
    } catch (err) {
      setError(t('autonomous.startFailed') + ': ' + (err instanceof Error ? err.message : String(err)));
      setRunning(false);
    }
  }, [metis, running, t, activeProjectId, projectChoice, selectedStrategyId, selectedStructureId, setActiveProject]);

  // 供事件回调（完成后自动开始下一个）使用的最新 startRun。
  useEffect(() => {
    startRunRef.current = startRun;
  }, [startRun]);

  const handleStart = useCallback(() => {
    void startRun(goal);
  }, [startRun, goal]);

  const handlePause = useCallback(async () => {
    if (!metis?.autonomousControl || !sessionId) return;
    chainCancelledRef.current = true;
    setNextGoalNotice(null);
    if (chainTimerRef.current) { clearTimeout(chainTimerRef.current); chainTimerRef.current = null; }
    try {
      await metis.autonomousControl({ sessionId, action: 'pause', reason: 'user_pause' });
    } catch { /* ignore */ }
  }, [metis, sessionId]);

  const handleResume = useCallback(async () => {
    if (!metis?.autonomousControl || !sessionId) return;
    setError(null);
    try {
      const result = await metis.autonomousControl({ sessionId, action: 'resume', reason: 'user_resume' });
      if (!result.ok) {
        setError(t('autonomous.resumeFailed') + (result.code ? ` (${result.code})` : ''));
      }
    } catch { /* ignore */ }
  }, [metis, sessionId, t]);

  const handleInterrupt = useCallback(async () => {
    if (!metis?.autonomousControl || !sessionId) return;
    chainCancelledRef.current = true;
    setNextGoalNotice(null);
    if (chainTimerRef.current) { clearTimeout(chainTimerRef.current); chainTimerRef.current = null; }
    try {
      await metis.autonomousControl({ sessionId, action: 'interrupt', reason: 'user_requested' });
    } catch { /* ignore */ }
  }, [metis, sessionId]);

  const handleOpenArtifacts = useCallback(() => {
    const projectId = runProjectId ?? activeProjectId;
    if (!projectId) return;
    window.dispatchEvent(new CustomEvent('metis:open-project', {
      detail: { projectId, section: 'artifacts' },
    }));
  }, [runProjectId, activeProjectId]);

  const handleRecoverSession = useCallback(async (checkpoint: RecoverableSession) => {
    if (!metis?.autonomousResumeSession || running) return;
    setError(null);
    setSummary(null);
    setArtifactIds([]);
    setInterrupted(false);
    setPaused(false);
    setReflections([]);
    setPhases(emptyPhases());
    setPhaseOrder([]);
    setWorkflowPlan([]);
    setIdeaOutputs([]);
    setMethod(null);
    setProgress(null);
    setGoal(checkpoint.goal);
    setSessionId(checkpoint.sessionId);
    setRunProjectId(checkpoint.projectId ?? null);
    setRunning(true);
    try {
      const result = await metis.autonomousResumeSession(checkpoint.sessionId);
      if (!result.ok) {
        setRunning(false);
        setPaused(true);
        setError(t('autonomous.resumeFailed') + (result.error ? ` (${result.error})` : ''));
        return;
      }
      setRecoverableSessions((current) => current.filter((item) => item.sessionId !== checkpoint.sessionId));
      if (checkpoint.projectId && checkpoint.projectId !== activeProjectId) {
        void setActiveProject(checkpoint.projectId);
      }
    } catch (error) {
      setRunning(false);
      setPaused(true);
      setError(t('autonomous.resumeFailed') + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }, [metis, running, t, activeProjectId, setActiveProject]);

  return (
    <div className="autonomous-page">
      <header className="autonomous-header">
        <h1>{t('autonomous.title')}</h1>
        <p className="autonomous-subtitle">{t('autonomous.subtitle')}</p>
      </header>

      {!running && recoverableSessions.length > 0 && (
        <section className="autonomous-recovery" data-testid="autonomous-recovery">
          <h2>{t('autonomous.recoverableRuns')}</h2>
          <p>{t('autonomous.recoverableRunsHint')}</p>
          <div className="autonomous-recovery-list">
            {recoverableSessions.map((checkpoint) => (
              <article key={checkpoint.sessionId} className="autonomous-recovery-item">
                <div>
                  <strong>{checkpoint.goal}</strong>
                  <span>{t('autonomous.completedPhases')}: {checkpoint.completedPhases}</span>
                  {checkpoint.failureReason && <small>{checkpoint.failureReason}</small>}
                </div>
                <button type="button" className="btn-primary" onClick={() => void handleRecoverSession(checkpoint)}>
                  {t('autonomous.continueFromCheckpoint')}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <AutonomousSetupPanel onStarted={() => void 0} />

      <details className="autonomous-manual">
        <summary>{t('autonomous.manualMode')}</summary>

      <section className="autonomous-control">
        <div className="autonomous-goal-block">
          <label htmlFor="autonomous-goal" className="autonomous-goal-label">{t('autonomous.goalLabel')}</label>
          <textarea
            id="autonomous-goal"
            className="autonomous-goal-input"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t('autonomous.goalPlaceholder')}
            rows={4}
            disabled={running}
          />
        </div>
        <div className="autonomous-options" role="group" aria-label={t('autonomous.advancedOptions')}>
          <label htmlFor="strategy-select">{t('autonomous.strategyLabel')}</label>
          <select
            className="settings-input"
            id="strategy-select"
            value={selectedStrategyId}
            onChange={(e) => setSelectedStrategyId(e.target.value)}
            disabled={running}
            data-testid="strategy-select"
          >
            <option value="">{t('autonomous.autoStrategy')}</option>
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>{strategy.name}</option>
            ))}
          </select>
          {structures.length > 0 && (
            <>
              <label htmlFor="structure-select">{t('autonomous.structureLabel')}</label>
              <select
                className="settings-input"
                id="structure-select"
                value={selectedStructureId}
                onChange={(e) => setSelectedStructureId(e.target.value)}
                disabled={running}
                data-testid="structure-select"
              >
                <option value="">{t('autonomous.noStructure')}</option>
                {structures.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="autonomous-project-select">{t('autonomous.projectLabel')}</label>
          <select
            className="settings-input"
            id="autonomous-project-select"
            value={projectChoice}
            onChange={(e) => setProjectChoice(e.target.value)}
            disabled={running}
            data-testid="autonomous-project-select"
          >
            <option value="">{t('autonomous.projectFollowActive')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.title}</option>
            ))}
          </select>
          <button type="button" className="btn-sm btn-secondary" onClick={() => setShowStrategyEditor((open) => !open)} data-testid="strategy-editor-toggle">
            {showStrategyEditor ? t('common.close') : t('autonomous.editStrategies')}
          </button>
        </div>
        <p className="autonomous-options-hint">{t('autonomous.projectHint')}</p>
        {showStrategyEditor && <StrategyEditor />}
        {method && (
          <div className="autonomous-method" data-testid="autonomous-method">
            <strong>{t('autonomous.selectedMethod')}: {method.name}</strong>
            <span>{Math.round(method.confidence * 100)}%</span>
            <p>{method.rationale}</p>
          </div>
        )}
        <div className="autonomous-actions">
          {!running && !paused ? (
            <>
              <button className="btn-primary" onClick={handleStart} disabled={!goal.trim()} title={!goal.trim() ? t('autonomous.startHint') : undefined} data-testid="autonomous-start">
                {t('autonomous.start')}
              </button>
              <button className="btn-secondary" onClick={enqueueGoal} disabled={!goal.trim()} title={!goal.trim() ? t('autonomous.startHint') : undefined} data-testid="autonomous-enqueue">
                {t('autonomous.enqueue')}
              </button>
            </>
          ) : paused ? (
            <>
              <button className="btn-primary" onClick={handleResume} data-testid="autonomous-resume">
                {t('autonomous.resume')}
              </button>
            </>
          ) : (
            <>
              <button className="btn-secondary" onClick={handlePause} data-testid="autonomous-pause">
                {t('autonomous.pause')}
              </button>
              <button className="btn-secondary" onClick={handleInterrupt} data-testid="autonomous-interrupt">
                {t('autonomous.interrupt')}
              </button>
              <button className="btn-secondary" onClick={enqueueGoal} disabled={!goal.trim()} title={!goal.trim() ? t('autonomous.startHint') : undefined} data-testid="autonomous-enqueue">
                {t('autonomous.enqueue')}
              </button>
            </>
          )}
          {progress && (
            <span className="autonomous-progress" data-testid="autonomous-progress">
              {t('autonomous.progressLabel')}: {progress.completed}/{progress.total}
            </span>
          )}
          {paused && <span className="autonomous-paused" data-testid="autonomous-paused-badge">{t('autonomous.paused')}</span>}
          {interrupted && <span className="autonomous-interrupted">{t('autonomous.interrupted')}</span>}
          {error && <span className="autonomous-error" role="alert">{error}</span>}
        </div>
      </section>
      </details>

      {nextGoalNotice && (
        <div className="autonomous-next-goal" role="status" data-testid="autonomous-next-goal">
          {t('autonomous.nextStart', { goal: nextGoalNotice })}
        </div>
      )}

      <section className="autonomous-queue" data-testid="autonomous-queue">
        <div className="autonomous-queue-head">
          <span className="autonomous-queue-title">{t('autonomous.queueTitle')}</span>
          <span className="autonomous-queue-count" data-testid="autonomous-queue-count">{queue.length}</span>
          <label className="autonomous-queue-continuous">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(e) => toggleContinuous(e.target.checked)}
              data-testid="autonomous-continuous"
            />
            {t('autonomous.continuousLabel')}
          </label>
        </div>
        {queue.length === 0 ? (
          <p className="autonomous-queue-empty">{t('autonomous.queueEmpty')}</p>
        ) : (
          <ol className="autonomous-queue-list">
            {queue.map((item, index) => (
              <li key={`${index}-${item.slice(0, 12)}`} className="autonomous-queue-item" data-testid="autonomous-queue-item">
                <span className="autonomous-queue-index">{index + 1}</span>
                <span className="autonomous-queue-text">{item}</span>
                <button
                  type="button"
                  className="autonomous-queue-remove"
                  aria-label={t('common.delete')}
                  onClick={() => removeQueuedGoal(index)}
                  disabled={running}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {!running && !paused && !summary && workflowPlan.length === 0 && (
        <section className="autonomous-preview" data-testid="autonomous-preview">
          <h2>{t('autonomous.previewTitle')}</h2>
          <ol className="autonomous-preview-steps">
            <li>
              <strong>{t('autonomous.previewStep1Title')}</strong>
              <span>{t('autonomous.previewStep1Desc')}</span>
            </li>
            <li>
              <strong>{t('autonomous.previewStep2Title')}</strong>
              <span>{t('autonomous.previewStep2Desc')}</span>
            </li>
            <li>
              <strong>{t('autonomous.previewStep3Title')}</strong>
              <span>{t('autonomous.previewStep3Desc')}</span>
            </li>
            <li>
              <strong>{t('autonomous.previewStep4Title')}</strong>
              <span>{t('autonomous.previewStep4Desc')}</span>
            </li>
            <li>
              <strong>{t('autonomous.previewStep5Title')}</strong>
              <span>{t('autonomous.previewStep5Desc')}</span>
            </li>
          </ol>
          <p className="autonomous-preview-note">{t('autonomous.previewNote')}</p>
          <p className="autonomous-preview-output">{t('autonomous.previewOutput')}</p>
        </section>
      )}

      {(method || ideaOutputs.length > 0) && (
        <section className="autonomous-topic" data-testid="autonomous-topic">
          <h2>{t('autonomous.topicTitle')}</h2>
          <dl className="autonomous-topic-grid">
            {goal.trim() && (
              <>
                <dt>{t('autonomous.topicGoal')}</dt>
                <dd>{goal}</dd>
              </>
            )}
            {method && (
              <>
                <dt>{t('autonomous.topicMethod')}</dt>
                <dd>
                  <strong>{method.name}</strong>
                  <span className="autonomous-topic-confidence">{Math.round(method.confidence * 100)}%</span>
                  <p className="autonomous-topic-rationale">{method.rationale}</p>
                </dd>
              </>
            )}
            {ideaOutputs.length > 0 && (
              <>
                <dt>{t('autonomous.topicAnalysis')}</dt>
                <dd>
                  <ul className="autonomous-topic-analysis">
                    {ideaOutputs.map((entry, index) => (
                      <li key={index}>
                        <span className="autonomous-topic-step">{entry.stepName}</span>
                        <p>{entry.output}</p>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      {workflowPlan.length > 0 && (
        <section className="autonomous-workflow" data-testid="autonomous-workflow">
          <div className="autonomous-workflow-head">
            <h2>{t('autonomous.workflowTitle')}</h2>
            {(() => {
              const currentItem = workflowPlan.find((item) => phases[item.phase]?.status === 'running');
              const currentStep = currentItem
                ? phases[currentItem.phase]?.steps.find((step) => step.status === 'running')
                : undefined;
              if (!currentItem) return null;
              return (
                <span className="autonomous-live-status" data-testid="autonomous-live-status" role="status">
                  {currentStep
                    ? t('autonomous.liveNowStep', { name: currentItem.name, step: currentStep.name })
                    : t('autonomous.liveNow', { name: currentItem.name })}
                </span>
              );
            })()}
          </div>
          <ol className="autonomous-pipeline" data-testid="autonomous-pipeline">
            {workflowPlan.map((item, index) => {
              const phase = phases[item.phase];
              const status = phase?.status ?? 'pending';
              const totalSteps = phase?.steps.length ?? 0;
              const doneSteps = phase?.steps.filter((step) => step.status === 'done').length ?? 0;
              return (
                <li
                  key={`${item.phase}-${index}`}
                  className={`autonomous-pipeline-node autonomous-pipeline-node--${status}`}
                  data-phase={item.phase}
                  data-status={status}
                >
                  <span className={`autonomous-pipeline-icon autonomous-pipeline-icon--${status}`} aria-hidden="true">
                    {status === 'done' ? '✓' : status === 'failed' ? '✕' : status === 'running' ? '◉' : '○'}
                  </span>
                  <span className="autonomous-pipeline-name">{item.name}</span>
                  <span className="autonomous-pipeline-progress">
                    {totalSteps > 0
                      ? `${doneSteps}/${totalSteps} ${t('autonomous.stepsUnit')}`
                      : statusLabel(status, t)}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section className="autonomous-phases" data-testid="autonomous-phases">
        {phaseOrder.map((phase) => (
          <div key={phase} className={`autonomous-phase autonomous-phase--${phases[phase].status}`}>
            <div className="autonomous-phase-head">
              <span className="autonomous-phase-name">{t(PHASE_LABEL_KEY[phase])}</span>
              {phases[phase].iteration > 1 && <span className="autonomous-phase-iter">#{phases[phase].iteration}</span>}
              <span className={`autonomous-phase-status autonomous-phase-status--${phases[phase].status}`}>
                {statusLabel(phases[phase].status, t)}
              </span>
            </div>
            <ol className="autonomous-steps">
              {phases[phase].steps.map((step) => (
                <li key={step.id} className={`autonomous-step autonomous-step--${step.status}`}>
                  <span className="autonomous-step-name">{step.name}</span>
                  {step.status === 'done' && step.output && (
                    <details className="autonomous-step-output">
                      <summary>{t('autonomous.output')}</summary>
                      <pre>{step.output.slice(0, 2000)}</pre>
                    </details>
                  )}
                  {step.status === 'failed' && step.error && (
                    <div className="autonomous-step-error">{step.error}</div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      {(running || paused || reflections.length > 0) && (
      <section className="autonomous-reflections">
        <h2>{t('autonomous.reflections')}</h2>
        <div className="autonomous-reflection-log" ref={logRef} data-testid="autonomous-reflection-log">
          {reflections.length === 0 && <p className="autonomous-empty">{t('autonomous.noReflections')}</p>}
          {reflections.map((r, i) => (
            <div key={i} className={`autonomous-reflection autonomous-reflection--${r.decision}`}>
              <div className="autonomous-reflection-head">
                <strong>{t(PHASE_LABEL_KEY[r.phase])}</strong>
                <span className={`autonomous-decision autonomous-decision--${r.decision}`}>
                  {decisionLabel(r.decision, t)}
                </span>
                <span className="autonomous-quality" title={t('autonomous.quality')}>
                  {(r.qualityScore * 100).toFixed(0)}%
                </span>
              </div>
              <p className="autonomous-reflection-reasoning">{r.reasoning}</p>
              {r.revisionNote && <p className="autonomous-reflection-note">↳ {r.revisionNote}</p>}
            </div>
          ))}
        </div>
      </section>
      )}

      {summary && (
        <section className="autonomous-summary" data-testid="autonomous-summary">
          <h2>{t('autonomous.finalSummary')}</h2>
          <pre>{summary}</pre>
          {artifactIds.length > 0 && (
            <div className="autonomous-deliverables" data-testid="autonomous-deliverables">
              <span>{t('autonomous.savedArtifacts')}: {artifactIds.length}</span>
              {(runProjectId ?? activeProjectId) && (
                <button type="button" className="btn-primary" onClick={handleOpenArtifacts} data-testid="autonomous-open-artifacts">
                  {t('autonomous.openArtifacts')}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <ResearchAgendaPanel
        onAdvance={async (goalPrompt, autonomous, projectId, title) => {
          if (autonomous) {
            const questionMatch = goalPrompt.match(/研究问题：(.+)/u);
            const created = await window.metis?.createProjectForAutonomous?.({
              title,
              researchQuestion: questionMatch?.[1]?.slice(0, 1000),
            });
            if (created?.ok && created.projectId) {
              await researchWorkspaceStore.getState().setActiveProject(created.projectId);
              if (goalPrompt) void startRunRef.current(goalPrompt);
            }
            return;
          }
          if (projectId) {
            const project = researchWorkspaceStore.getState().projects.find((p) => p.id === projectId);
            const question = project?.researchQuestion?.trim() || project?.title || '';
            if (question) void startRunRef.current(question);
          }
        }}
      />
    </div>
  );
}

function emptyPhases(): Record<PhaseKind, PhaseState> {
  const idle = (): PhaseState => ({ status: 'pending', iteration: 0, steps: [] });
  return {
    idea: { status: 'pending', iteration: 0, steps: seedSteps('idea') },
    experiment: { status: 'pending', iteration: 0, steps: seedSteps('experiment') },
    analysis: { status: 'pending', iteration: 0, steps: seedSteps('analysis') },
    paper: { status: 'pending', iteration: 0, steps: seedSteps('paper') },
    question_formulation: idle(),
    literature_review: idle(),
    source_discovery: idle(),
    screening: idle(),
    conceptual_analysis: idle(),
    source_criticism: idle(),
    research_design: idle(),
    data_collection: idle(),
    coding: idle(),
    data_preparation: idle(),
    statistics: idle(),
    triangulation: idle(),
    argumentation: idle(),
    writing: idle(),
    synthesis: idle(),
    quality_audit: idle(),
  };
}

// Static step skeletons mirroring researchPhases.ts (for display only).
function seedSteps(phase: PhaseKind): PhaseState['steps'] {
  switch (phase) {
    case 'idea': return [
      { id: 'gap_analysis', name: '研究空白分析', status: 'pending' },
      { id: 'idea_generation', name: '候选 Idea 生成', status: 'pending' },
      { id: 'hypothesis', name: '假设提炼', status: 'pending' },
    ];
    case 'experiment': return [
      { id: 'design', name: '实验方案设计', status: 'pending' },
      { id: 'implement', name: '实验代码实现', status: 'pending' },
      { id: 'run', name: '实验执行', status: 'pending' },
      { id: 'record', name: '结果记录', status: 'pending' },
    ];
    case 'analysis': return [
      { id: 'analyze', name: '统计分析', status: 'pending' },
      { id: 'interpret', name: '结果解释', status: 'pending' },
      { id: 'compare', name: '对比 baseline', status: 'pending' },
    ];
    case 'paper': return [
      { id: 'outline', name: '论文大纲', status: 'pending' },
      { id: 'draft_sections', name: '逐节起草', status: 'pending' },
      { id: 'compile_latex', name: '编译审计', status: 'pending' },
      { id: 'final', name: '定稿产出', status: 'pending' },
    ];
    default: return [];
  }
}

function statusLabel(status: PhaseState['status'], t: (k: string) => string): string {
  switch (status) {
    case 'pending': return t('autonomous.statusPending');
    case 'running': return t('autonomous.statusRunning');
    case 'done': return t('autonomous.statusDone');
    case 'failed': return t('autonomous.statusFailed');
  }
}

function decisionLabel(decision: ReflectionEntry['decision'], t: (k: string) => string): string {
  switch (decision) {
    case 'advance': return t('autonomous.decisionAdvance');
    case 'redo': return t('autonomous.decisionRedo');
    case 'rollback': return t('autonomous.decisionRollback');
    case 'done': return t('autonomous.decisionDone');
  }
}
