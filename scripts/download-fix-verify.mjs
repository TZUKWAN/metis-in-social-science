/**
 * E2E verification of the anti-leech download fix, inside the REAL app.
 *
 * A local server mimics a site that rejects downloads without a proper
 * Referer (responding 403 "应用来源不正确" — exactly what 刘总 saw).
 * The in-app browser downloads a PDF from it; acceptDownload must now
 * succeed because it replays Referer + User-Agent.
 *
 *   npx electron scripts/download-fix-verify.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { app, BrowserWindow } from 'electron';

app.setName('metis-dlfix');

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

// Negative-control: the server REALLY rejects Referer-less requests.
const server = http.createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><a id="dl" href="/file.pdf" download>下载 PDF</a></body></html>');
    return;
  }
  if (req.url === '/file.pdf') {
    const referer = String(req.headers.referer || '');
    if (!referer.includes('127.0.0.1')) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>应用来源不正确</body></html>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="paper.pdf"',
    });
    res.end(PDF_BYTES);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/page`;
const pdfUrl = `http://127.0.0.1:${port}/file.pdf`;

// sanity: bare fetch (no Referer) must be rejected, proving the mock checks it
const bare = await fetch(pdfUrl);
const bareStatus = bare.status;
const bareText = await bare.text();
console.log(`MOCK  bare fetch (no Referer) → HTTP ${bareStatus} "${bareText.match(/应用来源不正确/)?.[0] || ''}"`);

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 150) : ''}`); };
rec('模拟站点确实校验 Referer（裸请求 403 且返回「应用来源不正确」）', bareStatus === 403 && bareText.includes('应用来源不正确'));

await import('../dist-electron/electron/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  let win = BrowserWindow.getAllWindows()[0];
  for (let i = 0; i < 50 && !win; i += 1) { await sleep(300); win = BrowserWindow.getAllWindows()[0]; }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const run = (expr) =>
    win.webContents.executeJavaScript(`(async () => { try { return ${expr}; } catch (err) { return { __error: String(err && err.message || err) }; } })()`);

  await run(`window.metis.startupStatus()`);
  await sleep(2500);

  // skip first-run wizard (we don't need a provider for download testing)
  await run(`(() => { const b = document.querySelector('[data-testid="first-run-skip"]'); b && b.click(); return true; })()`);
  await sleep(2500);
  await run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === '跳过'); b && b.click(); return true; })()`);
  await sleep(1000);

  // open the in-app browser page so the BrowserView attaches
  await run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === '浏览器'); b && b.click(); return true; })()`);
  await sleep(2500);

  const nav = await run(`window.metis.browserNavigate(${JSON.stringify(pageUrl)})`);
  rec('应用内浏览器导航到论文页面', nav?.ok === true, JSON.stringify(nav));
  await sleep(3000);

  // click the download link inside the BrowserView (real user gesture path)
  const { webContents } = await import('electron');
  const viewWc = webContents.getAllWebContents().find((wc) => (wc.getURL() || '').includes(`127.0.0.1:${port}`));
  rec('定位应用内浏览器视图', !!viewWc);
  if (viewWc) {
    await viewWc.executeJavaScript(`document.getElementById('dl').click()`).catch(() => viewWc.downloadURL(pdfUrl));
  }

  // wait for will-download interception → pending download
  let pending = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const list = await run(`window.metis.browserListDownloads()`);
    pending = (list && (list.downloads || list.items || list)) || [];
    if (Array.isArray(pending) && pending.length > 0) break;
  }
  rec('下载被拦截并生成待确认任务', Array.isArray(pending) && pending.length > 0, JSON.stringify(pending).slice(0, 150));

  if (pending.length > 0) {
    const id = pending[0].id;
    const accept = await run(`window.metis.browserAcceptDownload(${JSON.stringify(id)}, null)`);
    rec('acceptDownload 成功（Referer 重放后 200）', accept?.ok === true, JSON.stringify(accept));
    if (accept?.ok && accept.savedPath) {
      const p = accept.savedPath;
      const exists = fs.existsSync(p);
      const head = exists ? fs.readFileSync(p).subarray(0, 8).toString('latin1') : '';
      rec('PDF 文件真实落盘且内容为 PDF', exists && head.startsWith('%PDF'), `${p} head=${JSON.stringify(head)}`);
      const data = await run(`window.metis.loadAllData()`);
      const paper = (data?.papers || []).find((x) => x.pdfPath === p || (x.tags || []).includes('downloaded'));
      rec('文献库出现带 PDF 的下载记录', !!paper, paper ? `title=${paper.title} pdf=${!!paper.pdfPath}` : 'none');
    } else if (accept && !accept.ok) {
      rec('（反证）错误不再是 403 防盗链', accept.error !== 'download_http_403', accept.error);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nDownload-fix verify: ${results.length - failed}/${results.length} passed`);
  server.close();
  app.exit(failed === 0 ? 0 : 1);
}

app.on('ready', () => {
  main().catch((err) => {
    rec('harness', false, String(err && err.message || err));
    server.close();
    app.exit(1);
  });
});
