/**
 * Built-in web tools — DuckDuckGo search + arbitrary URL content fetch.
 *
 * DuckDuckGo Instant Answer API is free and requires no API key. The fetch
 * tool downloads a URL and returns readable text (HTML stripped). Both are
 * outbound-only; no local network is exposed.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

/** Use the system proxy when set (curl works but node fetch times out without it). */
function getFetchOptions(): { dispatcher?: InstanceType<typeof ProxyAgent> } {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxyUrl) return {};
  try {
    return { dispatcher: new ProxyAgent(proxyUrl) };
  } catch {
    return {};
  }
}

// ─── DuckDuckGo Search ────────────────────────────────────────

export const webSearchSpec: ToolSpec = {
  name: 'web_search',
  description: 'Search the web using DuckDuckGo (no API key required). Returns instant answers, related topics, and result summaries. Use for current events, facts, definitions, or when you need information beyond the local library.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Maximum number of results to return (default 10)', default: 10 },
    },
    required: ['query'],
  },
};

export const webSearchHandler: ToolHandler = async (args) => {
  const query = String(args.query ?? '').trim();
  if (!query) return JSON.stringify({ ok: false, error: 'query is required' });
  if (typeof navigator !== 'undefined' && !(navigator as { onLine?: boolean }).onLine) {
    return JSON.stringify({ ok: false, error: 'offline', offline: true });
  }
  const maxResults = Math.min(Math.max(1, Number(args.maxResults) || 10), 50);

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    });
    const response = await undiciFetch(`https://api.duckduckgo.com/?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      ...getFetchOptions(),
    });
    if (!response.ok) {
      return JSON.stringify({ ok: false, error: `DuckDuckGo API returned ${response.status}` });
    }
    const data = await response.json() as Record<string, unknown>;

    // Extract the most useful fields.
    const abstract = String(data.Abstract ?? '');
    const abstractUrl = String(data.AbstractURL ?? '');
    const answer = String(data.Answer ?? '');
    const answerType = String(data.AnswerType ?? '');

    const relatedTopics = Array.isArray(data.RelatedTopics)
      ? (data.RelatedTopics as Array<Record<string, unknown>>)
          .filter((t) => t.Text)
          .slice(0, maxResults)
          .map((t) => ({
            text: String(t.Text),
            url: String(t.FirstURL ?? ''),
          }))
      : [];

    return JSON.stringify({
      ok: true,
      result: {
        query,
        answer: answer || undefined,
        answerType: answerType || undefined,
        abstract: abstract || undefined,
        abstractUrl: abstractUrl || undefined,
        relatedTopics: relatedTopics.length > 0 ? relatedTopics : undefined,
      },
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Search failed' });
  }
};

// ─── Web Fetch ────────────────────────────────────────────────

export const webFetchSpec: ToolSpec = {
  name: 'web_fetch',
  description: 'Fetch and read the content of a URL (web page, article, API response). HTML is stripped to readable text. Use when you have a specific link to read or an API endpoint to call.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (http or https)' },
      maxLength: { type: 'number', description: 'Maximum characters to return (default 5000)', default: 5000 },
      format: { type: 'string', description: '"text" (default, HTML stripped) or "raw" (raw HTML/JSON)', enum: ['text', 'raw'], default: 'text' },
    },
    required: ['url'],
  },
};

export const webFetchHandler: ToolHandler = async (args) => {
  const url = String(args.url ?? '').trim();
  if (!url) return JSON.stringify({ ok: false, error: 'url is required' });
  if (typeof navigator !== 'undefined' && !(navigator as { onLine?: boolean }).onLine) {
    return JSON.stringify({ ok: false, error: 'offline', offline: true });
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return JSON.stringify({ ok: false, error: 'url must start with http:// or https://' });
  }
  const maxLength = Math.min(Math.max(100, Number(args.maxLength) || 5000), 50_000);
  const format = String(args.format ?? 'text');

  try {
    const response = await undiciFetch(url, {
      headers: {
        'Accept': 'text/html,application/json,application/xml,text/plain,*/*',
        'User-Agent': 'Metis-Workbench/0.1 (research tool)',
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
      ...getFetchOptions(),
    });
    if (!response.ok) {
      return JSON.stringify({ ok: false, error: `HTTP ${response.status}: ${response.statusText}` });
    }
    const contentType = response.headers.get('content-type') ?? '';
    let text = await response.text();

    // Strip HTML to readable text unless raw format requested.
    if (format !== 'raw' && (contentType.includes('html') || text.startsWith('<'))) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return JSON.stringify({
      ok: true,
      result: {
        url: response.url,
        status: response.status,
        contentType,
        text: text.slice(0, maxLength),
        truncated: text.length > maxLength,
      },
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Fetch failed' });
  }
};

// ─── Registration ─────────────────────────────────────────────

export function getWebToolSpecs(): ToolSpec[] {
  return [webSearchSpec, webFetchSpec];
}

export function getWebToolHandlers(): Map<string, ToolHandler> {
  return new Map([
    ['web_search', webSearchHandler],
    ['web_fetch', webFetchHandler],
  ]);
}
