#!/usr/bin/env node
/**
 * ui-resolution-matrix.cjs — 多分辨率 UI 验收矩阵（真实 Electron + 真实 DOM）。
 *
 * 复用 scripts/ui-feature-sweep.cjs 的隔离启动模式：
 *   - 一次性临时 userData profile（同时通过 METIS_USER_DATA_DIR 传给真实主进程，
 *     见 electron/main.ts T00.03 acceptance isolation 分支）；
 *   - 随机 loopback CDP 端口（--remote-debugging-port=0，端口写入
 *     <profile>/DevToolsActivePort，harness 读取后仅作为证据记录，驱动本身走
 *     webContents.executeJavaScript，比 CDP 更稳、无 WebSocket 依赖）；
 *   - 单实例隔离（requestSingleInstanceLock 按 userData 目录加锁，临时目录即独占）；
 *   - 启动前检查 dist-electron 产物（缺失 → exit 2 blocked）；
 *   - 结束时只 taskkill 自己记录的 PID 树，不碰任何其他进程。
 *
 * 矩阵（默认 5 视口 × 6 surface）：
 *   视口: 1280x800, 1440x900, 1600x900, 1920x1080, 2560x1440
 *        （可用 METIS_RESOLUTION_MATRIX_VIEWPORTS="1280x800,..." 覆盖，便于单视口调试）
 *   surface: chat(ChatPage 聊天工作台) / topics(TopicWorkspacePage) /
 *            scenarios(ScenarioWorkbench) / outcomes(OutcomesPage) /
 *            submissions(SubmissionWorkspacePage) / settings(SettingsPanel)
 *
 * 每个 surface×视口断言（断言名 → 实现位置；断言求值全部发生在被测渲染进程内，
 * ok 只由真实 DOM 读数 / 真实 IPC 响应决定，没有任何硬编码通过路径）：
 *   viewport-applied                → childMain() 视口循环（win.setContentSize + settle 轮询）
 *   surface-ready                   → childMain() surface 循环（clickNav + waitForDom）
 *   no-horizontal-document-overflow → assertNoHorizontalOverflow()
 *   chat-composer-in-viewport       → assertChatComposer()
 *   topbar-nav-controls-geometry    → assertTopbarNav()
 *   scroll-owner-containers         → assertScrollOwners()
 *   screenshot-captured             → captureShot()
 *   app-boots-startup-ready         → childMain() 启动门控段（轮询 window.metis.startupStatus().ready）
 *   first-run-provider-probe / -save / onboarding-overlay-dismissed → childMain() onboarding handshake 段
 *
 * 失败快照：任一断言失败 → 该 surface×viewport 记录 body 可见文本前 2000 字、
 * 渲染进程 console error（webContents 'console-message' level 3 环形缓冲）、失败截图。
 *
 * 报告：logs/ui-resolution-matrix-<ts>.json
 *   { harness, status: passed|failed|blocked, assertions: [{surface,viewport,name,ok,detail}],
 *     evidence: { screenshots: [...] }, failureSnapshots: [...], ... }
 * 退出码：0 passed · 1 failed · 2 blocked（构建缺失 / 配置非法）。
 * 本脚本从不注入"通过"结果：每个 ok 都来自真实 DOM 读数或真实 IPC 响应。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(ROOT, 'dist-electron', 'electron', 'main.js');
const MODEL = 'metis-resolution-matrix-loopback';
const API_KEY = 'metis-resolution-matrix-loopback-key';
const CHILD_TIMEOUT_MS = 420_000;
const VIEWPORT_SETTLE_MS = 8_000;
const STARTUP_READY_TIMEOUT_MS = 120_000;

const DEFAULT_VIEWPORTS = [
  [1280, 800],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
];

/** 顶栏 6 个一级导航（src/shell/navConfig.ts + App.tsx data-nav-id）。 */
const TOPBAR_NAV_IDS = ['projects', 'topics', 'outcomes', 'submissions', 'personalization', 'settings'];

/**
 * Surface 契约。readySelector 为该页真实根节点；scrollOwners 为
 * docs/ui-surface-inventory.md「Scroll owner」列对应且在空态下也必然渲染的
 * 容器（必须存在、唯一、可见）；eitherGroups 为"空态/有态二选一"的容器组，
 * 至少命中一个，实况记录进 detail。
 */
