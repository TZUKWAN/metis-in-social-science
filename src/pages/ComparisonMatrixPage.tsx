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
          <button className="btn-toggle" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>

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
