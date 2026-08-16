// Probe NCPSSD journal search endpoint for core-journal markers.
const base = 'https://www.ncpssd.org';

async function probe(name, url, options) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        Accept: 'application/json',
        Referer: base + '/journal/index',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(15000),
      ...options,
    });
    const text = await res.text();
    const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
    console.log(`[${name}] status=${res.status} json=${isJson} bytes=${text.length}`);
    if (isJson) {
      const json = JSON.parse(text);
      const data = json?.data ?? json;
      const rows = data?.rows ?? data?.list ?? [];
      if (Array.isArray(rows) && rows.length > 0) {
        console.log('  first row keys:', Object.keys(rows[0]).join(',').slice(0, 300));
        console.log('  first row sample:', JSON.stringify(rows[0]).slice(0, 400));
      } else {
        console.log('  payload:', JSON.stringify(json).slice(0, 300));
      }
    } else {
      const hasCore = text.includes('核心') || /CSSCI|Peking University/i.test(text);
      console.log('  html contains core markers:', hasCore);
    }
  } catch (err) {
    console.log(`[${name}] ERROR ${err.message}`);
  }
}

// 1. Journal list page JS tells us the endpoint: check /js/web/Journal/*.js naming first via the journal index page.
const page = await fetch(base + '/journal/index?nav=1&langType=1&s=-1', {
  headers: { 'User-Agent': 'Mozilla/5.0' },
  signal: AbortSignal.timeout(15000),
}).then((r) => r.text());
const jsFiles = [...page.matchAll(/src="([^"]*js[^"]*journal[^"]*\.js[^"]*)"/gi)].map((m) => m[1]);
console.log('journal page js refs:', jsFiles.join(' | '));
const allJs = [...page.matchAll(/src="([^"]+\.js[^"]*)"/gi)].map((m) => m[1]).slice(0, 20);
console.log('all js refs:', allJs.join(' | '));

// Fetch likely journal list JS and grep for endpoints.
for (const jsPath of [...new Set([...jsFiles, ...allJs.filter((p) => p.toLowerCase().includes('journal'))])]) {
  const jsUrl = jsPath.startsWith('http') ? jsPath : base + (jsPath.startsWith('/') ? '' : '/') + jsPath;
  try {
    const js = await fetch(jsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }).then((r) => r.text());
    const hits = [...js.matchAll(/["']([^"']*(?:search|Handler|ajax|list)[^"']*)["']/gi)].map((m) => m[1]).filter((s) => s.includes('/'));
    if (hits.length > 0) console.log(jsUrl, '→ endpoints:', [...new Set(hits)].slice(0, 8).join(' | '));
  } catch { /* ignore */ }
}

// 2. Try the plausible API directly.
await probe('searchHandler-journal', base + '/searchHandler/search', {
  method: 'POST',
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Accept: 'application/json',
    Referer: base + '/journal/index',
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: new URLSearchParams({ search: 'title:("中国社会科学")', pageNum: '1', pageSize: '3', sort: '', sType: 'journal', ajaxKeys: '', customShowCondition: '' }).toString(),
});
