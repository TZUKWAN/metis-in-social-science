/**
 * Metis REAL-provider flow audit — configures a live OpenAI-compatible
 * provider through the first-run wizard, then exercises the real success
 * paths a paying user would: project creation, real chat with streamed
 * answer, one-shot AI channels, and persistence across reload.
 *
 *   npx electron scripts/real-flow-audit.mjs
 *
 * The API key is NEVER written to the report or logs. Isolated data dir.
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

app.setName('metis-real-flow');

const outDir = path.resolve('real-flow-audit');
fs.mkdirSync(outDir, { recursive: true });

const PROVIDER = {
  baseUrl: process.env.METIS_TEST_BASE_URL || 'https://api.deepseek.com',
  apiKey: process.env.METIS_TEST_API_KEY || '',
  model: process.env.METIS_TEST_MODEL || 'deepseek-v4-flash',
};
if (!PROVIDER.apiKey) {
  console.error('Set METIS_TEST_API_KEY (and optionally METIS_TEST_BASE_URL/METIS_TEST_MODEL) first.');
  process.exit(2);
}

const report = { startedAt: new Date().toISOString(), steps: [], issues: [], consoleErrors: [] };
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail: detail && String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
}
function issue(severity, where, what) {
  report.issues.push({ severity, where, what });
  console.log(`ISSUE[${severity}] ${where}: ${what}`);
}

await import('../dist-electron/electron/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  let win = BrowserWindow.getAllWindows()[0];
  for (let i = 0; i < 50 && !win; i += 1) { await sleep(300); win = BrowserWindow.getAllWindows()[0]; }
  if (!win) throw new Error('no window');
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) {
      // never log secrets
      const safe = String(message).replaceAll(PROVIDER.apiKey, '***').slice(0, 300);
      report.consoleErrors.push(safe);
      console.log(`[console.error] ${safe.slice(0, 200)}`);
    }
  });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));

  const run = (expr) =>
    win.webContents.executeJavaScript(
      `(async () => { try { return ${expr}; } catch (err) { return { __error: String(err && err.message || err) }; } })()`,
    );
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const bodyText = () => run(`document.body.innerText.slice(0, 6000)`);
  const hasText = async (text) => (await run(`document.body.innerText.includes(${JSON.stringify(text)})`)) === true;
  const clickSelector = (sel) =>
    run(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const clickText = (text, tag = 'button') =>
    run(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const el = els.find((e) => e.offsetParent !== null && e.textContent.trim().includes(${JSON.stringify(text)}));
      if (!el) return false; el.click(); return true;
    })()`);

  await run(`window.metis.startupStatus()`);
  await sleep(2500);

  // ── 1. Real provider configuration through the wizard ────────────────
  const wizardVisible = (await run(`!!document.querySelector('[data-testid="first-run-skip"]')`)) === true;
  step('首启向导出现（未配置）', wizardVisible);
  if (!wizardVisible) throw new Error('expected first-run wizard');

  const filledAll = await run(`(() => {
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null);
    const url = inputs.find((i) => i.type !== 'password' && /http/.test(i.value || ''));
    const key = inputs.find((i) => i.type === 'password');
    const model = inputs.find((i) => i.type !== 'password' && i !== url && (i.value || '').length > 0);
    if (!url || !key || !model) return { url: !!url, key: !!key, model: !!model };
    setVal(url, ${JSON.stringify(PROVIDER.baseUrl)});
    setVal(key, ${JSON.stringify(PROVIDER.apiKey)});
    setVal(model, ${JSON.stringify(PROVIDER.model)});
    return true;
  })()`);
  step('向导三项配置填写', filledAll === true, JSON.stringify(filledAll));
  await shot('01-wizard-filled');

  await clickText('连接并开始使用');
  // real probe + capability pipeline — allow generous time
  let configured = false;
  let failText = '';
  for (let i = 0; i < 100; i += 1) {
    await sleep(1500);
    const wizardGone = (await run(`!document.querySelector('[data-testid="first-run-skip"]')`)) === true
      && (await run(`!document.querySelector('[class*="first-run"]')`)) === true;
    if (wizardGone) { configured = true; break; }
    const failed = await run(`(() => { const t = document.body.innerText; return /无法连接|失败|错误|无效|拒绝|超时/.test(t) && !/正在完成连接/.test(t); })()`);
    if (failed) { failText = (await bodyText()).match(/无法连接到模型服务[\s\S]{0,200}/)?.[0] || 'probe failed'; break; }
  }
  step(`真实探测通过并进入主界面（${PROVIDER.baseUrl} / ${PROVIDER.model}）`, configured, configured ? undefined : failText || 'timeout');
  if (!configured) {
    issue('critical', '首启向导', `真实凭据配置失败: ${failText || 'probe timeout'}`);
    await shot('02-wizard-failed');
    throw new Error('provider configuration failed — aborting real-flow audit');
  }
  await sleep(2000);
  await shot('02-main-configured');

  // close onboarding tour if shown
  if (await hasText('你的研究项目')) { await clickText('跳过'); await sleep(800); }

  const settings = await run(`window.metis.getSettings()`);
  step('设置状态 configured + hasApiKey', settings?.configured === true && settings?.hasApiKey === true,
    JSON.stringify({ configured: settings?.configured, hasApiKey: settings?.hasApiKey, model: settings?.model }));
  // key must never leak into renderer-visible settings
  const keyLeak = JSON.stringify(settings || {}).includes(PROVIDER.apiKey);
  step('设置响应不回显 API 密钥', keyLeak === false);
  if (keyLeak) issue('critical', '安全', 'getSettings 响应包含明文 API 密钥');

  // ── 2. Create a project via UI (写作 workspace) ──────────────────────
  await clickText('写作');
  await sleep(1500);
  await clickSelector('.research-workspace-sidebar__create');
  await sleep(800);
  await run(`(() => {
    const form = document.querySelector('.research-workspace-create');
    const el = form && form.querySelector('input');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '真实流程测试项目');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await run(`(() => { const b = document.querySelector('.research-workspace-create button[type="submit"]'); b && b.click(); return true; })()`);
  await sleep(2000);
  const projectAppears = await hasText('真实流程测试项目');
  step('创建项目「真实流程测试项目」', projectAppears === true);
  await shot('03-project-created');

  // ── 3. REAL chat: send a research question, expect streamed answer ───
  await clickText('对话');
  await sleep(1500);
  const typed = await run(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null);
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用三句话说明什么是元分析（meta-analysis），并给出一个社会科学中的例子。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  step('对话输入研究问题', typed === true);
  await run(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === '发送');
    b && b.click(); return true;
  })()`);

  // wait for the assistant answer to finish streaming (failure marker or stable text)
  const t0 = Date.now();
  let answerLen = 0;
  let failed = false;
  let lastLen = -1;
  let stableRounds = 0;
  while (Date.now() - t0 < 180_000) {
    await sleep(3000);
    const state = await run(`(() => {
      const bubbles = [...document.querySelectorAll('[class*="message"], [class*="bubble"], article')];
      const t = document.body.innerText;
      const fail = /未能完成|无法连接|provider_unavailable|错误/.test(t);
      return { len: t.length, fail };
    })()`);
    if (state?.fail) { failed = true; break; }
    if (typeof state?.len === 'number') {
      answerLen = state.len;
      if (answerLen === lastLen && answerLen > 800) { stableRounds += 1; if (stableRounds >= 3) break; }
      else stableRounds = 0;
      lastLen = answerLen;
    }
  }
  const chatText = await bodyText();
  const hasMetaAnswer = typeof chatText === 'string' && /元分析|meta-analysis|Meta分析/i.test(chatText);
  step('真实模型返回实质性回答（非错误占位）', !failed && hasMetaAnswer, `failed=${failed} len=${answerLen}`);
  if (failed) issue('critical', '对话', '配置真实 provider 后发送消息返回失败');
  await shot('04-chat-real-answer');

  // session must appear in the sidebar list (the gap found in the no-provider run)
  await sleep(1500);
  const sessionListed = await run(`(() => {
    const t = document.body.innerText;
    return !/无会话/.test(t);
  })()`);
  step('会话出现在左侧「进行中」列表', sessionListed === true);
  if (!sessionListed) issue('medium', '对话', '成功对话后左侧会话列表仍显示「无会话」');
  await shot('05-session-listed');

  // ── 4. One-shot AI channels with the real provider ───────────────────
  const explain = await run(`window.metis.aiExplainPaper({ passage: 'This paper uses a randomized controlled trial to show that class-size reduction improves early literacy outcomes in rural schools.' })`);
  step('AI 论文解读（真实调用成功）', explain?.ok === true && typeof explain?.text === 'string' && explain.text.length > 20,
    explain?.ok ? `len=${explain.text?.length}` : JSON.stringify(explain ?? 'undefined')?.slice(0, 150));

  const polish = await run(`window.metis.aiPolishLatex({ text: 'The results shows that the treatment have significant effect.' })`);
  step('AI LaTeX 润色（真实调用成功）', polish?.ok === true && typeof polish?.text === 'string' && polish.text.length > 10,
    polish?.ok ? JSON.stringify(polish.text ?? '').slice(0, 120) : JSON.stringify(polish ?? 'undefined')?.slice(0, 150));

  // ── 5. Reload: provider + session + project must persist ─────────────
  await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  await sleep(4500);
  const wizardAgain = (await run(`!!document.querySelector('[data-testid="first-run-skip"]')`)) === true;
  step('重载后不再强制进入首启向导（已配置）', wizardAgain === false);
  if (wizardAgain) issue('high', '首启门禁', '已配置 provider 后重载仍弹首启向导');
  if (await hasText('你的研究项目')) { await clickText('跳过'); await sleep(800); }

  const settings2 = await run(`window.metis.getSettings()`);
  step('重载后 configured 保持', settings2?.configured === true && settings2?.hasApiKey === true);
  const projectDurable = await run(`window.metis.listProjects().then((r) => {
    const arr = (r && (r.projects || r.items || r.value || r)) || [];
    return Array.isArray(arr) && arr.some((p) => (p.title || p.name) === '真实流程测试项目');
  }).catch(() => false)`);
  step('重载后项目持久', projectDurable === true);
  await shot('06-after-reload');

  // ── Summary ──────────────────────────────────────────────────────────
  const failedSteps = report.steps.filter((s) => !s.ok);
  report.failed = failedSteps.length;
  report.passed = report.steps.length - failedSteps.length;
  report.uniqueConsoleErrors = [...new Set(report.consoleErrors)];
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'real-flow-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nReal-flow audit: ${report.passed}/${report.steps.length} passed; issues=${report.issues.length}; consoleErrors=${report.uniqueConsoleErrors.length}`);
  app.exit(failedSteps.length === 0 ? 0 : 1);
}

app.on('ready', () => {
  main().catch((err) => {
    step('harness', false, String(err && err.message || err));
    report.uniqueConsoleErrors = [...new Set(report.consoleErrors)];
    fs.writeFileSync(path.join(outDir, 'real-flow-report.json'), JSON.stringify(report, null, 2), 'utf-8');
    app.exit(1);
  });
});
