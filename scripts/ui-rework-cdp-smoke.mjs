/**
 * UI rework CDP smoke — drives the BUILT Electron app over the real
 * metis-app:// entry, verifies the fine top navigation, workspace shell,
 * standalone destinations, and horizontal-overflow invariants at multiple
 * viewports, and saves screenshots as evidence.
 *
 * Usage: node scripts/ui-rework-cdp-smoke.mjs <projectRoot>
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const PROJECT_ROOT = process.argv[2] ?? process.cwd();
const ELECTRON_EXE = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT_DIR = path.join(PROJECT_ROOT, 'test-results', 'ui-rework-smoke');
const TOKEN = randomBytes(24).toString('hex');

fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { width: 1440, height: 900, name: 'wide' },
  { width: 1200, height: 900, name: 'medium' },
  { width: 900, height: 900, name: 'narrow-shell' },
  { width: 650, height: 900, name: 'mobile' },
  { width: 400, height: 900, name: 'tiny' },
];

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForRenderer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith('metis-app://'));
      if (page) return page;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Renderer target did not appear within timeout');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async screenshot(fileName) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, fileName), Buffer.from(result.data, 'base64'));
  }
}

async function main() {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'metis-smoke-'));
  const child = spawn(ELECTRON_EXE, [
    PROJECT_ROOT,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--metis-layout-acceptance=${TOKEN}`,
  ], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  const report = { passed: false, checks: [], screenshots: [] };
  let cdp;
  try {
    const target = await waitForRenderer(port);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await new Promise((resolve) => setTimeout(resolve, 4000)); // hydration

    const record = (name, ok, detail = '') => {
      report.checks.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    };

    // ── Structure at the default wide viewport ─────────────────
    const structure = await cdp.evaluate(`(() => {
      const navItems = Array.from(document.querySelectorAll('.topbar-nav__item')).map((b) => b.getAttribute('data-nav-id'));
      const scenarioTrigger = document.querySelector('[data-testid="personalization-trigger"]');
      return {
        navItems,
        mainContent: Boolean(document.querySelector('.main-content')),
        projectShell: Boolean(document.querySelector('.project-shell')),
        active: document.querySelector('.topbar-nav__item[aria-current="page"]')?.getAttribute('data-nav-id') ?? null,
        scenarioIsNavItem: Boolean(scenarioTrigger) && scenarioTrigger.classList.contains('topbar-nav__item'),
        noIconTriggerInActions: !document.querySelector('.topbar-actions .personalization-trigger'),
      };
    })()`);
    record('topbar renders eight primary entries', JSON.stringify(structure.navItems) === JSON.stringify(['converse', 'read', 'write', 'autonomous', 'kanban', 'library', 'settings', 'personalization']), JSON.stringify(structure.navItems));
    record('scenario entry is a labeled nav item, not a lone icon button', structure.scenarioIsNavItem && structure.noIconTriggerInActions);
    record('main-content and project shell present', structure.mainContent && structure.projectShell);
    record('default active entry is converse', structure.active === 'converse', structure.active);

    // ── Viewport overflow invariants ───────────────────────────
    for (const viewport of VIEWPORTS) {
      await cdp.setViewport(viewport.width, viewport.height);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const overflow = await cdp.evaluate(`(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        bodyScrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))()`);
      record(`no horizontal overflow at ${viewport.width}px`, !overflow.horizontalOverflow, `scroll=${overflow.bodyScrollWidth} client=${overflow.clientWidth}`);
      await cdp.screenshot(`viewport-${viewport.name}-${viewport.width}.png`);
      report.screenshots.push(`viewport-${viewport.name}-${viewport.width}.png`);
    }

    // ── Navigation through the top bar ─────────────────────────
    const navigate = async (navId, markerSelector, markerText) => {
      await cdp.evaluate(`document.querySelector('.topbar-nav__item[data-nav-id="${navId}"]')?.click()`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const found = await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(markerSelector)}))`);
      record(`top bar ${navId} opens ${markerText}`, found);
    };
    await cdp.setViewport(1440, 900);
    await navigate('read', '[aria-label="阅读工作区"], [role="tabpanel"][aria-label="阅读工作区"]', 'read workspace');
    await navigate('autonomous', '.autonomous-page, .autonomous-header', 'autonomous research page');
    await navigate('kanban', '.kanban-page, .kanban-board', 'task board page');
    await navigate('settings', '.settings-group', 'settings page');
    await navigate('library', '.papers-page', 'library page');
    await navigate('personalization', '.personalization-page, .personalization-hero', 'scenario center');
    await cdp.screenshot('navigation-personalization.png');
    report.screenshots.push('navigation-personalization.png');
    await navigate('converse', '.chat-main, .shell-workspace--chat', 'conversation workspace');
    await cdp.screenshot('navigation-converse.png');
    report.screenshots.push('navigation-converse.png');

    report.passed = report.checks.every((check) => check.ok);
  } catch (error) {
    report.error = error.message;
    console.error('SMOKE FAILED:', error.message);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((check) => !check.ok);
  console.log(`\nSummary: ${report.checks.length - failed.length}/${report.checks.length} checks passed`);
  if (report.error) console.log(`Error: ${report.error}`);
  process.exit(report.passed && !report.error ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error.message);
  process.exit(1);
});
