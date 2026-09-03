/**
 * LibraryPage — 项目资料 / 文献管理（LIT-SEARCH-01）。
 *
 * 作为科研项目页「资料」模式的内容（也可独立渲染）：
 * - 上半区：内置文献检索（中文 NCPSSD / 英文 OpenAlex，默认核心期刊过滤）
 *   → 一键导入并关联当前项目（写入 project_id + 项目资料源，AI 可读）。
 * - 下半区：项目文献完整管理 —— 题录详情、编辑、收藏、阅读状态、
 *   内嵌浏览器打开原文（登录 NCPSSD 手动下载，PDF 自动归入项目工作空间）、
 *   删除、搜索筛选排序；有本地 PDF 的条目进入阅读器。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMetisStore, findDuplicatePaper } from '../store';
import type { PaperItem, ReadStatus } from '../../engine/research/PaperItem';
import { cleanPaperRecord } from '../../engine/research/PaperRecordCleaner';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import EmbeddedBrowserOverlay from '../components/EmbeddedBrowserOverlay';
import JobsIndicator from '../components/JobsIndicator';
import MethodsPanel from '../components/MethodsPanel';
import NotesPanel from '../components/NotesPanel';
import PdfReaderPage from './PdfReaderPage';
import './LibraryPage.css';

type SourceId = 'ncpssd' | 'openalex';

interface SearchItem {
  id: string;
  source: SourceId;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  doi?: string;
  url?: string;
  pdfUrl?: string;
  citationCount?: number;
  tags: string[];
  core: boolean;
}

interface LibraryPageProps {
  uiMode?: import('../../engine/capabilities/DiagnosticMode').UIMode;
  /** 项目资料模式：只显示并导入到该项目。 */
  projectId?: string | null;
}

type SortKey = 'added' | 'year' | 'title';
type StatusFilter = 'all' | 'unread' | 'reading' | 'read';

interface EditDraft {
  title: string;
  authors: string;
  year: string;
  venue: string;
  doi: string;
  tags: string;
  notes: string;
  readStatus: ReadStatus;
  rating: string;
}

function makePaperId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `paper-${crypto.randomUUID()}`;
    }
  } catch { /* fall through */ }
  return `paper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 原文入口：优先采集时的来源链接，其次 DOI 跳转。 */
function sourceLinkOf(paper: PaperItem): string | undefined {
  if (paper.pdfUrl) return paper.pdfUrl;
  if (paper.url) return paper.url;
  if (paper.doi) return `https://doi.org/${paper.doi}`;
  return undefined;
}

const STATUS_I18N: Record<ReadStatus, string> = {
  unread: 'library.statusUnread',
  reading: 'library.statusReading',
  read: 'library.statusRead',
  skimmed: 'library.statusSkimmed',
};

