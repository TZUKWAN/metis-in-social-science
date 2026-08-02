import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import SearchInput from '../components/SearchInput';
import ConfirmDialog from '../components/ConfirmDialog';
import { IntegrityBadge } from '../components/IntegrityBadge';
import { useMetisStore, filterPapers, findSimilarPapers, suggestTags } from '../store';
import type { ReadStatus, PaperItem, MetisState } from '../store';
import { useTranslation } from '../i18n';
import { formatCitation, type CitationFormat } from '../utils/citations.js';
import { searchPapers, getPaperRecommendations, recommendationToPlain, type SemanticScholarPaper, type CitationEdge } from '@engine/research/SemanticScholarClient.js';
import { resolveDoi } from '@engine/research/DoiResolver.js';
import { resolveArxiv } from '@engine/research/ArxivResolver.js';
import { fetchRssFeed, type RssFeedEntry } from '@engine/research/RssFeedResolver.js';
import { setPendingChatIntent } from '../lib/chatIntent.js';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode.js';
import { presentExecutionError, type PresentationLocale } from '../presentation/executionPresentation.js';
import { decodeAgentResponse } from '../../engine/runtime/ChatRuntimeContract.js';
import {
  ReactFlow, Background, Controls,
  type Node, type Edge, MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './PapersPage.css';

// ─── Lightweight BibTeX parser (mirrors engine parseBibtexString) ──

interface BibtexEntry {
  type: string;
  key: string;
  title: string;
  authors: string[];
  year: number;
  journal?: string;
  volume?: string;
  pages?: string;
  doi?: string;
  url?: string;
  abstract?: string;
}

function parseBibtex(text: string): BibtexEntry[] {
  const entries: BibtexEntry[] = [];
  const regex = /@(\w+)\s*\{([^,]*),\s*([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const type = match[1]?.toLowerCase() ?? '';
    const key = match[2]?.trim() ?? '';
    const fields = match[3] ?? '';

    const extract = (field: string): string => {
      const re = new RegExp(`${field}\\s*=\\s*[{"]([^}"]*)[}"]`, 'i');
      const m = fields.match(re);
      return m?.[1]?.trim() ?? '';
    };

    const authors = extract('author')
      .split(/\s+and\s+/)
      .map((a) => a.trim())
      .filter(Boolean);

    entries.push({
      type,
      key,
      title: extract('title'),
      authors,
      year: parseInt(extract('year'), 10) || 0,
      journal: extract('journal') || extract('booktitle') || undefined,
      volume: extract('volume') || undefined,
      pages: extract('pages') || undefined,
      doi: extract('doi') || undefined,
      url: extract('url') || undefined,
      abstract: extract('abstract') || undefined,
    });
  }

  return entries;
}

function isLikelyBibtex(text: string): boolean {
  return /@\w+\s*\{/.test(text.trim());
}

function generatePaperId(): string {
  return `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateTimestamp(): number {
  return Date.now();
}

function generateBibtexKey(paper: PaperItem): string {
  const firstAuthor = paper.authors[0]?.split(' ').pop() ?? 'unknown';
  const shortTitle = paper.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').slice(0, 3).join('');
  return `${firstAuthor.toLowerCase()}${paper.year}${shortTitle}`;
}

function paperToBibtex(paper: PaperItem): string {
  const key = generateBibtexKey(paper);
  const type = paper.venue ? 'article' : 'misc';
  const fields = [
    `  title={${paper.title}}`,
    `  author={${paper.authors.join(' and ')}}`,
    `  year={${paper.year}}`,
  ];
  if (paper.venue) fields.push(`  journal={${paper.venue}}`);
  if (paper.doi) fields.push(`  doi={${paper.doi}}`);
  if (paper.arxivId) fields.push(`  eprint={${paper.arxivId}}`);
  return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}

function papersToCsv(papers: PaperItem[]): string {
  const headers = ['title', 'authors', 'year', 'venue', 'doi', 'arxivId', 'tags', 'readStatus', 'rating', 'priority', 'deadline', 'abstract'];
  const rows = papers.map((p) => [
    JSON.stringify(p.title),
    JSON.stringify(p.authors.join('; ')),
    p.year,
    JSON.stringify(p.venue),
    JSON.stringify(p.doi ?? ''),
    JSON.stringify(p.arxivId ?? ''),
    JSON.stringify(p.tags.join('; ')),
    JSON.stringify(p.readStatus),
    p.rating,
    JSON.stringify(p.priority ?? ''),
    JSON.stringify(p.deadline ?? ''),
    JSON.stringify(p.abstract),
  ]);
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

function exportCitationsText(papers: PaperItem[], format: CitationFormat): string {
  return papers.map((p) => formatCitation(p, format)).join('\n\n');
}

function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function extractDoi(text: string): string | null {
  const trimmed = text.trim();
  // https://doi.org/10.xxx/xxx or doi:10.xxx/xxx or bare 10.xxx/xxx
  const match = trimmed.match(/(?:https?:\/\/doi\.org\/)?(?:doi:\s*)?(10\.\d{4,}(?:\.\d+)*\/\S+)/i);
  return match?.[1] ?? null;
}

function extractArxivId(text: string): string | null {
  const trimmed = text.trim();
  const urlMatch = trimmed.match(/(?:arxiv\.org\/(?:abs|pdf)\/|ar5iv\.org\/html\/)([^\s/]+)/);
  if (urlMatch) return urlMatch[1] ?? null;
  const prefixMatch = trimmed.match(/(?:ar[xX]iv:\s*)?([a-z]+(?:[.-][a-z]+)*\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
  return prefixMatch?.[1] ?? null;
}

function paperFromSemanticScholar(paper: SemanticScholarPaper): PaperItem {
  return {
    id: generatePaperId(),
    title: paper.title || 'Untitled',
    authors: (paper.authors ?? []).map((a) => a.name),
    year: paper.year ?? new Date().getFullYear(),
    venue: paper.venue ?? '',
    abstract: paper.abstract ?? '',
    doi: paper.externalIds?.DOI,
    arxivId: paper.externalIds?.ArXiv,
    citationCount: paper.citationCount,
    tags: [],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    referenceIds: [],
    addedAt: generateTimestamp(),
  };
}

interface PapersPageProps {
  onNavigate?: (page: string) => void;
  uiMode?: UIMode;
}

type PapersOperation =
  | 'import'
  | 'search'
  | 'pdfDownload'
  | 'pdfExtract'
  | 'pdfChat'
  | 'summaryTags'
  | 'pdfIndex'
  | 'relatedPapers'
  | 'rss';

const NORMAL_OPERATION_ERRORS: Record<PapersOperation, Record<PresentationLocale, string>> = {
  import: {
    en: 'The paper details could not be imported. Check the identifier and try again.',
    zh: '未能导入论文信息。请检查文献标识后重试。',
  },
  search: {
    en: 'Literature search could not be completed. Please try again later.',
    zh: '暂时无法完成文献搜索，请稍后重试。',
  },
  pdfDownload: {
    en: 'The PDF could not be downloaded. You can retry or attach a local copy.',
    zh: '未能下载 PDF。您可以重试或添加本地文件。',
  },
  pdfExtract: {
    en: 'The PDF content could not be read. Check the file and try again.',
    zh: '未能读取 PDF 内容。请检查文件后重试。',
  },
  pdfChat: {
    en: 'The question could not be answered from this PDF. Please try again.',
    zh: '暂时无法根据此 PDF 回答问题，请重试。',
  },
  summaryTags: {
    en: 'The summary and tags could not be generated. Please try again.',
    zh: '未能生成摘要与标签，请重试。',
  },
  pdfIndex: {
    en: 'The PDF could not be added to full-text search. Check the file and try again.',
    zh: '未能将 PDF 加入全文检索。请检查文件后重试。',
  },
  relatedPapers: {
    en: 'Related papers could not be loaded. Please try again later.',
    zh: '暂时无法加载相关论文，请稍后重试。',
  },
  rss: {
    en: 'The feed could not be loaded. Check the address and try again.',
    zh: '未能加载订阅内容。请检查地址后重试。',
  },
};

function presentPapersError(
  operation: PapersOperation,
  error: unknown,
  locale: PresentationLocale,
  uiMode: UIMode,
): string {
  if (uiMode === 'diagnostic') {
    return presentExecutionError(error, locale, uiMode);
  }
  return NORMAL_OPERATION_ERRORS[operation][locale];
}

function pdfAttachmentName(paper: PaperItem): string {
  return paper.pdfCapability?.displayName ?? '';
}

function hasPdfAttachment(paper: PaperItem): boolean {
  return Boolean(paper.pdfCapability);
}

function presentPdfAttachment(paper: PaperItem, uiMode: UIMode, locale: PresentationLocale): string {
  const basename = pdfAttachmentName(paper);
  if (uiMode === 'diagnostic') return basename || (locale === 'zh' ? '（无PDF）' : '(no PDF)');
  return locale === 'zh' ? `${paper.title}（PDF）` : `${paper.title} (PDF)`;
}

async function extractPaperPdf(paper: PaperItem, maxChars: number): Promise<string> {
  const metis = window.metis;
  if (!paper.pdfCapability || !metis?.useFileCapability) {
    throw new Error('PDF attachment is unavailable');
  }
  const result = await metis.useFileCapability({
    capabilityId: paper.pdfCapability.capabilityId,
    operation: 'extract',
    maxChars,
  });
  if (!result?.success || result.operation !== 'extract') {
    throw new Error('PDF extraction is unavailable');
  }
  return result.text;
}

export default function PapersPage({ onNavigate, uiMode = 'normal' }: PapersPageProps) {
  const {
    papers, paperFilter, setPaperFilter, addPaper, removePaper, updatePaper, togglePaperStar,
    addPaperReference, removePaperReference,
    archivePaper, unarchivePaper,
    collections, selectedCollection, addCollection, removeCollection, selectCollection,
    addPaperToCollection, removePaperFromCollection,
    savedFilters, addSavedFilter, removeSavedFilter,
    notes, experiments, updateNote, updateExperiment,
    selectedPaperId, setSelectedPaperId,
  } = useMetisStore();
  const { t, locale } = useTranslation();

  function handleAiReview(paper: PaperItem) {
    const authors = paper.authors?.join(', ') ?? t('papers.unknownAuthors');
    const message = `Please review the following paper:\n\nTitle: ${paper.title}\nAuthors: ${authors}\nYear: ${paper.year ?? 'N/A'}\nVenue: ${paper.venue ?? 'N/A'}\nAbstract: ${paper.abstract ?? 'N/A'}\n\nProvide a structured peer review.`;
    setPendingChatIntent({ skillId: 'paper-review', message });
    onNavigate?.('chat');
  }

  function handleCheckCitations(paper: PaperItem) {
    const refs = paper.referenceIds
      .map((id) => papers.find((p) => p.id === id))
      .filter((p): p is PaperItem => Boolean(p));
    const refsText = refs.length > 0
      ? refs.map((p, i) => `${i + 1}. ${formatCitation(p, 'apa')}`).join('\n')
      : '（该论文暂未关联本地参考文献）';
    const message = `Please check the following citations for existence and consistency. For each item, verify the title, authors, year, and DOI/arXiv ID if available:\n\n${refsText}`;
    setPendingChatIntent({ skillId: 'citation-check', message });
    onNavigate?.('chat');
  }

  const [showForm, setShowForm] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [mergedPaper, setMergedPaper] = useState<{ id: string; title: string } | null>(null);

  const notifyMerge = (saved: PaperItem, merged: boolean) => {
    if (merged) {
      setImportNotice(t('papers.importMerged'));
      setMergedPaper({ id: saved.id, title: saved.title });
    }
  };

  const [pdfDownloadError, setPdfDownloadError] = useState<Record<string, string>>({});
  const [pdfDownloadLoading, setPdfDownloadLoading] = useState<Set<string>>(new Set());
  const [pdfDownloadUrls, setPdfDownloadUrls] = useState<Record<string, string>>({});
  const [importResolving, setImportResolving] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const bulkSelectAllRef = useRef<HTMLInputElement>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  const [editingTags, setEditingTags] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesInput, setNotesInput] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [editingAbstract, setEditingAbstract] = useState(false);
  const [abstractInput, setAbstractInput] = useState('');

  // ─── Semantic Scholar search state ──────────────────────────────
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SemanticScholarPaper[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());

  // ─── PDF Chat state ─────────────────────────────────────────────
  const [pdfChatOpen, setPdfChatOpen] = useState(false);
  const [pdfContext, setPdfContext] = useState('');
  const [pdfContextLoading, setPdfContextLoading] = useState(false);
  const [pdfChatInput, setPdfChatInput] = useState('');
  const [pdfChatMessages, setPdfChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [pdfChatLoading, setPdfChatLoading] = useState(false);
  const [pdfChatError, setPdfChatError] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [pdfIndexLoading, setPdfIndexLoading] = useState(false);
  const [pdfIndexError, setPdfIndexError] = useState('');
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [citationFormat, setCitationFormat] = useState<CitationFormat>('apa');
  const [citationCopied, setCitationCopied] = useState(false);
  const [showCitationsExport, setShowCitationsExport] = useState(false);
  const [citationsExportCopied, setCitationsExportCopied] = useState(false);
  const [copiedPaperId, setCopiedPaperId] = useState<string | null>(null);
  const [batchIndexLoading, setBatchIndexLoading] = useState(false);
  const [batchIndexNotice, setBatchIndexNotice] = useState('');
  const [bulkNotice, setBulkNotice] = useState('');
  const [showBulkTagInput, setShowBulkTagInput] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [showBulkDeadlineInput, setShowBulkDeadlineInput] = useState(false);
  const [bulkDeadlineInput, setBulkDeadlineInput] = useState('');
  const [referenceInput, setReferenceInput] = useState('');

  // ─── Collections state ────────────────────────────────────────────
  const [showCollectionInput, setShowCollectionInput] = useState(false);
  const [collectionNameInput, setCollectionNameInput] = useState('');

  // ─── Saved filters state ──────────────────────────────────────────
  const [showSaveFilterInput, setShowSaveFilterInput] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');

  // ─── RSS feeds state ──────────────────────────────────────────────
  const [rssFeeds, setRssFeeds] = useState<string[]>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
        ? localStorage.getItem('metis-rss-feeds')
        : null;
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [rssFeedInput, setRssFeedInput] = useState('');
  const [rssEntries, setRssEntries] = useState<RssFeedEntry[]>([]);
  const [rssLoading, setRssLoading] = useState(false);
  const [rssError, setRssError] = useState('');
  const [showRssPanel, setShowRssPanel] = useState(false);

  useEffect(() => {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem('metis-rss-feeds', JSON.stringify(rssFeeds));
    }
  }, [rssFeeds]);

  // ─── Related papers state ───────────────────────────────────────
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [relatedPapers, setRelatedPapers] = useState<CitationEdge[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState('');
  const [relatedType, setRelatedType] = useState<'citations' | 'references'>('citations');
  const [relatedView, setRelatedView] = useState<'list' | 'graph'>('list');

  const READ_STATUS_LABELS: Record<ReadStatus, string> = {
    unread: t('papers.statusUnread'), reading: t('papers.statusReading'),
    read: t('papers.statusRead'), skimmed: t('papers.statusSkimmed'),
  };
  const PRIORITY_LABELS: Record<'high' | 'medium' | 'low', string> = {
    high: t('papers.priorityHigh'),
    medium: t('papers.priorityMedium'),
    low: t('papers.priorityLow'),
  };
  const priorityBadgeColor: Record<'high' | 'medium' | 'low', string> = {
    high: '#ef4444',
    medium: '#f59e0b',
    low: '#3b82f6',
  };

  function deadlineStatusInfo(deadline?: string): { label: string; color: string } | null {
    if (!deadline) return null;
    const d = new Date(deadline).setHours(0, 0, 0, 0);
    const today = new Date().setHours(0, 0, 0, 0);
    if (d < today) return { label: t('papers.deadlineOverdue'), color: '#ef4444' };
    if (d === today) return { label: t('papers.deadlineToday'), color: '#f59e0b' };
    return { label: t('papers.deadlineUpcoming'), color: '#3b82f6' };
  }

  function isOverdue(deadline?: string): boolean {
    if (!deadline) return false;
    return new Date(deadline).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0);
  }

  const filtered = filterPapers(papers, paperFilter, collections);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'year' | 'rating' | 'priority' | 'deadline' | 'title'>('newest');

  const sortedFiltered = useMemo(() => {
    const list = [...filtered];
    const priorityWeight = (p?: 'high' | 'medium' | 'low') => (p ? { high: 3, medium: 2, low: 1 }[p] : 0);
    const deadlineTs = (d?: string) => d ? new Date(d).getTime() : Infinity;
    switch (sortBy) {
      case 'newest': return list.sort((a, b) => b.addedAt - a.addedAt);
      case 'oldest': return list.sort((a, b) => a.addedAt - b.addedAt);
      case 'year': return list.sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));
      case 'rating': return list.sort((a, b) => b.rating - a.rating || a.title.localeCompare(b.title));
      case 'priority': return list.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority) || a.title.localeCompare(b.title));
      case 'deadline': return list.sort((a, b) => deadlineTs(a.deadline) - deadlineTs(b.deadline) || a.title.localeCompare(b.title));
      case 'title': return list.sort((a, b) => a.title.localeCompare(b.title));
      default: return list;
    }
  }, [filtered, sortBy]);

  const selected = papers.find((p) => p.id === selectedPaperId);

  // ─── Bulk selection helpers ─────────────────────────────────────
  const isAllSelected = filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));
  const someSelected = filtered.some((p) => selectedIds.has(p.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isAllSelected) {
        filtered.forEach((p) => next.delete(p.id));
      } else {
        filtered.forEach((p) => next.add(p.id));
      }
      return next;
    });
  };

  const markSelectedAsRead = () => {
    const now = Date.now();
    selectedIds.forEach((id) => {
      void updatePaper(id, { readStatus: 'read', readAt: now });
    });
    setSelectedIds(new Set());
  };

  const markSelectedAsUnread = () => {
    selectedIds.forEach((id) => {
      void updatePaper(id, { readStatus: 'unread' });
    });
    setSelectedIds(new Set());
  };

  const starSelected = () => {
    selectedIds.forEach((id) => {
      void updatePaper(id, { starred: true });
    });
    setSelectedIds(new Set());
  };

  const unstarSelected = () => {
    selectedIds.forEach((id) => {
      void updatePaper(id, { starred: false });
    });
    setSelectedIds(new Set());
  };

  const setSelectedRating = (rating: number) => {
    selectedIds.forEach((id) => {
      void updatePaper(id, { rating });
    });
    setSelectedIds(new Set());
  };

  const setSelectedPriority = (priority: 'high' | 'medium' | 'low') => {
    selectedIds.forEach((id) => {
      void updatePaper(id, { priority });
    });
    setSelectedIds(new Set());
  };

  const setSelectedDeadline = (deadline: string) => {
    selectedIds.forEach((id) => {
      void updatePaper(id, { deadline });
    });
    setSelectedIds(new Set());
  };

  const setSelectedStatus = (status: ReadStatus) => {
    const updates: Partial<PaperItem> = { readStatus: status };
    if (status === 'read') updates.readAt = Date.now();
    selectedIds.forEach((id) => {
      void updatePaper(id, updates);
    });
    setSelectedIds(new Set());
  };

  const archiveSelected = () => {
    selectedIds.forEach((id) => {
      void archivePaper(id);
    });
    setSelectedIds(new Set());
  };

  const unarchiveSelected = () => {
    selectedIds.forEach((id) => {
      void unarchivePaper(id);
    });
    setSelectedIds(new Set());
  };

  const handleSetBulkDeadline = () => {
    if (!bulkDeadlineInput) return;
    setSelectedDeadline(bulkDeadlineInput);
    setBulkNotice(t('papers.bulkDeadlineSet', { count: selectedIds.size }));
    window.setTimeout(() => setBulkNotice(''), 3000);
    setBulkDeadlineInput('');
    setShowBulkDeadlineInput(false);
  };

  const handleAddBulkTags = () => {
    const tags = bulkTagInput
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    if (tags.length === 0) return;
    let updated = 0;
    selectedIds.forEach((id) => {
      const paper = papers.find((p) => p.id === id);
      if (!paper) return;
      const merged = Array.from(new Set([...paper.tags, ...tags]));
      if (merged.length > paper.tags.length) {
        void updatePaper(id, { tags: merged });
        updated++;
      }
    });
    if (updated > 0) {
      setBulkNotice(t('papers.bulkTagsAdded', { count: updated, tags: tags.join(', ') }));
      window.setTimeout(() => setBulkNotice(''), 3000);
    }
    setBulkTagInput('');
    setShowBulkTagInput(false);
    setSelectedIds(new Set());
  };

  const confirmBulkDelete = async () => {
    for (const id of selectedIds) {
      await removePaper(id);
    }
    setSelectedIds(new Set());
    setShowBulkDeleteConfirm(false);
  };

  const handleAddSelectedToCollection = (collectionId: string) => {
    const collection = collections.find((c) => c.id === collectionId);
    if (!collection) return;
    let added = 0;
    for (const id of selectedIds) {
      if (!collection.paperIds.includes(id)) {
        void addPaperToCollection(collectionId, id);
        added++;
      }
    }
    if (added > 0) {
      setBulkNotice(t('papers.addedToCollection', { count: added, name: collection.name }));
      window.setTimeout(() => setBulkNotice(''), 3000);
    }
    setSelectedIds(new Set());
  };

  const handleRemoveSelectedFromCollection = () => {
    const collectionId = paperFilter.collectionId;
    const collection = collectionId ? collections.find((c) => c.id === collectionId) : undefined;
    if (!collectionId || !collection) return;
    let removed = 0;
    for (const id of selectedIds) {
      if (collection.paperIds.includes(id)) {
        void removePaperFromCollection(collectionId, id);
        removed++;
      }
    }
    if (removed > 0) {
      setBulkNotice(t('papers.removedFromCollection', { count: removed, name: collection.name }));
      window.setTimeout(() => setBulkNotice(''), 3000);
    }
    setSelectedIds(new Set());
  };

  const handleSaveFilter = () => {
    const trimmed = saveFilterName.trim();
    if (!trimmed) return;
    addSavedFilter(trimmed, { ...paperFilter });
    setSaveFilterName('');
    setShowSaveFilterInput(false);
  };

  const handleApplyFilter = (filter: MetisState['paperFilter']) => {
    selectCollection(filter.collectionId ?? null);
    setPaperFilter({ ...filter });
  };

  useEffect(() => {
    if (bulkSelectAllRef.current) {
      bulkSelectAllRef.current.indeterminate = someSelected && !isAllSelected;
    }
  }, [someSelected, isAllSelected]);

  // ─── Similar papers in library state ────────────────────────────
  const [similarOpen, setSimilarOpen] = useState(false);
  const similarPapers = useMemo(() => {
    if (!similarOpen || !selected) return [];
    return findSimilarPapers(papers, selected.id, 6);
  }, [similarOpen, selected, papers]);

  const relatedGraph = useMemo(() => {
    if (!selected) return { nodes: [] as Node[], edges: [] as Edge[] };
    const centerNode: Node = {
      id: selected.id,
      position: { x: 0, y: 0 },
      data: { label: selected.title },
      style: { width: 180, background: 'var(--accent-primary, #3182ce)', borderRadius: 8, padding: 8, color: '#fff', fontSize: 12 },
    };
    const nodes: Node[] = [centerNode];
    const edges: Edge[] = [];
    const radius = Math.max(180, relatedPapers.length * 60);
    relatedPapers.forEach((paper, index) => {
      const angle = (2 * Math.PI * index) / Math.max(relatedPapers.length, 1);
      const id = paper.paperId || `related-${index}`;
      nodes.push({
        id,
        position: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
        data: { label: paper.title || t('papers.untitled'), paper },
        style: { width: 160, background: 'var(--bg-card, #fff)', border: '2px solid var(--border, #e2e8f0)', borderRadius: 8, padding: 6, fontSize: 11, color: 'var(--text-primary)' },
      });
      edges.push({
        id: `${selected.id}-${id}`,
        source: relatedType === 'citations' ? id : selected.id,
        target: relatedType === 'citations' ? selected.id : id,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--text-muted, #718096)', width: 12, height: 12 },
        style: { stroke: 'var(--text-muted, #718096)', strokeWidth: 1.5 },
      });
    });
    return { nodes, edges };
  }, [selected, relatedPapers, relatedType, t]);

  const handleToggleNoteLink = (noteId: string) => {
    if (!selected) return;
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;
    const has = note.linkedPaperIds.includes(selected.id);
    void updateNote(note.id, {
      linkedPaperIds: has
        ? note.linkedPaperIds.filter((id) => id !== selected.id)
        : [...note.linkedPaperIds, selected.id],
    });
  };

  const handleToggleExperimentLink = (expId: string) => {
    if (!selected) return;
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    const has = exp.linkedPaperIds.includes(selected.id);
    void updateExperiment(exp.id, {
      linkedPaperIds: has
        ? exp.linkedPaperIds.filter((id) => id !== selected.id)
        : [...exp.linkedPaperIds, selected.id],
    });
  };

  const handleImport = async () => {
    if (!importText.trim()) return;
    setImportError('');
    setImportNotice('');
    setMergedPaper(null);

    const doi = extractDoi(importText);
    const arxivId = extractArxivId(importText);

    if (arxivId && !doi) {
      setImportResolving(true);
      try {
        const metadata = await resolveArxiv(arxivId);
        if (!metadata) {
          setImportError(presentPapersError('import', `No arXiv metadata found for ${arxivId}`, locale, uiMode));
          return;
        }
        const paper: PaperItem = {
          id: generatePaperId(),
          title: metadata.title || t('papers.untitled'),
          authors: metadata.authors,
          year: metadata.year || new Date().getFullYear(),
          venue: metadata.venue,
          abstract: metadata.abstract,
          arxivId: metadata.arxivId,
          doi: metadata.doi,
          pdfUrl: metadata.pdfUrl,
          tags: metadata.primaryCategory ? [metadata.primaryCategory] : [],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          referenceIds: [],
          addedAt: generateTimestamp(),
        };
        const { paper: saved, merged } = await addPaper(paper);
        notifyMerge(saved, merged);
        if (!saved.pdfCapability && saved.pdfUrl) {
          await downloadAndAttachPdf(saved.id, saved.pdfUrl, setImportNotice);
        }
        if (!merged) {
          setImportText('');
          setShowForm(false);
        }
      } catch (err) {
        setImportError(presentPapersError('import', err, locale, uiMode));
      } finally {
        setImportResolving(false);
      }
      return;
    }

    if (doi) {
      setImportResolving(true);
      try {
        const metadata = await resolveDoi(doi);
        if (!metadata) {
          setImportError(presentPapersError('import', `No DOI metadata found for ${doi}`, locale, uiMode));
          return;
        }
        const paper: PaperItem = {
          id: generatePaperId(),
          title: metadata.title || t('papers.untitled'),
          authors: metadata.authors,
          year: metadata.year || new Date().getFullYear(),
          venue: metadata.venue,
          abstract: metadata.abstract,
          doi: metadata.doi,
          arxivId: metadata.arxivId,
          pdfUrl: metadata.pdfUrl,
          citationCount: metadata.citationCount,
          tags: [],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          referenceIds: [],
          addedAt: generateTimestamp(),
        };
        const { paper: saved, merged } = await addPaper(paper);
        notifyMerge(saved, merged);
        if (!saved.pdfCapability && saved.pdfUrl) {
          await downloadAndAttachPdf(saved.id, saved.pdfUrl, setImportNotice);
        }
        if (!merged) {
          setImportText('');
          setShowForm(false);
        }
      } catch (err) {
        setImportError(presentPapersError('import', err, locale, uiMode));
      } finally {
        setImportResolving(false);
      }
      return;
    }

    if (isLikelyBibtex(importText)) {
      // Parse BibTeX entries
      const bibEntries = parseBibtex(importText);
      if (bibEntries.length === 0) {
        setImportError(t('papers.importParseError'));
        return;
      }
      let mergedCount = 0;
      for (const entry of bibEntries) {
        const id = generatePaperId();
        const paper: PaperItem = {
          id,
          title: entry.title || t('papers.untitled'),
          authors: entry.authors,
          year: entry.year || new Date().getFullYear(),
          venue: entry.journal || '',
          abstract: entry.abstract || '',
          doi: entry.doi,
          tags: [],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          referenceIds: [],
          addedAt: generateTimestamp(),
        };
        const result = await addPaper(paper);
        if (result.merged) {
          mergedCount += 1;
          notifyMerge(result.paper, true);
        }
      }
      if (mergedCount > 0) {
        setImportNotice(t('papers.importMerged'));
      } else {
        setImportText('');
        setShowForm(false);
      }
    } else {
      // Plain text import: treat as a single paper with the text as title
      const id = generatePaperId();
      const { paper: savedPlain, merged } = await addPaper({
        id,
        title: importText.slice(0, 200).split('\n')[0] || t('papers.untitled'),
        authors: [],
        year: new Date().getFullYear(),
        venue: '',
        abstract: importText,
        tags: [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        referenceIds: [],
        addedAt: generateTimestamp(),
      });
      notifyMerge(savedPlain, merged);
      if (!merged) {
        setImportText('');
        setShowForm(false);
      }
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError('');
    setSearchResults([]);
    setSearchTotal(0);

    try {
      const result = await searchPapers({ query: searchQuery, limit: 10 });
      setSearchResults(result.data);
      setSearchTotal(result.total);
    } catch (err) {
      setSearchError(presentPapersError('search', err, locale, uiMode));
    } finally {
      setSearchLoading(false);
    }
  };

  const downloadAndAttachPdf = async (paperId: string, pdfUrl: string | undefined, onResult?: (message: string) => void) => {
    if (!pdfUrl) return;
    const metis = window.metis;
    if (!metis?.downloadPaperPdf) {
      const message = presentPapersError('pdfDownload', 'PDF download not available', locale, uiMode);
      setPdfDownloadError((prev) => ({ ...prev, [paperId]: message }));
      onResult?.(message);
      return;
    }
    setPdfDownloadLoading((prev) => new Set(prev).add(paperId));
    setPdfDownloadError((prev) => { const next = { ...prev }; delete next[paperId]; return next; });
    setPdfDownloadUrls((prev) => ({ ...prev, [paperId]: pdfUrl }));
    try {
      const paper = papers.find((item) => item.id === paperId);
      if (paper?.pdfUrl !== pdfUrl) await updatePaper(paperId, { pdfUrl });

      const result = await metis.downloadPaperPdf(paperId);
      if (result.success) {
        await updatePaper(paperId, { pdfCapability: result.pdfCapability, pdfText: undefined });
        setPdfDownloadError((prev) => { const next = { ...prev }; delete next[paperId]; return next; });
        setPdfDownloadUrls((prev) => { const next = { ...prev }; delete next[paperId]; return next; });
        onResult?.(t('papers.pdfDownloaded'));
      } else {
        const message = presentPapersError('pdfDownload', result.code, locale, uiMode);
        setPdfDownloadError((prev) => ({ ...prev, [paperId]: message }));
        onResult?.(message);
      }
    } catch (err) {
      const message = presentPapersError('pdfDownload', err, locale, uiMode);
      setPdfDownloadError((prev) => ({ ...prev, [paperId]: message }));
      onResult?.(message);
    } finally {
      setPdfDownloadLoading((prev) => {
        const next = new Set(prev);
        next.delete(paperId);
        return next;
      });
    }
  };

  const handleImportResult = async (paper: SemanticScholarPaper) => {
    setImportingIds((prev) => new Set(prev).add(paper.paperId));
    try {
      const item = paperFromSemanticScholar(paper);
      const { paper: saved, merged } = await addPaper(item);
      notifyMerge(saved, merged);
      await downloadAndAttachPdf(saved.id, paper.openAccessPdf?.url, setImportNotice);
    } finally {
      setImportingIds((prev) => {
        const next = new Set(prev);
        next.delete(paper.paperId);
        return next;
      });
    }
  };

  const handleLoadPdfContext = async () => {
    if (!selected || !hasPdfAttachment(selected)) return;
    setPdfContextLoading(true);
    setPdfChatError('');
    try {
      const metis = window.metis;
      if (!selected.pdfCapability || !metis?.useFileCapability) {
        setPdfChatError(presentPapersError('pdfExtract', 'PDF extraction not available', locale, uiMode));
        return;
      }
      const text = await extractPaperPdf(selected, 12000);
      setPdfContext(text);
      setPdfChatMessages([]);
    } catch (err) {
      setPdfChatError(presentPapersError('pdfExtract', err, locale, uiMode));
    } finally {
      setPdfContextLoading(false);
    }
  };

  const handlePdfChatSend = async () => {
    if (!pdfChatInput.trim()) return;
    if (!pdfContext) {
      setPdfChatError(t('papers.pdfChatEmpty'));
      return;
    }
    setPdfChatLoading(true);
    setPdfChatError('');
    const question = pdfChatInput.trim();
    setPdfChatInput('');
    setPdfChatMessages((prev) => [...prev, { role: 'user', content: question }]);

    try {
      const metis = window.metis;
      if (!metis?.agentChat) {
        setPdfChatError(presentPapersError('pdfChat', 'Agent chat not available', locale, uiMode));
        return;
      }
      const sessionId = `pdf_chat_${selected?.id ?? Date.now()}`;
      const systemPrompt = `You are a research assistant answering questions based on the following PDF content. Be concise and cite page numbers when possible.\n\nPDF content:\n${pdfContext}`;
      const result = decodeAgentResponse(await metis.agentChat(
        sessionId,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
        undefined,
        { mode: 'send' },
      ));
      if (result.status !== 'completed') {
        setPdfChatError(presentPapersError('pdfChat', result.diagnostics[0]?.code ?? result.status, locale, uiMode));
      } else {
        setPdfChatMessages((prev) => [...prev, { role: 'assistant', content: result.answer }]);
      }
    } catch (err) {
      setPdfChatError(presentPapersError('pdfChat', err, locale, uiMode));
    } finally {
      setPdfChatLoading(false);
    }
  };

  const handleExport = (format: 'bibtex' | 'csv') => {
    if (papers.length === 0) return;
    const content = format === 'bibtex'
      ? papers.map((p) => paperToBibtex(p)).join('\n\n')
      : papersToCsv(papers);
    const filename = format === 'bibtex' ? 'library.bib' : 'library.csv';
    downloadTextFile(content, filename);
    setImportNotice(t('papers.exportSuccess'));
    setShowExport(false);
  };

  const handleGenerateSummaryTags = async () => {
    if (!selected || !hasPdfAttachment(selected)) return;
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const metis = window.metis;
      if (!selected.pdfCapability || !metis?.useFileCapability || !metis?.agentChat) {
        setSummaryError(presentPapersError('summaryTags', 'PDF extraction or agent chat not available', locale, uiMode));
        return;
      }
      const text = await extractPaperPdf(selected, 12000);
      const sessionId = `summary_${selected.id}`;
      const prompt = `Read the following academic paper content and produce a JSON object with exactly two keys: "abstract" (a concise 2-3 sentence summary) and "tags" (an array of 3-8 relevant keyword tags). Respond with JSON only.\n\nPDF content:\n${text}`;
      const result = decodeAgentResponse(await metis.agentChat(
        sessionId,
        [
          { role: 'system', content: 'You are a research assistant that extracts structured metadata from academic papers.' },
          { role: 'user', content: prompt },
        ],
        undefined,
        { mode: 'send' },
      ));
      if (result.status !== 'completed') {
        setSummaryError(presentPapersError('summaryTags', result.diagnostics[0]?.code ?? result.status, locale, uiMode));
        return;
      }
      const jsonMatch = result.answer.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? (JSON.parse(jsonMatch[0]) as { abstract?: string; tags?: string[] }) : {};
      const abstract = typeof parsed.abstract === 'string' ? parsed.abstract : '';
      const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [];
      if (!abstract && tags.length === 0) {
        setSummaryError(presentPapersError('summaryTags', 'Could not parse summary from model response', locale, uiMode));
        return;
      }
      updatePaper(selected.id, {
        abstract: abstract || selected.abstract,
        tags: [...new Set([...selected.tags, ...tags])],
      });
      setImportNotice(t('papers.summaryTagsGenerated'));
    } catch (err) {
      setSummaryError(presentPapersError('summaryTags', err, locale, uiMode));
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleIndexPdfText = async () => {
    if (!selected || !hasPdfAttachment(selected)) return;
    setPdfIndexLoading(true);
    setPdfIndexError('');
    try {
      const metis = window.metis;
      if (!selected.pdfCapability || !metis?.useFileCapability) {
        setPdfIndexError(presentPapersError('pdfIndex', 'PDF extraction not available', locale, uiMode));
        return;
      }
      const text = await extractPaperPdf(selected, 50000);
      await updatePaper(selected.id, { pdfText: text.slice(0, 50000) });
      setImportNotice(t('papers.pdfIndexed'));
    } catch (err) {
      setPdfIndexError(presentPapersError('pdfIndex', err, locale, uiMode));
    } finally {
      setPdfIndexLoading(false);
    }
  };

  const handleSuggestTags = () => {
    if (!selected) return;
    const suggestions = suggestTags(selected, papers, 6);
    setSuggestedTags(suggestions);
  };

  const handleApplySuggestedTag = (tag: string) => {
    if (!selected) return;
    void updatePaper(selected.id, { tags: [...new Set([...selected.tags, tag])] });
    setSuggestedTags((prev) => prev.filter((t) => t !== tag));
  };

  const handleIndexAllPdfs = async () => {
    const metis = window.metis;
    if (!metis?.useFileCapability) {
      setBatchIndexNotice(presentPapersError('pdfIndex', 'PDF extraction not available', locale, uiMode));
      return;
    }
    const targets = papers.filter((p) => hasPdfAttachment(p) && !p.pdfText);
    if (targets.length === 0) {
      setBatchIndexNotice(t('papers.batchIndexEmpty'));
      return;
    }
    setBatchIndexLoading(true);
    setBatchIndexNotice('');
    let indexed = 0;
    let failed = 0;
    for (const paper of targets) {
      try {
        const text = await extractPaperPdf(paper, 50000);
        await updatePaper(paper.id, { pdfText: text.slice(0, 50000) });
        indexed += 1;
      } catch {
        failed += 1;
      }
    }
    setBatchIndexLoading(false);
    setBatchIndexNotice(t('papers.batchIndexDone', { indexed, failed, total: targets.length }));
  };

  const handleLoadRelated = async (type: 'citations' | 'references') => {
    if (!selected?.doi && !selected?.arxivId) {
      setRelatedError(presentPapersError('relatedPapers', 'Paper must have a DOI or arXiv ID', locale, uiMode));
      return;
    }
    setRelatedLoading(true);
    setRelatedError('');
    setRelatedType(type);
    setRelatedPapers([]);

    try {
      const paperId = selected.doi ? `DOI:${selected.doi}` : `ARXIV:${selected.arxivId}`;
      const result = await getPaperRecommendations({ paperId, type, limit: 10 });
      const papers = result.data
        .map(recommendationToPlain)
        .filter((p): p is Record<string, unknown> => p !== null)
        .map((p) => ({
          paperId: String(p.paperId ?? ''),
          title: String(p.title ?? ''),
          authors: (p.authors as string[] | undefined)?.map((name) => ({ name })) ?? [],
          year: Number(p.year ?? 0),
          venue: String(p.venue ?? ''),
          externalIds: { DOI: p.doi as string | undefined, ArXiv: p.arxivId as string | undefined },
        }));
      setRelatedPapers(papers);
    } catch (err) {
      setRelatedError(presentPapersError('relatedPapers', err, locale, uiMode));
    } finally {
      setRelatedLoading(false);
    }
  };

  const convertRelatedToItem = useCallback((paper: CitationEdge): PaperItem => {
    const now = Date.now();
    return {
      id: generatePaperId(),
      title: paper.title || t('papers.untitled'),
      authors: (paper.authors ?? []).map((a) => a.name),
      year: paper.year ?? new Date().getFullYear(),
      venue: paper.venue ?? '',
      abstract: '',
      doi: paper.externalIds?.DOI,
      arxivId: paper.externalIds?.ArXiv,
      citationCount: paper.citationCount,
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      referenceIds: [],
      addedAt: now,
    };
  }, [t]);

  const handleImportRssEntry = async (entry: RssFeedEntry) => {
    const year = entry.publishedAt ? new Date(entry.publishedAt).getFullYear() : new Date().getFullYear();
    const arxivMatch = entry.link.match(/arxiv\.org\/abs\/(\d+\.\d+)/);
    const arxivId = arxivMatch?.[1];
    const paper: PaperItem = {
      id: generatePaperId(),
      title: entry.title || t('papers.untitled'),
      authors: entry.authors.length > 0 ? entry.authors : ['Unknown'],
      year,
      venue: entry.categories[0] ?? '',
      abstract: entry.summary,
      url: entry.link,
      arxivId,
      pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined,
      tags: entry.categories.slice(0, 3),
      notes: '',
      readStatus: 'unread',
      rating: 0,
      referenceIds: [],
      addedAt: generateTimestamp(),
    };
    const { paper: savedRss, merged } = await addPaper(paper);
    notifyMerge(savedRss, merged);
  };

  const handleImportRelated = async (paper: CitationEdge) => {
    const item = convertRelatedToItem(paper);
    const { paper: saved, merged } = await addPaper(item);
    notifyMerge(saved, merged);
    await downloadAndAttachPdf(saved.id, paper.openAccessPdf?.url, setImportNotice);
  };

  return (
    <div className="papers-page">
      <aside className="papers-sidebar">
        <div className="papers-toolbar">
          <SearchInput
            placeholder={t('papers.searchPlaceholder')}
            value={paperFilter.query}
            onChange={(query) => setPaperFilter({ query })}
            className="search-input"
          />
          <button
            className={`btn-toggle ${paperFilter.semantic ? 'active' : ''}`}
            onClick={() => setPaperFilter({ semantic: !paperFilter.semantic })}
            title={paperFilter.semantic ? t('papers.keywordSearch') : t('papers.semanticSearch')}
          >
            {paperFilter.semantic ? t('papers.semanticSearch') : t('papers.keywordSearch')}
          </button>
          <button className="btn-secondary" onClick={() => { setImportNotice(''); setShowSearch(true); }}>{t('common.search')}</button>
          <button className="btn-secondary" onClick={() => { setImportNotice(''); setShowExport(true); }}>{t('common.export')}</button>
          <button className="btn-secondary" onClick={() => { setImportNotice(''); setShowCitationsExport(true); }}>{t('papers.exportCitations')}</button>
          <button
            className="btn-secondary"
            onClick={() => void handleIndexAllPdfs()}
            disabled={batchIndexLoading}
          >
            {batchIndexLoading ? t('common.loading') : t('papers.indexAllPdfs')}
          </button>
          <button className="btn-primary" onClick={() => { setImportNotice(''); setShowForm(true); }}>{t('papers.add')}</button>
          <button
            className={`btn-toggle ${paperFilter.archived ? 'active' : ''}`}
            onClick={() => setPaperFilter({ archived: !paperFilter.archived })}
            title={paperFilter.archived ? t('papers.showActivePapers') : t('papers.showArchivedPapers')}
          >
            {paperFilter.archived ? t('papers.showActivePapers') : t('papers.showArchivedPapers')}
          </button>
        </div>
        <div className="result-count" aria-live="polite" aria-atomic="true">
          {paperFilter.readWithinDays
            ? t('papers.resultCountWithinDays', { count: filtered.length, days: paperFilter.readWithinDays })
            : t('papers.resultCount', { count: filtered.length })}
        </div>
        {paperFilter.tag && (
          <div style={{ padding: '4px 12px', fontSize: 13 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, background: 'var(--bg-tertiary, #edf2f7)', border: '1px solid var(--border-color, #e2e8f0)' }}>
              {t('papers.filterTagLabel', { tag: paperFilter.tag })}
              <button
                type="button"
                onClick={() => setPaperFilter({ tag: undefined })}
                aria-label={t('papers.clearTagFilter')}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, lineHeight: 1, color: 'var(--text-secondary)' }}
              >
                ×
              </button>
            </span>
          </div>
        )}
        {batchIndexNotice && (
          <div style={{ color: 'var(--status-success, #38a169)', fontSize: 13, padding: '4px 8px' }}>
            {batchIndexNotice}
          </div>
        )}
        <div className="papers-collections" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-color, #e2e8f0)' }}>
          <div className="detail-section-header" style={{ marginBottom: 6 }}>
            <h3 style={{ fontSize: 13 }}>{t('papers.collections')}</h3>
            <button className="btn-sm" onClick={() => setShowCollectionInput(true)}>{t('papers.newCollection')}</button>
          </div>
          {showCollectionInput && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                type="text"
                value={collectionNameInput}
                onChange={(e) => setCollectionNameInput(e.target.value)}
                placeholder={t('papers.collectionNamePlaceholder')}
                className="settings-input"
                style={{ flex: 1, fontSize: 12 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && collectionNameInput.trim()) {
                    void addCollection({
                      id: `collection_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                      name: collectionNameInput.trim(),
                      description: '',
                      paperIds: [],
                      createdAt: Date.now(),
                    });
                    setCollectionNameInput('');
                    setShowCollectionInput(false);
                  }
                }}
              />
              <button
                className="btn-sm btn-primary"
                onClick={() => {
                  if (!collectionNameInput.trim()) return;
                  void addCollection({
                    id: `collection_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    name: collectionNameInput.trim(),
                    description: '',
                    paperIds: [],
                    createdAt: Date.now(),
                  });
                  setCollectionNameInput('');
                  setShowCollectionInput(false);
                }}
              >
                {t('papers.createCollection')}
              </button>
              <button className="btn-sm" onClick={() => { setCollectionNameInput(''); setShowCollectionInput(false); }}>{t('common.cancel')}</button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button
              className={`btn-sm ${selectedCollection === null ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { selectCollection(null); setPaperFilter({ collectionId: undefined }); }}
              style={{ justifyContent: 'flex-start' }}
            >
              {t('papers.allCollections')}
            </button>
            {collections.map((collection) => (
              <div key={collection.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <button
                  className={`btn-sm ${selectedCollection === collection.id ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => { selectCollection(collection.id); setPaperFilter({ collectionId: collection.id }); }}
                  style={{ flex: 1, justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {collection.name}
                </button>
                <button
                  className="btn-sm"
                  onClick={() => void removeCollection(collection.id)}
                  title={t('common.delete')}
                >
                  {t('common.delete')}
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="papers-saved-filters" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-color, #e2e8f0)' }}>
          <div className="detail-section-header" style={{ marginBottom: 6 }}>
            <h3 style={{ fontSize: 13 }}>{t('papers.savedFilters')}</h3>
            <button className="btn-sm" onClick={() => setShowSaveFilterInput((prev) => !prev)}>
              {showSaveFilterInput ? t('common.close') : t('papers.saveFilter')}
            </button>
          </div>
          {showSaveFilterInput && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                type="text"
                value={saveFilterName}
                onChange={(e) => setSaveFilterName(e.target.value)}
                placeholder={t('papers.saveFilterPlaceholder')}
                className="settings-input"
                style={{ flex: 1, fontSize: 12 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && saveFilterName.trim()) handleSaveFilter();
                  if (e.key === 'Escape') { setSaveFilterName(''); setShowSaveFilterInput(false); }
                }}
                data-testid="save-filter-name-input"
              />
              <button
                className="btn-sm btn-primary"
                onClick={handleSaveFilter}
                disabled={!saveFilterName.trim()}
                data-testid="save-filter-confirm"
              >
                {t('papers.saveFilterCreate')}
              </button>
              <button
                className="btn-sm"
                onClick={() => { setSaveFilterName(''); setShowSaveFilterInput(false); }}
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {savedFilters.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '4px 0' }}>
                {t('papers.savedFiltersEmpty')}
              </div>
            )}
            {savedFilters.map((saved) => (
              <div key={saved.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <button
                  className="btn-sm btn-secondary"
                  style={{ flex: 1, justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  onClick={() => handleApplyFilter(saved.filter)}
                  title={t('papers.savedFilterApply', { name: saved.name })}
                  data-testid="saved-filter-item"
                >
                  {saved.name}
                </button>
                <button
                  className="btn-sm"
                  onClick={() => removeSavedFilter(saved.id)}
                  title={t('common.delete')}
                  data-testid="saved-filter-delete"
                >
                  {t('common.delete')}
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="papers-collections" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-color, #e2e8f0)' }}>
          <div className="detail-section-header" style={{ marginBottom: 6 }}>
            <h3 style={{ fontSize: 13 }}>{t('papers.rssFeeds')}</h3>
            <button className="btn-sm" onClick={() => setShowRssPanel((prev) => !prev)}>{showRssPanel ? t('common.close') : t('papers.manageRssFeeds')}</button>
          </div>
          {showRssPanel && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={rssFeedInput}
                  onChange={(e) => setRssFeedInput(e.target.value)}
                  placeholder={t('papers.rssFeedPlaceholder')}
                  className="settings-input"
                  style={{ flex: 1, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && rssFeedInput.trim()) { setRssFeeds((prev) => [...prev, rssFeedInput.trim()]); setRssFeedInput(''); } }}
                />
                <button
                  className="btn-sm btn-primary"
                  onClick={() => { if (!rssFeedInput.trim()) return; setRssFeeds((prev) => [...prev, rssFeedInput.trim()]); setRssFeedInput(''); }}
                >
                  {t('papers.addRssFeed')}
                </button>
              </div>
              {rssFeeds.map((feedUrl, index) => (
                <div key={`${feedUrl}-${index}`} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <button
                    className="btn-sm btn-secondary"
                    style={{ flex: 1, justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    onClick={() => {
                      setRssLoading(true);
                      setRssError('');
                      void fetchRssFeed(feedUrl).then((feed) => {
                        setRssLoading(false);
                        if (feed) setRssEntries(feed.entries.slice(0, 20));
                        else setRssError(presentPapersError('rss', 'Feed fetch returned no content', locale, uiMode));
                      }).catch((err: unknown) => {
                        setRssLoading(false);
                        setRssError(presentPapersError('rss', err, locale, uiMode));
                      });
                    }}
                    disabled={rssLoading}
                  >
                    {feedUrl}
                  </button>
                  <button className="btn-sm" onClick={() => setRssFeeds((prev) => prev.filter((_, i) => i !== index))} title={t('common.delete')}>
                    {t('common.delete')}
                  </button>
                </div>
              ))}
              {rssFeeds.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.rssFeedsEmpty')}</div>}
              {rssLoading && <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('common.loading')}</div>}
              {rssError && <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 12 }}>{rssError}</div>}
              {rssEntries.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto', marginTop: 4 }}>
                  {rssEntries.map((entry) => (
                    <div key={entry.id} style={{ padding: 8, border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 6 }}>
                      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>{entry.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted, #718096)', marginBottom: 4 }}>
                        {entry.authors.join(', ') || t('papers.unknownAuthors')} · {entry.publishedAt ? new Date(entry.publishedAt).getFullYear() : 'n.d.'}
                      </div>
                      <button
                        className="btn-sm btn-primary"
                        onClick={() => void handleImportRssEntry(entry)}
                      >
                        {t('papers.rssImportEntry')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="papers-filters">
          <select value={paperFilter.readStatus ?? ''} onChange={(e) => setPaperFilter({ readStatus: (e.target.value || undefined) as ReadStatus | undefined })}>
            <option value="">{t('papers.filterAllStatus')}</option>
            {Object.entries(READ_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={paperFilter.minRating ?? ''} onChange={(e) => setPaperFilter({ minRating: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">{t('papers.filterAnyRating')}</option>
            {[4, 3, 2, 1].map((r) => <option key={r} value={r}>{t('papers.filterRatingStars', { rating: r })}</option>)}
          </select>
          <input type="text" placeholder={t('papers.filterYearPlaceholder')}
            value={paperFilter.yearFrom ?? ''} onChange={(e) => setPaperFilter({ yearFrom: e.target.value ? Number(e.target.value) : undefined })}
            style={{ width: 80 }} />
          <input type="text" placeholder={t('papers.filterCitationsPlaceholder')}
            value={paperFilter.minCitations ?? ''} onChange={(e) => setPaperFilter({ minCitations: e.target.value ? Number(e.target.value) : undefined })}
            style={{ width: 90 }} />
          <button
            type="button"
            className={`btn-sm ${paperFilter.starred ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPaperFilter({ starred: !paperFilter.starred })}
            aria-pressed={!!paperFilter.starred}
          >
            {t('papers.filterStarredOnly')}
          </button>
          <select value={paperFilter.priority ?? ''} onChange={(e) => setPaperFilter({ priority: (e.target.value || undefined) as 'high' | 'medium' | 'low' | undefined })} aria-label={t('papers.filterPriority')}>
            <option value="">{t('papers.filterAnyPriority')}</option>
            <option value="high">{t('papers.priorityHigh')}</option>
            <option value="medium">{t('papers.priorityMedium')}</option>
            <option value="low">{t('papers.priorityLow')}</option>
          </select>
          <select value={paperFilter.deadlineStatus ?? ''} onChange={(e) => setPaperFilter({ deadlineStatus: (e.target.value || undefined) as 'overdue' | 'today' | 'upcoming' | undefined })} aria-label={t('papers.filterDeadline')}>
            <option value="">{t('papers.filterDeadlineAll')}</option>
            <option value="overdue">{t('papers.filterDeadlineOverdue')}</option>
            <option value="today">{t('papers.filterDeadlineToday')}</option>
            <option value="upcoming">{t('papers.filterDeadlineUpcoming')}</option>
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} aria-label={t('papers.sortBy')}>
            <option value="newest">{t('papers.sortNewest')}</option>
            <option value="oldest">{t('papers.sortOldest')}</option>
            <option value="year">{t('papers.sortYear')}</option>
            <option value="rating">{t('papers.sortRating')}</option>
            <option value="priority">{t('papers.sortPriority')}</option>
            <option value="deadline">{t('papers.sortDeadline')}</option>
            <option value="title">{t('papers.sortTitle')}</option>
          </select>
          <button
            type="button"
            className="btn-sm btn-secondary"
            onClick={() => setPaperFilter({
              query: '',
              semantic: undefined,
              readStatus: undefined,
              readWithinDays: undefined,
              minRating: undefined,
              minCitations: undefined,
              venue: undefined,
              collectionId: undefined,
              starred: undefined,
              tag: undefined,
              archived: false,
              priority: undefined,
              deadlineStatus: undefined,
            })}
          >
            {t('papers.clearFilters')}
          </button>
        </div>
        <div className="papers-bulk-bar">
          <label className="bulk-select-label">
            <input
              ref={bulkSelectAllRef}
              type="checkbox"
              checked={isAllSelected}
              onChange={toggleSelectAll}
              aria-label={t('papers.selectAll')}
            />
            <span>{selectedIds.size > 0 ? t('papers.selectedCount', { count: selectedIds.size }) : t('papers.selectAll')}</span>
          </label>
          {selectedIds.size > 0 && (
            <div className="bulk-actions">
              <button type="button" className="btn-sm btn-secondary" onClick={markSelectedAsUnread}>{t('papers.markAsUnread')}</button>
              <button type="button" className="btn-sm btn-secondary" onClick={markSelectedAsRead}>{t('papers.markAsRead')}</button>
              <button type="button" className="btn-sm btn-secondary" onClick={starSelected}>{t('papers.starSelected')}</button>
              <button type="button" className="btn-sm btn-secondary" onClick={unstarSelected}>{t('papers.unstarSelected')}</button>
              <select
                className="btn-sm"
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) {
                    handleAddSelectedToCollection(id);
                    e.target.value = '';
                  }
                }}
                aria-label={t('papers.addSelectedToCollection')}
              >
                <option value="">{t('papers.addSelectedToCollection')}</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {paperFilter.collectionId && (
                <button type="button" className="btn-sm btn-secondary" onClick={handleRemoveSelectedFromCollection}>
                  {t('papers.bulkRemoveFromCollection')}
                </button>
              )}
              <select
                className="btn-sm"
                value=""
                onChange={(e) => {
                  const rating = Number(e.target.value);
                  if (!Number.isNaN(rating) && rating >= 1 && rating <= 5) {
                    setSelectedRating(rating);
                    e.target.value = '';
                  }
                }}
                aria-label={t('papers.setRating')}
              >
                <option value="">{t('papers.setRating')}</option>
                {[1, 2, 3, 4, 5].map((r) => (
                  <option key={r} value={r}>{t('papers.ratingOption', { rating: r })}</option>
                ))}
              </select>
              <select
                className="btn-sm"
                value=""
                onChange={(e) => {
                  const status = e.target.value as ReadStatus;
                  if (status) {
                    setSelectedStatus(status);
                    e.target.value = '';
                  }
                }}
                aria-label={t('papers.setStatus')}
              >
                <option value="">{t('papers.setStatus')}</option>
                {(['unread', 'reading', 'read', 'skimmed'] as ReadStatus[]).map((s) => (
                  <option key={s} value={s}>{READ_STATUS_LABELS[s]}</option>
                ))}
              </select>
              <select
                className="btn-sm"
                value=""
                onChange={(e) => {
                  const priority = e.target.value as 'high' | 'medium' | 'low';
                  if (priority) {
                    setSelectedPriority(priority);
                    e.target.value = '';
                  }
                }}
                aria-label={t('papers.setPriority')}
              >
                <option value="">{t('papers.setPriority')}</option>
                <option value="high">{t('papers.priorityHigh')}</option>
                <option value="medium">{t('papers.priorityMedium')}</option>
                <option value="low">{t('papers.priorityLow')}</option>
              </select>
              <button type="button" className="btn-sm btn-secondary" onClick={() => setShowBulkTagInput(true)}>{t('papers.bulkAddTags')}</button>
              <button type="button" className="btn-sm btn-secondary" onClick={() => setShowBulkDeadlineInput(true)}>{t('papers.bulkSetDeadline')}</button>
              {paperFilter.archived ? (
                <button type="button" className="btn-sm btn-secondary" onClick={unarchiveSelected}>{t('papers.unarchiveSelected')}</button>
              ) : (
                <button type="button" className="btn-sm btn-secondary" onClick={archiveSelected}>{t('papers.archiveSelected')}</button>
              )}
              <button type="button" className="btn-sm" onClick={() => setShowBulkDeleteConfirm(true)}>{t('papers.bulkDelete')}</button>
            </div>
          )}
          {selectedIds.size > 0 && showBulkTagInput && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                value={bulkTagInput}
                onChange={(e) => setBulkTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddBulkTags(); }}
                placeholder={t('papers.bulkAddTagsPlaceholder')}
                className="search-input"
                style={{ flex: '1 1 200px', minWidth: 180, fontSize: 13 }}
                data-testid="bulk-tag-input"
              />
              <button type="button" className="btn-sm btn-primary" onClick={handleAddBulkTags}>{t('common.add')}</button>
              <button type="button" className="btn-sm btn-secondary" onClick={() => { setShowBulkTagInput(false); setBulkTagInput(''); }}>{t('common.cancel')}</button>
            </div>
          )}
          {selectedIds.size > 0 && showBulkDeadlineInput && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <input
                type="date"
                value={bulkDeadlineInput}
                onChange={(e) => setBulkDeadlineInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSetBulkDeadline(); }}
                className="search-input"
                style={{ flex: '1 1 200px', minWidth: 180, fontSize: 13 }}
                data-testid="bulk-deadline-input"
              />
              <button type="button" className="btn-sm btn-primary" onClick={handleSetBulkDeadline}>{t('common.add')}</button>
              <button type="button" className="btn-sm btn-secondary" onClick={() => { setShowBulkDeadlineInput(false); setBulkDeadlineInput(''); }}>{t('common.cancel')}</button>
            </div>
          )}
        </div>
        {bulkNotice && (
          <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--success, #38a169)' }}>
            {bulkNotice}
          </div>
        )}
        <ul className="papers-list" aria-label={t('papers.paperList')}>
          {sortedFiltered.map((p) => (
            <li key={p.id} className={`paper-item ${selectedPaperId === p.id ? 'active' : ''} ${selectedIds.has(p.id) ? 'batch-selected' : ''} ${isOverdue(p.deadline) ? 'overdue' : ''}`}
              onClick={(e) => {
                // Don't select row when clicking interactive child elements
                const target = e.target as HTMLElement;
                if (target.closest('button, input, select, a')) return;
                setSelectedPaperId(p.id);
              }}>
              <input
                type="checkbox"
                checked={selectedIds.has(p.id)}
                onChange={() => toggleSelect(p.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={t('papers.selectPaper', { title: p.title })}
                data-testid="paper-checkbox"
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="paper-title">{p.title}</div>
                <div className="paper-meta">
                  {p.authors[0] ?? t('papers.unknownAuthor')}{p.authors.length > 1 ? t('papers.etAl') : ''} · {p.year}
                  {p.citationCount !== undefined && p.citationCount > 0 && <span> · {t('papers.citationCount', { count: p.citationCount })}</span>}
                </div>
                <div className="paper-status">
                  <span className={`badge status-${p.readStatus}`}>{READ_STATUS_LABELS[p.readStatus]}</span>
                  {p.doi && <IntegrityBadge doi={p.doi} />}
                  {p.priority && (
                    <span
                      className="badge"
                      style={{ background: priorityBadgeColor[p.priority], color: '#fff', marginLeft: 6 }}
                      title={PRIORITY_LABELS[p.priority]}
                    >
                      {PRIORITY_LABELS[p.priority]}
                    </span>
                  )}
                  {(() => {
                    const info = deadlineStatusInfo(p.deadline);
                    if (!info) return null;
                    return (
                      <span
                        className="badge"
                        style={{ background: info.color, color: '#fff', marginLeft: 6 }}
                        title={`${info.label} · ${p.deadline}`}
                      >
                        {info.label} {p.deadline}
                      </span>
                    );
                  })()}
                  {p.rating > 0 && (
                      <span className="rating-display">
                        {Array.from({ length: 5 }, (_, i) => (
                          <span key={i} className={`rating-dot ${i < p.rating ? 'filled' : ''}`} />
                        ))}
                      </span>
                    )}
                </div>
                {p.tags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {p.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="btn-sm btn-secondary"
                        style={{ padding: '2px 8px', fontSize: 11, borderRadius: 999 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPaperFilter({ query: '', tag });
                        }}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="btn-sm"
                title={t('papers.openPaper')}
                onClick={(e) => { e.stopPropagation(); setSelectedPaperId(p.id); }}
                aria-label={t('papers.openPaperTitle', { title: p.title })}
                data-testid="paper-open-button"
              >
                {t('papers.open')}
              </button>
              <button
                className="btn-sm btn-secondary"
                title={t('papers.copyCitation')}
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard.writeText(formatCitation(p, citationFormat));
                  setCopiedPaperId(p.id);
                  setTimeout(() => setCopiedPaperId((prev) => (prev === p.id ? null : prev)), 1200);
                }}
              >
                {copiedPaperId === p.id ? t('papers.citationCopied') : t('papers.copyCitation')}
              </button>
              <button
                className={`btn-sm ${p.starred ? 'btn-primary' : 'btn-secondary'}`}
                title={p.starred ? t('common.unstar') : t('common.star')}
                aria-label={p.starred ? t('common.unstar') : t('common.star')}
                onClick={(e) => { e.stopPropagation(); void togglePaperStar(p.id); }}
                aria-pressed={p.starred}
                data-testid="paper-star-button"
              >
                {p.starred ? '★' : '☆'}
              </button>
            </li>
          ))}
          {sortedFiltered.length === 0 && (
            <div className="empty-list">
              {papers.length === 0 ? t('papers.emptyList') : t('papers.noMatchingPapers')}
              {papers.length > 0 && (paperFilter.query || paperFilter.tag) && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setPaperFilter({ query: '', tag: undefined })}
                  style={{ display: 'block', margin: '8px auto 0' }}
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
          )}
        </ul>
      </aside>
      <main className="papers-detail">
        {selected ? (
          <>
            <div className="detail-header">
              {editingTitle ? (
                <div className="edit-row" style={{ flex: 1 }}>
                  <input
                    type="text" value={titleInput}
                    onChange={(e) => setTitleInput(e.target.value)}
                    className="settings-input" style={{ flex: 1, fontSize: 18, fontWeight: 600 }}
                  />
                  <button className="btn-sm btn-primary" onClick={() => { void updatePaper(selected.id, { title: titleInput }); setEditingTitle(false); }}>{t('common.save')}</button>
                  <button className="btn-sm" onClick={() => setEditingTitle(false)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <h2 onDoubleClick={() => { setTitleInput(selected.title); setEditingTitle(true); }} style={{ cursor: 'text' }} title={t('common.edit')}>
                  {selected.title}
                </h2>
              )}
              <div className="edit-actions">
                <button
                  className={`btn-sm ${selected.starred ? 'btn-primary' : 'btn-secondary'}`}
                  title={selected.starred ? t('common.unstar') : t('common.star')}
                  aria-label={selected.starred ? t('common.unstar') : t('common.star')}
                  onClick={() => { void togglePaperStar(selected.id); }}
                  aria-pressed={selected.starred}
                  data-testid="pin-detail-star-button"
                >
                  {selected.starred ? '★' : '☆'}
                </button>
                <button className="btn-secondary btn-sm" onClick={() => { setTitleInput(selected.title); setEditingTitle(true); }}>{t('common.edit')}</button>
                {selected.archived ? (
                  <button className="btn-secondary btn-sm" onClick={() => void unarchivePaper(selected.id)}>{t('common.unarchive')}</button>
                ) : (
                  <button className="btn-secondary btn-sm" onClick={() => void archivePaper(selected.id)}>{t('common.archive')}</button>
                )}
                <button className="btn-secondary btn-sm" onClick={() => setShowDeleteConfirm(true)}>{t('common.delete')}</button>
                {(selected.doi || selected.arxivId) && (
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      const url = selected.doi
                        ? `https://doi.org/${selected.doi}`
                        : `https://arxiv.org/abs/${selected.arxivId}`;
                      window.open(url, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    {t('papers.openExternal')}
                  </button>
                )}
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => downloadTextFile(paperToBibtex(selected), `paper-${selected.id}.bib`)}
                >
                  {t('papers.exportBibtex')}
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => downloadTextFile(papersToCsv([selected]), `paper-${selected.id}.csv`)}
                >
                  {t('papers.exportCsv')}
                </button>
                <button
                  className="btn-secondary btn-sm"
                  data-testid="paper-ai-review"
                  onClick={() => handleAiReview(selected)}
                >
                  {t('papers.aiReview')}
                </button>
              </div>
            </div>
            <div className="detail-meta">
              <span>{selected.authors.join(', ') || t('papers.unknownAuthors')}</span>
              <span>{selected.year}</span>
              {selected.venue && <span>{selected.venue}</span>}
              {selected.citationCount !== undefined && selected.citationCount > 0 && <span>{t('papers.citationCount', { count: selected.citationCount })}</span>}
              {selected.doi && <span>{t('papers.doi', { id: selected.doi })}</span>}
              {selected.arxivId && <span>{t('papers.arxivId', { id: selected.arxivId })}</span>}
            </div>
            <div className="detail-tags">
              {selected.tags.map((tag) => (
                <span key={tag} className="tag inline-flex-center">
                  {tag}
                  <button
                    className="tag-remove"
                    onClick={() => { void updatePaper(selected.id, { tags: selected.tags.filter((t2) => t2 !== tag) }); }}
                    title={t('common.delete')}
                  >×</button>
                </span>
              ))}
              {editingTags ? (
                <div className="inline-flex-center">
                  <input
                    type="text" value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder={t('papers.editTagsPlaceholder')}
                    className="settings-input" style={{ width: 160, fontSize: 12 }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const newTags = tagInput.split(',').map((t2) => t2.trim()).filter(Boolean);
                        if (newTags.length > 0) {
                          void updatePaper(selected.id, { tags: [...selected.tags, ...newTags] });
                          setTagInput('');
                        }
                      }
                    }}
                  />
                  <button className="btn-sm btn-primary" onClick={() => {
                    const newTags = tagInput.split(',').map((t2) => t2.trim()).filter(Boolean);
                    if (newTags.length > 0) { void updatePaper(selected.id, { tags: [...selected.tags, ...newTags] }); setTagInput(''); }
                  }}>{t('common.add')}</button>
                  <button className="btn-sm" onClick={() => { setEditingTags(false); setTagInput(''); }}>{t('common.cancel')}</button>
                </div>
              ) : (
                <button className="btn-sm" onClick={() => setEditingTags(true)} style={{ fontSize: 11 }}>+ {t('papers.editTags')}</button>
              )}
              <button className="btn-sm" onClick={handleSuggestTags} style={{ fontSize: 11, marginLeft: 6 }}>{t('papers.suggestTags')}</button>
            </div>
            {suggestedTags.length > 0 && (
              <div className="detail-suggested-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.suggestedTags')}:</span>
                {suggestedTags.map((tag) => (
                  <button
                    key={tag}
                    className="btn-sm btn-secondary"
                    onClick={() => handleApplySuggestedTag(tag)}
                    style={{ fontSize: 11 }}
                  >
                    + {tag}
                  </button>
                ))}
              </div>
            )}
            {collections.length > 0 && (
              <div className="detail-collections" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.addToCollection')}:</span>
                <select
                  className="detail-select"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      void addPaperToCollection(e.target.value, selected.id);
                      e.target.value = '';
                    }
                  }}
                  style={{ fontSize: 12, flex: 1, minWidth: 120 }}
                >
                  <option value="">—</option>
                  {collections
                    .filter((c) => !c.paperIds.includes(selected.id))
                    .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {collections
                  .filter((c) => c.paperIds.includes(selected.id))
                  .map((c) => (
                    <span key={c.id} className="tag inline-flex-center">
                      {c.name}
                      <button
                        className="tag-remove"
                        onClick={() => void removePaperFromCollection(c.id, selected.id)}
                        title={t('papers.removeFromCollection')}
                      >×</button>
                    </span>
                  ))}
              </div>
            )}
            <div className="detail-abstract">
              <div className="detail-section-header">
                <h3>{t('papers.abstract')}</h3>
                <button className="btn-sm" onClick={() => { setAbstractInput(selected.abstract); setEditingAbstract(true); }}>{t('common.edit')}</button>
              </div>
              {editingAbstract ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    value={abstractInput} onChange={(e) => setAbstractInput(e.target.value)}
                    rows={5} className="settings-input" style={{ fontSize: 13, resize: 'vertical' }}
                  />
                  <div className="edit-actions">
                    <button className="btn-sm btn-primary" onClick={() => { void updatePaper(selected.id, { abstract: abstractInput }); setEditingAbstract(false); }}>{t('common.save')}</button>
                    <button className="btn-sm" onClick={() => setEditingAbstract(false)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (
                <p>{selected.abstract || t('papers.noAbstract')}</p>
              )}
            </div>
            <div className="detail-notes">
              <div className="detail-section-header">
                <h3>{t('papers.notes')}</h3>
                <button className="btn-sm" onClick={() => { setNotesInput(selected.notes); setEditingNotes(true); }}>{t('common.edit')}</button>
              </div>
              {editingNotes ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    value={notesInput} onChange={(e) => setNotesInput(e.target.value)}
                    rows={5} className="settings-input" style={{ fontSize: 13, resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span>{t('papers.wordCount', { count: notesInput.trim() ? notesInput.trim().split(/\s+/).length : 0 })}</span>
                    <span>{t('papers.charCount', { count: notesInput.length })}</span>
                  </div>
                  <div className="edit-actions">
                    <button className="btn-sm btn-primary" onClick={() => { void updatePaper(selected.id, { notes: notesInput }); setEditingNotes(false); }}>{t('common.save')}</button>
                    <button className="btn-sm" onClick={() => setEditingNotes(false)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (
                <>
                  <p>{selected.notes || t('papers.noNotes')}</p>
                  {selected.notes && (
                    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      <span>{t('papers.wordCount', { count: selected.notes.trim() ? selected.notes.trim().split(/\s+/).length : 0 })}</span>
                      <span>{t('papers.charCount', { count: selected.notes.length })}</span>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="detail-stats">
              <div>
                <strong>{t('papers.setStatus')}</strong>{' '}
                <select
                  className="detail-select"
                  value={selected.readStatus}
                  onChange={(e) => {
                    const readStatus = e.target.value as ReadStatus;
                    void updatePaper(selected.id, { readStatus, readAt: readStatus === 'read' ? Date.now() : undefined });
                  }}
                >
                  {Object.entries(READ_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <strong>{t('papers.setPriority')}</strong>{' '}
                <select
                  className="detail-select"
                  value={selected.priority ?? ''}
                  onChange={(e) => void updatePaper(selected.id, { priority: (e.target.value || undefined) as 'high' | 'medium' | 'low' | undefined })}
                  aria-label={t('papers.setPriority')}
                >
                  <option value="">{t('papers.filterAnyPriority')}</option>
                  <option value="high">{t('papers.priorityHigh')}</option>
                  <option value="medium">{t('papers.priorityMedium')}</option>
                  <option value="low">{t('papers.priorityLow')}</option>
                </select>
              </div>
              <div>
                <strong>{t('papers.setRating')}</strong>{' '}
                <span className="rating-interactive">
                  {Array.from({ length: 5 }, (_, i) => (
                    <span
                      key={i}
                      className={`rating-dot ${i < selected.rating ? 'filled' : ''}`}
                      onClick={() => { void updatePaper(selected.id, { rating: i + 1 === selected.rating ? 0 : i + 1 }); }}
                      style={{ cursor: 'pointer' }}
                    />
                  ))}
                </span>
              </div>
              <div>
                <strong>{t('papers.readingProgress')}</strong>{' '}
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={selected.readingProgress ?? 0}
                  onChange={(e) => void updatePaper(selected.id, { readingProgress: Number(e.target.value) })}
                  style={{ verticalAlign: 'middle', marginRight: 8 }}
                />
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{selected.readingProgress ?? 0}%</span>
              </div>
              <div>
                <strong>{t('papers.readingTime')}</strong>{' '}
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {selected.readingTimeSeconds
                    ? t('papers.readingTimeMinutes', { minutes: Math.round(selected.readingTimeSeconds / 60) })
                    : t('papers.readingTimeNone')}
                </span>
                <div style={{ display: 'inline-flex', gap: 6, marginLeft: 8 }}>
                  {[5, 10, 30].map((mins) => (
                    <button
                      key={mins}
                      className="btn-sm btn-secondary"
                      onClick={() => void updatePaper(selected.id, { readingTimeSeconds: (selected.readingTimeSeconds ?? 0) + mins * 60 })}
                    >
                      {t('papers.addReadingTime', { minutes: mins })}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <strong>{t('papers.deadline')}</strong>{' '}
                <input
                  type="date"
                  value={selected.deadline ?? ''}
                  onChange={(e) => void updatePaper(selected.id, { deadline: e.target.value || undefined })}
                  aria-label={t('papers.setDeadline')}
                />
                {selected.deadline && (
                  <button
                    type="button"
                    className="btn-sm btn-secondary"
                    style={{ marginLeft: 8 }}
                    onClick={() => void updatePaper(selected.id, { deadline: undefined })}
                  >
                    {t('papers.clearDeadline')}
                  </button>
                )}
              </div>
              <div><strong>{t('papers.detailAdded')}</strong> {new Date(selected.addedAt).toLocaleDateString()}</div>
            </div>
            <div className="detail-pdf">
              <h3>{t('papers.pdfAttachment')}</h3>
              {selected.pdfCapability ? (
                <div className="pdf-attached">
                  <span className="tag pdf-tag">{presentPdfAttachment(selected, uiMode, locale)}</span>
                  <button className="btn-secondary btn-sm" onClick={() => {
                    const capabilityId = selected.pdfCapability?.capabilityId;
                    if (capabilityId) void window.metis?.useFileCapability({ capabilityId, operation: 'file' });
                  }}>
                    {t('papers.openPdf')}
                  </button>
                  <button className="btn-secondary btn-sm" onClick={async () => {
                    const result = await window.metis?.detachPaperPdf(selected.id);
                    if (result?.success) await updatePaper(selected.id, { pdfCapability: undefined, pdfText: undefined });
                  }}>
                    {t('papers.removePdf')}
                  </button>
                </div>
              ) : (
                <div>
                  <button className="btn-secondary" onClick={async () => {
                    const result = await window.metis?.attachPaperPdf(selected.id);
                    if (result?.success) {
                      await updatePaper(selected.id, { pdfCapability: result.pdfCapability, pdfText: undefined });
                    }
                  }}>
                    {t('papers.attachPdf')}
                  </button>
                </div>
              )}
              {pdfDownloadError[selected.id] && (
                <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 13, marginTop: 6 }}>
                  {pdfDownloadError[selected.id]}
                </div>
              )}
              {!hasPdfAttachment(selected) && (pdfDownloadUrls[selected.id] || selected.pdfUrl) && (
                <button
                  className="btn-secondary btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => void downloadAndAttachPdf(selected.id, pdfDownloadUrls[selected.id] || selected.pdfUrl)}
                  disabled={pdfDownloadLoading.has(selected.id)}
                >
                  {pdfDownloadLoading.has(selected.id) ? t('common.loading') : (pdfDownloadUrls[selected.id] ? t('papers.pdfRetryDownload') : t('papers.pdfDownload'))}
                </button>
              )}
              {!hasPdfAttachment(selected) && selected.pdfUrl && (
                <button
                  className="btn-secondary btn-sm"
                  style={{ marginTop: 8, marginLeft: 8 }}
                  onClick={() => { void window.metis?.openExternal?.(selected.pdfUrl ?? ''); }}
                >
                  {t('papers.openPdf')}
                </button>
              )}
            </div>
            {hasPdfAttachment(selected) && (
              <div className="detail-pdf-actions" style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => void handleGenerateSummaryTags()}
                  disabled={summaryLoading}
                >
                  {summaryLoading ? t('common.loading') : t('papers.generateSummaryTags')}
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => void handleIndexPdfText()}
                  disabled={pdfIndexLoading}
                >
                  {pdfIndexLoading ? t('common.loading') : selected.pdfText ? t('papers.reindexPdf') : t('papers.indexPdf')}
                </button>
                {selected.pdfText && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>
                    {t('papers.pdfIndexedChars', { chars: selected.pdfText.length })}
                  </span>
                )}
                {summaryError && <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 13, marginTop: 6, width: '100%' }}>{summaryError}</div>}
                {pdfIndexError && <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 13, marginTop: 6, width: '100%' }}>{pdfIndexError}</div>}
              </div>
            )}
            {hasPdfAttachment(selected) && (
              <div className="detail-pdf-chat">
                <div className="detail-section-header">
                  <h3>{t('papers.pdfChat')}</h3>
                  <button
                    className="btn-sm btn-secondary"
                    onClick={() => setPdfChatOpen((prev) => !prev)}
                  >
                    {pdfChatOpen ? t('common.close') : t('common.open')}
                  </button>
                </div>
                {pdfChatOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {pdfContext ? (
                      <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>
                        {t('papers.pdfChatLoaded', { chars: pdfContext.length })}
                      </div>
                    ) : (
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => void handleLoadPdfContext()}
                        disabled={pdfContextLoading}
                      >
                        {pdfContextLoading ? t('common.loading') : t('papers.pdfChatLoad')}
                      </button>
                    )}
                    {pdfChatError && <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 13 }}>{pdfChatError}</div>}
                    <div className="pdf-chat-messages" style={{ maxHeight: 240, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: 8, background: 'var(--bg-secondary, #f7fafc)', borderRadius: 6 }}>
                      {pdfChatMessages.map((msg, idx) => (
                        <div key={idx} style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                          <strong>{msg.role === 'user' ? 'Q' : 'A'}:</strong>{' '}
                          <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                        </div>
                      ))}
                      {pdfChatMessages.length === 0 && pdfContext && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.pdfChatPlaceholder')}</div>
                      )}
                    </div>
                    <div className="pdf-chat-input" style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        value={pdfChatInput}
                        onChange={(e) => setPdfChatInput(e.target.value)}
                        placeholder={t('papers.pdfChatPlaceholder')}
                        className="settings-input"
                        style={{ flex: 1, fontSize: 13 }}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handlePdfChatSend(); }}
                        disabled={pdfChatLoading || !pdfContext}
                      />
                      <button
                        className="btn-primary btn-sm"
                        onClick={() => void handlePdfChatSend()}
                        disabled={pdfChatLoading || !pdfContext || !pdfChatInput.trim()}
                      >
                        {pdfChatLoading ? t('common.loading') : t('papers.pdfChatSend')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {(selected.doi || selected.arxivId) && (
              <div className="detail-related-papers">
                <div className="detail-section-header">
                  <h3>{t('papers.relatedPapers')}</h3>
                  <button
                    className="btn-sm btn-secondary"
                    onClick={() => setRelatedOpen((prev) => !prev)}
                  >
                    {relatedOpen ? t('common.close') : t('common.open')}
                  </button>
                </div>
                {relatedOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className={`btn-sm ${relatedType === 'citations' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => void handleLoadRelated('citations')}
                        disabled={relatedLoading}
                      >
                        {t('papers.relatedPapersLoadCitations')}
                      </button>
                      <button
                        className={`btn-sm ${relatedType === 'references' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => void handleLoadRelated('references')}
                        disabled={relatedLoading}
                      >
                        {t('papers.relatedPapersLoadReferences')}
                      </button>
                      <button
                        className={`btn-sm ${relatedView === 'list' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setRelatedView('list')}
                      >
                        {t('papers.relatedPapersList')}
                      </button>
                      <button
                        className={`btn-sm ${relatedView === 'graph' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setRelatedView('graph')}
                      >
                        {t('papers.relatedPapersGraph')}
                      </button>
                    </div>
                    {relatedLoading && <div style={{ fontSize: 13, color: 'var(--text-muted, #718096)' }}>{t('common.loading')}</div>}
                    {relatedError && <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 13 }}>{relatedError}</div>}
                    {relatedView === 'graph' && relatedPapers.length > 0 ? (
                      <div style={{ height: 320, border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 6 }}>
                        <ReactFlow nodes={relatedGraph.nodes} edges={relatedGraph.edges} fitView attributionPosition="bottom-left">
                          <Background />
                          <Controls />
                        </ReactFlow>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflow: 'auto' }}>
                        {relatedPapers.map((paper) => (
                          <div key={paper.paperId} style={{ padding: 8, border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 6 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{paper.title}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted, #718096)', marginBottom: 4 }}>
                              {(paper.authors ?? []).map((a) => a.name).join(', ') || t('papers.unknownAuthors')} · {paper.year ?? 'n.d.'}{paper.venue ? ` · ${paper.venue}` : ''}
                            </div>
                            <button
                              className="btn-sm btn-primary"
                              onClick={() => void handleImportRelated(paper)}
                            >
                              {t('papers.relatedPapersImport')}
                            </button>
                          </div>
                        ))}
                        {relatedPapers.length === 0 && !relatedLoading && !relatedError && (
                          <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.relatedPapersEmpty')}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="detail-citation" style={{ marginTop: 16 }}>
              <div className="detail-section-header">
                <h3>{t('papers.citationPreview')}</h3>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select
                    className="detail-select"
                    value={citationFormat}
                    onChange={(e) => setCitationFormat(e.target.value as CitationFormat)}
                    style={{ fontSize: 12 }}
                  >
                    <option value="apa">APA</option>
                    <option value="mla">MLA</option>
                    <option value="chicago">Chicago</option>
                    <option value="ieee">IEEE</option>
                    <option value="gbt7714">GB/T 7714</option>
                    <option value="vancouver">Vancouver</option>
                  </select>
                  <button
                    className="btn-sm btn-secondary"
                    onClick={() => {
                      void navigator.clipboard.writeText(formatCitation(selected, citationFormat));
                      setCitationCopied(true);
                      setTimeout(() => setCitationCopied(false), 1500);
                    }}
                  >
                    {citationCopied ? t('papers.citationCopied') : t('papers.copyCitation')}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-secondary, #f7fafc)', padding: 10, borderRadius: 6, marginTop: 6 }}>
                {formatCitation(selected, citationFormat)}
              </div>
            </div>
            <div className="detail-similar-papers" style={{ marginTop: 16 }}>
              <div className="detail-section-header">
                <h3>{t('papers.similarPapers')}</h3>
                <button
                  className="btn-sm btn-secondary"
                  onClick={() => setSimilarOpen((prev) => !prev)}
                >
                  {similarOpen ? t('common.close') : t('common.open')}
                </button>
              </div>
              {similarOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {similarPapers.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.similarPapersEmpty')}</div>
                  )}
                  {similarPapers.map(({ paper, score }) => (
                    <div key={paper.id} style={{ padding: 8, border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 6 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{paper.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted, #718096)', marginBottom: 4 }}>
                        {paper.authors.join(', ') || t('papers.unknownAuthors')} · {paper.year}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--accent-primary, #3182ce)' }}>
                        {t('papers.similarityScore', { score })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="detail-linked-items" style={{ marginTop: 16 }}>
              <div className="detail-section-header">
                <h3>{t('papers.linkedNotes')}</h3>
              </div>
              {notes.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.linkedNotesEmpty')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {notes.map((note) => {
                    const linked = selected ? note.linkedPaperIds.includes(selected.id) : false;
                    return (
                      <label key={note.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-color, #e2e8f0)' }}>
                        <input type="checkbox" checked={linked} onChange={() => handleToggleNoteLink(note.id)} />
                        <span style={{ fontSize: 13 }}>{note.title}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="detail-section-header" style={{ marginTop: 14 }}>
                <h3>{t('papers.linkedExperiments')}</h3>
              </div>
              {experiments.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.linkedExperimentsEmpty')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {experiments.map((exp) => {
                    const linked = selected ? exp.linkedPaperIds.includes(selected.id) : false;
                    return (
                      <label key={exp.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-color, #e2e8f0)' }}>
                        <input type="checkbox" checked={linked} onChange={() => handleToggleExperimentLink(exp.id)} />
                        <span style={{ fontSize: 13 }}>{exp.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted, #718096)' }}>({exp.status})</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="detail-empty">
            <h3>{t('papers.selectToView')}</h3>
            <p>{t('papers.libraryCount', { count: papers.length })}</p>
          </div>
        )}
        {selected && (
          <div className="detail-references" style={{ marginTop: 16 }}>
            <div className="detail-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>{t('papers.references')}</h3>
              <button
                className="btn-sm btn-secondary"
                data-testid="paper-check-citations"
                onClick={() => handleCheckCitations(selected)}
                disabled={selected.referenceIds.length === 0}
              >
                {t('papers.checkCitations')}
              </button>
            </div>
            {selected.referenceIds.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.referencesEmpty')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {selected.referenceIds.map((refId) => {
                  const ref = papers.find((p) => p.id === refId);
                  if (!ref) return null;
                  return (
                    <div
                      key={refId}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: 6,
                        border: '1px solid var(--border-color, #e2e8f0)',
                        borderRadius: 6,
                      }}
                    >
                      <button
                        className="btn-link"
                        style={{ textAlign: 'left', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-primary, #3182ce)' }}
                        onClick={() => setSelectedPaperId(refId)}
                      >
                        {ref.title}
                      </button>
                      <button
                        className="btn-sm"
                        onClick={() => void removePaperReference(selected.id, refId)}
                      >
                        {t('common.remove')}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {(() => {
              const available = papers.filter((p) => p.id !== selected.id && !selected.referenceIds.includes(p.id));
              return available.length > 0 ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <select
                    className="detail-select"
                    value={referenceInput}
                    onChange={(e) => setReferenceInput(e.target.value)}
                    style={{ flex: 1 }}
                  >
                    <option value="">{t('papers.addReferencePlaceholder')}</option>
                    {available.map((p) => (
                      <option key={p.id} value={p.id}>{p.title}</option>
                    ))}
                  </select>
                  <button
                    className="btn-sm btn-primary"
                    disabled={!referenceInput}
                    onClick={() => { void addPaperReference(selected.id, referenceInput); setReferenceInput(''); }}
                  >
                    {t('papers.addReference')}
                  </button>
                </div>
              ) : null;
            })()}
            <div className="detail-section-header" style={{ marginTop: 14 }}>
              <h3>{t('papers.citedBy')}</h3>
            </div>
            {(() => {
              const citedBy = papers.filter((p) => p.referenceIds.includes(selected.id));
              return citedBy.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)' }}>{t('papers.citedByEmpty')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {citedBy.map((p) => (
                    <button
                      key={p.id}
                      className="btn-link"
                      style={{ textAlign: 'left', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-primary, #3182ce)' }}
                      onClick={() => setSelectedPaperId(p.id)}
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        )}
      </main>
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('papers.importTitle')}</h3>
            <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)', marginBottom: 6 }}>
              {t('papers.importDoiLabel')}
            </div>
            <textarea value={importText} onChange={(e) => { setImportText(e.target.value); setImportError(''); setImportNotice(''); }}
              placeholder={t('papers.importPlaceholder')} rows={8} disabled={importResolving} />
            {importError && <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 13, marginTop: 4 }}>{importError}</div>}
            {importNotice && (
              <div style={{ color: 'var(--status-success, #38a169)', fontSize: 13, marginTop: 4 }}>
                {importNotice}
                {mergedPaper && (
                  <button
                    type="button"
                    className="btn-sm btn-link"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      setSelectedPaperId(mergedPaper.id);
                      setShowForm(false);
                      setImportNotice('');
                      setMergedPaper(null);
                    }}
                  >
                    {t('papers.viewMergedPaper', { title: mergedPaper.title })}
                  </button>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setShowForm(false); setImportError(''); setImportNotice(''); setMergedPaper(null); }}>{t('common.cancel')}</button>
              <button className="btn-primary" onClick={handleImport} disabled={importResolving}>
                {importResolving ? t('papers.importResolving') : t('papers.importSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showExport && (
        <div className="modal-overlay" onClick={() => setShowExport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('papers.exportTitle')}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              <button className="btn-primary" onClick={() => handleExport('bibtex')}>{t('papers.exportFormatBibtex')}</button>
              <button className="btn-primary" onClick={() => handleExport('csv')}>{t('papers.exportFormatCsv')}</button>
            </div>
            {importNotice && <div style={{ color: 'var(--status-success, #38a169)', fontSize: 13, marginTop: 8 }}>{importNotice}</div>}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setShowExport(false); setImportNotice(''); }}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
      {showCitationsExport && (
        <div className="modal-overlay" onClick={() => setShowCitationsExport(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>{t('papers.exportCitations')}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <select
                className="detail-select"
                value={citationFormat}
                onChange={(e) => setCitationFormat(e.target.value as CitationFormat)}
                style={{ fontSize: 12 }}
              >
                <option value="apa">APA</option>
                <option value="mla">MLA</option>
                <option value="chicago">Chicago</option>
                <option value="ieee">IEEE</option>
                <option value="gbt7714">GB/T 7714</option>
                <option value="vancouver">Vancouver</option>
              </select>
              <button
                className="btn-sm btn-secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(exportCitationsText(filtered, citationFormat));
                  setCitationsExportCopied(true);
                  setTimeout(() => setCitationsExportCopied(false), 1500);
                }}
              >
                {citationsExportCopied ? t('papers.citationCopied') : t('papers.copyAll')}
              </button>
              <button
                className="btn-sm btn-secondary"
                onClick={() => downloadTextFile(exportCitationsText(filtered, citationFormat), `citations-${citationFormat}.txt`)}
              >
                {t('common.download')}
              </button>
            </div>
            <textarea
              readOnly
              value={exportCitationsText(filtered, citationFormat)}
              rows={10}
              className="settings-input"
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
            />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowCitationsExport(false)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
      {showSearch && (
        <div className="modal-overlay" onClick={() => setShowSearch(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>{t('papers.searchTitle')}</h3>
            <div className="search-row" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('papers.searchInputPlaceholder')}
                className="search-input"
                style={{ flex: 1 }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
              />
              <button className="btn-primary" onClick={() => void handleSearch()} disabled={searchLoading}>
                {searchLoading ? t('common.loading') : t('papers.searchSubmit')}
              </button>
            </div>
            {searchError && <div style={{ color: 'var(--status-failed, #e53e3e)', fontSize: 13, marginBottom: 8 }}>{searchError}</div>}
            {importNotice && <div style={{ color: 'var(--status-success, #38a169)', fontSize: 13, marginBottom: 8 }}>{importNotice}</div>}
            {searchResults.length > 0 && (
              <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--text-muted, #718096)' }}>
                {t('papers.searchResultCount', { count: searchTotal })}
              </div>
            )}
            <div className="search-results" style={{ maxHeight: 360, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {searchResults.map((paper) => {
                const authors = (paper.authors ?? []).map((a) => a.name).join(', ') || t('papers.unknownAuthors');
                const isImporting = importingIds.has(paper.paperId);
                const openAccessPdfUrl = paper.openAccessPdf?.url;
                return (
                  <div key={paper.paperId} className="search-result-card" style={{ padding: 10, border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 6 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{paper.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #718096)', marginBottom: 4 }}>
                      {authors} · {paper.year ?? 'n.d.'}{paper.venue ? ` · ${paper.venue}` : ''}
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text-secondary, #4a5568)' }}>
                      {paper.abstract ? `${paper.abstract.slice(0, 240)}${paper.abstract.length > 240 ? '...' : ''}` : t('papers.noAbstract')}
                    </div>
                    <div className="search-result-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        className="btn-sm btn-primary"
                        onClick={() => void handleImportResult(paper)}
                        disabled={isImporting}
                      >
                        {isImporting ? t('common.loading') : t('papers.importResult')}
                      </button>
                      {openAccessPdfUrl && (
                        <button
                          type="button"
                          className="btn-sm btn-secondary"
                          onClick={() => { void window.metis?.openExternal(openAccessPdfUrl); }}
                        >
                          {t('common.open')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {searchResults.length === 0 && !searchLoading && !searchError && (
                <div className="empty-list">{t('papers.searchEmpty')}</div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setShowSearch(false); setSearchError(''); setImportNotice(''); }}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
      {showDeleteConfirm && selected && (
        <ConfirmDialog
          title={t('common.confirmDeleteTitle')}
          message={t('common.confirmDeleteMessage')}
          onConfirm={() => { void removePaper(selected.id); setShowDeleteConfirm(false); }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
      {showBulkDeleteConfirm && (
        <ConfirmDialog
          title={t('papers.bulkDeleteConfirmTitle')}
          message={t('papers.bulkDeleteConfirmMessage', { count: selectedIds.size })}
          onConfirm={() => { void confirmBulkDelete(); }}
          onCancel={() => setShowBulkDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
