/**
 * Zotero API client — search a user's Zotero library.
 *
 * Zotero provides a read/write REST API for personal and group libraries.
 * This client implements read-only search via the public API, returning
 * structured metadata similar to other academic indexes so the agent can
 * ground answers in the user's own Zotero collection.
 *
 * API docs: https://www.zotero.org/support/dev/web_api/v3/start
 */

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroItemData {
  key: string;
  version?: number;
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  date?: string;
  year?: number;
  DOI?: string;
  ISBN?: string;
  url?: string;
  abstractNote?: string;
  publicationTitle?: string;
  journalAbbreviation?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  dateAdded?: string;
  dateModified?: string;
  tags?: Array<{ tag: string; type?: number }>;
  collections?: string[];
}

export interface ZoteroItem {
  key: string;
  version: number;
  library?: {
    type: 'user' | 'group';
    id: number;
    name?: string;
  };
  links?: {
    alternate?: { href: string };
    self?: { href: string };
  };
  data: ZoteroItemData;
}

export interface ZoteroSearchOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  query?: string;
  itemType?: string;
  tag?: string;
  since?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  collectionKey?: string;
  qmode?: 'titleCreatorYear' | 'everything';
  start?: number;
  maxResults?: number;
}

export interface ZoteroSearchResult {
  totalResults: number;
  items: ZoteroItem[];
  lastVersion?: number;
}

const BASE_URL = 'https://api.zotero.org';

function extractYear(date?: string, year?: number): number {
  if (typeof year === 'number' && year > 0) return year;
  if (!date) return 0;
  const match = date.match(/(\d{4})/);
  return match ? Number(match[1]) : 0;
}

function formatCreators(creators?: ZoteroCreator[]): string[] {
  if (!creators) return [];
  return creators
    .map((c) => {
      if (c.name) return c.name;
      const parts = [c.firstName, c.lastName].filter((p): p is string => typeof p === 'string' && p.length > 0);
      return parts.join(' ');
    })
    .filter(Boolean);
}

export async function searchZoteroLibrary(options: ZoteroSearchOptions): Promise<ZoteroSearchResult> {
  const { userId, groupId, apiKey, query, itemType, tag, since, sort, order, collectionKey, qmode, start, maxResults = 10 } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');

  let path: string;
  if (userId) {
    path = collectionKey?.trim()
      ? `/users/${userId}/collections/${collectionKey.trim()}/items`
      : `/users/${userId}/items`;
  } else if (groupId) {
    path = collectionKey?.trim()
      ? `/groups/${groupId}/collections/${collectionKey.trim()}/items`
      : `/groups/${groupId}/items`;
  } else {
    throw new Error('Either userId or groupId is required.');
  }

  const limit = Math.min(Math.max(maxResults, 1), 100);
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('format', 'json');
  if (query?.trim()) {
    url.searchParams.set('q', query.trim());
  }
  url.searchParams.set('limit', String(limit));
  if (itemType) {
    url.searchParams.set('itemType', itemType);
  }
  if (tag?.trim()) {
    url.searchParams.set('tag', tag.trim());
  }
  if (typeof since === 'number' && since > 0) {
    url.searchParams.set('since', String(since));
  }
  if (sort?.trim()) {
    url.searchParams.set('sort', sort.trim());
    if (order === 'asc' || order === 'desc') {
      url.searchParams.set('order', order);
    }
  }
  if (qmode === 'titleCreatorYear' || qmode === 'everything') {
    url.searchParams.set('qmode', qmode);
  }
  if (typeof start === 'number' && start > 0) {
    url.searchParams.set('start', String(start));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Zotero-API-Key': apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Zotero API error ${response.status}: ${body || response.statusText}`);
    }

    const items = (await response.json()) as ZoteroItem[];
    const totalHeader = response.headers.get('Total-Results');
    const totalResults = totalHeader ? Number(totalHeader) : items.length;
    const lastVersion = items.length > 0 ? Math.max(...items.map((item) => item.version ?? 0)) : undefined;

    return { totalResults, items, lastVersion };
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface ZoteroChildItem {
  key: string;
  version: number;
  itemType: string;
  data: ZoteroItemData & {
    note?: string;
    linkMode?: string;
    contentType?: string;
    filename?: string;
    url?: string;
  };
}

export interface GetZoteroItemOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  itemKey: string;
  includeChildren?: boolean;
}

