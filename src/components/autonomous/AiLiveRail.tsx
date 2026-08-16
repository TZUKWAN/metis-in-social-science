/**
 * AiLiveRail — AI 实时科研直播（重构 R3 右栏）。
 *
 * 数据全部来自真实引擎事件流：场景由 liveClassifier 从 step/reflection
 * 事件归类；「正在推进」来自 progress 事件；自主决策/研究动态来自工作区
 * 真实 decisions/timeline。无运行时显示 idle 态 + 最近动态。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { classifyStep, classifyReflection, type LiveScene } from '../../autonomous/liveClassifier';
import './autonomousWorkspace.css';

interface DecisionItem { id: string; at: number; decision: string; note: string; before: string; after: string }
interface TimelineItem { at: number; kind: string; text: string }

export interface LiveFeed {
  step: { type: string; phase: string; stepName: string; output?: string; at: number } | null;
  reflection: { type: string; phase: string; decision: string; reasoning: string; revisionNote?: string; at: number } | null;
  progress: { completedPhases: number; totalPhases: number; currentPhase: string } | null;
  running: boolean;
}

const SCENE_LABEL_KEYS: Record<string, string> = {
  writing: 'autoLive.sceneWriting',
  question: 'autoLive.sceneQuestion',
  framework: 'autoLive.sceneFramework',
  literature: 'autoLive.sceneLiterature',
  analysis: 'autoLive.sceneAnalysis',
  figure: 'autoLive.sceneFigure',
  table: 'autoLive.sceneTable',
  idle: 'autoLive.sceneIdle',
};

export default function AiLiveRail({ feed, decisions, timeline }: { feed: LiveFeed | null; decisions: DecisionItem[]; timeline: TimelineItem[] }) {
  const { t, locale } = useTranslation();
  const [history, setHistory] = useState<LiveScene[]>([]);
  const lastAtRef = useRef(0);

  // 事件流 → 场景（保留最近 8 条）。
  useEffect(() => {
    const scene = feed?.reflection
      ? classifyReflection(feed.reflection)
      : feed?.step
        ? classifyStep(feed.step)
        : null;
    if (scene && scene.at !== lastAtRef.current) {
      lastAtRef.current = scene.at;
      setHistory((current) => [scene, ...current].slice(0, 8));
    }
  }, [feed?.step, feed?.reflection]);

  const current = history[0] ?? null;
  const progress = feed?.progress ?? null;

  return (
    <aside className="aw-rail" data-testid="ai-live-rail" aria-label={t('autoLive.title')}>
      <div className="aw-rail__inner">
        <header className="aw-live__head">
          <span className={`aw-live__dot ${feed?.running ? 'aw-live__dot--on' : ''}`} aria-hidden="true" />
          <h2>{t('autoLive.title')}</h2>
          {feed?.running && <span className="aw-live__state">{t('autoLive.liveNow')}</span>}
        </header>

        {current ? (
          <section className="aw-live__scene" data-testid="ai-live-scene">
            <div className="aw-live__scene-kind">{t(SCENE_LABEL_KEYS[current.kind] ?? 'autoLive.sceneIdle')}</div>
            <div className="aw-live__scene-target">{current.target}</div>
            {current.funnel && (
              <dl className="aw-live__funnel" data-testid="ai-live-funnel">
                <div><dt>{t('autoLive.funnelScanned')}</dt><dd>{current.funnel.scanned}</dd></div>
                <div><dt>{t('autoLive.funnelRelevant')}</dt><dd>{current.funnel.relevant}</dd></div>
                <div><dt>{t('autoLive.funnelFullText')}</dt><dd>{current.funnel.fullText}</dd></div>
                <div><dt>{t('autoLive.funnelIncluded')}</dt><dd>{current.funnel.included}</dd></div>
              </dl>
            )}
            {current.after && (
              <div className="aw-live__change">
                {current.after && <p className="aw-live__change-after">{current.after}</p>}
                {current.reason && <p className="aw-live__change-reason">{current.reason}</p>}
              </div>
            )}
            {current.detail && <pre className="aw-live__detail">{current.detail.slice(0, 900)}</pre>}
          </section>
        ) : (
          <section className="aw-live__scene aw-live__scene--idle" data-testid="ai-live-idle">
            <p>{t('autoLive.idleHint')}</p>
          </section>
        )}

        {progress && feed?.running && (
          <section className="aw-live__progress" data-testid="ai-live-progress">
            <div className="aw-live__progress-head">
              <span>{t('autoLive.currentTask')}</span>
              <span>{Math.round((progress.completedPhases / Math.max(1, progress.totalPhases)) * 100)}%</span>
            </div>
            <div className="aw-live__progress-bar" role="progressbar" aria-valuenow={progress.completedPhases} aria-valuemin={0} aria-valuemax={progress.totalPhases}>
              <span style={{ width: `${Math.round((progress.completedPhases / Math.max(1, progress.totalPhases)) * 100)}%` }} />
            </div>
            <div className="aw-live__progress-meta">{progress.completedPhases}/{progress.totalPhases} · {progress.currentPhase}</div>
          </section>
        )}

        <section className="aw-live__decisions" data-testid="ai-live-decisions">
          <h3>{t('autoLive.decisionsTitle')}</h3>
          {decisions.length === 0 ? (
            <p className="aw-live__empty">{t('autoLive.noDecisions')}</p>
          ) : (
            <ul>
              {decisions.slice(0, 4).map((decision) => (
                <li key={decision.id} className="aw-live__decision">
                  <span className="aw-live__decision-time">{formatClock(decision.at, locale)}</span>
                  <span className="aw-live__decision-kind">{decision.decision}</span>
                  {decision.before && <p className="aw-live__decision-before">− {decision.before}</p>}
                  {decision.after && <p className="aw-live__decision-after">+ {decision.after}</p>}
                  {decision.note && <p className="aw-live__decision-note">{decision.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="aw-live__timeline" data-testid="ai-live-timeline">
          <h3>{t('autoLive.timelineTitle')}</h3>
          {timeline.length === 0 ? (
            <p className="aw-live__empty">{t('autoLive.noTimeline')}</p>
          ) : (
            <ul>
              {timeline.slice(0, 8).map((item, index) => (
                <li key={index} className="aw-live__tl-item">
                  <span className="aw-live__tl-time">{formatClock(item.at, locale)}</span>
                  <span className={`aw-live__tl-kind aw-live__tl-kind--${item.kind}`}>{timelineKindLabel(item.kind, t)}</span>
                  <span className="aw-live__tl-text">{item.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

function formatClock(at: number, locale: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function timelineKindLabel(kind: string, t: (k: string) => string): string {
  const map: Record<string, string> = {
    decision: 'autoLive.kindDecision',
    'artifact-version': 'autoLive.kindArtifact',
    evidence: 'autoLive.kindEvidence',
    source: 'autoLive.kindSource',
    claim: 'autoLive.kindClaim',
  };
  return t(map[kind] ?? 'autoLive.kindArtifact');
}
