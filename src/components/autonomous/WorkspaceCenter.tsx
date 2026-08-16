/**
 * WorkspaceCenter — 中间研究工作区（重构 R3）。
 *
 * 直接展示研究本体：研究问题（版本化）、AI 当前核心判断、本轮新增发现、
 * 当前不确定性、成果内容直展（非文件卡片；文件是次级导出）。
 * 数据全部来自 AutonomousWorkspaceService 的真实记录。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import './autonomousWorkspace.css';

interface ArtifactView { id: string; title: string; artifactType: string; version: number; updatedAt: number; contentPreview: string; aiEditing: boolean; fileCount: number }
interface Finding { id: string; text: string; confidence: number; at: number; origin?: string }
interface QuestionView { text: string; version: number; updatedAt: number; history: Array<{ version: number; text: string; at: number; note: string }> }

export interface CenterSection {
  question: QuestionView;
  coreJudgments: Finding[];
  newFindings: Finding[];
  uncertainties: Array<{ text: string; reason: string }>;
  artifacts: ArtifactView[];
  stats: { evidenceCount: number; claimCount: number; sourceCount: number; artifactCount: number };
}

const SECTION_TABS = ['overview', 'findings', 'theory', 'evidence', 'data', 'trail'] as const;

export default function WorkspaceCenter({ section }: { section: CenterSection }) {
  const { t, locale } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);

  const confidenceLabel = useMemo(() => (c: number) => `${Math.round(c * 100)}%`, []);

  return (
    <div className="aw-center" data-testid="aw-center">
      <section className="aw-block aw-question" data-testid="aw-question">
        <div className="aw-block__head">
          <h2>{t('autoWs.questionTitle')}</h2>
          <span className="aw-version">v{section.question.version}</span>
          <button type="button" className="btn-sm btn-secondary" onClick={() => setHistoryOpen((v) => !v)} data-testid="aw-question-history">
            {t('autoWs.questionHistory')}
          </button>
        </div>
        <p className="aw-question__text">{section.question.text}</p>
        {historyOpen && section.question.history.length > 0 && (
          <ul className="aw-question__history" data-testid="aw-question-history-list">
            {section.question.history.map((item) => (
              <li key={item.version}>
                <span className="aw-version aw-version--old">v{item.version}</span>
                <span className="aw-question__history-text">{item.text}</span>
                {item.note && <span className="aw-question__history-note">{item.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="aw-block" data-testid="aw-judgment">
        <div className="aw-block__head"><h2>{t('autoWs.judgmentTitle')}</h2></div>
        {section.coreJudgments.length === 0 ? (
          <p className="aw-block__empty">{t('autoWs.judgmentEmpty')}</p>
        ) : (
          <ul className="aw-judgments">
            {section.coreJudgments.map((item) => (
              <li key={item.id} className="aw-judgment">
                <p className="aw-judgment__text">{item.text}</p>
                <span className="aw-judgment__confidence">{t('autoWs.supportRate')}{confidenceLabel(item.confidence)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="aw-block aw-findings" data-testid="aw-findings">
        <div className="aw-block__head"><h2>{t('autoWs.findingsTitle')}</h2></div>
        {section.newFindings.length === 0 ? (
          <p className="aw-block__empty">{t('autoWs.findingsEmpty')}</p>
        ) : (
          <ul className="aw-finding-list">
            {section.newFindings.map((item) => (
              <li key={`${item.origin}-${item.id}`} className="aw-finding">
                <span className={`aw-finding__origin aw-finding__origin--${item.origin ?? 'claim'}`}>
                  {item.origin === 'evidence' ? t('autoWs.originEvidence') : t('autoWs.originClaim')}
                </span>
                <span className="aw-finding__text">{item.text}</span>
                <span className="aw-finding__time">{new Date(item.at).toLocaleDateString(locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="aw-block" data-testid="aw-uncertainty">
        <div className="aw-block__head"><h2>{t('autoWs.uncertaintyTitle')}</h2></div>
        {section.uncertainties.length === 0 ? (
          <p className="aw-block__empty">{t('autoWs.uncertaintyEmpty')}</p>
        ) : (
          <ul className="aw-uncertainties">
            {section.uncertainties.map((item, index) => (
              <li key={index} className="aw-uncertainty">
                <p className="aw-uncertainty__text">{item.text}</p>
                <p className="aw-uncertainty__reason">{item.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="aw-block aw-artifacts" data-testid="aw-artifacts">
        <div className="aw-block__head">
          <h2>{t('autoWs.artifactsTitle')}</h2>
          <span className="aw-block__count">{section.artifacts.length}</span>
        </div>
        {section.artifacts.length === 0 ? (
          <p className="aw-block__empty">{t('autoWs.artifactsEmpty')}</p>
        ) : (
          <div className="aw-artifact-grid">
            {section.artifacts.map((artifact) => (
              <article key={artifact.id} className={`aw-artifact aw-artifact--${artifact.artifactType}`} data-testid="aw-artifact">
                <header className="aw-artifact__head">
                  <span className="aw-artifact__type">{artifactTypeLabel(artifact.artifactType, t)}</span>
                  <h3 className="aw-artifact__title">{artifact.title}</h3>
                  <span className="aw-version">v{artifact.version}</span>
                  {artifact.aiEditing && <span className="aw-artifact__editing" data-testid="aw-artifact-editing">{t('autoWs.aiEditing')}</span>}
                </header>
                <div className="aw-artifact__content">
                  {renderArtifactContent(artifact, t)}
                </div>
                <footer className="aw-artifact__foot">
                  <span className="aw-artifact__time">{t('autoWs.updatedAt')}{new Date(artifact.updatedAt).toLocaleString(locale)}</span>
                  {artifact.fileCount > 0 && <span className="aw-artifact__files">{t('autoWs.exportFiles')}{artifact.fileCount}</span>}
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="aw-stats" data-testid="aw-stats">
        <span>{t('autoWs.statSources')}{section.stats.sourceCount}</span>
        <span>{t('autoWs.statEvidence')}{section.stats.evidenceCount}</span>
        <span>{t('autoWs.statClaims')}{section.stats.claimCount}</span>
        <span>{t('autoWs.statArtifacts')}{section.stats.artifactCount}</span>
      </div>

      <div style={{ display: 'none' }}>{/* section tabs reserved for future deep views */}{SECTION_TABS.join(',')}{' '}<SectionTabLegacy /></div>
    </div>
  );
}

function SectionTabLegacy(): null {
  return null;
}

function artifactTypeLabel(type: string, t: (k: string) => string): string {
  const map: Record<string, string> = {
    manuscript: 'autoWs.typeManuscript',
    chart: 'autoWs.typeChart',
    table: 'autoWs.typeTable',
    report: 'autoWs.typeReport',
    network: 'autoWs.typeNetwork',
    other: 'autoWs.typeOther',
  };
  return t(map[type] ?? 'autoWs.typeOther');
}

function renderArtifactContent(artifact: ArtifactView, t: (k: string) => string): React.ReactNode {
  const content = artifact.contentPreview;
  if (!content) {
    return <p className="aw-artifact__nocontent">{t('autoWs.noContentPreview')}</p>;
  }
  if (artifact.artifactType === 'table') {
    return <pre className="aw-artifact__table">{content.slice(0, 1600)}</pre>;
  }
  if (artifact.artifactType === 'chart' || artifact.artifactType === 'network') {
    return <pre className="aw-artifact__figure">{content.slice(0, 800) || t('autoWs.noContentPreview')}</pre>;
  }
  return <pre className="aw-artifact__text">{content.slice(0, 2400)}</pre>;
}
