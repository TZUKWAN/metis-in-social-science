/**
 * ArtifactsPage — project-scoped artifact management.
 *
 * Replaces the old session-grouped browser with a management console:
 * project overview stats, type/status/search filters, review-status
 * transitions with an audit timeline, and a version history panel.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from '../i18n';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import './ArtifactsPage.css';

type ReviewStatus = 'draft' | 'pending' | 'partial' | 'verified' | 'stale';

interface ProjectArtifact {
  id: string;
  projectId: string;
  title: string;
  artifactType: string;
  reviewStatus: ReviewStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  citedSourceIds: string[];
  reviewTrail: Array<{ at: number; from: string; to: string; reason: string }>;
}

interface ArtifactVersionEntry {
  version: number;
  createdAt: number;
  createdBy: string;
  contentPreview: string;
}

const STATUS_ORDER: ReviewStatus[] = ['draft', 'pending', 'partial', 'verified', 'stale'];

/** Legal review transitions offered as buttons per current status. */
const TRANSITIONS: Record<ReviewStatus, Array<{ to: ReviewStatus; actionKey: string }>> = {
  draft: [{ to: 'pending', actionKey: 'submitReview' }],
  pending: [{ to: 'verified', actionKey: 'approve' }, { to: 'draft', actionKey: 'reject' }],
  partial: [{ to: 'pending', actionKey: 'resubmit' }],
  verified: [{ to: 'draft', actionKey: 'reject' }],
  stale: [{ to: 'draft', actionKey: 'resetStale' }],
};

function formatTime(ts: number, locale: string): string {
  try {
    return new Date(ts).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(ts);
  }
}

