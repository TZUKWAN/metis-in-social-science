/**
 * ComparisonMatrixPage — side-by-side structured comparison of library papers.
 *
 * Wires the previously-orphaned engine/research/ComparisonMatrix engine into
 * the UI: lets the user pick which papers to compare, runs the extractor, and
 * renders both an HTML table and the generated Markdown. Pure renderer-side
 * compute (no IPC, no Node deps).
 */

import { useMemo, useState } from 'react';
import { useMetisStore } from '../store';
import { useTranslation } from '../i18n';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import { getComparisonMatrix } from '@engine/research/ComparisonMatrix.js';
import './ComparisonMatrixPage.css';

interface ComparisonMatrixPageProps {
  onClose: () => void;
}

export function ComparisonMatrixPage({ onClose }: ComparisonMatrixPageProps) {
  const { papers } = useMetisStore();
  const { t, locale } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(papers.slice(0, 5).map((p) => p.id)));
  const [view, setView] = useState<'table' | 'markdown'>('table');
  // AI comparison analysis over the selected papers (main-process one-shot).
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(false);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(papers.map((p) => p.id)));
  const clearAll = () => setSelectedIds(new Set());

  const runAiCompare = async () => {
    const metis = window.metis;
    const selected = papers.filter((p) => selectedIds.has(p.id));
    if (aiLoading || !metis?.aiSynthesis || selected.length < 2) return;
    setAiLoading(true);
    setAiResult(null);
    setAiError(false);
    try {
      const result = await metis.aiSynthesis({
        mode: 'compare',
        papers: selected.map((p) => ({
          title: p.title,
          authors: p.authors,
          year: p.year,
          venue: p.venue,
          abstract: p.abstract ?? '',
        })),
      });
      if (result.ok && result.text) {
        setAiResult(result.text);
      } else {
        setAiError(true);
      }
    } catch {
      setAiError(true);
    } finally {
      setAiLoading(false);
    }
  };

  const saveAiCompareAsNote = async () => {
    if (!aiResult) return;
    const selected = papers.filter((p) => selectedIds.has(p.id));
    const noteId = `note_compare_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await useMetisStore.getState().addNote({
      id: noteId,
      title: t('comparison.aiCompareNoteTitle'),
      content: aiResult,
      tags: [t('comparison.aiCompareNoteTitle')],
      linkedPaperIds: selected.map((p) => p.id),
      linkedNoteIds: [],
      starred: false,
      updatedAt: Date.now(),
    });
    setAiResult(null);
  };

  const result = useMemo(() => {
    const selected = papers.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return null;
    return getComparisonMatrix().generate(selected);
  }, [papers, selectedIds]);

  return (
    <div className="comparison-matrix-page">
      <div className="graph-toolbar">
        <h2>{t('comparison.pageTitle')}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-toggle" onClick={selectAll}>{t('comparison.selectAll')}</button>
          <button className="btn-toggle" onClick={clearAll}>{t('comparison.clearAll')}</button>
          <button className={`btn-toggle ${view === 'table' ? 'active' : ''}`} onClick={() => setView('table')}>{t('comparison.viewTable')}</button>
          <button className={`btn-toggle ${view === 'markdown' ? 'active' : ''}`} onClick={() => setView('markdown')}>{t('comparison.viewMarkdown')}</button>
          {selectedIds.size >= 2 && (
            <button
              className="btn-toggle"
              data-testid="comparison-ai-compare"
              disabled={aiLoading}
              onClick={() => void runAiCompare()}
            >
              {aiLoading ? t('comparison.aiComparing') : t('comparison.aiCompare')}
            </button>
          )}
          <button className="btn-toggle" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>

      {aiError && (
        <div role="alert" style={{ padding: '8px 12px', margin: '8px 16px', background: 'var(--status-failed-bg)', color: 'var(--status-failed)', borderRadius: 6, fontSize: 13 }}>
          {t('comparison.aiCompareFailed')}
        </div>
      )}

      {aiResult && (
        <div className="comparison-ai-result" data-testid="comparison-ai-result" style={{ margin: '8px 16px', padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-card)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>{t('comparison.aiCompare')}</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-sm btn-primary" data-testid="comparison-ai-save-note" onClick={() => void saveAiCompareAsNote()}>
                {t('comparison.aiCompareSaveNote')}
              </button>
              <button className="btn-sm btn-secondary" onClick={() => setAiResult(null)}>{t('common.close')}</button>
            </div>
          </div>
          <SafeMarkdown content={aiResult} locale={locale} />
        </div>
      )}

      <div className="comparison-selector">
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {t('comparison.selectedCount', { count: selectedIds.size })}
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {papers.map((p) => (
            <button
              key={p.id}
              className={`btn-toggle ${selectedIds.has(p.id) ? 'active' : ''}`}
              style={{ fontSize: 11 }}
              onClick={() => toggle(p.id)}
            >
              {p.title.length > 40 ? p.title.slice(0, 40) + '...' : p.title}
            </button>
          ))}
        </div>
      </div>

      {!result ? (
        <div className="empty-state">
          <p>{t('comparison.empty')}</p>
        </div>
      ) : view === 'table' ? (
        <div className="comparison-table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                {result.columns.map((col) => <th key={col}>{col}</th>)}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={result.papers[i]?.id ?? i}>
                  {row.map((cell, j) => <td key={j}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="comparison-markdown">
          <SafeMarkdown content={result.markdown} locale={locale} />
        </div>
      )}
    </div>
  );
}
