/**
 * Render the paper library as a self-contained, shareable HTML page.
 */

import type { PaperItem } from '../store';

/** Render the library as a self-contained, shareable HTML page. */
export function papersToHtml(papers: PaperItem[], locale: 'zh' | 'en'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cards = papers.map((p) => {
    const meta = [
      p.authors.join(', ') || (locale === 'zh' ? '未知作者' : 'Unknown authors'),
      String(p.year || ''),
      p.venue,
    ].filter(Boolean).join(' · ');
    const ids = [p.doi ? `DOI: ${p.doi}` : '', p.arxivId ? `arXiv: ${p.arxivId}` : ''].filter(Boolean).join(' · ');
    const tags = p.tags.length > 0
      ? `<div class="tags">${p.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>`
      : '';
    return `<article class="card">
  <h2>${esc(p.title)}</h2>
  <div class="meta">${esc(meta)}</div>
  ${ids ? `<div class="ids">${esc(ids)}</div>` : ''}
  ${p.abstract ? `<p class="abstract">${esc(p.abstract)}</p>` : ''}
  ${tags}
</article>`;
  }).join('\n');
  const title = locale === 'zh' ? '文献库' : 'Paper Library';
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width: 860px; margin: 0 auto; padding: 32px 20px; color: #1a202c; background: #f7fafc; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #718096; font-size: 13px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; margin-bottom: 14px; }
  .card h2 { font-size: 16px; margin: 0 0 6px; }
  .meta { color: #4a5568; font-size: 13px; margin-bottom: 4px; }
  .ids { color: #718096; font-size: 12px; margin-bottom: 6px; font-family: monospace; }
  .abstract { color: #2d3748; font-size: 13px; line-height: 1.65; margin: 8px 0 0; }
  .tags { margin-top: 10px; }
  .tag { display: inline-block; background: #edf2f7; color: #4a5568; border-radius: 4px; padding: 2px 8px; font-size: 11px; margin: 0 6px 4px 0; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="subtitle">${papers.length} ${locale === 'zh' ? '篇论文 · 由 Metis 导出' : 'papers · exported from Metis'}</div>
${cards}
</body>
</html>`;
}
