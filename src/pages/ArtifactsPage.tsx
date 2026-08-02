/**
 * ArtifactsPage — browse generated artifacts across sessions.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from '../i18n';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import type { ArtifactListItem } from '../../engine/runtime/ArtifactRuntimeContract.js';

interface ArtifactContent {
  id: string;
  name: string;
  type: string;
  content: unknown;
  createdAt: number;
}

function formatTime(ts: number, locale: string): string {
  try {
    return new Date(ts).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(ts);
  }
}

export default function ArtifactsPage() {
  const { t, locale } = useTranslation();
  const [artifacts, setArtifacts] = useState<ArtifactListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadArtifacts = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.listArtifacts) return;
    setLoading(true);
    setError(null);
    try {
      const result = await metis.listArtifacts('default');
      if (result.success) {
        setArtifacts(result.items ?? []);
      } else {
        setError(t('artifacts.loadFailed'));
      }
    } catch {
      setError(t('artifacts.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadContent = useCallback(async (artifact: ArtifactListItem) => {
    const metis = window.metis;
    if (!metis?.getArtifactContent) return;
    setSelectedId(artifact.id);
    setContent(null);
    try {
      const result = await metis.getArtifactContent(artifact.sessionId, artifact.id);
      if (result.success) {
        setContent(result as ArtifactContent);
      }
    } catch {
      // Content unavailable.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const metis = window.metis;
        if (!metis?.listArtifacts) return;
        const result = await metis.listArtifacts('default');
        if (cancelled) return;
        if (result.success) {
          setArtifacts(result.items ?? []);
        } else {
          setError(t('artifacts.loadFailed'));
        }
      } catch {
        if (!cancelled) setError(t('artifacts.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const sessions = [...new Set(artifacts.map((a) => a.sessionId))];

  return (
    <div className="artifacts-page">
      <div className="artifacts-header">
        <h2>{t('artifacts.pageTitle')}</h2>
        <button className="btn-toggle" onClick={() => void loadArtifacts()} disabled={loading}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>

      {error && <div className="artifacts-error">{error}</div>}

      {artifacts.length === 0 && !loading ? (
        <div className="empty-state">
          <h3>{t('artifacts.emptyTitle')}</h3>
          <p>{t('artifacts.emptyDescription')}</p>
        </div>
      ) : (
        <div className="artifacts-grid">
          <div className="artifacts-list">
            {sessions.map((sessionId) => (
              <div key={sessionId} className="artifacts-session">
                <h4>{t('artifacts.session', { id: sessionId.slice(0, 12) })}</h4>
                <ul>
                  {artifacts
                    .filter((a) => a.sessionId === sessionId)
                    .map((artifact) => (
                      <li
                        key={artifact.id}
                        className={`artifact-item ${selectedId === artifact.id ? 'active' : ''}`}
                        onClick={() => void loadContent(artifact)}
                      >
                        <span className="artifact-name">{artifact.name}</span>
                        <span className="artifact-type">{artifact.type}</span>
                        <span className="artifact-time">{formatTime(artifact.createdAt, locale)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="artifact-preview">
            {!selectedId ? (
              <div className="empty-state">{t('artifacts.selectToPreview')}</div>
            ) : !content ? (
              <div className="empty-state">{t('common.loading')}</div>
            ) : (
              <div className="artifact-content">
                <h3>{content.name}</h3>
                <div className="artifact-content-body">
                  {typeof content.content === 'string' ? (
                    <SafeMarkdown content={content.content} locale={locale} />
                  ) : (
                    <pre>{JSON.stringify(content.content, null, 2)}</pre>
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