export interface GetZoteroItemResult {
  item: ZoteroItem;
  children: ZoteroChildItem[];
}

export interface ReadZoteroAttachmentOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  itemKey: string;
  attachmentKey?: string;
  pages?: string;
}

export interface ReadZoteroAttachmentResult {
  itemTitle?: string;
  attachmentKey: string;
  filename?: string;
  contentType?: string;
  text: string;
  totalPages: number;
  extractedPages: number;
}

function buildLibraryPath(userId?: string, groupId?: string): string {
  if (userId) return `/users/${userId}`;
  if (groupId) return `/groups/${groupId}`;
  throw new Error('Either userId or groupId is required.');
}

async function zoteroFetch<T>(path: string, apiKey: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Zotero-API-Key': apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Zotero API error ${response.status}: ${body || response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch a single Zotero item by key, optionally including its child items
 * (notes and attachments).
 */
export async function getZoteroItem(options: GetZoteroItemOptions): Promise<GetZoteroItemResult> {
  const { userId, groupId, apiKey, itemKey, includeChildren = false } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');
  if (!itemKey.trim()) throw new Error('itemKey is required.');

  const libraryPath = buildLibraryPath(userId, groupId);
  const item = await zoteroFetch<ZoteroItem>(`${libraryPath}/items/${itemKey.trim()}`, apiKey);

  let children: ZoteroChildItem[] = [];
  if (includeChildren) {
    children = await zoteroFetch<ZoteroChildItem[]>(`${libraryPath}/items/${itemKey.trim()}/children`, apiKey);
  }

  return { item, children };
}

/**
 * Download a Zotero attachment (PDF) and extract its text.
 * If `attachmentKey` is omitted and the item has multiple PDF attachments,
 * the result lists available attachments instead of extracting text.
 */
export async function readZoteroAttachment(
  options: ReadZoteroAttachmentOptions,
): Promise<ReadZoteroAttachmentResult | { attachments: Array<{ key: string; filename?: string; title?: string }> }> {
  const { userId, groupId, apiKey, itemKey, attachmentKey, pages } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');
  if (!itemKey.trim()) throw new Error('itemKey is required.');

  const libraryPath = buildLibraryPath(userId, groupId);
  const { children } = await getZoteroItem({ userId, groupId, apiKey, itemKey, includeChildren: true });

  const attachments = children.filter(
    (c) => c.data.itemType === 'attachment' && c.data.contentType === 'application/pdf',
  );

  if (attachments.length === 0) {
    throw new Error('No PDF attachments found for this Zotero item.');
  }

  const targetAttachment = attachmentKey?.trim()
    ? attachments.find((a) => a.key === attachmentKey.trim())
    : attachments[0];

  if (attachmentKey?.trim() && !targetAttachment) {
    throw new Error(`Attachment key ${attachmentKey.trim()} not found among ${attachments.length} PDF attachment(s).`);
  }

  if (!attachmentKey?.trim() && attachments.length > 1) {
    return {
      attachments: attachments.map((a) => ({
        key: a.key,
        filename: a.data.filename,
        title: a.data.title,
      })),
    };
  }

  const resolvedAttachment = targetAttachment ?? attachments[0];
  if (!resolvedAttachment) {
    throw new Error('No PDF attachment selected.');
  }
  const targetKey = resolvedAttachment.key;

  const fileUrl = `${BASE_URL}${libraryPath}/items/${targetKey}/file`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let tempPath: string | undefined;
  try {
    // Initial request with API key; Zotero responds with a redirect to a signed URL.
    const initialResponse = await fetch(fileUrl, {
      method: 'GET',
      headers: { 'Zotero-API-Key': apiKey },
      redirect: 'manual',
      signal: controller.signal,
    });

    if (initialResponse.status !== 302 && initialResponse.status !== 301) {
      const body = await initialResponse.text().catch(() => '');
      throw new Error(`Zotero file request returned ${initialResponse.status}: ${body || initialResponse.statusText}`);
    }

    const redirectUrl = initialResponse.headers.get('location');
    if (!redirectUrl) {
      throw new Error('Zotero file request did not return a redirect URL.');
    }

    // Follow redirect without the API key.
    const fileResponse = await fetch(redirectUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!fileResponse.ok) {
      const body = await fileResponse.text().catch(() => '');
      throw new Error(`Zotero file download failed ${fileResponse.status}: ${body || fileResponse.statusText}`);
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('Downloaded PDF is empty.');
    }

    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    tempPath = path.join(os.tmpdir(), `zotero-attachment-${targetKey}-${Date.now()}.pdf`);
    fs.writeFileSync(tempPath, buffer);

    const { getPdfReader } = await import('./PdfReader.js');
    const reader = getPdfReader();
    const result = await reader.readFile(tempPath, { pages: pages ? String(pages) : undefined });

    const text = result.pages.map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');

    return {
      itemTitle: result.metadata.title,
      attachmentKey: targetKey,
      filename: resolvedAttachment.data.filename,
      contentType: resolvedAttachment.data.contentType,
      text,
      totalPages: result.totalPages,
      extractedPages: result.pages.length,
    };
  } finally {
    clearTimeout(timeoutId);
    if (tempPath) {
      try {
        const fs = await import('node:fs');
        fs.unlinkSync(tempPath);
      } catch { /* ignore */ }
    }
  }
}

export function zoteroChildToPlain(child: ZoteroChildItem): Record<string, unknown> {
  const data = child.data;
  const base = {
    key: child.key,
    version: child.version,
    itemType: data.itemType,
    title: data.title,
    dateAdded: data.dateAdded,
    dateModified: data.dateModified,
  };

  if (data.itemType === 'note') {
    return { ...base, note: data.note ?? '' };
  }

  if (data.itemType === 'attachment') {
    return {
      ...base,
      linkMode: data.linkMode,
      contentType: data.contentType,
      filename: data.filename,
      url: data.url,
    };
  }

  return base;
}

export function zoteroItemToPlain(item: ZoteroItem): Record<string, unknown> {
  const data = item.data;
  return {
    key: item.key,
    version: item.version,
    libraryType: item.library?.type,
    libraryId: item.library?.id,
    itemType: data.itemType,
    title: data.title,
    authors: formatCreators(data.creators),
    year: extractYear(data.date, data.year),
    date: data.date,
    dateAdded: data.dateAdded,
    dateModified: data.dateModified,
    doi: data.DOI,
    isbn: data.ISBN,
    url: data.url,
    abstract: data.abstractNote,
    venue: data.publicationTitle || data.journalAbbreviation,
    volume: data.volume,
    issue: data.issue,
    pages: data.pages,
    tags: (data.tags ?? []).map((t) => t.tag),
    zoteroUrl: item.links?.alternate?.href,
  };
}

export interface CreateZoteroItemOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  item: Partial<ZoteroItemData> & Pick<ZoteroItemData, 'itemType' | 'title'>;
}

