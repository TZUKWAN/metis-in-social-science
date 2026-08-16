/**
 * Tests for ZoteroClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../engine/research/PdfReader.js', () => ({
  getPdfReader: () => ({
    readFile: vi.fn().mockResolvedValue({
      metadata: { title: 'Mock PDF', author: '', keywords: [] },
      totalPages: 3,
      pages: [
        { pageNumber: 1, text: 'Page one text' },
        { pageNumber: 2, text: 'Page two text' },
      ],
    }),
  }),
}));

import {
  searchZoteroLibrary,
  zoteroItemToPlain,
  createZoteroItem,
  getZoteroItem,
  zoteroChildToPlain,
  listZoteroCollections,
  zoteroCollectionToPlain,
  findDuplicateZoteroItems,
  updateZoteroItemTags,
  createZoteroCollection,
  readZoteroAttachment,
} from '../../engine/research/ZoteroClient.js';

describe('ZoteroClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, headers: Record<string, string> = {}, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      headers: new Map(Object.entries(headers)) as unknown as Headers,
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as Response);
  }

  function mockFetchRaw(response: Partial<Response>) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(response as Response);
  }

  it('searches a user library and parses items', async () => {
    mockFetch(
      [
        {
          key: 'ABC123',
          version: 1,
          library: { type: 'user', id: 12345 },
          links: { alternate: { href: 'https://www.zotero.org/users/12345/items/ABC123' } },
          data: {
            key: 'ABC123',
            itemType: 'journalArticle',
            title: 'Transformer Efficiency',
            creators: [{ creatorType: 'author', firstName: 'Alice', lastName: 'Author' }],
            date: '2023',
            DOI: '10.1234/example',
            publicationTitle: 'Journal of Examples',
            abstractNote: 'We improve transformers.',
          },
        },
      ],
      { 'Total-Results': '42' },
    );

    const result = await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      query: 'transformer',
      maxResults: 5,
    });

    expect(result.totalResults).toBe(42);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.data.title).toBe('Transformer Efficiency');
    expect(result.lastVersion).toBe(1);

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('/users/12345/items');
    expect(url).toContain('q=transformer');
  });

  it('searches a group library when groupId is provided', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      groupId: '67890',
      apiKey: 'secret',
      query: 'nlp',
      maxResults: 10,
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('/groups/67890/items');
  });

  it('adds a tag filter when tag is provided', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      query: 'nlp',
      tag: 'important',
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('tag=important');
  });

  it('adds a since version parameter for incremental sync', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      query: 'nlp',
      since: 1234567,
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('since=1234567');
  });

  it('adds sort and order parameters when provided', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      query: 'nlp',
      sort: 'dateModified',
      order: 'desc',
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('sort=dateModified');
    expect(url).toContain('order=desc');
  });

  it('uses a collection-specific path when collectionKey is provided', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      query: 'nlp',
      collectionKey: 'ABC123',
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('/users/12345/collections/ABC123/items');
  });

  it('adds a qmode parameter when provided', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      query: 'nlp',
      qmode: 'titleCreatorYear',
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('qmode=titleCreatorYear');
  });

  it('adds a start offset for pagination when provided', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      query: 'nlp',
      start: 50,
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('start=50');
  });

  it('throws when both userId and groupId are missing', async () => {
    await expect(
      searchZoteroLibrary({ apiKey: 'secret', query: 'x' }),
    ).rejects.toThrow('A single Zotero library type and ID are required.');
  });

  it('rejects ambiguous user+group input instead of silently preferring the personal library', async () => {
    await expect(
      searchZoteroLibrary({ apiKey: 'secret', userId: '1', groupId: '2', query: 'x' }),
    ).rejects.toThrow('A single Zotero library type and ID are required.');
  });

  it('prefers the explicit library type and ID over legacy fields', async () => {
    mockFetch([], {});
    await searchZoteroLibrary({
      libraryType: 'group',
      libraryId: '999',
      userId: '1',
      groupId: '2',
      apiKey: 'secret',
      query: 'x',
    });
    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('/groups/999/items');
  });

  it('throws when apiKey is empty', async () => {
    await expect(searchZoteroLibrary({ userId: '1', apiKey: '', query: 'x' })).rejects.toThrow('apiKey is required.');
  });

  it('allows an empty query when a tag filter is provided', async () => {
    mockFetch([], {});

    await searchZoteroLibrary({
      userId: '12345',
      apiKey: 'secret',
      tag: 'must-read',
    });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('tag=must-read');
    expect(url).not.toContain('q=');
  });

  it('converts an item to a plain object', () => {
    const plain = zoteroItemToPlain({
      key: 'ABC123',
      version: 42,
      data: {
        key: 'ABC123',
        itemType: 'journalArticle',
        title: 'Sample Paper',
        creators: [{ creatorType: 'author', firstName: 'B.', lastName: 'Researcher' }],
        date: '2022-05-10',
        dateAdded: '2022-05-10T10:00:00Z',
        dateModified: '2023-01-15T12:00:00Z',
        DOI: '10.5678/sample',
        publicationTitle: 'AI Journal',
        abstractNote: 'Abstract text.',
        tags: [{ tag: 'nlp' }],
      },
    });

    expect(plain.title).toBe('Sample Paper');
    expect(plain.authors).toEqual(['B. Researcher']);
    expect(plain.year).toBe(2022);
    expect(plain.doi).toBe('10.5678/sample');
    expect(plain.tags).toEqual(['nlp']);
    expect(plain.version).toBe(42);
    expect(plain.dateAdded).toBe('2022-05-10T10:00:00Z');
    expect(plain.dateModified).toBe('2023-01-15T12:00:00Z');
  });

  describe('createZoteroItem', () => {
    it('creates an item in a user library and returns the key', async () => {
      mockFetch({ successful: { '0': { key: 'NEWITEM' } } });

      const result = await createZoteroItem({
        userId: '12345',
        apiKey: 'secret',
        item: { itemType: 'journalArticle', title: 'A Paper' },
      });

      expect(result.success).toBe(true);
      expect(result.key).toBe('NEWITEM');
      expect(result.url).toBe('https://www.zotero.org/users/12345/items/NEWITEM');

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
      expect(url).toContain('/users/12345/items');
      expect(init?.method).toBe('POST');
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ itemType: 'journalArticle', title: 'A Paper' });
    });

    it('creates an item in a group library', async () => {
      mockFetch({ successful: { '0': { key: 'GROUPITEM' } } });

      const result = await createZoteroItem({
        groupId: '67890',
        apiKey: 'secret',
        item: { itemType: 'preprint', title: 'Preprint' },
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://www.zotero.org/groups/67890/items/GROUPITEM');

      const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
      expect(url).toContain('/groups/67890/items');
    });

    it('returns a failure result when the Zotero API errors', async () => {
      mockFetch({ error: 'Forbidden' }, {}, 403);

      const result = await createZoteroItem({
        userId: '12345',
        apiKey: 'secret',
        item: { itemType: 'journalArticle', title: 'A Paper' },
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('403');
    });

    it('throws when apiKey is missing', async () => {
      await expect(
        createZoteroItem({ userId: '12345', apiKey: '', item: { itemType: 'journalArticle', title: 'A Paper' } }),
      ).rejects.toThrow('apiKey is required.');
    });

    it('throws when both userId and groupId are missing', async () => {
      await expect(
        createZoteroItem({ apiKey: 'secret', item: { itemType: 'journalArticle', title: 'A Paper' } }),
      ).rejects.toThrow('Either userId or groupId is required.');
    });

    it('succeeds without a key when Zotero omits it', async () => {
      mockFetch({ successful: {} });

      const result = await createZoteroItem({
        userId: '12345',
        apiKey: 'secret',
        item: { itemType: 'journalArticle', title: 'A Paper' },
      });

      expect(result.success).toBe(true);
      expect(result.key).toBeUndefined();
      expect(result.url).toBeUndefined();
      expect(result.message).toBe('Item created in Zotero.');
    });

    it('omits undefined and empty string fields from the POST payload', async () => {
      mockFetch({ successful: { '0': { key: 'CLEANITEM' } } });

      await createZoteroItem({
        userId: '12345',
        apiKey: 'secret',
        item: {
          itemType: 'journalArticle',
          title: 'A Paper',
          DOI: '10.1234/example',
          date: '',
          abstractNote: undefined,
          creators: [{ creatorType: 'author', firstName: 'A.', lastName: 'Author' }],
        },
      });

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body[0]).toHaveProperty('itemType');
      expect(body[0]).toHaveProperty('title');
      expect(body[0]).toHaveProperty('DOI');
      expect(body[0]).not.toHaveProperty('date');
      expect(body[0]).not.toHaveProperty('abstractNote');
      expect(body[0]).not.toHaveProperty('ISBN');
      expect(body[0]).toHaveProperty('creators');
      expect(body[0]).toHaveProperty('tags');
    });

    it('returns a failure result when the network request is aborted', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('The operation was aborted.'));

      const result = await createZoteroItem({
        userId: '12345',
        apiKey: 'secret',
        item: { itemType: 'journalArticle', title: 'A Paper' },
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('aborted');
    });

    it('returns a failure result when fetch throws a network error', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('fetch failed'));

      const result = await createZoteroItem({
        userId: '12345',
        apiKey: 'secret',
        item: { itemType: 'journalArticle', title: 'A Paper' },
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('fetch failed');
    });
  });

  describe('getZoteroItem', () => {
    it('fetches a single item by key', async () => {
      mockFetch(
        {
          key: 'ITEM1',
          version: 2,
          library: { type: 'user', id: 12345 },
          data: {
            key: 'ITEM1',
            itemType: 'journalArticle',
            title: 'Single Item',
            creators: [{ creatorType: 'author', firstName: 'A.', lastName: 'Author' }],
            date: '2024',
            DOI: '10.1234/single',
          },
        },
        {},
      );

      const result = await getZoteroItem({ userId: '12345', apiKey: 'secret', itemKey: 'ITEM1' });

      expect(result.item.data.title).toBe('Single Item');
      expect(result.children).toEqual([]);

      const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
      expect(url).toContain('/users/12345/items/ITEM1');
    });

    it('fetches a group item with children', async () => {
      mockFetch(
        {
          key: 'ITEM2',
          version: 1,
          library: { type: 'group', id: 67890 },
          data: {
            key: 'ITEM2',
            itemType: 'journalArticle',
            title: 'Group Item',
            creators: [],
            date: '2023',
          },
        },
        {},
      );
      mockFetch(
        [
          {
            key: 'NOTE1',
            version: 1,
            data: {
              key: 'NOTE1',
              itemType: 'note',
              title: 'Note',
              note: '<p>Insight</p>',
            },
          },
        ],
        {},
      );

      const result = await getZoteroItem({
        groupId: '67890',
        apiKey: 'secret',
        itemKey: 'ITEM2',
        includeChildren: true,
      });

      expect(result.item.library?.type).toBe('group');
      expect(result.children).toHaveLength(1);
      expect(result.children[0]!.data.itemType).toBe('note');

      const urls = vi.mocked(globalThis.fetch).mock.calls.map((call) => call[0] as string);
      expect(urls[1]).toContain('/groups/67890/items/ITEM2/children');
    });

    it('throws when apiKey is missing', async () => {
      await expect(getZoteroItem({ userId: '12345', apiKey: '', itemKey: 'ITEM1' })).rejects.toThrow('apiKey is required.');
    });

    it('throws when itemKey is missing', async () => {
      await expect(getZoteroItem({ userId: '12345', apiKey: 'secret', itemKey: '' })).rejects.toThrow('itemKey is required.');
    });

    it('throws when library id is missing', async () => {
      await expect(getZoteroItem({ apiKey: 'secret', itemKey: 'ITEM1' })).rejects.toThrow('Either userId or groupId is required.');
    });
  });

  it('converts a note child to a plain object', () => {
    const plain = zoteroChildToPlain({
      key: 'NOTE1',
      version: 1,
      itemType: 'note',
      data: {
        key: 'NOTE1',
        itemType: 'note',
        title: 'Reading Note',
        note: '<p>Insight</p>',
        dateAdded: '2023-01-01T00:00:00Z',
        dateModified: '2023-01-02T00:00:00Z',
      },
    });

    expect(plain.itemType).toBe('note');
    expect(plain.note).toBe('<p>Insight</p>');
  });

  it('converts an attachment child to a plain object', () => {
    const plain = zoteroChildToPlain({
      key: 'ATT1',
      version: 1,
      itemType: 'attachment',
      data: {
        key: 'ATT1',
        itemType: 'attachment',
        title: 'PDF',
        linkMode: 'imported_file',
        contentType: 'application/pdf',
        filename: 'paper.pdf',
        url: 'https://example.com/paper.pdf',
      },
    });

    expect(plain.itemType).toBe('attachment');
    expect(plain.linkMode).toBe('imported_file');
    expect(plain.filename).toBe('paper.pdf');
  });

  describe('listZoteroCollections', () => {
    it('lists user collections', async () => {
      mockFetch(
        [
          {
            key: 'COL1',
            version: 1,
            data: { key: 'COL1', name: 'Reading List', numberOfItems: 12 },
            meta: { numItems: 12 },
          },
          {
            key: 'COL2',
            version: 1,
            data: { key: 'COL2', name: 'Thesis', parentCollection: 'COL1' },
          },
        ],
        { 'Total-Results': '2' },
      );

      const result = await listZoteroCollections({ userId: '12345', apiKey: 'secret' });

      expect(result.totalResults).toBe(2);
      expect(result.collections).toHaveLength(2);
      expect(result.collections[0]!.data.name).toBe('Reading List');

      const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
      expect(url).toContain('/users/12345/collections');
      expect(url).toContain('limit=100');
    });

    it('lists group collections', async () => {
      mockFetch([], { 'Total-Results': '0' });

      await listZoteroCollections({ groupId: '67890', apiKey: 'secret', maxResults: 10 });

      const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
      expect(url).toContain('/groups/67890/collections');
      expect(url).toContain('limit=10');
    });

    it('throws when apiKey is missing', async () => {
      await expect(listZoteroCollections({ userId: '12345', apiKey: '' })).rejects.toThrow('apiKey is required.');
    });

    it('throws when library id is missing', async () => {
      await expect(listZoteroCollections({ apiKey: 'secret' })).rejects.toThrow('Either userId or groupId is required.');
    });
  });

  it('converts a collection to a plain object', () => {
    const plain = zoteroCollectionToPlain({
      key: 'COL1',
      version: 1,
      data: { key: 'COL1', name: 'Reading List', parentCollection: 'ROOT', numberOfItems: 5 },
    });

    expect(plain.key).toBe('COL1');
    expect(plain.name).toBe('Reading List');
    expect(plain.parentCollectionKey).toBe('ROOT');
    expect(plain.itemCount).toBe(5);
  });

  describe('findDuplicateZoteroItems', () => {
    it('groups items with the same DOI', async () => {
      mockFetch(
        [
          {
            key: 'A1',
            version: 1,
            data: {
              key: 'A1',
              itemType: 'journalArticle',
              title: 'Duplicate Paper',
              DOI: '10.1234/dup',
            },
          },
          {
            key: 'A2',
            version: 1,
            data: {
              key: 'A2',
              itemType: 'journalArticle',
              title: 'Duplicate Paper Variant',
              DOI: '10.1234/dup',
            },
          },
        ],
        { 'Total-Results': '2' },
      );

      const groups = await findDuplicateZoteroItems({ userId: '12345', apiKey: 'secret', maxItems: 100 });

      expect(groups).toHaveLength(1);
      expect(groups[0]!.type).toBe('doi');
      expect(groups[0]!.items).toHaveLength(2);
    });

    it('groups items with the same normalized title', async () => {
      mockFetch(
        [
          {
            key: 'B1',
            version: 1,
            data: {
              key: 'B1',
              itemType: 'journalArticle',
              title: 'The Great Study: Part I',
            },
          },
          {
            key: 'B2',
            version: 1,
            data: {
              key: 'B2',
              itemType: 'journalArticle',
              title: 'The Great Study — Part I',
            },
          },
        ],
        { 'Total-Results': '2' },
      );

      const groups = await findDuplicateZoteroItems({ userId: '12345', apiKey: 'secret', maxItems: 100 });

      expect(groups).toHaveLength(1);
      expect(groups[0]!.type).toBe('title');
      expect(groups[0]!.items).toHaveLength(2);
    });

    it('returns an empty array when no duplicates exist', async () => {
      mockFetch(
        [
          {
            key: 'C1',
            version: 1,
            data: { key: 'C1', itemType: 'journalArticle', title: 'Unique Paper', DOI: '10.1234/unique' },
          },
        ],
        { 'Total-Results': '1' },
      );

      const groups = await findDuplicateZoteroItems({ userId: '12345', apiKey: 'secret', maxItems: 100 });

      expect(groups).toHaveLength(0);
    });

    it('paginates through large libraries', async () => {
      mockFetch(
        Array.from({ length: 100 }, (_, i) => ({
          key: `D${i}`,
          version: 1,
          data: { key: `D${i}`, itemType: 'journalArticle', title: `Paper ${i}` },
        })),
        { 'Total-Results': '250' },
      );
      mockFetch(
        Array.from({ length: 100 }, (_, i) => ({
          key: `E${i}`,
          version: 1,
          data: { key: `E${i}`, itemType: 'journalArticle', title: `Paper ${100 + i}` },
        })),
        { 'Total-Results': '250' },
      );
      mockFetch(
        Array.from({ length: 50 }, (_, i) => ({
          key: `F${i}`,
          version: 1,
          data: { key: `F${i}`, itemType: 'journalArticle', title: `Paper ${200 + i}` },
        })),
        { 'Total-Results': '250' },
      );

      const groups = await findDuplicateZoteroItems({ userId: '12345', apiKey: 'secret', maxItems: 250 });

      expect(groups).toHaveLength(0);
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);

      const urls = vi.mocked(globalThis.fetch).mock.calls.map((call) => call[0] as string);
      expect(urls[0]).toContain('start=0');
      expect(urls[1]).toContain('start=100');
      expect(urls[2]).toContain('start=200');
    });

    it('throws when apiKey is missing', async () => {
      await expect(findDuplicateZoteroItems({ userId: '12345', apiKey: '' })).rejects.toThrow('apiKey is required.');
    });

    it('throws when library id is missing', async () => {
      await expect(findDuplicateZoteroItems({ apiKey: 'secret' })).rejects.toThrow('Either userId or groupId is required.');
    });
  });

  describe('updateZoteroItemTags', () => {
    it('adds new tags to an item', async () => {
      mockFetch(
        {
          key: 'ITEM1',
          version: 5,
          data: {
            key: 'ITEM1',
            itemType: 'journalArticle',
            title: 'Tagged Paper',
            tags: [{ tag: 'existing' }],
          },
        },
        {},
      );
      mockFetch({}, {});

      const result = await updateZoteroItemTags({
        userId: '12345',
        apiKey: 'secret',
        itemKey: 'ITEM1',
        tags: ['must-read', 'existing'],
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Added 1 tag(s)');
      expect(result.message).toContain('must-read');

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[1]!;
      expect(init?.method).toBe('PATCH');
      const headers = init?.headers as Record<string, string>;
      expect(headers['If-Unmodified-Since-Version']).toBe('5');
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.tags).toEqual([{ tag: 'existing' }, { tag: 'must-read' }]);
    });

    it('returns success when all tags already exist', async () => {
      mockFetch(
        {
          key: 'ITEM2',
          version: 1,
          data: {
            key: 'ITEM2',
            itemType: 'journalArticle',
            title: 'Already Tagged',
            tags: [{ tag: 'reviewed' }],
          },
        },
        {},
      );

      const result = await updateZoteroItemTags({
        userId: '12345',
        apiKey: 'secret',
        itemKey: 'ITEM2',
        tags: ['reviewed'],
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('already present');
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    });

    it('returns failure when the API rejects the update', async () => {
      mockFetch(
        {
          key: 'ITEM3',
          version: 2,
          data: {
            key: 'ITEM3',
            itemType: 'journalArticle',
            title: 'Conflict Item',
            tags: [],
          },
        },
        {},
      );
      mockFetch({ error: 'Conflict' }, {}, 412);

      const result = await updateZoteroItemTags({
        groupId: '67890',
        apiKey: 'secret',
        itemKey: 'ITEM3',
        tags: ['new-tag'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('412');
    });

    it('throws when apiKey is missing', async () => {
      await expect(updateZoteroItemTags({ userId: '12345', apiKey: '', itemKey: 'ITEM1', tags: ['x'] })).rejects.toThrow('apiKey is required.');
    });

    it('throws when itemKey is missing', async () => {
      await expect(updateZoteroItemTags({ userId: '12345', apiKey: 'secret', itemKey: '', tags: ['x'] })).rejects.toThrow('itemKey is required.');
    });

    it('throws when tags array is empty', async () => {
      await expect(updateZoteroItemTags({ userId: '12345', apiKey: 'secret', itemKey: 'ITEM1', tags: [] })).rejects.toThrow('At least one tag is required.');
    });

    it('throws when library id is missing', async () => {
      await expect(updateZoteroItemTags({ apiKey: 'secret', itemKey: 'ITEM1', tags: ['x'] })).rejects.toThrow('Either userId or groupId is required.');
    });
  });

  describe('createZoteroCollection', () => {
    it('creates a collection in a user library', async () => {
      mockFetch(
        { successful: { '0': { key: 'COLL123' } } },
        {},
      );

      const result = await createZoteroCollection({
        userId: '12345',
        apiKey: 'secret',
        name: 'Thesis References',
      });

      expect(result.success).toBe(true);
      expect(result.key).toBe('COLL123');
      expect(result.url).toContain('/users/12345/collections/COLL123');
      expect(result.message).toContain('Thesis References');

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
      expect(url).toContain('/users/12345/collections');
      expect(init?.method).toBe('POST');
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body[0].name).toBe('Thesis References');
      expect(body[0].parentCollection).toBe(false);
    });

    it('creates a nested collection under a parent', async () => {
      mockFetch(
        { successful: { '0': { key: 'CHILD01' } } },
        {},
      );

      const result = await createZoteroCollection({
        groupId: '67890',
        apiKey: 'secret',
        name: 'Chapter 1',
        parentCollectionKey: 'PARENT99',
      });

      expect(result.success).toBe(true);
      expect(result.key).toBe('CHILD01');
      expect(result.url).toContain('/groups/67890/collections/CHILD01');

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body[0].parentCollection).toBe('PARENT99');
    });

    it('returns failure when the API rejects the request', async () => {
      mockFetch({ error: 'Forbidden' }, {}, 403);

      const result = await createZoteroCollection({
        userId: '12345',
        apiKey: 'secret',
        name: 'Bad Collection',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('403');
    });

    it('throws when apiKey is missing', async () => {
      await expect(createZoteroCollection({ userId: '12345', apiKey: '', name: 'X' })).rejects.toThrow('apiKey is required.');
    });

    it('throws when name is missing', async () => {
      await expect(createZoteroCollection({ userId: '12345', apiKey: 'secret', name: '' })).rejects.toThrow('name is required.');
    });

    it('throws when library id is missing', async () => {
      await expect(createZoteroCollection({ apiKey: 'secret', name: 'X' })).rejects.toThrow('Either userId or groupId is required.');
    });
  });

  describe('readZoteroAttachment', () => {
    it('throws when apiKey is missing', async () => {
      await expect(readZoteroAttachment({ userId: '12345', apiKey: '', itemKey: 'ABC123' })).rejects.toThrow('apiKey is required.');
    });

    it('throws when itemKey is missing', async () => {
      await expect(readZoteroAttachment({ userId: '12345', apiKey: 'secret', itemKey: '' })).rejects.toThrow('itemKey is required.');
    });

    it('throws when no PDF attachments exist', async () => {
      mockFetch(
        {
          key: 'ABC123',
          version: 1,
          data: { key: 'ABC123', itemType: 'journalArticle', title: 'No PDF' },
        },
        {},
      );
      mockFetch([], {});

      await expect(readZoteroAttachment({ userId: '12345', apiKey: 'secret', itemKey: 'ABC123' })).rejects.toThrow('No PDF attachments found');
    });

    it('lists attachments when multiple PDFs exist and no attachmentKey is provided', async () => {
      mockFetch(
        {
          key: 'ABC123',
          version: 1,
          data: { key: 'ABC123', itemType: 'journalArticle', title: 'Two PDFs' },
        },
        {},
      );
      mockFetch(
        [
          {
            key: 'ATT1',
            version: 1,
            data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'main.pdf', title: 'Main' },
          },
          {
            key: 'ATT2',
            version: 1,
            data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'supp.pdf', title: 'Supplement' },
          },
        ],
        {},
      );

      const result = await readZoteroAttachment({ userId: '12345', apiKey: 'secret', itemKey: 'ABC123' });
      expect('attachments' in result).toBe(true);
      if ('attachments' in result) {
        expect(result.attachments).toHaveLength(2);
        expect(result.attachments[0]!.key).toBe('ATT1');
      }
    });

    it('downloads and extracts text from a single PDF attachment', async () => {
      mockFetch(
        {
          key: 'ABC123',
          version: 1,
          data: { key: 'ABC123', itemType: 'journalArticle', title: 'Single PDF' },
        },
        {},
      );
      mockFetch(
        [
          {
            key: 'ATT1',
            version: 1,
            data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'paper.pdf', title: 'Paper' },
          },
        ],
        {},
      );
      mockFetchRaw({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: new Map([['location', 'https://files.zotero.org/signed.pdf']]) as unknown as Headers,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
      mockFetchRaw({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map() as unknown as Headers,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
        arrayBuffer: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
      });

      const result = await readZoteroAttachment({ userId: '12345', apiKey: 'secret', itemKey: 'ABC123' });
      expect('text' in result).toBe(true);
      if ('text' in result) {
        expect(result.text).toContain('Page one text');
        expect(result.totalPages).toBe(3);
        expect(result.extractedPages).toBe(2);
        expect(result.filename).toBe('paper.pdf');
      }
    });

    it('throws when attachmentKey is not found', async () => {
      mockFetch(
        {
          key: 'ABC123',
          version: 1,
          data: { key: 'ABC123', itemType: 'journalArticle', title: 'Missing Attachment' },
        },
        {},
      );
      mockFetch(
        [
          {
            key: 'ATT1',
            version: 1,
            data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'paper.pdf' },
          },
        ],
        {},
      );

      await expect(
        readZoteroAttachment({ userId: '12345', apiKey: 'secret', itemKey: 'ABC123', attachmentKey: 'MISSING' }),
      ).rejects.toThrow('Attachment key MISSING not found');
    });
  });
});