export default function LibraryPage({ uiMode = 'normal', projectId = null }: LibraryPageProps) {
  const { t, locale } = useTranslation();
  const zh = locale === 'zh';
  const papers = useMetisStore((state) => state.papers);
  const selectedPaperId = useMetisStore((state) => state.selectedPaperId);
  const setSelectedPaperId = useMetisStore((state) => state.setSelectedPaperId);
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  // 导入归属：显式传入的项目优先，其次当前激活项目。
  const targetProjectId = projectId ?? activeProjectId ?? null;

  const [query, setQuery] = useState('');
  const [useNcpssd, setUseNcpssd] = useState(true);
  const [useOpenalex, setUseOpenalex] = useState(true);
  const [coreOnly, setCoreOnly] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [results, setResults] = useState<SearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 30;

  const [filterQuery, setFilterQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('added');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [browseUrl, setBrowseUrl] = useState<string | null>(null);
  const [methodsOpen, setMethodsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchList, setWatchList] = useState<Array<{ id: string; query: string; lastCheckedAt: number | null; lastNewCount: number }>>([]);
  const [watchQuery, setWatchQuery] = useState('');
  const [watchNotice, setWatchNotice] = useState('');

  const reloadWatch = useCallback(async () => {
    const list = await window.metis?.listWatchSubscriptions?.();
    if (Array.isArray(list)) setWatchList(list);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.metis?.listWatchSubscriptions?.().then((list) => {
      if (alive && Array.isArray(list)) setWatchList(list);
    });
    return () => { alive = false; };
  }, []);

  const addWatch = useCallback(async () => {
    const created = await window.metis?.addWatchSubscription?.({ query: watchQuery });
    if (created) {
      setWatchQuery('');
      setWatchNotice(t('library.watchAdded'));
      void reloadWatch();
    } else {
      setWatchNotice(t('library.watchDuplicate'));
    }
  }, [watchQuery, t, reloadWatch]);

  const importPdfs = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.openPdfDialog || !metis.importPdfFiles) return;
    const files = await metis.openPdfDialog();
    if (files.length === 0) return;
    const result = await metis.importPdfFiles(files);
    setWatchNotice(t('library.importedNotice', { count: result.imported, enriched: result.enriched }));
  }, [t]);

  // 项目资料模式：只看关联到该项目的文献。
  const scopedPapers = useMemo(
    () => (projectId ? papers.filter((paper) => paper.projectId === projectId || (paper.projectIds ?? []).includes(projectId)) : papers),
    [papers, projectId],
  );

  const sortedPapers = useMemo(() => {
    const list = [...scopedPapers];
    if (sortKey === 'year') {
      list.sort((a, b) => (b.year || 0) - (a.year || 0) || b.addedAt - a.addedAt);
    } else if (sortKey === 'title') {
      list.sort((a, b) => a.title.localeCompare(b.title, locale));
    } else {
      list.sort((a, b) => b.addedAt - a.addedAt);
    }
    return list;
  }, [scopedPapers, sortKey, locale]);

  const visiblePapers = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return sortedPapers.filter((paper) => {
      if (statusFilter === 'unread' && paper.readStatus !== 'unread' && paper.readStatus !== 'skimmed') return false;
      if ((statusFilter === 'reading' || statusFilter === 'read') && paper.readStatus !== statusFilter) return false;
      if (!q) return true;
      const haystack = [paper.title, paper.authors.join(' '), paper.venue, ...(paper.tags ?? [])]
        .join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedPapers, filterQuery, statusFilter]);

  const readingPaper = selectedPaperId ? papers.find((paper) => paper.id === selectedPaperId) ?? null : null;
  const detailPaper = detailId ? papers.find((paper) => paper.id === detailId) ?? null : null;

  const runSearch = useCallback(async (targetPage = 1) => {
    const metis = window.metis;
    const term = query.trim();
    if (!term || searching) return;
    const sources: SourceId[] = [];
    if (useNcpssd) sources.push('ncpssd');
    if (useOpenalex) sources.push('openalex');
    if (sources.length === 0) {
      setSearchError(t('library.noSourceSelected'));
      return;
    }
    if (!metis?.literatureSearch) {
      setSearchError(t('library.searchUnavailable'));
      return;
    }
    setSearching(true);
    setSearchError('');
    setWarnings([]);
    try {
      const response = await metis.literatureSearch({ query: term, sources, page: targetPage, pageSize: PAGE_SIZE, coreOnly });
      if (!response.ok) {
        setSearchError(t('library.searchFailed'));
        setResults([]);
        setTotal(0);
        return;
      }
      setResults((response.results ?? []) as SearchItem[]);
      setTotal(response.total ?? 0);
      setWarnings(response.warnings ?? []);
      setPage(targetPage);
    } catch {
      setSearchError(t('library.searchFailed'));
    } finally {
      setSearching(false);
    }
  }, [query, searching, useNcpssd, useOpenalex, coreOnly, t]);

  const importItem = useCallback(async (item: SearchItem) => {
    const store = useMetisStore.getState();
    const saved = await store.addPaper({
      id: makePaperId(),
      title: item.title,
      authors: item.authors,
      year: item.year,
      venue: item.venue,
      abstract: item.abstract,
      ...(item.doi ? { doi: item.doi } : {}),
      ...(item.pdfUrl ? { pdfUrl: item.pdfUrl } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.citationCount !== undefined ? { citationCount: item.citationCount } : {}),
      tags: item.tags,
      notes: '',
      readStatus: 'unread',
      rating: 0,
      referenceIds: [],
      addedAt: Date.now(),
      ...(targetProjectId ? { projectId: targetProjectId } : {}),
    } as never);
    // 双写项目资料源：让研究对话/自主科研的资料工具能读到这篇文献。
    if (targetProjectId && saved?.paper?.id) {
      await window.metis?.linkPaperToProject?.({ paperId: saved.paper.id, projectId: targetProjectId, link: true });
    }
    setImportedIds((current) => new Set([...current, item.id]));
  }, [targetProjectId]);

  /** 在内嵌浏览器浮层中打开原文页（登录/手动下载都在浮层内完成）。 */
  const openInBrowser = useCallback((url: string | undefined) => {
    if (!url) return;
    setBrowseUrl(url);
  }, []);

  const openDetail = useCallback((paperId: string) => {
    setDetailId(paperId);
    setEditing(false);
    setDraft(null);
    setConfirmDeleteId(null);
  }, []);

  // ─── T15 文献质量治理：确定性题录清理 / 项目认领 / 重复合并 ───

  const cleanablePapers = useMemo(
    () => scopedPapers.filter((paper) => cleanPaperRecord(paper).changes.length > 0),
    [scopedPapers],
  );

  const cleanSingle = useCallback(async (paper: PaperItem) => {
    const result = cleanPaperRecord(paper);
    if (result.changes.length === 0) return;
    await useMetisStore.getState().updatePaper(paper.id, {
      title: result.title,
      abstract: result.abstract,
    });
  }, []);

  const cleanAll = useCallback(async () => {
    for (const paper of cleanablePapers) {
      await cleanSingle(paper);
    }
  }, [cleanablePapers, cleanSingle]);

  const linkToProject = useCallback(async (paper: PaperItem) => {
    if (!targetProjectId) return;
    await useMetisStore.getState().updatePaper(paper.id, { projectId: targetProjectId });
    await window.metis?.linkPaperToProject?.({ paperId: paper.id, projectId: targetProjectId, link: true });
  }, [targetProjectId]);

  /** 对列表做一次重复检测：返回 每篇疑似重复的对方条目。 */
  const duplicateMap = useMemo(() => {
    const map = new Map<string, PaperItem>();
    for (const paper of scopedPapers) {
      // findDuplicatePaper 会把自身计入标题匹配，先排除自身。
      const dup = findDuplicatePaper(scopedPapers.filter((p) => p.id !== paper.id), paper);
      if (dup && (dup.doi || dup.year || dup.title.length > 8)) {
        // 只报"更早入库"一侧为保留方，避免同对条目互相提示两次。
        if (dup.addedAt < paper.addedAt) map.set(paper.id, dup);
      }
    }
    return map;
  }, [scopedPapers]);

  const mergeWithDuplicate = useCallback(async (paper: PaperItem, dup: PaperItem) => {
    await useMetisStore.getState().mergePapers(dup.id, paper.id);
    if (detailId === paper.id) setDetailId(null);
  }, [detailId]);

  const startEdit = useCallback((paper: PaperItem) => {
    setDraft({
      title: paper.title,
      authors: paper.authors.join(zh ? '；' : '; '),
      year: paper.year ? String(paper.year) : '',
      venue: paper.venue,
      doi: paper.doi ?? '',
      tags: (paper.tags ?? []).filter((tag) => tag !== 'collected').join(zh ? '；' : '; '),
      notes: paper.notes ?? '',
      readStatus: paper.readStatus,
      rating: String(paper.rating ?? 0),
    });
    setEditing(true);
  }, [zh]);

  const saveEdit = useCallback(async () => {
    if (!detailPaper || !draft) return;
    const yearText = draft.year.trim();
    await useMetisStore.getState().updatePaper(detailPaper.id, {
      title: draft.title.trim() || detailPaper.title,
      authors: draft.authors.split(/[;；,，]/u).map((name) => name.trim()).filter(Boolean),
      year: /^\d{4}$/u.test(yearText) ? Number(yearText) : 0,
      venue: draft.venue.trim(),
      doi: draft.doi.trim() || undefined,
      tags: draft.tags.split(/[;；,，]/u).map((tag) => tag.trim()).filter(Boolean),
      notes: draft.notes,
      readStatus: draft.readStatus,
      rating: Math.max(0, Math.min(5, Number(draft.rating) || 0)),
    });
    setEditing(false);
    setDraft(null);
  }, [detailPaper, draft]);

  const removePaper = useCallback(async (paperId: string) => {
    await useMetisStore.getState().removePaper(paperId);
    if (detailId === paperId) {
      setDetailId(null);
      setEditing(false);
      setDraft(null);
    }
    setConfirmDeleteId(null);
  }, [detailId]);

  return (
    <div className="library-page" data-testid="library-page">
      <section className="library-search" aria-label={zh ? '文献检索' : 'Literature search'}>
        <div className="library-search__row">
          <input
            className="settings-input library-search__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }}
            placeholder={t('library.searchPlaceholder')}
            aria-label={t('library.searchPlaceholder')}
            data-testid="library-search-input"
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void runSearch()}
            disabled={searching || !query.trim()}
            data-testid="library-search-submit"
          >
            {searching ? t('library.searching') : t('library.searchAction')}
          </button>
        </div>
        <div className="library-search__options">
          <label className="library-search__check">
            <input type="checkbox" checked={useNcpssd} onChange={(e) => setUseNcpssd(e.target.checked)} data-testid="library-source-ncpssd" />
            {t('library.sourceNcpssd')}
          </label>
          <label className="library-search__check">
            <input type="checkbox" checked={useOpenalex} onChange={(e) => setUseOpenalex(e.target.checked)} data-testid="library-source-openalex" />
            {t('library.sourceOpenalex')}
          </label>
          <label className="library-search__check library-search__check--core">
            <input type="checkbox" checked={coreOnly} onChange={(e) => setCoreOnly(e.target.checked)} data-testid="library-core-only" />
            {t('library.coreOnly')}
          </label>
        </div>
        <p className="library-search__hint">{t('library.searchHint')}</p>

        {searchError && <div className="library-search__error" role="alert" data-testid="library-search-error">{searchError}</div>}
        {warnings.length > 0 && (
          <div className="library-search__warnings" role="status">
            {t('library.partialFailure')}: {warnings.join('；')}
          </div>
        )}

        {results.length > 0 && (
          <div className="library-results" data-testid="library-results">
            <div className="library-results__meta">
              {t('library.resultCount', { count: results.length, total })}
              <span className="library-results__page">{t('library.pageInfo', { page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) })}</span>
            </div>
            <ul className="library-results__list">
              {results.map((item) => (
                <li key={item.id} className="library-result" data-testid="library-result">
                  <div className="library-result__main">
                    <span className="library-result__title">{item.title}</span>
                    <span className="library-result__meta">
                      {item.authors.slice(0, 3).join('、')}
                      {item.year ? ` · ${item.year}` : ''}
                      {item.venue ? ` · ${item.venue}` : ''}
                    </span>
                    <span className="library-result__badges">
                      <span className={`library-result__source library-result__source--${item.source}`}>
                        {item.source === 'ncpssd' ? 'NCPSSD' : 'OpenAlex'}
                      </span>
                      {item.core && <span className="library-result__core">{t('library.coreBadge')}</span>}
                      {item.pdfUrl && <span className="library-result__pdf">{t('library.pdfAvailable')}</span>}
                    </span>
                    {item.abstract && (
                      <p className="library-result__abstract" data-testid="library-result-abstract">{item.abstract.slice(0, 200)}{item.abstract.length > 200 ? '…' : ''}</p>
                    )}
                  </div>
                  <div className="library-result__actions">
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => void importItem(item)}
                      disabled={importedIds.has(item.id)}
                      data-testid="library-import"
                    >
                      {importedIds.has(item.id) ? t('library.imported') : t('library.import')}
                    </button>
                    {item.url && (
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => openInBrowser(item.url)}
                        data-testid="library-open-detail"
                      >
                        {t('library.openDetail')}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="library-results__pagination" data-testid="library-pagination">
              <button
                type="button"
                className="btn-sm btn-secondary"
                disabled={searching || page <= 1}
                onClick={() => void runSearch(page - 1)}
                data-testid="library-page-prev"
              >
                {t('library.prevPage')}
              </button>
              <span className="library-results__page-num">{t('library.pageInfo', { page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) })}</span>
              <button
                type="button"
                className="btn-sm btn-secondary"
                disabled={searching || page * PAGE_SIZE >= total}
                onClick={() => void runSearch(page + 1)}
                data-testid="library-page-next"
              >
                {t('library.nextPage')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="library-mine" aria-label={zh ? '我的文献' : 'My library'}>
        <div className="library-mine__heading">
          <h2 className="library-mine__title">{t('library.mineTitle')}</h2>
          <JobsIndicator />
          <button
            type="button"
            className="btn-sm btn-secondary"
            title={t('methods.hint')}
            onClick={() => setMethodsOpen(true)}
            data-testid="library-methods-open"
          >
            {t('methods.entryButton')}
          </button>
          <button
            type="button"
            className="btn-sm btn-secondary"
            title={t('notesPanel.hint')}
            onClick={() => setNotesOpen(true)}
            data-testid="library-notes-open"
          >
            {t('notesPanel.entryButton')}
          </button>
          <button
            type="button"
            className="btn-sm btn-secondary"
            title={t('library.extractHint')}
            onClick={() => void window.metis?.extractBacklog?.()}
            data-testid="library-extract-all"
          >
            {t('library.extractAll')}
          </button>
          <button
            type="button"
            className="btn-sm btn-secondary"
            title={t('library.importPdfHint')}
            onClick={() => void importPdfs()}
            data-testid="library-import-pdf"
          >
            {t('library.importPdf')}
          </button>
          <button
            type="button"
            className="btn-sm btn-secondary"
            title={t('library.watchHint')}
            onClick={() => setWatchOpen((v) => !v)}
            data-testid="library-watch-toggle"
          >
            {t('library.watch')}
          </button>
        </div>

        {watchNotice && <div className="library-search__warnings" role="status" data-testid="library-watch-notice">{watchNotice}</div>}

        {watchOpen && (
          <div className="library-watch" data-testid="library-watch-panel">
            <div className="library-watch__row">
              <input
                className="settings-input library-watch__input"
                value={watchQuery}
                placeholder={t('library.watchPlaceholder')}
                onChange={(event) => setWatchQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void addWatch(); }}
                data-testid="library-watch-input"
              />
              <button type="button" className="btn-sm btn-primary" onClick={() => void addWatch()} data-testid="library-watch-add">{t('library.watchAdd')}</button>
            </div>
            {watchList.length > 0 && (
              <ul className="library-watch__list">
                {watchList.map((item) => (
                  <li key={item.id} className="library-watch__item" data-testid="library-watch-item">
                    <span className="library-watch__query">{item.query}</span>
                    <span className="library-watch__meta">
                      {item.lastCheckedAt
                        ? t('library.watchMeta', { count: item.lastNewCount, time: new Date(item.lastCheckedAt).toLocaleDateString(locale) })
                        : t('library.watchNeverChecked')}
                    </span>
                    <button type="button" className="btn-sm btn-secondary" onClick={() => void window.metis?.checkWatchNow?.(item.id)} data-testid="library-watch-check">{t('library.watchCheckNow')}</button>
                    <button type="button" className="btn-sm btn-secondary" onClick={() => void window.metis?.removeWatchSubscription?.(item.id).then(() => reloadWatch())}>{t('library.actionDelete')}</button>
                  </li>
                ))}
              </ul>
            )}
            {watchList.length === 0 && <p className="library-watch__empty">{t('library.watchEmpty')}</p>}
          </div>
        )}

        {readingPaper ? (
          <div className="library-reader">
            <div className="library-reader__bar">
              <button
                type="button"
                className="btn-sm btn-secondary"
                onClick={() => setSelectedPaperId(null)}
                data-testid="library-reader-back"
              >
                ← {t('library.backToList')}
              </button>
              <span className="library-reader__title">{readingPaper.title}</span>
            </div>
            <PdfReaderPage uiMode={uiMode} openPaperId={selectedPaperId} />
          </div>
        ) : (
          <>
            <div className="library-mine__toolbar" data-testid="library-toolbar">
              <input
                className="settings-input library-mine__filter"
                value={filterQuery}
                onChange={(event) => setFilterQuery(event.target.value)}
                placeholder={t('library.mineSearch')}
                aria-label={t('library.mineSearch')}
                data-testid="library-filter-input"
              />
              <select
                className="settings-input library-mine__select"
                value={sortKey}
                onChange={(event) => setSortKey(event.target.value as SortKey)}
                aria-label={t('library.sortLabel')}
                data-testid="library-sort-select"
              >
                <option value="added">{t('library.sortAdded')}</option>
                <option value="year">{t('library.sortYear')}</option>
                <option value="title">{t('library.sortTitle')}</option>
              </select>
              <select
                className="settings-input library-mine__select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                aria-label={t('library.filterStatusLabel')}
                data-testid="library-status-select"
              >
                <option value="all">{t('library.filterAll')}</option>
                <option value="unread">{t('library.filterUnread')}</option>
                <option value="reading">{t('library.filterReading')}</option>
                <option value="read">{t('library.filterRead')}</option>
              </select>
              <span className="library-mine__count">{t('library.paperCount', { count: visiblePapers.length })}</span>
              {cleanablePapers.length > 0 && (
                <button
                  type="button"
                  className="btn-sm btn-secondary"
                  onClick={() => void cleanAll()}
                  title={t('library.cleanHint', { count: cleanablePapers.length })}
                  data-testid="library-clean-all"
                >
                  {t('library.cleanAll')}
                </button>
              )}
            </div>

            {detailPaper && (
              <article className="library-detail" data-testid="library-detail">
                <header className="library-detail__header">
                  <h3 className="library-detail__title">{detailPaper.title}</h3>
                  <button
                    type="button"
                    className="library-detail__close"
                    onClick={() => { setDetailId(null); setEditing(false); setDraft(null); }}
                    aria-label={t('library.closeDetail')}
                    data-testid="library-detail-close"
                  >
                    ✕
                  </button>
                </header>

                {editing && draft ? (
                  <div className="library-detail__form" data-testid="library-edit-form">
                    <label className="library-edit__field">
                      <span>{t('library.fieldTitle')}</span>
                      <input className="settings-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="library-edit-title" />
                    </label>
                    <label className="library-edit__field">
                      <span>{t('library.fieldAuthors')}</span>
                      <input className="settings-input" value={draft.authors} onChange={(e) => setDraft({ ...draft, authors: e.target.value })} data-testid="library-edit-authors" />
                    </label>
                    <div className="library-edit__row">
                      <label className="library-edit__field">
                        <span>{t('library.fieldYear')}</span>
                        <input className="settings-input" inputMode="numeric" value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} data-testid="library-edit-year" />
                      </label>
                      <label className="library-edit__field">
                        <span>{t('library.fieldVenue')}</span>
                        <input className="settings-input" value={draft.venue} onChange={(e) => setDraft({ ...draft, venue: e.target.value })} data-testid="library-edit-venue" />
                      </label>
                    </div>
                    <div className="library-edit__row">
                      <label className="library-edit__field">
                        <span>{t('library.fieldDoi')}</span>
                        <input className="settings-input" value={draft.doi} onChange={(e) => setDraft({ ...draft, doi: e.target.value })} data-testid="library-edit-doi" />
                      </label>
                      <label className="library-edit__field">
                        <span>{t('library.fieldRating')}</span>
                        <input className="settings-input" inputMode="numeric" value={draft.rating} onChange={(e) => setDraft({ ...draft, rating: e.target.value })} data-testid="library-edit-rating" />
                      </label>
                    </div>
                    <label className="library-edit__field">
                      <span>{t('library.fieldTags')}</span>
                      <input className="settings-input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} data-testid="library-edit-tags" />
                    </label>
                    <label className="library-edit__field">
                      <span>{t('library.fieldStatus')}</span>
                      <select
                        className="settings-input"
                        value={draft.readStatus}
                        onChange={(e) => setDraft({ ...draft, readStatus: e.target.value as ReadStatus })}
                        data-testid="library-edit-status"
                      >
                        <option value="unread">{t('library.statusUnread')}</option>
                        <option value="reading">{t('library.statusReading')}</option>
                        <option value="read">{t('library.statusRead')}</option>
                        <option value="skimmed">{t('library.statusSkimmed')}</option>
                      </select>
                    </label>
                    <label className="library-edit__field">
                      <span>{t('library.fieldNotes')}</span>
                      <textarea className="settings-input library-edit__notes" rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} data-testid="library-edit-notes" />
                    </label>
                    <div className="library-detail__actions">
                      <button type="button" className="btn-primary btn-sm" onClick={() => void saveEdit()} data-testid="library-edit-save">{t('library.actionSave')}</button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => { setEditing(false); setDraft(null); }} data-testid="library-edit-cancel">{t('library.actionCancel')}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <dl className="library-detail__fields">
                      <div className="library-detail__field">
                        <dt>{t('library.fieldAuthors')}</dt>
                        <dd>{detailPaper.authors.length > 0 ? detailPaper.authors.join(zh ? '；' : '; ') : t('library.noAuthors')}</dd>
                      </div>
                      <div className="library-detail__field">
                        <dt>{t('library.fieldYear')}</dt>
                        <dd>{detailPaper.year || t('library.unknown')}</dd>
                      </div>
                      <div className="library-detail__field">
                        <dt>{t('library.fieldVenue')}</dt>
                        <dd>{detailPaper.venue || t('library.unknown')}</dd>
                      </div>
                      {detailPaper.doi && (
                        <div className="library-detail__field">
                          <dt>DOI</dt>
                          <dd>{detailPaper.doi}</dd>
                        </div>
                      )}
                      <div className="library-detail__field">
                        <dt>{t('library.fieldStatus')}</dt>
                        <dd><span className={`library-status library-status--${detailPaper.readStatus}`}>{t(STATUS_I18N[detailPaper.readStatus])}</span></dd>
                      </div>
                      <div className="library-detail__field">
                        <dt>{t('library.fieldRating')}</dt>
                        <dd>{detailPaper.rating > 0 ? '★'.repeat(Math.min(5, detailPaper.rating)) : t('library.unknown')}</dd>
                      </div>
                      <div className="library-detail__field">
                        <dt>{t('library.fieldAddedAt')}</dt>
                        <dd>{new Date(detailPaper.addedAt).toLocaleDateString(locale)}</dd>
                      </div>
                    </dl>
                    {detailPaper.abstract && (
                      <div className="library-detail__abstract">
                        <h4>{t('library.fieldAbstract')}</h4>
                        <p>{detailPaper.abstract}</p>
                      </div>
                    )}
                    {(detailPaper.tags ?? []).filter((tag) => tag !== 'collected').length > 0 && (
                      <div className="library-detail__tags">
                        {(detailPaper.tags ?? []).filter((tag) => tag !== 'collected').map((tag) => (
                          <span key={tag} className="library-tag">{tag}</span>
                        ))}
                      </div>
                    )}
                    {detailPaper.notes && (
                      <div className="library-detail__notes" data-testid="library-detail-notes">
                        <h4>{t('library.fieldNotes')}</h4>
                        <p>{detailPaper.notes}</p>
                      </div>
                    )}
                    <div className="library-detail__actions">
                      <button type="button" className="btn-secondary btn-sm" onClick={() => startEdit(detailPaper)} data-testid="library-detail-edit">{t('library.actionEdit')}</button>
                      {cleanPaperRecord(detailPaper).changes.length > 0 && (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => void cleanSingle(detailPaper)} data-testid="library-detail-clean">{t('library.cleanRecord')}</button>
                      )}
                      {projectId && detailPaper.projectId !== projectId && (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => void linkToProject(detailPaper)} data-testid="library-detail-link">{t('library.linkToProject')}</button>
                      )}
                      {duplicateMap.has(detailPaper.id) && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          title={t('library.duplicateWith', { title: duplicateMap.get(detailPaper.id)!.title })}
                          onClick={() => void mergeWithDuplicate(detailPaper, duplicateMap.get(detailPaper.id)!)}
                          data-testid="library-detail-merge"
                        >
                          {t('library.mergeAction')}
                        </button>
                      )}
                      {detailPaper.pdfCapability && (
                        <button type="button" className="btn-primary btn-sm" onClick={() => setSelectedPaperId(detailPaper.id)} data-testid="library-detail-read">{t('library.actionReadPdf')}</button>
                      )}
                      {sourceLinkOf(detailPaper) && (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => openInBrowser(sourceLinkOf(detailPaper)!)} data-testid="library-detail-source">{t('library.actionOpenSource')}</button>
                      )}
                      <button
                        type="button"
                        className={`btn-sm ${detailPaper.starred ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => void useMetisStore.getState().togglePaperStar(detailPaper.id)}
                        data-testid="library-detail-star"
                      >
                        {detailPaper.starred ? t('library.actionUnstar') : t('library.actionStar')}
                      </button>
                      {confirmDeleteId === detailPaper.id ? (
                        <>
                          <button type="button" className="btn-danger btn-sm" onClick={() => void removePaper(detailPaper.id)} data-testid="library-delete-confirm">{t('library.confirmDelete')}</button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirmDeleteId(null)}>{t('library.actionCancel')}</button>
                        </>
                      ) : (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirmDeleteId(detailPaper.id)} data-testid="library-detail-delete">{t('library.actionDelete')}</button>
                      )}
                    </div>
                  </>
                )}
              </article>
            )}

            {scopedPapers.length === 0 ? (
              <div className="library-mine__empty" data-testid="library-empty">
                <p className="library-mine__empty-title">{t('library.emptyTitle')}</p>
                <p className="library-mine__empty-body">{projectId ? t('library.emptyProjectBody') : t('library.emptyBody')}</p>
              </div>
            ) : visiblePapers.length === 0 ? (
              <div className="library-mine__empty" data-testid="library-empty">
                <p className="library-mine__empty-body">{t('library.noMatch')}</p>
              </div>
            ) : (
              <ul className="library-mine__list" data-testid="library-papers-list">
                {visiblePapers.map((paper) => (
                  <li
                    key={paper.id}
                    className={`library-mine__item${detailId === paper.id ? ' library-mine__item--active' : ''}`}
                    data-testid="library-paper-item"
                  >
                    <button
                      type="button"
                      className="library-mine__open"
                      onClick={() => openDetail(paper.id)}
                      data-testid="library-paper-open"
                    >
                      {paper.starred && <span className="library-mine__star" aria-label={t('library.actionStar')}>★</span>}
                      <span className="library-mine__paper-title">{paper.title}</span>
                      <span className={`library-status library-status--${paper.readStatus}`}>{t(STATUS_I18N[paper.readStatus])}</span>
                    </button>
                    <div className="library-mine__meta">
                      {paper.authors.length > 0 ? paper.authors.slice(0, 3).join(zh ? '、' : ', ') : t('library.noAuthors')}
                      {paper.year ? ` · ${paper.year}` : ''}
                      {paper.venue ? ` · ${paper.venue}` : ''}
                    </div>
                    {(paper.tags ?? []).filter((tag) => tag !== 'collected').length > 0 && (
                      <div className="library-mine__tags">
                        {(paper.tags ?? []).filter((tag) => tag !== 'collected').slice(0, 6).map((tag) => (
                          <span key={tag} className="library-tag">{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className="library-mine__row-actions">
                      {paper.pdfCapability && (
                        <button type="button" className="btn-sm btn-primary" onClick={() => setSelectedPaperId(paper.id)} data-testid="library-paper-read">
                          {t('library.actionReadPdf')}
                        </button>
                      )}
                      {sourceLinkOf(paper) && (
                        <button type="button" className="btn-sm btn-secondary" onClick={() => openInBrowser(sourceLinkOf(paper)!)} data-testid="library-paper-source">
                          {t('library.actionOpenSource')}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {browseUrl && (
        <EmbeddedBrowserOverlay url={browseUrl} onClose={() => setBrowseUrl(null)} projectId={targetProjectId} />
      )}

      {methodsOpen && (
        <MethodsPanel onClose={() => setMethodsOpen(false)} />
      )}

      {notesOpen && (
        <NotesPanel onClose={() => setNotesOpen(false)} />
      )}
    </div>
  );
}
