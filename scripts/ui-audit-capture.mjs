// Lightweight UI screenshot harness (main-process capturePage — reliable).
// Launches a fresh app against a stub provider, navigates every surface,
// and writes PNGs to the output dir. Usage:
//   node_modules/.bin/electron.cmd scripts/ui-audit-capture.mjs [theme]
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const theme = process.argv[2] ?? 'light';
const outDir = path.join(process.cwd(), 'ui-audit-capture');
fs.mkdirSync(outDir, { recursive: true });

const providerServer = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini', context_window: 128000, modalities: ['text'] }] }));
      return;
    }
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const payload = {
    id: 'probe', object: 'chat.completion', created: Date.now(), model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: '模拟研究响应' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
});
await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}/v1`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-ui-audit-'));
app.setPath('userData', profileDir);

await import('../dist-electron/electron/main.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.on('ready', async () => {
  const results = [];
  try {
    let win = BrowserWindow.getAllWindows()[0];
    for (let index = 0; index < 80 && !win; index += 1) {
      await sleep(200);
      win = BrowserWindow.getAllWindows()[0];
    }
    if (!win) throw new Error('main window was not created');
    win.setSize(1440, 900, false);
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    }
    const run = (expression) => win.webContents.executeJavaScript(
      `(async () => { try { return ${expression}; } catch (error) { return { __error: String(error?.message ?? error) }; } })()`,
    );
    const waitFor = async (expression, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await run(expression);
        if (value) return value;
        await sleep(150);
      }
      return null;
    };
    const click = (selector) => run(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`);
    const shot = async (name) => {
      await sleep(400);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${theme}-${name}.png`), image.toPNG());
      console.log(`shot ${theme}-${name}`);
    };

    // Configure a provider so the app skips the first-run gate.
    const probe = await run(`window.metis.setupProbe(${JSON.stringify({ version: 1, operationId: 'audit-1', keyMode: 'replace', baseUrl: providerBaseUrl, model: 'gpt-4o-mini', newApiKey: 'audit-key' })})`);
    await run(`window.metis.setupSave(${JSON.stringify({ version: 1, operationId: 'audit-save', expectedConfigVersion: probe?.configVersion ?? 0, probeId: probe?.probeId ?? '' })})`);
    await run(`localStorage.setItem('metis-onboarding-done', '1'); localStorage.setItem('metis-theme', ${JSON.stringify(theme)}); 'ok'`);
    await run(`window.metis.setSettings?.(${JSON.stringify({ theme })}).catch(() => null)`);
    await win.reload();
    if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await sleep(1800);

    // Seed a project with an artifact + a task so the pages show real content.
    const projectId = 'audit-project-1';
    await run(`window.metis.researchCrud(${JSON.stringify({ operation: 'create', entityKind: 'project', projectId, value: { title: '民国救济制度研究', originalIntent: '', researchQuestion: '', methodology: '', discipline: '' } })})`);
    await run(`window.metis.researchCrud(${JSON.stringify({ operation: 'create', entityKind: 'source', projectId, value: { id: 'audit-source-1', kind: 'archive', title: '模拟地方档案目录', authors: [], year: 1935, venue: '模拟档案馆', identifier: '', identifierType: 'other', externalUrl: null, tags: ['档案'], deliverableSourceKind: null, deliverableRuleKind: null, sourceVersionHash: null } })})`);
    await run(`window.metis.researchVersion(${JSON.stringify({ operation: 'save_version', projectId, artifactId: 'audit-artifact-1', expectedVersion: null, title: '救济制度演变阶段报告', artifactType: 'report', reviewStatus: 'draft', inputs: [{ kind: 'source', id: 'audit-source-1' }], capabilityId: 'writing', method: 'audit', citedSourceIds: ['audit-source-1'], citationRequests: [], rendererKind: 'markdown', contentRef: null, media: [], inputHash: null, content: '# 阶段报告\n\n审计内容。', createdBy: 'user', branchFromVersion: null })})`);
    await run(`window.metis.createGoal?.(${JSON.stringify({ description: '核对档案来源边界并整理为研究报告', projectId })})`).catch(() => null);

    const surfaces = [
      { nav: 'converse', marker: '.chat-main, .shell-workspace--chat', name: 'converse' },
      { nav: 'projects', marker: '[data-testid="projects-page"]', name: 'projects-chat' },
      { nav: null, tab: 'projects-mode-kanban', name: 'projects-kanban' },
      { nav: null, tab: 'projects-mode-artifacts', name: 'projects-artifacts' },
      { nav: 'autonomous', marker: '.autonomous-page', name: 'autonomous' },
      { nav: 'settings', marker: '.settings-group', name: 'settings' },
      { nav: 'personalization', marker: '.personalization-center, .personalization-page', name: 'personalization', testId: 'personalization-trigger' },
      { nav: null, name: 'personalization-ai', extra: true },
      { nav: 'browser', marker: '.browser-page, [data-testid="browser-web-shell"]', name: 'browser' },
    ];
    for (const surface of surfaces) {
      if (surface.testId) {
        await click(`[data-testid="${surface.testId}"]`);
      } else if (surface.nav) {
        await click(`[data-nav-id="${surface.nav}"]`);
      } else if (surface.tab) {
        await click(`[data-testid="${surface.tab}"]`);
      } else if (surface.extra) {
        await click('[data-testid="ai-create-toggle"]');
        await click('[data-testid="template-parse-toggle"]');
      }
      if (surface.marker) await waitFor(`Boolean(document.querySelector(${JSON.stringify(surface.marker)}))`);
      await sleep(900);
      await shot(surface.name);
      results.push(surface.name);
    }
  } catch (error) {
    console.log('FATAL', String(error?.stack ?? error));
  }
  console.log('CAPTURE_DONE', JSON.stringify(results));
  app.exit(0);
});