export default function ArtifactsPage() {
  const { t, locale } = useTranslation();
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const projects = useResearchWorkspaceStore((state) => state.projects);

  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [query, setQuery] = useState('');
  const [versions, setVersions] = useState<ArtifactVersionEntry[]>([]);
  const [busyAction, setBusyAction] = useState(false);

  const loadArtifacts = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.artifactListByProject || !activeProjectId) {
      setArtifacts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await metis.artifactListByProject(activeProjectId);
      setArtifacts((result.items ?? []) as unknown as ProjectArtifact[]);
    } catch {
      setError(t('artifacts.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadArtifacts sets loading state synchronously before its first await
    void loadArtifacts();
  }, [loadArtifacts]);

  const selected = artifacts.find((a) => a.id === selectedId) ?? null;

  // Load the version list whenever the selection changes.
  useEffect(() => {
    if (!selectedId || !window.metis?.artifactListVersions) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale version list when nothing is selected
      setVersions([]);
      return;
    }
    let cancelled = false;
    void window.metis.artifactListVersions(selectedId).then((result) => {
      if (!cancelled) setVersions(result.versions ?? []);
    }).catch(() => { if (!cancelled) setVersions([]); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return artifacts.filter((a) => {
      if (typeFilter && a.artifactType !== typeFilter) return false;
      if (statusFilter && a.reviewStatus !== statusFilter) return false;
      if (q && !a.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [artifacts, typeFilter, statusFilter, query]);

  const stats = useMemo(() => {
    const byStatus = new Map<ReviewStatus, number>();
    for (const status of STATUS_ORDER) byStatus.set(status, 0);
    for (const a of artifacts) byStatus.set(a.reviewStatus, (byStatus.get(a.reviewStatus) ?? 0) + 1);
    return { total: artifacts.length, byStatus };
  }, [artifacts]);

  const transition = useCallback(async (artifact: ProjectArtifact, to: ReviewStatus) => {
    const metis = window.metis;
    if (busyAction || !metis?.artifactUpdateReviewStatus) return;
    setBusyAction(true);
    try {
      const result = await metis.artifactUpdateReviewStatus({
        artifactId: artifact.id,
        toStatus: to,
        reason: 'manual',
      });
      if (result.ok) {
        await loadArtifacts();
      } else {
        setError(t('artifacts.statusUpdateFailed'));
      }
    } catch {
      setError(t('artifacts.statusUpdateFailed'));
    } finally {
      setBusyAction(false);
    }
  }, [busyAction, loadArtifacts, t]);

  const restoreVersion = useCallback(async (artifact: ProjectArtifact, version: number) => {
    const metis = window.metis;
    if (busyAction || !metis?.artifactRestoreVersion) return;
    setBusyAction(true);
    try {
      const result = await metis.artifactRestoreVersion({ artifactId: artifact.id, version });
      if (result.ok) {
        await loadArtifacts();
        const refreshed = await window.metis?.artifactListVersions?.(artifact.id);
        if (refreshed) setVersions(refreshed.versions ?? []);
      } else {
        setError(t('artifacts.restoreFailed'));
      }
    } catch {
      setError(t('artifacts.restoreFailed'));
    } finally {
      setBusyAction(false);
    }
  }, [busyAction, loadArtifacts, t]);

  const projectName = projects.find((p) => p.id === activeProjectId)?.title ?? activeProjectId ?? '';

  return (
    <div className="artifacts-page">
      <div className="artifacts-header">
        <h2>{t('artifacts.pageTitle')}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {projectName && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{projectName}</span>}
          <button className="btn-toggle" onClick={() => void loadArtifacts()} disabled={loading}>
            {loading ? t('common.loading') : t('common.refresh')}
          </button>
        </div>
      </div>

      {/* Project overview stats */}
      {artifacts.length > 0 && (
        <div className="artifacts-stats" data-testid="artifacts-stats" style={{ display: 'flex', gap: 12, padding: '8px 16px', fontSize: 12, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
          <span>{t('artifacts.statsTotal', { count: stats.total })}</span>
          {STATUS_ORDER.map((status) => (
            <span key={status}>
              {t(`artifacts.status_${status}`)}: {stats.byStatus.get(status) ?? 0}
            </span>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="btn-sm" aria-label={t('artifacts.filterType')} data-testid="artifacts-filter-type">
          <option value="">{t('artifacts.filterTypeAll')}</option>
          {['manuscript', 'chart', 'table', 'report', 'network', 'other'].map((type) => (
            <option key={type} value={type}>{t(`artifacts.type_${type}`)}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="btn-sm" aria-label={t('artifacts.filterStatus')} data-testid="artifacts-filter-status">
          <option value="">{t('artifacts.filterStatusAll')}</option>
          {STATUS_ORDER.map((status) => (
            <option key={status} value={status}>{t(`artifacts.status_${status}`)}</option>
          ))}
        </select>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('artifacts.searchPlaceholder')}
          className="search-input"
          style={{ width: 200 }}
        />
      </div>

      {error && <div className="artifacts-error" role="alert">{error}</div>}

      {filtered.length === 0 && !loading ? (
        <div className="empty-state">
          <h3>{t('artifacts.emptyTitle')}</h3>
          <p>{t('artifacts.emptyDescription')}</p>
        </div>
      ) : (
        <div className="artifacts-grid">
          <div className="artifacts-list" data-testid="artifacts-cards">
            {filtered.map((artifact) => (
              <div
                key={artifact.id}
                className={`artifact-item artifact-card ${selectedId === artifact.id ? 'active' : ''}`}
                data-testid="artifact-card"
                onClick={() => setSelectedId(artifact.id)}
                style={{ cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span className="artifact-name" style={{ fontWeight: 600 }}>{artifact.title}</span>
                  <span className={`artifact-status artifact-status--${artifact.reviewStatus}`}>
                    {t(`artifacts.status_${artifact.reviewStatus}`)}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  <span>{t(`artifacts.type_${artifact.artifactType}`)}</span>
                  <span>v{artifact.version}</span>
                  <span>{formatTime(artifact.updatedAt, locale)}</span>
                  <span>{t('artifacts.citedSources', { count: artifact.citedSourceIds.length })}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="artifact-preview">
            {!selected ? (
              <div className="empty-state">{t('artifacts.selectToPreview')}</div>
            ) : (
              <div className="artifact-content" data-testid="artifact-detail">
                <h3>{selected.title}</h3>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  {(TRANSITIONS[selected.reviewStatus] ?? []).map((transitionOption) => (
                    <button
                      key={transitionOption.to}
                      className="btn-sm btn-primary"
                      data-testid={`artifact-action-${transitionOption.actionKey}`}
                      disabled={busyAction}
                      onClick={() => void transition(selected, transitionOption.to)}
                    >
                      {t(`artifacts.action_${transitionOption.actionKey}`)}
                    </button>
                  ))}
                </div>

                {/* Version history */}
                <div style={{ marginBottom: 12 }}>
                  <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>{t('artifacts.versionsTitle')}</h4>
                  {versions.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('artifacts.versionsEmpty')}</div>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {versions.map((entry) => (
                        <li key={entry.version} style={{ padding: '4px 0', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>
                              v{entry.version} · {formatTime(entry.createdAt, locale)} · {entry.createdBy}
                            </span>
                            {entry.version !== selected.version && (
                              <button
                                className="btn-sm btn-secondary"
                                data-testid={`artifact-restore-v${entry.version}`}
                                disabled={busyAction}
                                onClick={() => void restoreVersion(selected, entry.version)}
                              >
                                {t('artifacts.restoreVersion')}
                              </button>
                            )}
                          </div>
                          {entry.contentPreview && (
                            <div style={{ marginTop: 4, maxHeight: 120, overflowY: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>
                              <SafeMarkdown content={entry.contentPreview} locale={locale} />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Review timeline */}
                <div>
                  <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>{t('artifacts.reviewTrailTitle')}</h4>
                  {selected.reviewTrail.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('artifacts.reviewTrailEmpty')}</div>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {[...selected.reviewTrail].reverse().map((entry, index) => (
                        <li key={index} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                          {formatTime(entry.at, locale)} · {t(`artifacts.status_${entry.from}`)} → {t(`artifacts.status_${entry.to}`)}
                          {entry.reason && entry.reason !== 'manual' ? ` · ${entry.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
