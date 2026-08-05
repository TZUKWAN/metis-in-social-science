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
import './AutonomousResearchPage.css';

type PhaseKind = 'idea' | 'experiment' | 'analysis' | 'paper';

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

const PHASE_ORDER: PhaseKind[] = ['idea', 'experiment', 'analysis', 'paper'];
const PHASE_LABEL_KEY: Record<PhaseKind, string> = {
  idea: 'autonomous.phaseIdea',
  experiment: 'autonomous.phaseExperiment',
  analysis: 'autonomous.phaseAnalysis',
  paper: 'autonomous.phasePaper',
};

export default function AutonomousResearchPage(): ReactNode {
  const { t } = useTranslation();
  const metis = window.metis;
  const [goal, setGoal] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phases, setPhases] = useState<Record<PhaseKind, PhaseState>>(emptyPhases());
  const [reflections, setReflections] = useState<ReflectionEntry[]>([]);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Subscribe to all live event channels once.
  useEffect(() => {
    if (!metis) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(metis.onAutonomousEngineStarted?.((e) => {
      setProgress({ completed: 0, total: e.plan.length });
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousPhaseStarted?.((e) => {
      setPhases((prev) => ({
        ...prev,
        [e.phase]: { ...prev[e.phase], status: 'running', iteration: e.phaseIteration, steps: prev[e.phase].steps.map((s) => ({ ...s, status: 'pending' as const })) },
      }));
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousStep?.((e) => {
      setPhases((prev) => {
        const phase = prev[e.phase];
        const steps = phase.steps.map((s) => {
          if (s.id !== e.stepId) return s;
          if (e.type === 'step-start') return { ...s, status: 'running' as const };
          if (e.type === 'step-complete') return { ...s, status: 'done' as const, output: e.output };
          if (e.type === 'step-failed') return { ...s, status: 'failed' as const, error: e.error };
          return s;
        });
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
      setRunning(false);
      setPhases((prev) => {
        const next = { ...prev };
        for (const p of PHASE_ORDER) if (next[p].status === 'running') next[p] = { ...next[p], status: 'done' };
        return next;
      });
    }) ?? (() => {}));

    unsubs.push(metis.onAutonomousInterrupted?.(() => {
      setInterrupted(true);
      setRunning(false);
    }) ?? (() => {}));

    return () => { for (const u of unsubs) { try { u(); } catch { /* ignore */ } } };
  }, [metis]);

  // Auto-scroll the reflection log.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [reflections]);

  const handleStart = useCallback(async () => {
    if (!metis?.autonomousStart || !goal.trim() || running) return;
    setError(null);
    setSummary(null);
    setInterrupted(false);
    setReflections([]);
    setPhases(emptyPhases());
    setProgress(null);
    setRunning(true);
    try {
      const result = await metis.autonomousStart({ goal: goal.trim() });
      if (result.ok && result.sessionId) {
        setSessionId(result.sessionId);
      } else {
        setError(t('autonomous.startFailed') + (result.error ? ` (${result.error})` : ''));
        setRunning(false);
      }
    } catch (err) {
      setError(t('autonomous.startFailed') + ': ' + (err instanceof Error ? err.message : String(err)));
      setRunning(false);
    }
  }, [metis, goal, running, t]);

  const handleInterrupt = useCallback(async () => {
    if (!metis?.autonomousControl || !sessionId) return;
    try {
      await metis.autonomousControl({ sessionId, action: 'interrupt', reason: 'user_requested' });
    } catch { /* ignore */ }
  }, [metis, sessionId]);

  return (
    <div className="autonomous-page">
      <header className="autonomous-header">
        <h1>{t('autonomous.title')}</h1>
        <p className="autonomous-subtitle">{t('autonomous.subtitle')}</p>
      </header>

      <section className="autonomous-control">
        <textarea
          className="autonomous-goal-input"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t('autonomous.goalPlaceholder')}
          rows={3}
          disabled={running}
        />
        <div className="autonomous-actions">
          {!running ? (
            <button className="btn-primary" onClick={handleStart} disabled={!goal.trim()} data-testid="autonomous-start">
              {t('autonomous.start')}
            </button>
          ) : (
            <button className="btn-secondary" onClick={handleInterrupt} data-testid="autonomous-interrupt">
              {t('autonomous.interrupt')}
            </button>
          )}
          {progress && (
            <span className="autonomous-progress" data-testid="autonomous-progress">
              {t('autonomous.progressLabel')}: {progress.completed}/{progress.total}
            </span>
          )}
          {interrupted && <span className="autonomous-interrupted">{t('autonomous.interrupted')}</span>}
          {error && <span className="autonomous-error" role="alert">{error}</span>}
        </div>
      </section>

      <section className="autonomous-phases" data-testid="autonomous-phases">
        {PHASE_ORDER.map((phase) => (
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

      {summary && (
        <section className="autonomous-summary" data-testid="autonomous-summary">
          <h2>{t('autonomous.finalSummary')}</h2>
          <pre>{summary}</pre>
        </section>
      )}
    </div>
  );
}

function emptyPhases(): Record<PhaseKind, PhaseState> {
  return {
    idea: { status: 'pending', iteration: 0, steps: seedSteps('idea') },
    experiment: { status: 'pending', iteration: 0, steps: seedSteps('experiment') },
    analysis: { status: 'pending', iteration: 0, steps: seedSteps('analysis') },
    paper: { status: 'pending', iteration: 0, steps: seedSteps('paper') },
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