const SURFACES = [
  {
    id: 'chat',
    label: 'ChatPage 聊天工作台',
    navId: 'projects',
    readySelector: '[data-testid="projects-page"]',
    composer: true,
    scrollOwners: ['.chat-messages'],
    eitherGroups: [],
  },
  {
    id: 'topics',
    label: 'TopicWorkspacePage 选题',
    navId: 'topics',
    readySelector: '[data-testid="topic-workspace"]',
    composer: false,
    // Inventory「候选/对话各自」：对话区 + 会话列表常驻；候选列表仅在有候选时
    // 渲染（rightHidden = rightCollapsed || candidatesEmpty），故候选栏进 either 组。
    scrollOwners: ['.topic-workspace__messages', '.topic-workspace__sessionlist-scroll'],
    eitherGroups: [['.topic-workspace__candidate-list', '.topic-workspace__candidates']],
  },
  {
    id: 'scenarios',
    label: 'ScenarioWorkbench 场景',
    navId: 'personalization',
    readySelector: '[data-testid="scenario-workbench"]',
    composer: false,
    // Inventory「步骤列表/编辑器」：场景库列表常驻；编辑器滚动容器仅在打开
    // 草稿后出现，空态由 sw-empty 占位。
    scrollOwners: ['.scenario-library__list'],
    eitherGroups: [['.scenario-workbench__editor-scroll', '[data-testid="sw-empty"]']],
  },
  {
    id: 'outcomes',
    label: 'OutcomesPage 成果',
    navId: 'outcomes',
    // 无科研项目时产品正确渲染 .outcomes-empty 空态引导（OutcomesPage.tsx:749），
    // 两种根都算 surface ready。
    readySelector: '.outcomes-page, .outcomes-empty',
    composer: false,
    // Inventory「各栏内部」：树滚动常驻——仅在有项目时渲染；空态下整页被
    // .outcomes-empty 替代（无项目时无树也无助手栏），两组 eitherGroup 都以
    // .outcomes-empty 作为空态分支命中项，实况记录。
    scrollOwners: [],
    eitherGroups: [
      ['.outcomes-tree-scroll', '.outcomes-empty'],
      ['.outcome-assistant__messages', '.outcome-assistant__empty', '.outcomes-empty'],
    ],
  },
  {
    id: 'submissions',
    label: 'SubmissionWorkspacePage 投稿',
    navId: 'submissions',
    readySelector: '.submission-workspace',
    composer: false,
    // Inventory「各栏」：左栏列表与右栏参谋消息区均 overflow-y:auto 且常驻。
    scrollOwners: ['.submission-workspace__left', '.submission-workspace__messages'],
    eitherGroups: [],
  },
  {
    id: 'settings',
    label: 'SettingsPanel 设置',
    navId: 'settings',
    readySelector: '.settings-page',
    composer: false,
    // Inventory「placeholder-page」：设置页根节点即 .placeholder-page.settings-page，
    // 页级滚动由 .main-content（overflow-y:auto）承担，一并在 mainContent 断言。
    scrollOwners: ['.settings-page'],
    eitherGroups: [],
  },
];

