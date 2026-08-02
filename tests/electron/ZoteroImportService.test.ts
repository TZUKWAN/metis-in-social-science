/**
 * Tests for ZoteroImportService — Zotero → local library import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ZoteroImportService } from '../../electron/ZoteroImportService.js';

const searchMock = vi.fn();

vi.mock('../../engine/research/ZoteroClient.js', () => ({
  searchZoteroLibrary: (opts: unknown) => searchMock(opts),
  zoteroItemToPlain: (item: { data: Record<string, unknown>; key: string }) => ({
    key: item.key,
    title: item.data.title,
    authors: item.data.authors ?? [],
    year: item.data.year ?? 2024,
    venue: item.data.venue ?? '',
    doi: item.data.DOI,
    abstract: item.data.abstract ?? '',
    tags: item.data.tags ?? [],
    url: item.data.url,
  }),
}));

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-zotero-import-'));
}

function makeStore(dir: string): PersistenceStore {
  return new PersistenceStore(path.join(dir, 'test.db'));
}

describe('ZoteroImportService', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    store = makeStore(dir);
    searchMock.mockReset();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports new items and persists them', async () => {
    searchMock.mockResolvedValue({
      items: [
        { key: 'k1', data: { title: 'Zotero Paper One', DOI: '10.1/z1', year: 2023, venue: 'J', authors: ['Ada'], abstract: 'abs', tags: ['zotero'], url: 'https://example.com' } },
      ],
    });
    const service = new ZoteroImportService({ store, apiKeyResolver: () => 'secret-key' });
    const result = await service.import({ userId: '12345' });
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    expect(result.merged).toBe(0);
    const papers = store.getPapers();
    expect(papers).toHaveLength(1);
    expect(papers[0]!.doi).toBe('10.1/z1');
    expect(papers[0]!.title).toBe('Zotero Paper One');
  });

  it('merges into an existing paper with the same DOI', async () => {
    store.savePaper({
      id: 'paper-existing', title: 'Old Title', authors: [], year: 2020, venue: '',
      abstract: '', doi: '10.1/z1', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
    });
    searchMock.mockResolvedValue({
      items: [{ key: 'k1', data: { title: 'Zotero Paper One', DOI: '10.1/z1', year: 2023, venue: 'J', tags: ['new-tag'] } }],
    });
    const service = new ZoteroImportService({ store, apiKeyResolver: () => 'secret-key' });
    const result = await service.import({ userId: '12345' });
    expect(result.imported).toBe(0);
    expect(result.merged).toBe(1);
    const papers = store.getPapers();
    expect(papers).toHaveLength(1);
    expect(papers[0]!.tags).toContain('new-tag');
  });

  it('skips items without a title', async () => {
    searchMock.mockResolvedValue({ items: [{ key: 'k1', data: { title: '', DOI: '10.1/x' } }] });
    const service = new ZoteroImportService({ store, apiKeyResolver: () => 'secret-key' });
    const result = await service.import({ userId: '12345' });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(1);
    expect(store.getPapers()).toHaveLength(0);
  });

  it('reports not-configured when the key is missing', async () => {
    const service = new ZoteroImportService({ store, apiKeyResolver: () => undefined });
    const result = await service.import({ userId: '12345' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('zotero_not_configured');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('reports structured failure on network error', async () => {
    searchMock.mockRejectedValue(new Error('api down'));
    const service = new ZoteroImportService({ store, apiKeyResolver: () => 'secret-key' });
    const result = await service.import({ userId: '12345' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('api down');
  });
});
