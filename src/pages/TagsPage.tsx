import { useState, useMemo } from 'react';
import { useMetisStore, type Page } from '../store';
import { useTranslation } from '../i18n';
import ConfirmDialog from '../components/ConfirmDialog';

interface TagsPageProps {
  onNavigate: (page: Page) => void;
}

export default function TagsPage({ onNavigate }: TagsPageProps) {
  const { t } = useTranslation();
  const {
    papers, notes, experiments,
    renameTag, mergeTags, deleteTag,
    setPaperFilter,
  } = useMetisStore();

  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [mergingTag, setMergingTag] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => p.tags.forEach((tag) => set.add(tag)));
    notes.forEach((n) => n.tags.forEach((tag) => set.add(tag)));
    experiments.forEach((e) => e.tags.forEach((tag) => set.add(tag)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [papers, notes, experiments]);

  const tagStats = useMemo(() => {
    const stats = new Map<string, { papers: number; notes: number; experiments: number }>();
    const inc = (tag: string, key: 'papers' | 'notes' | 'experiments') => {
      const current = stats.get(tag) ?? { papers: 0, notes: 0, experiments: 0 };
      current[key] += 1;
      stats.set(tag, current);
    };
    papers.forEach((p) => p.tags.forEach((tag) => inc(tag, 'papers')));
    notes.forEach((n) => n.tags.forEach((tag) => inc(tag, 'notes')));
    experiments.forEach((e) => e.tags.forEach((tag) => inc(tag, 'experiments')));
    return stats;
  }, [papers, notes, experiments]);

  const handleOpenPapers = (tag: string) => {
    setPaperFilter({ tag, query: '' });
    onNavigate('papers');
  };

  const startRename = (tag: string) => {
    setEditingTag(tag);
    setEditValue(tag);
    setError(null);
  };

  const handleRename = async (oldTag: string) => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      setError(t('tags.nameRequired'));
      return;
    }
    await renameTag(oldTag, trimmed);
    setEditingTag(null);
    setEditValue('');
    setError(null);
  };

  const startMerge = (tag: string) => {
    setMergingTag(tag);
    setMergeTarget('');
    setError(null);
  };

  const handleMerge = async (sourceTag: string) => {
    const trimmed = mergeTarget.trim();
    if (!trimmed) {
      setError(t('tags.nameRequired'));
      return;
    }
    if (trimmed === sourceTag) {
      setError(t('tags.duplicateName'));
      return;
    }
    await mergeTags(sourceTag, trimmed);
    setMergingTag(null);
    setMergeTarget('');
    setError(null);
  };

  const handleDelete = async (tag: string) => {
    await deleteTag(tag);
    setDeleteTagName(null);
  };

  return (
    <div className="tags-page" style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 20px' }}>{t('tags.title')}</h1>

      {error && (
        <div style={{ color: 'var(--danger, #e53e3e)', fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {allTags.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 14, padding: '32px 0' }}>
          {t('tags.empty')}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {allTags.map((tag) => {
            const stats = tagStats.get(tag) ?? { papers: 0, notes: 0, experiments: 0 };
            const total = stats.papers + stats.notes + stats.experiments;
            const isEditing = editingTag === tag;
            const isMerging = mergingTag === tag;
            const listId = `merge-targets-${tag.replace(/\s+/g, '_')}`;

            return (
              <div
                key={tag}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 16,
                  background: 'var(--bg-secondary)',
                }}
              >
                {isEditing ? (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(tag);
                        if (e.key === 'Escape') setEditingTag(null);
                      }}
                      className="search-input"
                      style={{ flex: '1 1 200px' }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="btn-sm btn-primary"
                      onClick={() => void handleRename(tag)}
                    >
                      {t('common.save')}
                    </button>
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      onClick={() => setEditingTag(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : isMerging ? (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={mergeTarget}
                      onChange={(e) => setMergeTarget(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleMerge(tag);
                        if (e.key === 'Escape') setMergingTag(null);
                      }}
                      placeholder={t('tags.mergePlaceholder')}
                      className="search-input"
                      style={{ flex: '1 1 200px' }}
                      list={listId}
                      autoFocus
                    />
                    <datalist id={listId}>
                      {allTags
                        .filter((t) => t !== tag)
                        .map((t) => (
                          <option key={t} value={t} />
                        ))}
                    </datalist>
                    <button
                      type="button"
                      className="btn-sm btn-primary"
                      onClick={() => void handleMerge(tag)}
                    >
                      {t('tags.merge')}
                    </button>
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      onClick={() => setMergingTag(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div
                        role="button"
                        tabIndex={0}
                        style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, cursor: 'pointer' }}
                        onClick={() => handleOpenPapers(tag)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') handleOpenPapers(tag);
                        }}
                      >
                        {tag}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {t('tags.itemCount', { count: total })}
                        {stats.papers > 0 && ` · ${t('tags.paperCount', { count: stats.papers })}`}
                        {stats.notes > 0 && ` · ${t('tags.noteCount', { count: stats.notes })}`}
                        {stats.experiments > 0 && ` · ${t('tags.experimentCount', { count: stats.experiments })}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn-sm btn-primary"
                        onClick={() => handleOpenPapers(tag)}
                      >
                        {t('tags.filterPapers')}
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-secondary"
                        onClick={() => startRename(tag)}
                      >
                        {t('tags.rename')}
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-secondary"
                        onClick={() => startMerge(tag)}
                      >
                        {t('tags.merge')}
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-danger"
                        onClick={() => setDeleteTagName(tag)}
                      >
                        {t('tags.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {deleteTagName && (
        <ConfirmDialog
          title={t('tags.deleteConfirmTitle')}
          message={t('tags.deleteConfirm', { tag: deleteTagName })}
          confirmLabel={t('tags.delete')}
          cancelLabel={t('common.cancel')}
          onConfirm={() => void handleDelete(deleteTagName)}
          onCancel={() => setDeleteTagName(null)}
        />
      )}
    </div>
  );
}