const STAMP = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
const REPORT_INDEX = process.argv.indexOf('--report');
const REPORT_PATH = path.resolve(
  REPORT_INDEX >= 0 && process.argv[REPORT_INDEX + 1]
    ? process.argv[REPORT_INDEX + 1]
    : path.join(ROOT, 'logs', `ui-resolution-matrix-${STAMP}.json`),
);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function safeRead(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function pathToFileURL(p) { return require('node:url').pathToFileURL(p); }

/** 解析 METIS_RESOLUTION_MATRIX_VIEWPORTS（"1280x800,1920x1080"）；非法项直接报错。 */
function parseViewportsOverride(raw) {
  const text = String(raw || '').trim();
  if (!text) return DEFAULT_VIEWPORTS.map(([w, h]) => [w, h]);
  const out = [];
  for (const part of text.split(',')) {
    const token = part.trim().toLowerCase();
    const match = /^(\d{2,5})x(\d{2,5})$/u.exec(token);
    const w = match ? Number(match[1]) : 0;
    const h = match ? Number(match[2]) : 0;
    if (!match || w < 320 || h < 240 || w > 8192 || h > 8192) {
      throw new Error(`METIS_RESOLUTION_MATRIX_VIEWPORTS 含非法视口 "${part}"（期望 WxH，如 1280x800）`);
    }
    out.push([w, h]);
  }
  if (out.length === 0) throw new Error('METIS_RESOLUTION_MATRIX_VIEWPORTS 解析结果为空');
  return out;
}

// ─── Loopback provider（确定性的 OpenAI 兼容回环服务，仅用于首启 probe）─────

function sendJson(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function sse(data) { return `data: ${data}\n\n`; }
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

async function startProvider() {
  const state = { requests: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models')) {
      return sendJson(res, 200, { data: [{ id: MODEL, context_window: 32_000, modalities: ['text'] }] });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: 'not_found' });
    }
    state.requests += 1;
    let body;
    try { body = await parseRequestBody(req); } catch { return sendJson(res, 400, { error: 'invalid_json' }); }
    const chunk = { id: 'matrix', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'MATRIX_OK' }, finish_reason: null }] };
    const done = { id: 'matrix', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] };
    if (body?.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(sse(JSON.stringify(chunk)));
      res.write(sse(JSON.stringify(done)));
      return res.end(sse('[DONE]'));
    }
    return sendJson(res, 200, {
      id: `matrix-${Date.now()}`, object: 'chat.completion', created: Math.trunc(Date.now() / 1000), model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'MATRIX_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

// ─── Electron 子进程内执行（childMain）───────────────────────────────────────

const rendererExpression = (expr) => `(async () => { try { return await (${expr}); } catch (error) { return { __e2eError: String(error && (error.stack || error.message) || error) }; } })()`;

async function childMain() {
  const { app, BrowserWindow, webContents } = require('electron');
  const profileDir = process.env.METIS_RESOLUTION_MATRIX_PROFILE;
  const providerUrl = process.env.METIS_RESOLUTION_MATRIX_PROVIDER;
  const reportPath = process.env.METIS_RESOLUTION_MATRIX_REPORT;
  const shotDir = process.env.METIS_RESOLUTION_MATRIX_SHOTS;
  if (!profileDir || !providerUrl || !reportPath || !shotDir) throw new Error('resolution matrix child env incomplete');

  app.setName('METIS UI Resolution Matrix');
  // 双保险：child 里先设一次（sweep 机制），真实 main.ts 读 METIS_USER_DATA_DIR 再设同值。
  app.setPath('userData', profileDir);

  const viewports = parseViewportsOverride(process.env.METIS_RESOLUTION_MATRIX_VIEWPORTS);
  const report = {
    harness: 'ui-resolution-matrix',
    status: 'failed',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    viewports: viewports.map(([w, h]) => `${w}x${h}`),
    surfaces: SURFACES.map((s) => ({ id: s.id, label: s.label, navId: s.navId })),
    assertions: [],
    evidence: { screenshots: [], shotDir, profileDir },
    failureSnapshots: [],
    consoleErrors: [],
    isolation: { userDataDir: profileDir, provider: providerUrl },
  };
  const writeReport = () => {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  };
  const check = (surface, viewport, name, ok, detail) => {
    const entry = { surface, viewport, name, ok: ok === true, detail: detail ?? null };
    report.assertions.push(entry);
    console.log(`[matrix] ${ok === true ? 'ok  ' : 'FAIL'} [${viewport}] ${surface} :: ${name}${ok === true ? '' : ` → ${JSON.stringify(detail)?.slice(0, 300)}`}`);
    return ok === true;
  };

  // 渲染进程 console error 环形缓冲（Electron 41: (event, messageDetails level 0-3)；
  // 兼容旧签名 (event, level, message, line, sourceId)）。
  const consoleErrors = [];
  const rememberConsole = (...args) => {
    const maybe = args[1];
    let level = null; let message = null; let source = null;
    if (maybe && typeof maybe === 'object') {
      level = maybe.level; message = maybe.message; source = maybe.source ?? null;
    } else if (typeof maybe === 'number') {
      level = maybe; message = typeof args[2] === 'string' ? args[2] : null; source = typeof args[4] === 'string' ? args[4] : null;
    }
    if (level === 3 && message) {
      consoleErrors.push({ at: new Date().toISOString(), message: String(message).slice(0, 500), source });
      if (consoleErrors.length > 80) consoleErrors.shift();
    }
  };

  let win = null;
  const run = async (expr) => {
    if (!win || win.isDestroyed()) throw new Error('main window gone');
    const value = await win.webContents.executeJavaScript(rendererExpression(expr), true);
    if (value && typeof value === 'object' && value.__e2eError) throw new Error(`renderer eval failed: ${value.__e2eError}`);
    return value;
  };

  try {
    if (!fs.existsSync(MAIN_ENTRY)) {
      report.status = 'blocked';
      report.error = `electron build missing: ${MAIN_ENTRY}（先运行 npm run build:electron）`;
      writeReport();
      app.exit(2);
      return;
    }

    console.log('[matrix-child] importing real main entry...');
    await import(pathToFileURL(MAIN_ENTRY).href);
    await app.whenReady();
    const bootDeadline = Date.now() + 90_000;
    while (!win && Date.now() < bootDeadline) {
      win = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed()) || null;
      if (!win) await sleep(200);
    }
    if (!win) throw new Error('main BrowserWindow never appeared');
    win.webContents.on('console-message', (...args) => rememberConsole(...args));
    if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    console.log('[matrix-child] window acquired, gating on startup ready');

    // ── 启动门控：轮询真实 startup:status 快照直到 ready ──────────────────
    const readyDeadline = Date.now() + STARTUP_READY_TIMEOUT_MS;
    let status = null;
    while (Date.now() < readyDeadline) {
      status = await run(`window.metis?.startupStatus ? window.metis.startupStatus() : null`);
      if (status?.ready === true) break;
      await sleep(500);
    }
    check('app', 'startup', 'app-boots-startup-ready', status?.ready === true, { lastStatus: status ?? 'startupStatus unreachable' });
    if (status?.ready !== true) throw new Error('startup never became ready');

    // ── Onboarding handshake：真实首启 probe/save 激活 provider，再确认引导层退场 ──
    const probe = await run(`window.metis.setupProbe(${JSON.stringify({ version: 1, operationId: `matrix-probe-${Date.now()}`, keyMode: 'replace', baseUrl: providerUrl, model: MODEL, newApiKey: API_KEY })})`);
    check('onboarding', 'startup', 'first-run-provider-probe', probe?.success === true, probe ?? 'setupProbe unreachable');
    if (probe?.success !== true) throw new Error('first-run provider probe failed');
    const saved = await run(`window.metis.setupSave(${JSON.stringify({ version: 1, operationId: `matrix-save-${Date.now()}`, expectedConfigVersion: Number(probe.configVersion), probeId: probe.probeId })})`);
    check('onboarding', 'startup', 'first-run-provider-save', saved?.success === true, saved ?? 'setupSave unreachable');
    if (saved?.success !== true) throw new Error('first-run provider save failed');

    // 引导层（OnboardingOverlay）首启已弹出时走真实 UI「跳过」，否则视为已退场。
    const overlayGone = async () => !(await run(`Boolean(document.querySelector('.onboarding-overlay'))`));
    let dismissed = await (async () => {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) { if (await overlayGone()) return true; await sleep(250); }
      return false;
    })();
    if (!dismissed) {
      await run(`(() => { const b = document.querySelector('[data-testid="onboarding-skip"]'); if (!b) return false; b.click(); return true; })()`);
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) { if (await overlayGone()) break; await sleep(250); }
      dismissed = await overlayGone();
    }
    check('onboarding', 'startup', 'onboarding-overlay-dismissed', dismissed, { path: dismissed ? 'overlay absent / skipped via real UI' : 'overlay still mounted' });
    if (!dismissed) throw new Error('onboarding overlay still blocking the UI');

    // ── 矩阵执行 ────────────────────────────────────────────────────────
    fs.mkdirSync(shotDir, { recursive: true });

    const clickNav = async (navId) => {
      const clicked = await run(`(() => { const n = document.querySelector('[data-nav-id="${navId}"]'); if (!n) return false; n.click(); return true; })()`);
      if (!clicked) throw new Error(`missing topbar nav entry: ${navId}`);
    };
    const waitForDom = async (expr, label, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await run(`Boolean(document.querySelector(${JSON.stringify(expr)}))`)) === true) return;
        await sleep(250);
      }
      throw new Error(`timeout waiting: ${label}`);
    };
    const captureShot = async (surface, viewportLabel) => {
      const file = path.join(shotDir, `${viewportLabel}-${surface}.png`);
      let size = 0;
      for (let attempt = 0; attempt < 2 && size < 1_000; attempt += 1) {
        const image = await win.webContents.capturePage();
        const buffer = image.toPNG();
        fs.writeFileSync(file, buffer);
        size = buffer.length;
        if (size < 1_000) await sleep(300);
      }
      check(surface, viewportLabel, 'screenshot-captured', size > 1_000, { file, bytes: size });
      if (size > 1_000) report.evidence.screenshots.push(file);
      return { file, size, ok: size > 1_000 };
    };
    const failureSnapshot = async (surface, viewportLabel, shot) => {
      const visibleText = await run(`(() => {
        const node = document.body;
        const text = (node && (node.innerText || node.textContent)) || '';
        return text.replace(/\\s+/gu, ' ').trim().slice(0, 2000);
      })()`);
      report.failureSnapshots.push({
        surface,
        viewport: viewportLabel,
        visibleText: typeof visibleText === 'string' ? visibleText : String(visibleText),
        consoleErrors: consoleErrors.slice(-10),
        screenshot: shot?.file ?? null,
        url: await run(`location.href`),
      });
    };

    for (const [vw, vh] of viewports) {
      const viewportLabel = `${vw}x${vh}`;

      // 真实窗口 resize（内容区 DIP == CSS px），轮询 innerWidth/innerHeight 稳定。
      win.setContentSize(vw, vh);
      let measured = null;
      const settleDeadline = Date.now() + VIEWPORT_SETTLE_MS;
      let previous = null;
      while (Date.now() < settleDeadline) {
        measured = await run(`({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio })`);
        if (previous && previous.iw === measured.iw && previous.ih === measured.ih) break;
        previous = measured;
        await sleep(300);
      }
      // Windows 显示缩放（如 105%/125%）下 innerWidth 与内容区 DIP 存在系统舍入差，
// 容差 = 2px + 视口的 1%；实测值仍完整记录在 evidence 中供判读。
const appliedOk = Boolean(measured) && Math.abs(measured.iw - vw) <= 2 + vw * 0.01 && Math.abs(measured.ih - vh) <= 2 + vh * 0.01;
      check('app', viewportLabel, 'viewport-applied', appliedOk, {
        requested: { width: vw, height: vh },
        measured: measured ?? null,
        note: appliedOk ? 'setContentSize 生效' : '窗口被钳制或未稳定（对照 BrowserWindow minWidth/minHeight）',
      });

      for (const surface of SURFACES) {
        let surfaceOk = true;
        try {
          await clickNav(surface.navId);
          await waitForDom(surface.readySelector, `${surface.id} root (${surface.readySelector})`);
        } catch (error) {
          surfaceOk = false;
          check(surface.id, viewportLabel, 'surface-ready', false, { error: String(error && (error.message || error)) });
        }
        // 原生 WebContentsView（投稿内嵌浏览器）的隐藏经 MutationObserver 异步生效，
        // 上一 surface 的原生层可能在 capturePage 合成时仍盖在窗口上（1600x900
        // settings 曾中招）。统一 settle 后再断言/截图，关闭该竞态窗口。
        if (surfaceOk) await sleep(700);
        // 联网复核（2026-09-15 积压关闭项）：submissions 内嵌 view 加载外部站点，
        // 主框架完成可能远慢于本地 DOM。METIS_MATRIX_SUBS_WAIT_MS 开启时轮询产品
        // API browserState() 直到 eshukan 主框架标题非空，最终状态如实入 detail。
        if (surfaceOk && surface.id === 'submissions' && process.env.METIS_MATRIX_SUBS_WAIT_MS) {
          const waitMs = Number(process.env.METIS_MATRIX_SUBS_WAIT_MS) || 0;
          // browserState() 返回 { ok, state: { url, title, loading, ... } } 包装，
          // 轮询与判定都取内层 state。
          const state = await run(`(async () => { const t0 = Date.now(); let s = null; while (Date.now() - t0 < ${waitMs}) { const raw = await (window.metis && window.metis.browserState ? window.metis.browserState() : null); s = raw && raw.state ? raw.state : raw; if (s && /eshukan\\.com/i.test(s.url || '') && (s.title || '').trim()) break; await new Promise((r) => setTimeout(r, 3000)); } return s; })()`);
          // 像素级取证：宿主 capturePage 不合成原生 WebContentsView 层（其空白
          // 不能证明渲染缺陷），必须对 view 自己的 webContents 单独 capturePage。
          let viewShot = null;
          try {
            const viewWc = webContents.getAllWebContents().find((wc) => {
              try { return !wc.isDestroyed() && /eshukan\.com/i.test(wc.getURL()); } catch { return false; }
            });
            if (viewWc) {
              const img = await viewWc.capturePage();
              const file = path.join(shotDir, `${viewportLabel}-embedded-view.png`);
              fs.writeFileSync(file, img.toPNG());
              viewShot = { file, bytes: img.toPNG().length, url: viewWc.getURL(), title: viewWc.getTitle() };
              report.evidence.screenshots.push(file);
            }
          } catch (e) {
            viewShot = { error: String((e && e.message) || e) };
          }
          const painted = Boolean(viewShot && viewShot.bytes > 5000);
          check('submissions', viewportLabel, 'embedded-site-content', Boolean(state && (state.title || '').trim()) && painted, { state, viewShot, waitedMs: waitMs, note: 'bytes>5000 视为 view 自身合成出站点像素' });
        }
        if (surfaceOk) {
          surfaceOk = check(surface.id, viewportLabel, 'surface-ready', true, { root: surface.readySelector, navId: surface.navId });
        }

        if (surfaceOk && !(await assertNoHorizontalOverflow(run, check, surface.id, viewportLabel))) surfaceOk = false;
        if (surfaceOk && surface.composer && !(await assertChatComposer(run, check, surface.id, viewportLabel))) surfaceOk = false;
        if (surfaceOk && !(await assertTopbarNav(run, check, surface.id, viewportLabel))) surfaceOk = false;
        if (surfaceOk && !(await assertScrollOwners(run, check, surface, viewportLabel))) surfaceOk = false;

        // 截图：无论断言结果如何都尝试留证；截图失败本身也是一条失败断言。
        let shot = null;
        try {
          shot = await captureShot(surface.id, viewportLabel);
          if (!shot.ok) surfaceOk = false; // 截图断言失败同样触发失败快照
        }
        catch (error) {
          check(surface.id, viewportLabel, 'screenshot-captured', false, { error: String(error && (error.message || error)) });
          surfaceOk = false;
        }
        if (!surfaceOk && report.failureSnapshots.every((s) => !(s.surface === surface.id && s.viewport === viewportLabel))) {
          try { await failureSnapshot(surface.id, viewportLabel, shot); }
          catch (snapshotError) {
            report.failureSnapshots.push({ surface: surface.id, viewport: viewportLabel, error: String(snapshotError && (snapshotError.message || snapshotError)) });
          }
        }
      }
    }

    report.consoleErrors = consoleErrors.slice(-40);
    report.isolation.cdp = await readDevToolsActivePort(profileDir);
    report.finishedAt = new Date().toISOString();
    report.status = report.assertions.every((a) => a.ok) ? 'passed' : 'failed';
    writeReport();
    console.log(`[matrix-child] done: ${report.status} (${report.assertions.filter((a) => a.ok).length}/${report.assertions.length})`);
    const quitDone = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      app.once('quit', () => { clearTimeout(timer); resolve(true); });
    });
    app.quit();
    await quitDone;
    app.exit(report.status === 'passed' ? 0 : 1);
  } catch (error) {
    report.status = error?.code === 'electron_build_missing' || /build missing/u.test(String(error)) ? 'blocked' : 'failed';
    report.error = String(error && (error.stack || error.message) || error);
    report.consoleErrors = consoleErrors.slice(-40);
    report.finishedAt = new Date().toISOString();
    if (report.isolation) report.isolation.cdp = await readDevToolsActivePort(profileDir).catch(() => null);
    writeReport();
    try { app.quit(); } catch { /* dying */ }
    setTimeout(() => app.exit(report.status === 'blocked' ? 2 : 1), 400);
  }
}

