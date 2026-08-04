/**
 * Metis end-to-end connectivity smoke test.
 *
 * Boots the real application (main process + renderer + SQLite) inside
 * Electron with an isolated data directory, then exercises every IPC surface
 * from the renderer side via window.metis, exactly as the UI would.
 *
 *   npx electron scripts/smoke.mjs
 *
 * Writes smoke-report.json and exits 0 when every check passes.
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

// Isolate the data directory so the smoke test never touches real user data.
app.setName('metis-smoke');

// Boot the real app main process (registers IPC, creates the window). This is
// a top-level await so it runs before Electron fires `ready` — required for
// main.js to register its privileged scheme in time.
await import('../dist-electron/electron/main.js');

const reportPath = path.resolve('smoke-report.json');
const report = { startedAt: new Date().toISOString(), checks: [] };
function record(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // main.js was imported at the top level (before ready). Wait for the window
  // the app creates in its own ready callback.

  // The app's own ready callback creates the window asynchronously — poll.
  let win = BrowserWindow.getAllWindows()[0];
  for (let i = 0; i < 50 && !win; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('no browser window created');
  // Capture renderer console errors for diagnostics. Electron's CSP advisory
  // (a warning about unsafe-eval/unsafe-inline, which the pdf.js stack needs)
  // is informational and excluded.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 && !message.includes('Electron Security Warning')) {
      record('renderer console', false, message.slice(0, 300));
    }
  });
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }

  // Wait for the main process startup gate (renderer polls this too).
  for (let i = 0; i < 50; i += 1) {
    const status = await win.webContents.executeJavaScript('window.metis?.startupStatus?.()');
    if (status?.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const run = (expr) => win.webContents.executeJavaScript(`(async () => { try { return ${expr}; } catch (err) { return { __error: String(err && err.message || err) }; } })()`);

  // 1. Startup gate
  const startup = await run('window.metis.startupStatus()');
  record('startup:status ready', startup?.ready === true && startup?.storeReady === true, JSON.stringify(startup));

  // 2. Settings round-trip
  const settings = await run('window.metis.getSettings()');
  record('settings:get returns structured view', settings && typeof settings.configured === 'boolean', JSON.stringify(settings).slice(0, 120));

  // 3. Data load (empty store, structured)
  const data = await run('window.metis.loadAllData()');
  record('data:loadAll returns structured payload',
    data && Array.isArray(data.papers) && Array.isArray(data.notes) && Array.isArray(data.experiments) && Array.isArray(data.collections),
    `papers=${data?.papers?.length}`);

  // 4. Storage write→read connectivity (SQLite)
  const note = { id: 'smoke-note-1', title: 'smoke note', content: 'connectivity check', tags: ['smoke'], linkedPaperIds: [], linkedNoteIds: [], updatedAt: Date.now() };
  await run(`window.metis.saveNote(${JSON.stringify(note)})`);
  const dataAfter = await run('window.metis.loadAllData()');
  record('note saved and reloaded from SQLite', dataAfter?.notes?.some((n) => n.id === 'smoke-note-1') === true);

  // 5. Full-text search IPC (empty library → empty results, structured)
  const search = await run(`window.metis.searchPapersFullText('metis')`);
  record('papers:searchFullText structured response', search && Array.isArray(search.results));

  // 6. AI one-shot IPCs fail structurally without a provider
  const explain = await run(`window.metis.aiExplainPaper({ passage: 'test passage' })`);
  record('papers:aiExplain provider_unavailable without provider', explain?.ok === false && explain?.error === 'provider_unavailable', explain?.error);

  const synthInvalid = await run(`window.metis.aiSynthesis({ mode: 'synthesis', papers: [] })`);
  record('papers:aiSynthesis rejects <2 papers', synthInvalid?.ok === false && synthInvalid?.error === 'need_at_least_two_papers', synthInvalid?.error);

  const synthNoProvider = await run(`window.metis.aiSynthesis({ mode: 'synthesis', papers: [{ title: 'A', authors: [], year: 2024, venue: '', abstract: '' }, { title: 'B', authors: [], year: 2024, venue: '', abstract: '' }] })`);
  record('papers:aiSynthesis provider_unavailable without provider', synthNoProvider?.ok === false && synthNoProvider?.error === 'provider_unavailable', synthNoProvider?.error);

  const polish = await run(`window.metis.aiPolishLatex({ text: 'hello world' })`);
  record('latex:aiPolish provider_unavailable without provider', polish?.ok === false && polish?.error === 'provider_unavailable', polish?.error);

  // 7. Paper detail on demand
  const detail = await run(`window.metis.loadPaperDetail({ paperId: 'nonexistent' })`);
  record('data:loadPaperDetail structured miss', detail?.found === false);

  // 8. WeChat bot status (unbound, no state)
  const wx = await run('window.metis.wechatGetStatus()');
  record('wechat:getStatus structured response', wx && typeof wx.ok === 'boolean', JSON.stringify(wx).slice(0, 120));

  // 9. Renderer UI actually rendered (root has content)
  const uiProbe = await run(`({
    children: document.getElementById('root')?.children.length ?? -1,
    scripts: Array.from(document.querySelectorAll('script')).map((s) => s.src || 'inline').slice(0, 5),
    bodyLen: document.body?.innerHTML.length ?? 0,
  })`);
  record('renderer UI mounted', uiProbe?.children > 0, JSON.stringify(uiProbe).slice(0, 200));

  // 10. OfficeCli bridge: detect + create + add + render + close (real binary).
  const officeStatus = await run('window.metis.officeCliStatus()');
  if (officeStatus?.available) {
    record('officecli:detected', true, officeStatus.version);
    const created = await run(`window.metis.officeCliNewDocument('docx', 'smoke')`);
    if (created?.success && created.filePath) {
      const docPath = created.filePath;
      const added = await run(`window.metis.officeCliAdd(${JSON.stringify({ filePath: docPath, parent: '/', type: 'paragraph', props: { text: 'smoke paragraph' } })})`);
      record('officecli:add paragraph', added?.success === true, added?.error);
      const html = await run(`window.metis.officeCliRenderHtml(${JSON.stringify(docPath)})`);
      record('officecli:render html', html?.success === true && typeof html.data === 'string' && html.data.includes('smoke paragraph'), String(html?.data ?? '').slice(0, 60));
      const closed = await run(`window.metis.officeCliClose(${JSON.stringify(docPath)})`);
      record('officecli:close', closed?.success === true);
    } else {
      record('officecli:create', false, created?.error);
    }
  } else {
    record('officecli:detected', false, officeStatus?.error ?? 'not installed (skipped)');
  }

  const failed = report.checks.filter((c) => !c.ok);
  report.failed = failed.length;
  report.passed = report.checks.length - failed.length;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nSmoke: ${report.passed}/${report.checks.length} passed — report: ${reportPath}`);
  app.exit(failed.length === 0 ? 0 : 1);
}

app.on('ready', () => {
  main().catch((err) => {
    record('smoke harness', false, String(err && err.message || err));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    app.exit(1);
  });
});