export interface CreateZoteroItemResult {
  success: boolean;
  key?: string;
  url?: string;
  message: string;
}

/**
 * Create a single item in a Zotero user or group library.
 */
export async function createZoteroItem(options: CreateZoteroItemOptions): Promise<CreateZoteroItemResult> {
  const { userId, groupId, apiKey, item } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');
  if (!userId && !groupId) throw new Error('Either userId or groupId is required.');

  let path: string;
  if (userId) {
    path = `/users/${userId}/items`;
  } else {
    path = `/groups/${groupId}/items`;
  }

  const payload = [Object.fromEntries(
    Object.entries({
      itemType: item.itemType,
      title: item.title,
      creators: item.creators ?? [],
      date: item.date,
      DOI: item.DOI,
      ISBN: item.ISBN,
      url: item.url,
      abstractNote: item.abstractNote,
      publicationTitle: item.publicationTitle,
      journalAbbreviation: item.journalAbbreviation,
      volume: item.volume,
      issue: item.issue,
      pages: item.pages,
      tags: item.tags ?? [],
    }).filter(([, value]) => value != null && value !== ''),
  )];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Zotero-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        success: false,
        message: `Zotero API error ${response.status}: ${body || response.statusText}`,
      };
    }

    const result = (await response.json()) as { successful?: { '0'?: { key?: string } }; unsuccessful?: unknown };
    const key = result.successful?.['0']?.key;
    const urlPrefix = userId ? `users/${userId}` : `groups/${groupId}`;
    return {
      success: true,
      key,
      url: key ? `https://www.zotero.org/${urlPrefix}/items/${key}` : undefined,
      message: key ? `Item created in Zotero with key ${key}.` : 'Item created in Zotero.',
    };
  } catch (err) {
    return {
      success: false,
      message: `Zotero item creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface ZoteroCollection {
  key: string;
  version: number;
  data: {
    key: string;
    name: string;
    parentCollection?: string;
    numberOfItems?: number;
  };
  meta?: {
    numItems?: number;
  };
}

export interface ListZoteroCollectionsOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  maxResults?: number;
}

export interface ListZoteroCollectionsResult {
  totalResults: number;
  collections: ZoteroCollection[];
}

/**
 * List collections in a Zotero user or group library.
 */
export async function listZoteroCollections(options: ListZoteroCollectionsOptions): Promise<ListZoteroCollectionsResult> {
  const { userId, groupId, apiKey, maxResults = 100 } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');

  const libraryPath = buildLibraryPath(userId, groupId);
  const limit = Math.min(Math.max(maxResults, 1), 100);
  const url = new URL(`${BASE_URL}${libraryPath}/collections`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Zotero-API-Key': apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Zotero API error ${response.status}: ${body || response.statusText}`);
    }

    const collections = (await response.json()) as ZoteroCollection[];
    const totalHeader = response.headers.get('Total-Results');
    const totalResults = totalHeader ? Number(totalHeader) : collections.length;

    return { totalResults, collections };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function zoteroCollectionToPlain(collection: ZoteroCollection): Record<string, unknown> {
  return {
    key: collection.key,
    version: collection.version,
    name: collection.data.name,
    parentCollectionKey: collection.data.parentCollection,
    itemCount: collection.data.numberOfItems ?? collection.meta?.numItems ?? 0,
  };
}

export interface FindDuplicateZoteroItemsOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  maxItems?: number;
}

export interface ZoteroDuplicateGroup {
  key: string;
  type: 'doi' | 'title';
  items: ZoteroItem[];
}

function normalizeTitle(title?: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
    .trim();
}

/**
 * Find likely duplicate items in a Zotero library by grouping on DOI and
 * normalized title. Fetches items in batches using the Zotero REST API.
 */
export async function findDuplicateZoteroItems(
  options: FindDuplicateZoteroItemsOptions,
): Promise<ZoteroDuplicateGroup[]> {
  const { userId, groupId, apiKey, maxItems = 1000 } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');

  const libraryPath = buildLibraryPath(userId, groupId);
  const limit = 100;
  const items: ZoteroItem[] = [];

  for (let start = 0; start < maxItems; start += limit) {
    const batchLimit = Math.min(limit, maxItems - start);
    const url = new URL(`${BASE_URL}${libraryPath}/items`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', String(batchLimit));
    url.searchParams.set('start', String(start));

    const batch = await zoteroFetch<ZoteroItem[]>(url.toString(), apiKey);
    if (batch.length === 0) break;
    items.push(...batch);
    if (batch.length < batchLimit) break;
  }

  const byDoi = new Map<string, ZoteroItem[]>();
  const byTitle = new Map<string, ZoteroItem[]>();

  for (const item of items) {
    const doi = item.data.DOI?.trim().toLowerCase();
    if (doi) {
      const group = byDoi.get(doi) ?? [];
      group.push(item);
      byDoi.set(doi, group);
    }

    const normalized = normalizeTitle(item.data.title);
    if (normalized.length > 5) {
      const group = byTitle.get(normalized) ?? [];
      group.push(item);
      byTitle.set(normalized, group);
    }
  }

  const groups: ZoteroDuplicateGroup[] = [];
  for (const [doi, groupItems] of byDoi.entries()) {
    if (groupItems.length > 1) {
      groups.push({ key: doi, type: 'doi', items: groupItems });
    }
  }
  for (const [title, groupItems] of byTitle.entries()) {
    if (groupItems.length > 1) {
      groups.push({ key: title, type: 'title', items: groupItems });
    }
  }

  return groups;
}

export interface UpdateZoteroItemTagsOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  itemKey: string;
  tags: string[];
}