/** 随机 loopback CDP 端口证据：Chromium 把实际端口写入 <userData>/DevToolsActivePort。 */
async function readDevToolsActivePort(profileDir) {
  try {
    const text = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
    const port = Number.parseInt(text.split(/\r?\n/u, 1)[0] ?? '', 10);
    return { mode: 'random-loopback-port (--remote-debugging-port=0)', port: Number.isInteger(port) ? port : null, note: '仅作为调试入口证据；矩阵驱动走 executeJavaScript' };
  } catch {
    return { mode: 'random-loopback-port (--remote-debugging-port=0)', port: null, note: 'DevToolsActivePort 未读取到' };
  }
}

// ─── 页面内断言（全部返回真实读数；ok 只由读数决定）─────────────────────────

async function assertNoHorizontalOverflow(run, check, surfaceId, viewportLabel) {
  const geo = await run(`({
    iw: window.innerWidth,
    docSW: document.documentElement.scrollWidth,
    bodySW: document.body ? document.body.scrollWidth : null,
  })`);
  return check(surfaceId, viewportLabel, 'no-horizontal-document-overflow',
    Number.isFinite(geo?.docSW) && geo.docSW <= geo.iw + 1 && (geo.bodySW === null || geo.bodySW <= geo.iw + 1),
    { innerWidth: geo?.iw, documentScrollWidth: geo?.docSW, bodyScrollWidth: geo?.bodySW, tolerance: 1 });
}

