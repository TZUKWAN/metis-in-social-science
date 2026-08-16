/**
 * Metis usage-logic audit — drives the REAL UI of a fresh install (isolated
 * data dir) the way a first-time user would, clicking through every primary
 * surface, verifying usage logic and capturing screenshots as evidence.
 *
 *   npx electron scripts/usage-logic-audit.mjs
 *
 * Output: usage-audit/*.png + usage-audit/usage-logic-report.json
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

app.setName('metis-usage-audit');

const outDir = path.resolve('usage-audit');
fs.mkdirSync(outDir, { recursive: true });

const report = { startedAt: new Date().toISOString(), steps: [], issues: [], consoleErrors: [] };
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
}
function issue(severity, where, what, evidence) {
  report.issues.push({ severity, where, what, evidence });
  console.log(`ISSUE[${severity}] ${where}: ${what}`);
}

// Boot the real app main process (privileged scheme registration must happen top-level).
await import('../dist-electron/electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();

  let win = BrowserWindow.getAllWindows()[0];
  for (let i = 0; i < 50 && !win; i += 1) {
    await sleep(300);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('no window');

  win.webContents.on('console-message', (_e, level, message) => {
    // level 3 = error, 2 = warning
    if (level >= 3) {
      report.consoleErrors.push(message.slice(0, 300));
      console.log(`[console.error] ${message.slice(0, 200)}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    issue('critical', 'renderer', `render process gone: ${details.reason}`);
  });

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }

  const run = (expr) =>
    win.webContents.executeJavaScript(
      `(async () => { try { return ${expr}; } catch (err) { return { __error: String(err && err.message || err) }; } })()`,
    );
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const bodyText = () => run(`document.body.innerText.slice(0, 4000)`);
  const hasText = async (text) => (await run(`document.body.innerText.includes(${JSON.stringify(text)})`)) === true;
  const clickSelector = (sel) =>
    run(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const clickText = (text, tag = 'button') =>
    run(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const el = els.find((e) => e.offsetParent !== null && e.textContent.trim().includes(${JSON.stringify(text)}));
      if (!el) return false; el.click(); return true;
    })()`);

  // wait for startup to finish (window appears before heavy init)
  await run(`window.metis.startupStatus()`);
  await sleep(2500);

  // ── 1. First-run gate ────────────────────────────────────────────────
  const wizardVisible = (await run(`!!document.querySelector('[data-testid="first-run-skip"]')`)) === true;
  step('首启硬门禁：未配置 provider 时进入首启向导', wizardVisible);
  await shot('01-first-run-wizard');

  if (wizardVisible) {
    // 1a. Try to complete with empty/invalid config -> expect structured validation, not a pass
    const buttons = await run(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)`);
    step('首启向导按钮可见', Array.isArray(buttons) && buttons.length > 0, JSON.stringify(buttons));
    // click primary action without filling anything
    const clickedPrimary = await run(`(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.disabled);
      const primary = btns.find((b) => /测试|完成|继续|保存|开始/.test(b.textContent));
      if (!primary) return false; primary.click(); return primary.textContent.trim();
    })()`);
    await sleep(1500);
    const errShown = await run(`(() => {
      const t = document.body.innerText;
      return /错误|失败|无效|必填|请|error|invalid|failed/i.test(t);
    })()`);
    step('空配置提交被拦截并给出结构化提示', clickedPrimary !== false && errShown === true, `clicked=${clickedPrimary}`);
    await shot('02-wizard-empty-submit');

    // 1c. Invalid credentials: real probe must fail and the wizard must stay
    const credsFilled = await run(`(() => {
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const inputs = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null);
      const key = inputs.find((i) => i.type === 'password' || /密钥|key/i.test(i.placeholder || ''));
      if (!key) return 'no-key-input';
      setVal(key, 'fake-key-000000000000');
      return true;
    })()`);
    if (credsFilled === true) {
      await clickText('连接并开始使用');
      // wait for the full probe pipeline (20s probe timeout + capability
      // phases + retry backoff can exceed 60s in total)
      let probeFailed = false;
      for (let i = 0; i < 80; i += 1) {
        await sleep(1500);
        const stillWizard = (await run(`!!document.querySelector('[data-testid="first-run-skip"], .first-run-wizard, [class*="first-run"]')`)) === true;
        const errText = await run(`(() => { const t = document.body.innerText; return /失败|错误|无效|无法|拒绝|failed|invalid|401|unauthorized|超时/i.test(t); })()`);
        const busy = await run(`(() => { const t = document.body.innerText; return /正在完成连接|测试中|连接中/.test(t); })()`);
        if (errText && !busy) { probeFailed = true; break; }
        if (!stillWizard) break;
      }
      step('假密钥真实探测被拒绝并给出失败提示', probeFailed === true);
      if (!probeFailed) issue('critical', '首启向导', '填入假 API 密钥后向导放行或未给出失败提示——provider 探测逻辑失效');
      await shot('02b-wizard-invalid-key');
      // wait until the wizard is no longer busy so the skip button returns
      for (let i = 0; i < 20; i += 1) {
        const skipBack = (await run(`!!document.querySelector('[data-testid="first-run-skip"]')`)) === true;
        if (skipBack) break;
        await sleep(1500);
      }
    } else {
      step('向导密钥输入框可填写', false, String(credsFilled));
    }

    // 1b. skip path — allowed by design (gate covers research EXECUTION;
    // workspace browsing may be skipped and the choice is persisted, F6/F7)
    const skipped = await clickSelector('[data-testid="first-run-skip"]');
    step('点击「稍后配置」跳过向导', skipped === true);
    await sleep(2500);
  }
  await shot('03-main-after-skip');

  // ── 2. Onboarding tour ───────────────────────────────────────────────
  const tourVisible = await hasText('你的研究项目');
  if (tourVisible) {
    step('新手引导（OnboardingTour）在首次进入时出现', true);
    await shot('04-onboarding-tour');
    const closed = await clickText('跳过');
    step('关闭新手引导', closed === true);
    await sleep(800);
  } else {
    step('新手引导（OnboardingTour）在首次进入时出现', false, 'tour not visible after skip');
  }

  // ── 3. Top-bar nav structure (normal mode: no technical entries) ─────
  const navText = await run(`[...document.querySelectorAll('.topbar-nav__item, .topbar-nav button')].map((b) => b.textContent.trim())`);
  step('顶栏导航条目', Array.isArray(navText) && navText.length >= 5, JSON.stringify(navText));
  const technicalVisible = ['评估', '终端', '日志', '运行时', '沙箱'].filter((w) => Array.isArray(navText) && navText.some((n) => n.includes(w)));
  step('普通模式隐藏技术条目（评估/终端/日志等）', technicalVisible.length === 0, technicalVisible.join(','));
  if (technicalVisible.length > 0) issue('high', '导航', `普通模式顶栏泄露技术条目: ${technicalVisible.join(',')}`);

  // ── 4. Walk every top-level destination ──────────────────────────────
  // NOTE: 「研究项目」is deliberately NOT a topbar entry — the workspace home
  // IS the projects area (App.tsx filters it out of NAV_ITEMS). Not a bug.
  const destinations = ['对话', '写作', '自主科研', '任务看板', '场景', '浏览器', '设置'];
  for (const dest of destinations) {
    const clicked = await clickText(dest);
    if (clicked !== true) {
      step(`导航到「${dest}」`, false, 'button not found');
      issue('high', '导航', `顶栏找不到「${dest}」入口`);
      continue;
    }
    await sleep(1500);
    const crashed = await hasText('出错了');
    const text = await bodyText();
    const hasContent = typeof text === 'string' && text.length > 50;
    step(`导航到「${dest}」页面渲染`, crashed === false && hasContent, crashed ? 'error boundary!' : undefined);
    if (crashed) issue('critical', dest, '页面触发 ErrorBoundary（出错了）');
    await shot(`10-nav-${dest}`);
  }
  // personalization center is a toggle — close it again so later steps start clean
  await clickText('场景');
  await sleep(800);

  // ── 5. Project creation via UI (写作 workspace sidebar「新建项目」) ──
  // The project-creation entry lives in the 写作 workspace sidebar; the
  // onboarding tour's step 1 now points users there explicitly (F8).
  await clickText('写作');
  await sleep(1500);
  await shot('20-write-workspace');
  const createClicked = await clickSelector('.research-workspace-sidebar__create');
  step('侧栏「新建项目」按钮可点击', createClicked === true);
  await sleep(800);
  await shot('21-project-create-form');
  const filled = await run(`(() => {
    const form = document.querySelector('.research-workspace-create');
    if (!form) return 'no-form';
    const el = form.querySelector('input');
    if (!el) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '逻辑审计测试项目');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  step('项目创建表单打开并可填写', filled === true, String(filled));
  if (filled === true) {
    await sleep(400);
    const confirmed = await run(`(() => {
      const form = document.querySelector('.research-workspace-create');
      const b = form && form.querySelector('button[type="submit"]');
      if (!b) return false; b.click(); return b.textContent.trim();
    })()`);
    await sleep(2000);
    const appears = await hasText('逻辑审计测试项目');
    step('UI 创建项目并出现在工作区中', confirmed !== false && appears === true, `confirm=${confirmed} appears=${appears}`);
    if (!appears) issue('high', '项目创建', '通过 UI 填写项目名并提交后，工作区中未出现新项目');
    await shot('22-project-created');
    // verify persistence through the real IPC layer (project:list, not loadAllData)
    const persisted = await run(`window.metis.listProjects().then((r) => {
      const arr = (r && (r.projects || r.items || r.value || r)) || [];
      return Array.isArray(arr) && arr.some((p) => (p.title || p.name) === '逻辑审计测试项目');
    }).catch(() => false)`);
    step('新项目经 SQLite 持久化（project:list 可查）', persisted === true);
    if (persisted !== true) issue('high', '项目创建', '项目出现在 UI 但 project:list 查不到——持久化缺失');
  }

  // ── 6. Chat without provider: graceful degradation ───────────────────
  await clickText('对话');
  await sleep(1500);
  const chatTyped = await run(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null);
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '这是一条未配置模型时的测试消息');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  step('对话输入框可输入', chatTyped === true);
  if (chatTyped === true) {
    await sleep(400);
    const sent = await run(`(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.disabled);
      const b = btns.find((x) => x.textContent.trim() === '发送');
      if (!b) return false; b.click(); return true;
    })()`);
    if (sent !== true) {
      // fall back: Enter key
      await run(`(() => { const ta = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null); ta && ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    }
    await sleep(2500);
    const chatText = await bodyText();
    const graceful = typeof chatText === 'string' && /未配置|配置模型|provider|不可用|无法|失败|设置/.test(chatText);
    const chatCrashed = await hasText('出错了');
    step('未配置 provider 发送消息→结构化降级提示（非崩溃）', graceful === true && chatCrashed === false);
    if (chatCrashed) issue('critical', '对话', '未配置 provider 发送消息导致 ErrorBoundary');
    else if (!graceful) issue('high', '对话', '未配置 provider 发送消息后无任何可见反馈');
    await shot('30-chat-no-provider');
  }

  // ── 7. Ctrl+K global search on (nearly) empty data ───────────────────
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  await sleep(1000);
  const searchOpen = await run(`!!document.querySelector('input[placeholder*="搜索"], [class*="search"] input')`);
  step('Ctrl+K 打开全局搜索', searchOpen === true);
  await shot('40-global-search');
  if (searchOpen === true) {
    await run(`(() => {
      const el = document.querySelector('input[placeholder*="搜索"], [class*="search"] input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'transformer'); el.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    await sleep(1200);
    await shot('41-global-search-results');
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(500);
  }

  // ── 8. Settings: provider section visible post-skip ──────────────────
  await clickText('设置');
  await sleep(1500);
  const settingsHasProvider = await hasText('API');
  step('设置页包含模型/API 配置区', settingsHasProvider === true);
  await shot('50-settings');

  // ── 9. Session restore: reload on settings page ──────────────────────
  // F6: after the user explicitly skipped setup, the choice is persisted —
  // the wizard must NOT reappear on reload, and settings must report it.
  const skipPersisted = await run(`window.metis.getSettings().then((s) => s?.setupSkipped === true)`);
  step('「稍后配置」选择已持久化（setupSkipped=true）', skipPersisted === true);
  if (!skipPersisted) issue('high', '首启门禁', '点击「稍后配置」后 setupSkipped 未持久化');
  const beforeReload = await run(`window.location.hash || document.querySelector('[data-page], main')?.textContent?.slice(0, 60)`);
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.reload();
  });
  await sleep(4000);
  const wizardAgain = (await run(`!!document.querySelector('[data-testid="first-run-skip"]')`)) === true;
  step('重载后不再弹首启向导（跳过已记住）', wizardAgain === false);
  if (wizardAgain) {
    issue('high', '会话恢复', '重载后再次强制进入首启向导——setupSkipped 持久化未生效');
    await clickSelector('[data-testid="first-run-skip"]');
    await sleep(2500);
  }
  if (await hasText('你的研究项目')) {
    // onboarding shows only on the very first entry; if it reappears after
    // reload the tour-done flag was not persisted — close and note it.
    issue('low', '新手引导', '重载后新手引导再次出现');
    await clickText('跳过');
    await sleep(800);
  }
  const restoredToSettings = await hasText('API');
  step('重载后会话恢复到之前的页面（设置）', restoredToSettings === true, `before=${String(beforeReload).slice(0, 60)}`);
  await shot('60-after-reload');

  // ── 10. Cross-restart durability: project created earlier must survive ──
  const durableProject = await run(`window.metis.listProjects().then((r) => {
    const arr = (r && (r.projects || r.items || r.value || r)) || [];
    return Array.isArray(arr) && arr.some((p) => (p.title || p.name) === '逻辑审计测试项目');
  }).catch(() => false)`);
  step('重载后项目依然存在（跨会话持久）', durableProject === true);

  // ── Summary ──────────────────────────────────────────────────────────
  const failed = report.steps.filter((s) => !s.ok);
  report.failed = failed.length;
  report.passed = report.steps.length - failed.length;
  report.uniqueConsoleErrors = [...new Set(report.consoleErrors)];
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'usage-logic-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nUsage-logic audit: ${report.passed}/${report.steps.length} passed; issues=${report.issues.length}; consoleErrors=${report.uniqueConsoleErrors.length}`);
  console.log(`Report: ${path.join(outDir, 'usage-logic-report.json')}`);
  app.exit(0);
}

app.on('ready', () => {
  main().catch((err) => {
    step('harness', false, String(err && err.message || err));
    fs.writeFileSync(path.join(outDir, 'usage-logic-report.json'), JSON.stringify(report, null, 2), 'utf-8');
    app.exit(1);
  });
});