export interface UpdateZoteroItemTagsResult {
  success: boolean;
  message: string;
}

/**
 * Add tags to an existing Zotero item. Skips tags that are already present.
 * Fetches the current item version to avoid conflicts.
 */
export async function updateZoteroItemTags(
  options: UpdateZoteroItemTagsOptions,
): Promise<UpdateZoteroItemTagsResult> {
  const { userId, groupId, apiKey, itemKey, tags } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');
  if (!itemKey.trim()) throw new Error('itemKey is required.');
  if (!Array.isArray(tags) || tags.length === 0) throw new Error('At least one tag is required.');
  if (!userId && !groupId) throw new Error('Either userId or groupId is required.');

  const libraryPath = buildLibraryPath(userId, groupId);
  const key = itemKey.trim();

  try {
    const item = await zoteroFetch<ZoteroItem>(`${libraryPath}/items/${key}`, apiKey);
    const existingTags = new Set((item.data.tags ?? []).map((t) => t.tag));
    const tagsToAdd = tags.filter((tag) => !existingTags.has(tag));

    if (tagsToAdd.length === 0) {
      return { success: true, message: 'All specified tags are already present on the item.' };
    }

    const updatedTags = [...(item.data.tags ?? []), ...tagsToAdd.map((tag) => ({ tag }))];

    const response = await fetch(`${BASE_URL}${libraryPath}/items/${key}`, {
      method: 'PATCH',
      headers: {
        'Zotero-API-Key': apiKey,
        'Content-Type': 'application/json',
        'If-Unmodified-Since-Version': String(item.version),
      },
      body: JSON.stringify({ tags: updatedTags }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        success: false,
        message: `Zotero API error ${response.status}: ${body || response.statusText}`,
      };
    }

    return {
      success: true,
      message: `Added ${tagsToAdd.length} tag(s) to item ${key}: ${tagsToAdd.join(', ')}.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to update Zotero tags: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ImportZoteroItemByUrlOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  url: string;
  collectionKey?: string;
  tags?: string[];
}

export interface ImportZoteroItemByUrlResult {
  success: boolean;
  key?: string;
  url?: string;
  message: string;
}

/**
 * Import an item into Zotero by fetching a web page URL and extracting metadata.
 * Enriches via Crossref if a DOI is found. Optionally assigns the item to a
 * collection and adds tags.
 */
export async function importZoteroItemByUrl(
  options: ImportZoteroItemByUrlOptions,
): Promise<ImportZoteroItemByUrlResult> {
  const { userId, groupId, apiKey, url, collectionKey, tags } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');
  if (!userId && !groupId) throw new Error('Either userId or groupId is required.');
  if (!url.trim()) throw new Error('url is required.');

  const { importFromUrl } = await import('./WebImport.js');
  const meta = await importFromUrl(url);

  let itemType = 'webpage';
  if (meta.doi) {
    itemType = meta.venue ? 'journalArticle' : 'journalArticle';
  } else if (meta.arxivId) {
    itemType = 'preprint';
  } else if (meta.venue) {
    itemType = 'conferencePaper';
  }

  const creators = meta.authors.map((name) => {
    const parts = name.trim().split(/\s+/);
    const lastName = parts.pop() ?? '';
    const firstName = parts.join(' ');
    return firstName ? { creatorType: 'author', firstName, lastName } : { creatorType: 'author', name: lastName };
  });

  const item: Partial<ZoteroItemData> & Pick<ZoteroItemData, 'itemType' | 'title'> = {
    itemType,
    title: meta.title || url,
    creators,
    date: meta.year ? String(meta.year) : undefined,
    DOI: meta.doi,
    url: meta.url,
    abstractNote: meta.abstract,
    publicationTitle: meta.venue,
  };

  const createResult = await createZoteroItem({ userId, groupId, apiKey, item });
  if (!createResult.success || !createResult.key) {
    return { success: false, message: createResult.message };
  }

  const itemKey = createResult.key;
  const libraryPath = buildLibraryPath(userId, groupId);

  try {
    if (collectionKey?.trim()) {
      const existing = await zoteroFetch<ZoteroItem>(`${libraryPath}/items/${itemKey}`, apiKey);
      const collections = [...new Set([...(existing.data.collections ?? []), collectionKey.trim()])];
      await fetch(`${BASE_URL}${libraryPath}/items/${itemKey}`, {
        method: 'PATCH',
        headers: {
          'Zotero-API-Key': apiKey,
          'Content-Type': 'application/json',
          'If-Unmodified-Since-Version': String(existing.version),
        },
        body: JSON.stringify({ collections }),
      });
    }

    if (tags && tags.length > 0) {
      await updateZoteroItemTags({ userId, groupId, apiKey, itemKey, tags });
    }
  } catch (err) {
    // Item was created; collection/tag assignment failed non-fatally.
    return {
      success: true,
      key: itemKey,
      url: createResult.url,
      message: `Imported "${item.title}" into Zotero with key ${itemKey}, but collection/tag assignment failed: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }

  return {
    success: true,
    key: itemKey,
    url: createResult.url,
    message: `Imported "${item.title}" into Zotero with key ${itemKey}.${collectionKey?.trim() ? ` Added to collection ${collectionKey.trim()}.` : ''}${tags && tags.length > 0 ? ` Tags: ${tags.join(', ')}.` : ''}`,
  };
}

export interface CreateZoteroCollectionOptions {
  userId?: string;
  groupId?: string;
  apiKey: string;
  name: string;
  parentCollectionKey?: string;
}

export interface CreateZoteroCollectionResult {
  success: boolean;
  key?: string;
  url?: string;
  message: string;
}

/**
 * Create a new collection in a Zotero user or group library.
 */
export async function createZoteroCollection(
  options: CreateZoteroCollectionOptions,
): Promise<CreateZoteroCollectionResult> {
  const { userId, groupId, apiKey, name, parentCollectionKey } = options;

  if (!apiKey.trim()) throw new Error('apiKey is required.');
  if (!userId && !groupId) throw new Error('Either userId or groupId is required.');
  if (!name.trim()) throw new Error('name is required.');

  const libraryPath = buildLibraryPath(userId, groupId);
  const payload = [{
    name: name.trim(),
    parentCollection: parentCollectionKey?.trim() || false,
  }];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${BASE_URL}${libraryPath}/collections`, {
      method: 'POST',
      headers: {
        'Zotero-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        success: false,
        message: `Zotero API error ${response.status}: ${body || response.statusText}`,
      };
    }

    const result = (await response.json()) as { successful?: { '0'?: { key?: string } }; unsuccessful?: unknown };
    const key = result.successful?.['0']?.key;
    const urlPrefix = userId ? `users/${userId}` : `groups/${groupId}`;
    return {
      success: true,
      key,
      url: key ? `https://www.zotero.org/${urlPrefix}/collections/${key}` : undefined,
      message: key ? `Collection "${name}" created in Zotero with key ${key}.` : `Collection "${name}" created in Zotero.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Zotero collection creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