async function assertChatComposer(run, check, surfaceId, viewportLabel) {
  const probe = await run(`(() => {
    const el = document.querySelector('.chat-input-area');
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!el) return { present: false, vw, vh };
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const input = el.querySelector('textarea, input[type="text"], [contenteditable="true"]');
    const ir = input ? input.getBoundingClientRect() : null;
    return {
      present: true,
      display: style.display, visibility: style.visibility,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      intersects: r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh,
      positive: r.width > 0 && r.height > 0,
      hasInputControl: Boolean(input),
      inputRect: ir ? { x: Math.round(ir.left), y: Math.round(ir.top), w: Math.round(ir.width), h: Math.round(ir.height) } : null,
      vw, vh,
    };
  })()`);
  const ok = probe?.present === true
    && probe.display !== 'none' && probe.visibility !== 'hidden'
    && probe.positive === true && probe.intersects === true
    && probe.hasInputControl === true;
  return check(surfaceId, viewportLabel, 'chat-composer-in-viewport', ok, probe);
}

async function assertTopbarNav(run, check, surfaceId, viewportLabel) {
  const probe = await run(`(() => {
    const ids = ${JSON.stringify(TOPBAR_NAV_IDS)};
    const vw = window.innerWidth, vh = window.innerHeight;
    const topbar = document.querySelector('.topbar');
    const tr = topbar ? topbar.getBoundingClientRect() : null;
    const controls = ids.map((id) => {
      const el = document.querySelector('[data-nav-id="' + id + '"]');
      if (!el) return { id, present: false };
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        id, present: true,
        visible: style.display !== 'none' && style.visibility !== 'hidden',
        positive: r.width > 0 && r.height > 0,
        insideViewport: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      };
    });
    return { topbarPresent: Boolean(topbar), topbarRect: tr ? { x: Math.round(tr.left), y: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) } : null, controls, vw, vh };
  })()`);
  const controls = Array.isArray(probe?.controls) ? probe.controls : [];
  const bad = controls.filter((c) => !(c.present && c.visible && c.positive && c.insideViewport));
  return check(surfaceId, viewportLabel, 'topbar-nav-controls-geometry',
    probe?.topbarPresent === true && controls.length === TOPBAR_NAV_IDS.length && bad.length === 0,
    { topbarRect: probe?.topbarRect ?? null, failing: bad, viewport: { w: probe?.vw, h: probe?.vh } });
}

