import { useState, useMemo } from 'react';
import { useMetisStore, type Page } from '../store';
import { useTranslation } from '../i18n';
import ConfirmDialog from '../components/ConfirmDialog';

interface CollectionsPageProps {
  onNavigate: (page: Page) => void;
}

export default function CollectionsPage({ onNavigate }: CollectionsPageProps) {
  const { t } = useTranslation();
  const {
    collections,
    papers,
    addCollection,
    updateCollection,
    removeCollection,
    selectCollection,
    setPaperFilter,
  } = useMetisStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const [deleteId, setDeleteId] = useState<string | null>(null);

  const sortedCollections = useMemo(
    () => [...collections].sort((a, b) => a.name.localeCompare(b.name)),
    [collections]
  );

  const countPapers = (collection: (typeof collections)[number]) =>
    papers.filter((p) => collection.paperIds.includes(p.id)).length;

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('collections.nameRequired'));
      return;
    }
    void addCollection({
      id: `collection_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      description: description.trim(),
      paperIds: [],
      createdAt: Date.now(),
    });
    setName('');
    setDescription('');
    setError(null);
  };

  const startEdit = (collection: (typeof collections)[number]) => {
    setEditingId(collection.id);
    setEditName(collection.name);
    setEditDescription(collection.description || '');
  };

  const handleSaveEdit = (id: string) => {
    const trimmed = editName.trim();
    if (!trimmed) return;
    void updateCollection(id, { name: trimmed, description: editDescription.trim() });
    setEditingId(null);
  };

  const openCollection = (id: string) => {
    selectCollection(id);
    setPaperFilter({ collectionId: id });
    onNavigate('papers');
  };

  const deletingCollection = deleteId
    ? collections.find((c) => c.id === deleteId) ?? null
    : null;

  return (
    <div className="collections-page" style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 20,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>{t('collections.title')}</h1>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 24,
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
          }}
          placeholder={t('collections.namePlaceholder')}
          className="search-input"
          style={{ flex: '1 1 200px', minWidth: 180 }}
        />
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
          }}
          placeholder={t('collections.descriptionPlaceholder')}
          className="search-input"
          style={{ flex: '2 1 300px', minWidth: 240 }}
        />
        <button type="button" className="btn-primary" onClick={handleCreate}>
          {t('collections.create')}
        </button>
      </div>

      {error && (
        <div style={{ color: 'var(--danger, #e53e3e)', fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {sortedCollections.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 14, padding: '32px 0' }}>
          {t('collections.empty')}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {sortedCollections.map((collection) => {
            const isEditing = editingId === collection.id;
            const paperCount = countPapers(collection);
            return (
              <div
                key={collection.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 16,
                  background: 'var(--bg-secondary)',
                }}
              >
                {isEditing ? (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit(collection.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      placeholder={t('collections.namePlaceholder')}
                      className="search-input"
                      style={{ flex: '1 1 200px' }}
                    />
                    <input
                      type="text"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit(collection.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      placeholder={t('collections.descriptionPlaceholder')}
                      className="search-input"
                      style={{ flex: '2 1 300px' }}
                    />
                    <button
                      type="button"
                      className="btn-sm btn-primary"
                      onClick={() => handleSaveEdit(collection.id)}
                    >
                      {t('collections.save')}
                    </button>
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      onClick={() => setEditingId(null)}
                    >
                      {t('collections.cancel')}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
                        {collection.name}
                      </div>
                      {collection.description && (
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                          {collection.description}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {t('collections.paperCount', { count: paperCount })}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn-sm btn-primary"
                        onClick={() => openCollection(collection.id)}
                      >
                        {t('collections.openPapers')}
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-secondary"
                        onClick={() => startEdit(collection)}
                      >
                        {t('collections.edit')}
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-danger"
                        onClick={() => setDeleteId(collection.id)}
                      >
                        {t('collections.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {deletingCollection && (
        <ConfirmDialog
          title={t('collections.deleteConfirmTitle')}
          message={t('collections.deleteConfirm', { name: deletingCollection.name })}
          confirmLabel={t('collections.delete')}
          cancelLabel={t('common.cancel')}
          onConfirm={() => {
            void removeCollection(deletingCollection.id);
            setDeleteId(null);
          }}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
