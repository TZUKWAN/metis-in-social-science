/**
 * ZoteroImportService — import Zotero library items into the local paper
 * library from the main process.
 *
 * The Zotero API key lives in the personalization secret vault, which only the
 * main process can decrypt (the renderer only sees metadata). This service runs
 * in main: it resolves the key from the vault, searches the user's Zotero
 * library, converts items to the local PaperItem shape, deduplicates by
 * normalized DOI/arXiv/title against existing papers, and persists via
 * PersistenceStore.savePaper. Network failures are reported as structured
 * results, never thrown to the renderer.
 */

import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';

export interface ZoteroImportOptions {
  apiKeyResolver: () => string | undefined;
  store: PersistenceStore;
  /**
   * Optional project linker invoked for every imported/merged paper when the
   * import request carries a projectId. The host uses it to set papers.project_id
   * and upsert the project source row.
   */
  linkToProject?: (paper: { id: string; title: string; authors: string[]; year: number; venue: string; doi?: string; arxivId?: string }) => void;
}

export interface ZoteroImportRequest {
  libraryType: 'personal' | 'group';
  libraryId: string;
  query?: string;
  maxItems?: number;
  /** When set, every imported/merged paper is linked to this project. */
  projectId?: string;
}

export interface ZoteroImportResult {
  ok: boolean;
  imported: number;
  merged: number;
  skipped: number;
  error?: string;
  items: Array<{ title: string; merged: boolean }>;
}

function normalizeDoi(doi?: string): string {
  if (!doi) return '';
  return doi.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').trim();
}

function normalizeArxiv(id?: string): string {
  if (!id) return '';
  return id.toLowerCase().replace(/^arxiv:/i, '').replace(/^arxiv\.org\/abs\//i, '').trim();
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export class ZoteroImportService {
  readonly #options: ZoteroImportOptions;

  constructor(options: ZoteroImportOptions) {
    this.#options = options;
  }

  /** Import items from the user's Zotero library. */
  async import(request: ZoteroImportRequest): Promise<ZoteroImportResult> {
    const apiKey = this.#options.apiKeyResolver();
    if (!apiKey || !request.libraryId.trim()) {
      return { ok: false, imported: 0, merged: 0, skipped: 0, error: 'zotero_not_configured', items: [] };
    }
    try {
      const { searchZoteroLibrary, zoteroItemToPlain } = await import('../engine/research/ZoteroClient.js');
      const result = await searchZoteroLibrary({
        apiKey,
        libraryType: request.libraryType,
        libraryId: request.libraryId.trim(),
        query: request.query?.trim() ?? '',
        start: 0,
        maxResults: Math.min(50, request.maxItems ?? 20),
      });
      if (!result.items || result.items.length === 0) {
        return { ok: true, imported: 0, merged: 0, skipped: 0, items: [] };
      }

      const existing = this.#options.store.getPapers();
      const byDoi = new Map(existing.map((p) => [normalizeDoi(p.doi), p]));
      const byArxiv = new Map(existing.map((p) => [normalizeArxiv(p.arxivId), p]));
      const byTitle = new Map(existing.map((p) => [normalizeTitle(p.title), p]));

      let imported = 0;
      let merged = 0;
      let skipped = 0;
      const items: Array<{ title: string; merged: boolean }> = [];

      for (const raw of result.items) {
        const plain = zoteroItemToPlain(raw as never) as Record<string, unknown>;
        const title = String(plain.title ?? '').trim();
        if (!title) { skipped++; continue; }
        const doi = String(plain.doi ?? '').trim();
        const arxivId = String(plain.arxivId ?? '').trim();
        const match = (doi && byDoi.get(normalizeDoi(doi)))
          || (arxivId && byArxiv.get(normalizeArxiv(arxivId)))
          || byTitle.get(normalizeTitle(title));

        const authors = Array.isArray(plain.authors)
          ? (plain.authors as unknown[]).map((a) => String(a)).filter(Boolean)
          : [];
        const year = Number(plain.year ?? new Date().getFullYear());

        if (match) {
          // Merge missing fields into the existing record.
          const updated = { ...match, doi: match.doi ?? doi, arxivId: match.arxivId ?? arxivId, venue: match.venue || String(plain.venue ?? ''), abstract: match.abstract || String(plain.abstract ?? ''), tags: [...new Set([...match.tags, ...(Array.isArray(plain.tags) ? (plain.tags as string[]) : [])])], projectId: match.projectId ?? request.projectId };
          this.#options.store.savePaper(updated as never);
          merged++;
          items.push({ title, merged: true });
          if (request.projectId && this.#options.linkToProject) {
            this.#options.linkToProject({ id: match.id, title: match.title, authors: match.authors, year: match.year, venue: match.venue, doi: match.doi, arxivId: match.arxivId });
          }
          continue;
        }
        const id = `paper_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        this.#options.store.savePaper({
          id,
          title,
          authors,
          year,
          venue: String(plain.venue ?? ''),
          abstract: String(plain.abstract ?? ''),
          doi: doi || undefined,
          arxivId: arxivId || undefined,
          url: String(plain.url ?? '') || undefined,
          tags: Array.isArray(plain.tags) ? (plain.tags as string[]) : [],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          addedAt: Date.now(),
          projectId: request.projectId,
        } as never);
        imported++;
        items.push({ title, merged: false });
        if (request.projectId && this.#options.linkToProject) {
          this.#options.linkToProject({ id, title, authors, year, venue: String(plain.venue ?? ''), doi: doi || undefined, arxivId: arxivId || undefined });
        }
      }

      return { ok: true, imported, merged, skipped, items };
    } catch (err) {
      return { ok: false, imported: 0, merged: 0, skipped: 0, error: err instanceof Error ? err.message : 'zotero_import_failed', items: [] };
    }
  }
}