async function assertScrollOwners(run, check, surface, viewportLabel) {
  const probe = await run(`((owners, eitherGroups) => {
    const round = (r) => r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
    const inspected = owners.map((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const r = nodes.length > 0 ? nodes[0].getBoundingClientRect() : null;
      return { sel, count: nodes.length, unique: nodes.length === 1, visible: Boolean(r && r.width > 0 && r.height > 0), rect: round(r) };
    });
    const groups = eitherGroups.map((options) => ({
      options,
      hits: options
        .map((sel) => ({ sel, count: document.querySelectorAll(sel).length }))
        .filter((hit) => hit.count > 0),
    }));
    const main = document.querySelector('.main-content');
    const mainStyle = main ? getComputedStyle(main) : null;
    return {
      owners: inspected,
      groups,
      mainContentPresent: Boolean(main),
      mainContentOverflowY: mainStyle ? mainStyle.overflowY : null,
    };
  })(${JSON.stringify(surface.scrollOwners)}, ${JSON.stringify(surface.eitherGroups)})`);
  const owners = Array.isArray(probe?.owners) ? probe.owners : [];
  const groups = Array.isArray(probe?.groups) ? probe.groups : [];
  const badOwners = owners.filter((o) => !(o.count === 1 && o.visible));
  const badGroups = groups.filter((g) => g.hits.length === 0);
  // owners 为空时必须至少有一组 eitherGroup 兜底（如 outcomes 空态分支），
  // 否则该 surface 等于没有任何滚动容器核验，视为配置错误。
  const coverageOk = owners.length > 0 ? badOwners.length === 0 : groups.length > 0;
  return check(surface.id, viewportLabel, 'scroll-owner-containers',
    coverageOk && badGroups.length === 0 && probe.mainContentPresent === true,
    {
      requiredOwners: owners,
      failingOwners: badOwners,
      eitherGroups: groups,
      mainContentPresent: probe.mainContentPresent,
      mainContentOverflowY: probe.mainContentOverflowY,
      source: 'docs/ui-surface-inventory.md Scroll owner 列',
    });
}

