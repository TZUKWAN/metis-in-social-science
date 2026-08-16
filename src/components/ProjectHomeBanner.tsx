/**
 * ProjectHomeBanner — 项目主页横幅（批3 改造）。
 *
 * 研究阶段由 AI 依据项目真实进展自动判定（StageDetector 规则引擎），
 * 用户不可手选；横幅展示判定结果与依据、上次进展摘要（研究日志）、
 * 概念图谱入口。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import ConceptGraphPanel from './ConceptGraphPanel';
import { RESEARCH_STAGES, DEFAULT_STAGE, stageProgress, type ResearchStageId } from '../../engine/research/ResearchStages';
import './ProjectHomeBanner.css';

interface BriefView {
  projectId: string;
  summaryText: string;
}

export default function ProjectHomeBanner() {
  const { t } = useTranslation();
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const projects = useResearchWorkspaceStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [stage, setStage] = useState<ResearchStageId>(DEFAULT_STAGE);
  const [rationale, setRationale] = useState<string[]>([]);
  const [brief, setBrief] = useState<BriefView | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (activeProjectId) {
      void window.metis?.detectStage?.(activeProjectId).then((result) => {
        if (!alive || !result) return;
        if (RESEARCH_STAGES.some((def) => def.id === result.stage)) {
          setStage(result.stage as ResearchStageId);
          setRationale(result.rationale ?? []);
        }
      });
      void window.metis?.getResumeBrief?.(activeProjectId).then((result) => {
        if (alive && result && result.projectId === activeProjectId) setBrief({ projectId: result.projectId, summaryText: result.summaryText });
      });
    }
    return () => { alive = false; };
  }, [activeProjectId, project?.updatedAt]);

  if (!project) return null;

  const progress = stageProgress(stage);
  const stageDef = RESEARCH_STAGES.find((def) => def.id === stage) ?? RESEARCH_STAGES[0]!;

  return (
    <div className="project-home" data-testid="project-home">
      <div className="project-home__main">
        <div className="project-home__stage">
          <span className="project-home__stage-label">{t('projects.aiStageLabel')}</span>
          <span className="project-home__stage-value" data-testid="project-ai-stage">{t(`projects.stage_${stageDef.key}.label`)}</span>
          <div className="project-home__stage-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="project-home__stage-count">{Math.round(progress * 100)}%</span>
          <button type="button" className="btn-sm btn-secondary" onClick={() => setGraphOpen(true)} data-testid="project-graph-open" title={t('cgraph.hint')}>
            {t('cgraph.entryButton')}
          </button>
        </div>
        {rationale.length > 0 && (
          <p className="project-home__rationale" data-testid="project-stage-rationale">
            {rationale.map((reason, index) => (
              <span key={index} className="project-home__rationale-chip">{reason}</span>
            ))}
          </p>
        )}
        {brief && brief.projectId === project.id && (
          <p className="project-home__brief" data-testid="project-home-brief" title={brief.summaryText}>{brief.summaryText}</p>
        )}
      </div>

      {graphOpen && (
        <ConceptGraphPanel projectId={project.id} onClose={() => setGraphOpen(false)} />
      )}
    </div>
  );
}
