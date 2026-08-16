// Screenshot main surfaces via CDP — no reload (in-page navigation only).
// Usage: node scripts/ui-audit-screenshots.mjs <outDir> [theme]
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? path.join(process.cwd(), 'ui-audit');
const theme = process.argv[3] ?? 'light';
fs.mkdirSync(outDir, { recursive: true });

const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('metis-app'));
if (!page) throw new Error('no renderer page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { try { return ${expression}; } catch (error) { return { __error: String(error?.message ?? error) }; } })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return res.result?.result?.value;
}

async function shot(name) {
  const result = await Promise.race([
    send('Page.captureScreenshot', { format: 'png' }),
    sleep(8000).then(() => null),
  ]);
  if (!result?.result?.data) {
    console.log(`SKIP ${theme}-${name}.png (capture hung)`);
    return;
  }
  fs.writeFileSync(path.join(outDir, `${theme}-${name}.png`), Buffer.from(result.result.data, 'base64'));
  console.log(`shot ${theme}-${name}.png`);
}

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// Theme without reload: toggle via the in-app store through the UI button label.
const currentTheme = await evaluate(`(() => document.documentElement.getAttribute('data-theme') ?? 'light')()`);
if (theme === 'dark' && currentTheme !== 'dark') {
  await evaluate(`(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.body?.setAttribute('data-theme', 'dark'); return true; })()`);
}

const skip = await evaluate(`(() => { const el = document.querySelector('[data-testid="first-run-skip"]'); if (el) { el.click(); return 'skipped'; } return 'no-gate'; })()`);
console.log('setup:', skip);
await sleep(600);

const waitForMarker = async (marker, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(`Boolean(document.querySelector(${JSON.stringify(marker)}))`);
    if (found) return true;
    await sleep(150);
  }
  return false;
};

const navTo = async (navId, marker, name, extraMs = 900) => {
  await evaluate(`(() => { const b = document.querySelector('[data-nav-id="${navId}"]'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(extraMs);
  await waitForMarker(marker, 5000);
  await shot(name);
};

// 1. 对话
await navTo('converse', '.chat-main, .shell-workspace--chat', 'converse');
// 2. 科研项目 — chat
await navTo('projects', '[data-testid="projects-page"]', 'projects-chat', 1200);
// 3. 科研项目 — kanban
await evaluate(`(() => { const b = document.querySelector('[data-testid="projects-mode-kanban"]'); if (b) { b.click(); return true; } return false; })()`);
await sleep(1200);
await shot('projects-kanban');
// 4. 科研项目 — artifacts
await evaluate(`(() => { const b = document.querySelector('[data-testid="projects-mode-artifacts"]'); if (b) { b.click(); return true; } return false; })()`);
await sleep(1200);
await shot('projects-artifacts');
// 5. 自主科研
await navTo('autonomous', '.autonomous-page', 'autonomous', 1400);
// 6. 设置
await navTo('settings', '.settings-page, .settings-group', 'settings', 1400);
// 7. 场景中心
await evaluate(`(() => { const b = document.querySelector('[data-testid="personalization-trigger"]'); if (b) { b.click(); return true; } return false; })()`);
await sleep(1500);
await shot('personalization');
// 8. 场景中心 — AI 面板
await evaluate(`(() => { const t = document.querySelector('[data-testid="ai-create-toggle"]'); if (t) t.click(); const t2 = document.querySelector('[data-testid="template-parse-toggle"]'); if (t2) t2.click(); return true; })()`);
await sleep(900);
await shot('personalization-ai');
// 9. 浏览器（最后：其 webview 可能阻塞截图）
await navTo('browser', '.browser-page, [data-testid="browser-web-shell"]', 'browser', 1600);

ws.close();
console.log('DONE');
process.exit(0);