// ─── 父进程（普通 node）：隔离启动 + 收割报告 + 只清理自己记录的 PID 树 ────────

const recordedPids = new Set();

function killPidTree(pid) {
  if (!pid || !recordedPids.has(pid)) return; // 只清理自己记录的 PID
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* already dead */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
}

function killAllRecorded() {
  for (const pid of [...recordedPids]) killPidTree(pid);
}

function registerCleanup() {
  process.once('exit', killAllRecorded);
  process.once('SIGINT', () => { killAllRecorded(); process.exit(130); });
  process.once('SIGTERM', () => { killAllRecorded(); process.exit(143); });
}

function writeFinalReport(report, exitCode) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const total = (report.assertions || []).length;
  const failed = (report.assertions || []).filter((a) => !a.ok).length;
  console.log(`--- ui resolution matrix: ${String(report.status || 'unknown').toUpperCase()} (${total - failed}/${total} assertions, ${report.failureSnapshots?.length ?? 0} failure snapshot(s)) ---`);
  console.log(`report: ${REPORT_PATH}`);
  console.log(`screenshots: ${report.evidence?.shotDir ?? '(n/a)'}`);
  process.exit(exitCode);
}

async function main() {
  // Electron 子进程分支：electron.exe 直接把本文件当主模块加载。
  if (process.env.METIS_RESOLUTION_MATRIX_CHILD === '1') {
    await childMain().catch((error) => {
      console.error('[matrix-child] fatal:', error);
      process.exitCode = 1;
    });
    return;
  }

  registerCleanup();

  let viewports;
  try { viewports = parseViewportsOverride(process.env.METIS_RESOLUTION_MATRIX_VIEWPORTS); }
  catch (error) {
    console.error('[matrix] blocked:', error.message);
    process.exit(2);
    return;
  }

  // 启动前检查（sweep 同款 gate）。
  if (!fs.existsSync(MAIN_ENTRY)) {
    console.error('[matrix] blocked — build missing:', MAIN_ENTRY, '（先运行 npm run build:electron）');
    process.exit(2);
    return;
  }
  const electronBinary = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electronBinary)) {
    console.error('[matrix] blocked — electron binary missing:', electronBinary, '（先运行 npm install）');
    process.exit(2);
    return;
  }

  const provider = await startProvider();
  const profileDir = tempDir('metis-resolution-matrix-profile-');
  const shotDir = path.join(ROOT, 'logs', `ui-resolution-matrix-${STAMP}`);
  fs.mkdirSync(shotDir, { recursive: true });
  const childReportPath = REPORT_PATH.replace(/\.json$/u, '.child.json');
  const stdoutLogPath = REPORT_PATH.replace(/\.json$/u, '.stdout.log');

  console.log(`[matrix] profile: ${profileDir}`);
  console.log(`[matrix] provider: ${provider.baseUrl}`);
  console.log(`[matrix] viewports: ${viewports.map(([w, h]) => `${w}x${h}`).join(', ')}`);

  const child = spawn(electronBinary, [__filename, '--remote-debugging-port=0'], {
    cwd: ROOT,
    env: {
      ...process.env,
      METIS_RESOLUTION_MATRIX_CHILD: '1',
      METIS_RESOLUTION_MATRIX_PROFILE: profileDir,
      METIS_RESOLUTION_MATRIX_PROVIDER: provider.baseUrl,
      METIS_RESOLUTION_MATRIX_REPORT: childReportPath,
      METIS_RESOLUTION_MATRIX_SHOTS: shotDir,
      METIS_RESOLUTION_MATRIX_VIEWPORTS: process.env.METIS_RESOLUTION_MATRIX_VIEWPORTS ?? '',
      METIS_USER_DATA_DIR: profileDir, // electron/main.ts T00.03 acceptance isolation
      METIS_BACKGROUND_AUDIT: '0',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  recordedPids.add(child.pid);

  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); process.stdout.write(chunk); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); process.stderr.write(chunk); });

  const timeoutTimer = setTimeout(() => {
    console.error('[matrix] child timed out — killing recorded pid tree only');
    killAllRecorded();
    writeFinalReport({
      harness: 'ui-resolution-matrix',
      status: 'failed',
      error: `child timeout after ${CHILD_TIMEOUT_MS} ms`,
      viewports: viewports.map(([w, h]) => `${w}x${h}`),
      assertions: [],
      evidence: { screenshots: [], shotDir, profileDir },
      failureSnapshots: [],
    }, 1);
  }, CHILD_TIMEOUT_MS);

  child.once('error', (error) => {
    clearTimeout(timeoutTimer);
    console.error('[matrix] child spawn failed:', error);
    writeFinalReport({ harness: 'ui-resolution-matrix', status: 'failed', error: `spawn failed: ${String(error)}`, assertions: [], evidence: { screenshots: [], shotDir, profileDir }, failureSnapshots: [] }, 1);
  });

  child.once('exit', async (exitCode) => {
    clearTimeout(timeoutTimer);
    recordedPids.delete(child.pid);
    fs.writeFileSync(stdoutLogPath, output);
    const childReport = safeRead(childReportPath);
    if (!childReport) {
      await provider.close().catch(() => undefined);
      return writeFinalReport({
        harness: 'ui-resolution-matrix',
        status: 'failed',
        error: 'child 未产出报告（崩溃或被杀）。完整输出见 stdout 日志。',
        stdoutLog: stdoutLogPath,
        outputTail: output.slice(-4000),
        assertions: [],
        evidence: { screenshots: [], shotDir, profileDir },
        failureSnapshots: [],
      }, 1);
    }
    const report = {
      ...childReport,
      finishedAt: childReport.finishedAt ?? new Date().toISOString(),
      childExitCode: exitCode, // 记录 child 退出码作证据；最终退出码仍由报告 status 决定。
      stdoutLog: stdoutLogPath,
      isolation: { ...(childReport.isolation ?? {}), userDataDir: profileDir, pidTreeKilledOnly: true },
    };
    const finalExitCode = report.status === 'passed' ? 0 : (report.status === 'blocked' ? 2 : 1);
    await provider.close().catch(() => undefined);
    writeFinalReport(report, finalExitCode);
  });
}

main().catch((error) => {
  console.error('[matrix] fatal:', error);
  killAllRecorded();
  process.exit(1);
});
