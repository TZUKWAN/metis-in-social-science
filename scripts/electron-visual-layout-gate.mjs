#!/usr/bin/env node
/**
 * Electron visual/layout geometry gate (T09).
 *
 * Connects to a running Electron app over CDP (launch Electron with
 * `--remote-debugging-port=9222`), drives the app through its public
 * navigation bus (`metis:navigate`), and evaluates programmatic layout
 * checks per surface. Emits geometry.json + issues.md + PNG screenshots.
 *
 * Zero dependencies: Node >= 22 (built-in WebSocket + fetch).
 *
 * Usage:
 *   node scripts/electron-visual-layout-gate.mjs [--port=9222] [--out=logs/ui-overhaul/gate]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const PORT = Number(opt('port', '9222'));
const OUT = path.resolve(opt('out', 'logs/ui-overhaul/gate'));

const SURFACES = [
  { id: 'research-chat', navigate: { kind: 'workspace', tab: 'chat' } },
  { id: 'research-kanban', navigate: { kind: 'workspace', tab: 'kanban' } },
  { id: 'topics', navigate: { kind: 'standalone', page: 'topics' } },
  { id: 'outcomes', navigate: { kind: 'standalone', page: 'outcomes' } },
  { id: 'submissions', navigate: { kind: 'standalone', page: 'submissions' } },
  { id: 'settings', navigate: { kind: 'settings' } },
];

/** Geometry probe evaluated inside the page. Keep it dependency-free. */
const PROBE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const round = (r) => r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const clipped = [];
  for (const el of document.querySelectorAll('button, [role="tab"], [role="menuitem"], .topbar-nav__item, h1, h2, h3, label')) {
    if (!visible(el)) continue;
    // Labels that merely caption a form control (the control truncates itself).
    if (el.tagName === 'LABEL' && el.querySelector('select, input, textarea')) continue;
    const style = getComputedStyle(el);
    const intentional = style.textOverflow === 'ellipsis' || style.overflow === 'hidden' && style.whiteSpace === 'nowrap';
    if (el.scrollWidth > el.clientWidth + 2 && !intentional) {
      clipped.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 30), scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
  }
  const scrollingEl = document.scrollingElement || document.documentElement;
  const rootOverflowY = getComputedStyle(scrollingEl).overflowY;
  const q = (sel) => document.querySelector(sel);
  const topbar = q('.topbar');
  const main = q('.main-content');
  return {
    viewport: { w: vw, h: vh },
    url: location.href,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    bodyScrollH: document.body.scrollHeight,
    docScrollH: document.documentElement.scrollHeight,
    rootOverflowY,
    rootScrollable: rootOverflowY !== 'hidden' && rootOverflowY !== 'clip',
    topbar: topbar ? round(topbar.getBoundingClientRect()) : null,
    main: main ? round(main.getBoundingClientRect()) : null,
    chatSidebar: (el => el ? round(el.getBoundingClientRect()) : null)(q('.chat-sidebar')),
    candidatesPanel: (el => el ? round(el.getBoundingClientRect()) : null)(q('.topic-workspace__candidates')),
    rightPanel: (el => el ? round(el.getBoundingClientRect()) : null)(q('.research-shell-inspector, .workspace-shell__right, .outcome-assistant')),
    clipped: clipped.slice(0, 12),
    clippedCount: clipped.length,
    aio: Boolean(q('.aio-root')),
    composer: (el => el ? round(el.getBoundingClientRect()) : null)(q('.aio-root .chat-input-area')),
    conversation: (el => el ? round(el.getBoundingClientRect()) : null)(q('.aio-conversation')),
    surfaceHint: (q('.topic-workspace') ? 'topics' : q('.outcome-workbench, [class*="outcome"]') ? 'outcomes' : q('.settings-page') ? 'settings' : q('.submission') ? 'submissions' : 'research') 
  };
})()`;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP websocket failed')); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
    });
  }
  listen(handler) { this.ws.onmessage = (event) => handler(JSON.parse(event.data)); }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /localhost:5173/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error('No METIS renderer target found on CDP');
  const client = await Cdp.connect(page.webSocketDebuggerUrl);

  let screenshotResolve = null;
  client.listen((message) => {
    if (message.id && client.pending.has(message.id)) {
      const { resolve, reject } = client.pending.get(message.id);
      client.pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      return;
    }
    if (message.method === 'Page.screencastFrame') { /* unused */ }
  });

  const evalJs = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Probe failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  };
  const shot = async (file) => {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(OUT, file), Buffer.from(data, 'base64'));
  };
  const navigateSurface = async (intent) => {
    await evalJs(`window.dispatchEvent(new CustomEvent('metis:navigate', { detail: ${JSON.stringify(intent)} }))`);
    await new Promise((r) => setTimeout(r, 1400));
  };

  const results = [];
  const issues = [];

  for (const surface of SURFACES) {
    await navigateSurface(surface.navigate);
    const geo = await evalJs(PROBE);
    await shot(`${surface.id}.png`);
    results.push({ surface: surface.id, ...geo });

    // T09.02 horizontal overflow
    if (geo.docScrollW > geo.viewport.w + 1 || geo.bodyScrollW > geo.viewport.w + 1) {
      issues.push({ id: `${surface.id}-overflow-x`, severity: 'P1', problem: `horizontal overflow (doc ${geo.docScrollW} / viewport ${geo.viewport.w})` });
    }
    // T09.07 scroll ownership: page-level vertical scroll only when the root
    // is actually scrollable; hidden overflow is recorded as P2 (clipped tail).
    if (geo.docScrollH > geo.viewport.h + 1) {
      if (geo.rootScrollable) {
        issues.push({ id: `${surface.id}-body-scroll`, severity: 'P1', problem: `body/document vertical scroll (docH ${geo.docScrollH} > viewport ${geo.viewport.h})` });
      } else {
        issues.push({ id: `${surface.id}-clipped-doc`, severity: 'P2', problem: `content extends ${geo.docScrollH}px under overflow:hidden (verify reachability)` });
      }
    }
    // T09.01 root contract
    if (geo.main && (geo.main.x < -1 || geo.main.y < -1 || geo.main.x + geo.main.w > geo.viewport.w + 1 || geo.main.y + geo.main.h > geo.viewport.h + 1)) {
      issues.push({ id: `${surface.id}-root-bounds`, severity: 'P1', problem: `main root escapes viewport: ${JSON.stringify(geo.main)}` });
    }
    // T09.04 text clipping
    if (geo.clippedCount > 0) {
      issues.push({ id: `${surface.id}-clipped-text`, severity: 'P2', problem: `${geo.clippedCount} clipped element(s)`, samples: geo.clipped.slice(0, 4) });
    }
  }

  // T09.08 AIO geometry — normalize to normal mode first (AIO persists across
  // launches via metis:aio-mode), then toggle in via the app's global shortcut.
  const toggleAio = async () => {
    await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true }))`);
    await new Promise((r) => setTimeout(r, 1000));
  };
  let pre = await evalJs(PROBE);
  if (pre.aio) await toggleAio(); // exit leftover AIO from a previous session
  await navigateSurface({ kind: 'workspace', tab: 'chat' });
  await toggleAio();
  const aio = await evalJs(PROBE);
  await shot('aio-zen.png');
  results.push({ surface: 'aio-zen', ...aio });

  if (!aio.aio) issues.push({ id: 'aio-not-active', severity: 'P0', problem: `AIO root not present after Ctrl+Shift+A (active page: ${aio.surfaceHint}, layout: ${aio.topbar ? 'topbar' : 'no-topbar'})` });
  else {    if (aio.topbar) issues.push({ id: 'aio-topbar-visible', severity: 'P0', problem: `topbar rect occupied in AIO: ${JSON.stringify(aio.topbar)}` });
    if (!aio.composer) issues.push({ id: 'aio-composer-missing', severity: 'P0', problem: 'composer not visible in AIO' });
    if (aio.conversation && aio.conversation.w > 920) issues.push({ id: 'aio-conversation-too-wide', severity: 'P1', problem: `conversation width ${aio.conversation.w}px > 900` });
    if (aio.chatSidebar) issues.push({ id: 'aio-sidebar-visible', severity: 'P0', problem: 'chat sidebar rendered in AIO' });
  }
  // restore normal mode
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', shiftKey: true, ctrlKey: true, bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 800));

  await writeFile(path.join(OUT, 'geometry.json'), JSON.stringify(results, null, 2));
  const p0 = issues.filter((i) => i.severity === 'P0').length;
  const p1 = issues.filter((i) => i.severity === 'P1').length;
  const md = [
    '# Geometry gate report', '',
    `- Viewport surfaces: ${SURFACES.length} + AIO`,
    `- P0: ${p0} | P1: ${p1} | P2: ${issues.length - p0 - p1}`, '',
    '| ID | Severity | Problem |', '|---|---|---|',
    ...issues.map((i) => `| ${i.id} | ${i.severity} | ${i.problem} |`), '',
  ].join('\n');
  await writeFile(path.join(OUT, 'issues.md'), md);
  console.log(md);
  console.log(`GATE ${p0 === 0 && p1 === 0 ? 'PASS' : 'FAIL'} → ${OUT}`);
  process.exitCode = p0 === 0 && p1 === 0 ? 0 : 1;
  client.ws.close();
}

main().catch((err) => { console.error('[ui-gate]', err.message); process.exit(2); });
