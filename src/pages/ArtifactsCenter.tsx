/**
 * ArtifactsCenter — 研究成果（科研项目页内第三模式）。
 *
 * 展示当前项目的全部过程产物：按更新时间倒序（最新在前）、直接列出
 * 类别（论文/源代码/元数据/参考文献）、审核状态和版本历史。
 * 该区域是项目工作台内的只读查看器；成果内容编辑、版本写入、审核写入
 * 和投稿管理统一留在正式成果工作台或对应流程页面。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import type { ResearchArtifactDto, ResearchArtifactVersionDto } from '../../engine/runtime/ResearchRuntimeContract.js';

export type ArtifactCategory = 'paper' | 'code' | 'metadata' | 'references';

interface ArtifactRow {
  artifact: ResearchArtifactDto;
  category: ArtifactCategory;
  versions: ResearchArtifactVersionDto[];
}

const CATEGORY_ORDER: Array<{ category: ArtifactCategory | 'all'; labelKey: string }> = [
  { category: 'all', labelKey: 'artifactsCenter.filterAll' },
  { category: 'paper', labelKey: 'artifactsCenter.categoryPaper' },
  { category: 'code', labelKey: 'artifactsCenter.categoryCode' },
  { category: 'metadata', labelKey: 'artifactsCenter.categoryMetadata' },
  { category: 'references', labelKey: 'artifactsCenter.categoryReferences' },
];

const CATEGORY_LABEL_KEYS: Record<ArtifactCategory, string> = {
  paper: 'artifactsCenter.categoryPaper',
  code: 'artifactsCenter.categoryCode',
  metadata: 'artifactsCenter.categoryMetadata',
  references: 'artifactsCenter.categoryReferences',
};

/** 把产物归入用户可见的四类：论文/源代码/元数据/参考文献。 */
function classifyArtifact(artifact: ResearchArtifactDto): ArtifactCategory {
  switch (artifact.artifactType) {
    case 'manuscript':
    case 'report':
      return 'paper';
    case 'chart':
    case 'table':
    case 'network':
      return 'metadata';
    default:
      return 'references';
  }
}

function formatTime(ts: number, locale: string): string {
  const date = new Date(ts);
  const diffDays = Math.floor((Date.now() - ts) / 86_400_000);
  if (diffDays <= 0) return locale === 'zh' ? '今天' : 'today';
  if (diffDays === 1) return locale === 'zh' ? '昨天' : 'yesterday';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface ArtifactsCenterProps {
  projectId: string | null;
}

export default function ArtifactsCenter({ projectId }: ArtifactsCenterProps) {
  const { t, locale } = useTranslation();
  const [rows, setRows] = useState<ArtifactRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<ArtifactCategory | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const snapshot = await window.metis?.researchSnapshot?.({ operation: 'snapshot', projectId });
      const artifacts = snapshot?.success ? snapshot.snapshot.artifacts : [];
      const loaded: ArtifactRow[] = [];
      for (const artifact of artifacts) {
        const versions = await window.metis?.researchVersion?.({
          operation: 'list_versions',
          projectId,
          artifactId: artifact.id,
          limit: 100,
          offset: 0,
        });
        const versionItems = versions && 'items' in versions && versions.success
          ? versions.items
          : [];
        loaded.push({
          artifact,
          category: classifyArtifact(artifact),
          versions: versionItems,
        });
      }
      loaded.sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt);
      setRows(loaded);
    } catch {
      setError(t('artifactsCenter.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load sets loading state synchronously before its first await
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (categoryFilter === 'all') return rows;
    return rows.filter((row) => row.category === categoryFilter);
  }, [rows, categoryFilter]);

  const statusLabel = (status: string): string => {
    switch (status) {
      case 'draft': return t('artifactsCenter.markDraft');
      case 'pending': return t('artifactsCenter.markPending');
      case 'partial': return t('artifactsCenter.markPartial');
      case 'verified': return t('artifactsCenter.markVerified');
      case 'stale': return t('artifactsCenter.markStale');
      default: return status;
    }
  };

  return (
    <div className="artifacts-center" data-testid="artifacts-center">
      <header className="artifacts-center__header">
        <h2>{t('artifactsCenter.title')}</h2>
        <div className="artifacts-center__filters" role="group" aria-label={t('artifactsCenter.title')}>
          {CATEGORY_ORDER.map((entry) => (
            <button
              key={entry.category}
              type="button"
              className={`artifacts-center__filter ${categoryFilter === entry.category ? 'active' : ''}`}
              aria-pressed={categoryFilter === entry.category}
              onClick={() => setCategoryFilter(entry.category)}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="artifacts-center__error" role="alert">{error}</div>}

      {loading && rows.length === 0 ? (
        <div className="artifacts-center__empty">{t('common.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="artifacts-center__empty">
          <p className="artifacts-center__empty-title">{t('artifactsCenter.emptyTitle')}</p>
          <p className="artifacts-center__empty-desc">{t('artifactsCenter.emptyDescription')}</p>
        </div>
      ) : (
        <ul className="artifacts-center__list">
          {filtered.map((row) => (
            <li
              key={row.artifact.id}
              className="artifacts-center__item"
              data-testid="artifacts-center-item"
              data-artifact-id={row.artifact.id}
            >
              <button
                type="button"
                className="artifacts-center__item-main"
                onClick={() => setExpandedId(expandedId === row.artifact.id ? null : row.artifact.id)}
                aria-expanded={expandedId === row.artifact.id}
              >
                <span className="artifacts-center__item-title">{row.artifact.title}</span>
                <span className="artifacts-center__item-meta">
                  <span className={`artifacts-center__category artifacts-center__category--${row.category}`}>
                    {t(CATEGORY_LABEL_KEYS[row.category])}
                  </span>
                  <span className={`artifacts-center__status artifacts-center__status--${row.artifact.reviewStatus}`}>
                    {statusLabel(row.artifact.reviewStatus)}
                  </span>
                  <span className="artifacts-center__versions">
                    {t('artifactsCenter.versionCount', { count: row.versions.length })}
                  </span>
                  <span className="artifacts-center__time">
                    {t('artifactsCenter.updatedAt', { time: formatTime(row.artifact.updatedAt, locale) })}
                  </span>
                </span>
              </button>
              {expandedId === row.artifact.id && (
                <div className="artifacts-center__versions-panel" data-testid="artifacts-center-versions">
                  <h4>{t('artifactsCenter.versionsTitle')}</h4>
                  {row.versions.length === 0 ? (
                    <p className="artifacts-center__versions-empty">{t('artifacts.versionsEmpty')}</p>
                  ) : (
                    <ul>
                      {row.versions.map((version) => (
                        <li key={`${version.artifactId}-${version.version}`}>
                          <span className="artifacts-center__version-badge">
                            {t('artifactsCenter.versionBadge', { version: version.version })}
                          </span>
                          <span>{formatTime(version.createdAt, locale)}</span>
                          <span className="artifacts-center__version-author">{version.createdBy}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

    </div>
  );
}
