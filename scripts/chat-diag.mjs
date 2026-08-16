/**
 * Focused chat diagnostics in the already-configured metis-real-flow profile.
 * Re-sends the research question, captures ALL goal events + console output,
 * inspects goal state + failure reason via IPC, then re-checks the one-shot
 * AI channels with the correct `text` field.
 *
 *   npx electron scripts/chat-diag.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

app.setName('metis-real-flow'); // reuse the configured profile

const outDir = path.resolve('real-flow-audit');
fs.mkdirSync(outDir, { recursive: true });
await import('../dist-electron/electron/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const API_KEY = process.env.METIS_TEST_API_KEY || '';
const scrub = (s) => (API_KEY ? String(s).replaceAll(API_KEY, '***') : String(s));

async function main() {
  await app.whenReady();
  let win = BrowserWindow.getAllWindows()[0];
  for (let i = 0; i < 50 && !win; i += 1) { await sleep(300); win = BrowserWindow.getAllWindows()[0]; }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));

  const events = [];
  win.webContents.on('console-message', (_e, level, message) => {
    events.push({ level, message: scrub(message).slice(0, 400) });
  });

  const run = (expr) =>
    win.webContents.executeJavaScript(
      `(async () => { try { return ${expr}; } catch (err) { return { __error: String(err && err.message || err) }; } })()`,
    );
  const shot = async (name) => fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const rec = (name, ok, detail) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + scrub(detail).slice(0, 220) : ''}`);

  await run(`window.metis.startupStatus()`);
  await sleep(3500);
  const wizard = (await run(`!!document.querySelector('[data-testid="first-run-skip"]')`)) === true;
  rec('已配置 profile 直接进入主界面（无向导）', wizard === false);
  if (await run(`document.body.innerText.includes('你的研究项目')`)) {
    await run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === '跳过'); b && b.click(); return true; })()`);
    await sleep(800);
  }

  // hook goal events for the failure reason
  await run(`(() => {
    window.__diag = { steps: [], failed: [], progress: [] };
    if (window.metis.onGoalStepStart) window.metis.onGoalStepStart((e) => window.__diag.steps.push(JSON.stringify(e).slice(0, 200)));
    if (window.metis.onGoalStepFailed) window.metis.onGoalStepFailed((e) => window.__diag.failed.push(JSON.stringify(e).slice(0, 500)));
    return Object.keys(window.metis).filter((k) => /goal/i.test(k));
  })()`).then((r) => console.log('goal IPC keys:', JSON.stringify(r)));

  // ── one-shot AI channels with correct field ──────────────────────────
  const explain = await run(`window.metis.aiExplainPaper({ passage: 'This paper uses a randomized controlled trial to show that class-size reduction improves early literacy outcomes in rural schools.' })`);
  rec('AI 论文解读（text 字段）', explain?.ok === true && (explain?.text || '').length > 20,
    explain?.ok ? `len=${explain.text.length}: ${explain.text.slice(0, 100)}` : JSON.stringify(explain));
  const polish = await run(`window.metis.aiPolishLatex({ text: 'The results shows that the treatment have significant effect.' })`);
  rec('AI LaTeX 润色（text 字段）', polish?.ok === true && (polish?.text || '').length > 10,
    polish?.ok ? polish.text.slice(0, 120) : JSON.stringify(polish));

  // ── resend the chat question and watch the goal run ──────────────────
  await run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === '对话'); b && b.click(); return true; })()`);
  await sleep(1500);
  await run(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用三句话说明什么是元分析（meta-analysis），并给出一个社会科学中的例子。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && !x.disabled && x.textContent.trim() === '发送');
    b && b.click(); return true;
  })()`);

  let diag = { failed: [] };
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    await sleep(4000);
    diag = await run(`window.__diag`);
    const text = await run(`document.body.innerText`);
    const done = /未能完成|已完成：|研究任务已完成/.test(text) && !/正在|执行中|规划中/.test(text.slice(-800));
    if ((diag?.failed || []).length > 0 || done) break;
  }
  await sleep(3000);
  diag = await run(`window.__diag`);
  console.log('step events:', JSON.stringify(diag?.steps || []));
  console.log('FAILED STEP EVENTS:', JSON.stringify(diag?.failed || [], null, 1));

  const goals = await run(`window.metis.listGoals()`);
  console.log('listGoals:', scrub(JSON.stringify(goals)).slice(0, 1200));
  const goalArr = (goals && (goals.goals || goals.items || goals.value || [])) || [];
  if (goalArr.length > 0) {
    const g = goalArr[0];
    const prog = await run(`window.metis.getGoalProgress(${JSON.stringify(g.id || g.goalId)})`);
    console.log('goal progress:', scrub(JSON.stringify(prog)).slice(0, 2000));
  }

  const sessions = await run(`window.metis.listSessions ? window.metis.listSessions() : 'no-api'`);
  console.log('sessions:', scrub(JSON.stringify(sessions)).slice(0, 600));

  await shot('10-chat-diag-final');
  const errs = events.filter((e) => e.level >= 3);
  console.log(`\nconsole errors (${errs.length}):`);
  for (const e of errs.slice(0, 10)) console.log(' -', e.message.slice(0, 250));
  fs.writeFileSync(path.join(outDir, 'chat-diag-events.json'), JSON.stringify({ diag, goals, events: errs }, null, 2));
  app.exit(0);
}

app.on('ready', () => {
  main().catch((err) => { console.log('harness error:', err && err.message); app.exit(1); });
});
