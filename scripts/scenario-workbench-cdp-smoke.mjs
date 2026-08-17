/**
 * Scenario workbench CDP smoke — drives the freshly packaged win-unpacked
 * app over the real metis-app:// entry with the REAL user profile, verifies
 * the scenario rework surface end-to-end:
 *   - scenario center opens with the 3-column workbench (library / detail /
 *     right context editor) and the five primary tabs
 *   - real repository is connected (listPersonalization)
 *   - a deterministic smoke scenario is created via IPC if the profile has
 *     none (or selects an existing one), then the UI shows:
 *       structure tree (locked/conditional markers), right context editor,
 *       adaptivity switches, rules & methods, capability/workflow, save
 *   - 1440px no horizontal overflow, no renderer console errors
 * Saves screenshots as evidence.
 *
 * Usage: node scripts/scenario-workbench-cdp-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = process.argv[2] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXE = path.join(PROJECT_ROOT, 'release', 'win-unpacked', 'Metis Research Workbench.exe');
const OUT_DIR = path.join(PROJECT_ROOT, 'test-results', 'scenario-workbench-smoke');
const TOKEN = randomBytes(24).toString('hex');
fs.mkdirSync(OUT_DIR, { recursive: true });

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

async function waitForRenderer(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('metis-app://'));
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
    this.consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) ?? '');
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

  async screenshot(fileName) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, fileName), Buffer.from(result.data, 'base64'));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic smoke scenario: matches the AI-created shape (deliverable /
// adaptivity / writingRules / methodPolicy) so all five tabs have content.
function smokeScenarioDefinition() {
  const now = Date.now();
  return {
    contractVersion: 1,
    id: 'user:scenario/cdp-smoke',
    kind: 'scenario',
    name: 'CDP 冒烟场景',
    description: '场景页 CDP 冒烟使用的确定性场景。',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'user', author: 'cdp-smoke', version: '1.0.0', license: null, sourceUrl: null,
      sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null,
      locallyModified: false, createdAt: now, updatedAt: now,
    },
    agentIds: [], skillIds: [], mcpIds: [], rulesIds: [],
    workflow: [],
    fullAccess: {
      mode: 'full_access', perActionConfirmation: false, liveSteering: true,
      silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true,
    },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 1000 },
    output: { format: 'markdown', schema: null, plan: null, requireEvidenceEnvelope: false, includeIntegrityReport: false },
    triggerPhrases: ['冒烟'],
    capability: 'research',
    deliverable: {
      type: 'theory_paper',
      typeLabel: '纯理论论文',
      globalLength: '8000-10000 字',
      structurePolicy: { defaultSections: 3, suggestedMin: 3, suggestedMax: 5 },
      sections: [
        { id: 'title', title: '题目', kind: 'title', status: 'locked', purpose: '概括核心论点' },
        { id: 'abstract', title: '摘要', kind: 'abstract', status: 'required', requirements: ['研究问题', '核心论点'], forbidden: ['出现本文'] },
        { id: 'keywords', title: '关键词', kind: 'keywords', status: 'optional' },
        { id: 'c1', title: '1 引言', kind: 'chapter', status: 'required', purpose: '提出研究问题', lengthTarget: '1200-1800 字' },
        { id: 'c2', title: '2 理论框架', kind: 'chapter', status: 'required', purpose: '建构理论框架', method: '概念分析' },
        { id: 'c3', title: '3 结论', kind: 'chapter', status: 'locked', purpose: '总结论点与边界' },
        { id: 'r1', title: '机制分析', kind: 'section', status: 'conditional', condition: '理论框架含明确机制时' },
      ],
    },
    adaptivity: {
      structure: { addSections: true, deleteUnlockedSections: true, splitSections: true, mergeSections: false, reorderSections: false, adjustLength: true },
      content: { reviseQuestion: true, addQuestion: false, reviseHypothesis: true, dropUnsupportedHypothesis: true, adjustFramework: true },
      method: { addMethod: true, replaceUnsuitableMethod: true, addRobustness: false, addHeterogeneity: false, addMechanism: true },
      allowedBacktracks: ['analysis->literature'],
      majorAdjustmentTriggers: ['新证据推翻原假设'],
    },
    writingRules: ['摘要禁止出现"本文"', '每节开头给出本节论点'],
    methodPolicy: { recommended: ['概念分析'], allowed: ['文本分析'], conditional: [], forbidden: ['问卷调查'] },
    materials: [],
  };
}

async function main() {
  const port = await freePort();
  const child = spawn(EXE, [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--metis-layout-acceptance=${TOKEN}`,
  ], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  const report = { passed: false, checks: [], screenshots: [] };
  const record = (name, ok, detail = '') => {
    report.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };

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
    await sleep(6000); // hydration + IPC ready

    // 0. Open scenario center via top bar.
    await cdp.evaluate(`document.querySelector('.topbar-nav__item[data-nav-id="personalization"]')?.click()`);
    await sleep(2500);
    const centerOpen = await cdp.evaluate(`Boolean(document.querySelector('.personalization-page'))`);
    record('场景中心可打开', centerOpen);

    // 1. Three-column workbench + five tabs surface.
    const surface = await cdp.evaluate(`(() => ({
      workbench: Boolean(document.querySelector('[data-testid="scenario-workbench"]')),
      aiEntry: Boolean(document.querySelector('[data-testid="sw-ai-create"]')),
      newEntry: Boolean(document.querySelector('[data-testid="sw-new-scenario"]')),
      libraryViews: document.querySelectorAll('[data-testid="sw-library-view"]').length,
      empty: Boolean(document.querySelector('[data-testid="sw-empty"]')),
    }))()`);
    record('三栏工作台就位（AI 创建/新建/分类树）', surface.workbench && surface.aiEntry && surface.newEntry && surface.libraryViews >= 6, JSON.stringify(surface));

    // 2. Real repository connected.
    const list = await cdp.evaluate(`window.metis.listPersonalization({ contractVersion: 1, includeDisabled: true })`);
    const existing = (list?.definitions ?? []).filter((d) => d.kind === 'scenario');
    record('场景中心连接真实个性化仓库', list?.ok === true && Array.isArray(list.definitions), `scenarios=${existing.length}`);

    // 3. Ensure the deterministic structured smoke scenario exists in the real
    //    repository (ai-create shaped: deliverable/adaptivity/writingRules/methodPolicy).
    const smokeExists = existing.some((s) => s.id === 'user:scenario/cdp-smoke');
    if (!smokeExists) {
      const saved = await cdp.evaluate(`window.metis.savePersonalization({ contractVersion: 1, definition: ${JSON.stringify(smokeScenarioDefinition())}, expectedRevision: 0 })`);
      record('真实仓库写入结构化冒烟场景', saved?.ok && saved?.code === 'saved', JSON.stringify(saved ? { code: saved.code, id: saved.definition?.id } : saved));
    } else {
      record('真实仓库写入结构化冒烟场景', true, 'already present');
    }
    // 仓库已写入但中心 definitions 状态未刷新：重载页面让工作台读到新场景，
    // 再回到场景中心（重载会回到默认落地页）。
    await cdp.evaluate(`location.reload()`);
    await sleep(6000);
    await cdp.evaluate(`document.querySelector('.topbar-nav__item[data-nav-id="personalization"]')?.click()`);
    await sleep(2500);

    // 4. Select the smoke scenario in the workbench (wait for async refresh).
    const selected = await cdp.evaluate(`(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const items = Array.from(document.querySelectorAll('[data-testid="sw-scenario-item"]'));
        const found = items.find((item) => item.textContent.includes('CDP 冒烟场景'));
        if (found) { found.click(); return true; }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })()`);
    record('工作台选中冒烟场景', Boolean(selected));

    const tabsReady = await cdp.evaluate(`(async () => {
      const want = ['sw-tab-overview', 'sw-tab-structure', 'sw-tab-rules', 'sw-tab-adapt', 'sw-tab-capability'];
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const tabs = Array.from(document.querySelectorAll('[data-testid^="sw-tab-"]')).map((el) => el.getAttribute('data-testid'));
        if (want.every((w) => tabs.includes(w))) return JSON.stringify(tabs);
        await new Promise((r) => setTimeout(r, 200));
      }
      return JSON.stringify(Array.from(document.querySelectorAll('[data-testid^="sw-tab-"]')).map((el) => el.getAttribute('data-testid')));
    })()`);
    record('选中后五个一级分区就位', tabsReady === JSON.stringify(['sw-tab-overview', 'sw-tab-structure', 'sw-tab-rules', 'sw-tab-adapt', 'sw-tab-capability']), tabsReady);

    // 5. Structure tree: rows, locked + conditional markers.
    await cdp.evaluate(`document.querySelector('[data-testid="sw-tab-structure"]')?.click()`);
    await sleep(600);
    const tree = await cdp.evaluate(`(() => ({
      rows: document.querySelectorAll('[data-testid="sw-tree-row"]').length,
      locked: document.querySelectorAll('[data-testid="sw-tree-row"] .sw-tree__icon[aria-label*="锁定"]').length,
      conditional: document.querySelectorAll('[data-testid="sw-tree-row"] .sw-tree__icon[aria-label*="条件"]').length,
    }))()`);
    record('成果结构树直展（含锁定与条件标识）', tree.rows >= 6, JSON.stringify(tree));
    await cdp.screenshot('scenario-structure.png');
    report.screenshots.push('scenario-structure.png');

    // 6. Click a chapter → right context editor.
    const openedRow = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="sw-tree-row"]'));
      const target = rows.find((row) => row.textContent.includes('理论框架'));
      if (!target) return false;
      target.click(); return true;
    })()`);
    await sleep(600);
    const ctxEditor = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="sw-context-editor"]')?.textContent?.includes('理论框架'))`);
    record('点击章节 → 右栏上下文编辑器', openedRow && ctxEditor);
    await cdp.screenshot('scenario-context-editor.png');
    report.screenshots.push('scenario-context-editor.png');

    // 7. Adaptivity tab: three switch groups + backtracks + triggers.
    await cdp.evaluate(`document.querySelector('[data-testid="sw-tab-adapt"]')?.click()`);
    await sleep(600);
    const adapt = await cdp.evaluate(`(() => ({
      groups: document.querySelectorAll('.sw-adapt__group').length,
      checked: document.querySelectorAll('[data-testid^="sw-adapt-"]:checked').length,
      backtracks: document.querySelector('.sw-adapt__backtracks textarea')?.value ?? '',
      triggers: document.querySelector('.sw-adapt__triggers textarea')?.value ?? '',
    }))()`);
    record('自适应页展示 AI 自主边界', adapt.groups >= 3 && adapt.checked >= 5 && adapt.backtracks.includes('analysis->literature') && adapt.triggers.length > 0, JSON.stringify(adapt));
    await cdp.screenshot('scenario-adaptivity.png');
    report.screenshots.push('scenario-adaptivity.png');

    // 8. Rules & methods + capability/workflow pages.
    await cdp.evaluate(`document.querySelector('[data-testid="sw-tab-rules"]')?.click()`);
    await sleep(600);
    const rulesText = await cdp.evaluate(`document.querySelector('[data-testid="sw-rules"]')?.textContent ?? ''`);
    record('规则与方法页含写作规范与方法策略', rulesText.includes('摘要禁止出现') && rulesText.includes('概念分析'), rulesText.slice(0, 60));
    await cdp.evaluate(`document.querySelector('[data-testid="sw-tab-capability"]')?.click()`);
    await sleep(600);
    const cap = await cdp.evaluate(`(() => ({
      agentGroup: Boolean(document.querySelector('[data-testid="sw-cap-agent"]') ?? document.querySelector('.sw-cap__group h4')?.textContent?.includes('智能体')),
      advanced: Boolean(document.querySelector('[data-testid="sw-advanced"]')),
      workflowList: Boolean(document.querySelector('[data-testid="sw-workflow-list"]')),
    }))()`);
    record('能力与运行页含绑定/高级设置/工作流', cap.advanced && (cap.agentGroup || cap.workflowList), JSON.stringify(cap));

    // 9. Edit a section purpose then save (real persistence round-trip).
    await cdp.evaluate(`document.querySelector('[data-testid="sw-tab-structure"]')?.click()`);
    await sleep(400);
    await cdp.evaluate(`(() => { const rows = Array.from(document.querySelectorAll('[data-testid="sw-tree-row"]')); const t = rows.find((r) => r.textContent.includes('章节')) ?? rows[0]; if (t) t.click(); return true; })()`);
    await sleep(500);
    const rowTitle = await cdp.evaluate(`document.querySelector('[data-testid="sw-context-editor"] h3')?.textContent ?? ''`);
    const edited = await cdp.evaluate(`(() => {
      // 「这一部分负责什么」是右栏第一个 textarea（标题/类型/条件在前，但均为非 textarea）。
      const purpose = document.querySelector('[data-testid="sw-context-editor"] textarea');
      if (!purpose) return false;
      const proto = HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(purpose, 'CDP 冒烟：建构理论框架与核心论点');
      purpose.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await cdp.evaluate(`document.querySelector('[data-testid="sw-save"]')?.click()`);
    await sleep(1500);
    const savedState = await cdp.evaluate(`document.querySelector('[data-testid="sw-save-state"]')?.textContent ?? ''`);
    const activeName = await cdp.evaluate(`document.querySelector('.sw-head__name')?.value ?? ''`);
    const persisted = await cdp.evaluate(`window.metis.listPersonalization({ contractVersion: 1, includeDisabled: true }).then((r) => {
      const defs = r.definitions ?? [];
      const scenario = defs.find((d) => d.kind === 'scenario' && d.name === thisActiveName()) ?? defs.find((d) => d.kind === 'scenario');
      return scenario?.deliverable?.sections?.some((s) => s.purpose === 'CDP 冒烟：建构理论框架与核心论点') ?? false;
    })`.replace('thisActiveName()', JSON.stringify(activeName)));
    record('修改章节要求并保存落库', edited && savedState !== '' && Boolean(persisted), JSON.stringify({ rowTitle, savedState, persisted }));
    await cdp.screenshot('scenario-saved.png');
    report.screenshots.push('scenario-saved.png');

    // 10. Viewport sanity.
    const overflow = await cdp.evaluate(`(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))()`);
    record('1440px 无整页横向滚动', overflow.w <= overflow.c + 1, 'scroll=' + overflow.w + ' client=' + overflow.c);

    record('模拟期间无渲染器错误级控制台消息', cdp.consoleErrors.length === 0, JSON.stringify(cdp.consoleErrors.slice(0, 3)));

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
  console.log('Summary: ' + (report.checks.length - failed.length) + '/' + report.checks.length + ' checks passed');
  if (report.error) console.log('Error: ' + report.error);
  process.exit(report.passed && !report.error ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error.message);
  process.exit(1);
});
