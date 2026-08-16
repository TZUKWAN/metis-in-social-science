/**
 * Controlled autonomous-research Electron E2E.
 *
 * Boots the real packaged main/preload/renderer and canonical SQLite repository
 * under an isolated app name. A local deterministic OpenAI-compatible server
 * exercises setup, streaming, native tool calling and reflection without using
 * a paid credential. This verifies product plumbing only; it does not claim
 * real-model research quality.
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, BrowserWindow } from 'electron';

app.setName('metis-autonomous-e2e');

const outputDir = path.resolve('autonomous-e2e');
fs.mkdirSync(outputDir, { recursive: true });
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-autonomous-e2e-'));
app.setPath('userData', isolatedUserData);
const reportPath = path.join(outputDir, 'autonomous-research-e2e-report.json');
const report = {
  startedAt: new Date().toISOString(),
  providerKind: 'deterministic-local-openai-compatible-test-server',
  checks: [],
  requests: { total: 0, streaming: 0, listSourcesToolCalls: 0 },
  consoleErrors: [],
};

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
}

function completionPayload(content, toolCall) {
  return {
    id: `test-${Date.now()}`,
    object: 'chat.completion',
    created: Math.trunc(Date.now() / 1000),
    model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: toolCall
        ? { role: 'assistant', content: '', tool_calls: [toolCall] }
        : { role: 'assistant', content },
      finish_reason: toolCall ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 30, completion_tokens: 80, total_tokens: 110 },
  };
}

function responseFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemText = messages
    .filter((message) => message?.role === 'system')
    .map((message) => String(message.content ?? ''))
    .join('\n');
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => tool?.function?.name).filter(Boolean)
    : [];
  const hasToolFeedback = messages.some((message) => message?.role === 'tool');

  if (body.response_format?.type === 'json_object') {
    return { content: '{"ok":true}' };
  }
  if (tools.includes('metis_probe')) {
    return {
      content: '',
      toolCall: {
        id: 'probe-tool-call',
        type: 'function',
        function: { name: 'metis_probe', arguments: '{"ok":true}' },
      },
    };
  }
  if (systemText.includes('人文社会科学研究设计模块')) {
    return {
      content: JSON.stringify({
        family: 'historical',
        confidence: 0.94,
        rationale: '目标明确依赖地方档案、制度演变与历时解释，适合历史研究及史料批判路径。',
      }),
    };
  }
  if (systemText.includes('reflection module')) {
    const next = systemText.match(/当前计划的下一阶段是\s+([a-z_]+)。/u)?.[1];
    return {
      content: JSON.stringify(next
        ? {
            decision: 'advance',
            qualityScore: 0.86,
            nextPhase: next,
            reasoning: '阶段产物结构完整，已明确测试环境证据边界，可继续到下一方法阶段。',
          }
        : {
            decision: 'done',
            qualityScore: 0.9,
            reasoning: '方法计划已经执行完毕，阶段产物和限制说明均已保留。',
          }),
    };
  }
  if (tools.includes('list_sources') && !hasToolFeedback) {
    report.requests.listSourcesToolCalls += 1;
    return {
      content: '',
      toolCall: {
        id: `list-sources-${report.requests.listSourcesToolCalls}`,
        type: 'function',
        function: { name: 'list_sources', arguments: '{}' },
      },
    };
  }

  const prompt = String(messages.at(-1)?.content ?? '').slice(0, 180);
  return {
    content: [
      '# 自主科研阶段记录',
      '',
      '本阶段由受控端到端验证提供程序执行，用于核验真实主进程、AgentLoop、项目工具、检查点与产物持久化链路。',
      `阶段提示摘要：${prompt}`,
      '',
      '## 当前判断',
      '已形成结构化阶段输出，并明确区分已执行的软件链路与尚未由真实外部资料支持的学术判断。',
      '',
      '## 证据与限制',
      hasToolFeedback
        ? '已调用当前项目的 canonical list_sources 工具；隔离项目中尚无外部来源，因此不虚构档案、引文或事实。'
        : '本阶段不声称检索到真实外部资料；任何内容均保持草稿状态，等待真实模型和来源进一步研究。',
      '',
      '## 下一步',
      '沿选定历史研究方法继续推进，并将每一阶段输出保存为可追溯、可版本化的项目研究产物。',
    ].join('\n'),
  };
}

const server = http.createServer(async (request, response) => {
  report.requests.total += 1;
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname.startsWith('/v1/models')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      data: [{ id: 'gpt-4o-mini', context_window: 128000, modalities: ['text'] }],
    }));
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const selected = responseFor(body);
  if (body.stream === true) {
    report.requests.streaming += 1;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const delta = selected.toolCall
      ? { tool_calls: [{ index: 0, ...selected.toolCall }] }
      : { content: selected.content };
    response.write(`data: ${JSON.stringify({
      id: `stream-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: selected.toolCall ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 80, total_tokens: 110 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(completionPayload(selected.content, selected.toolCall)));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('local provider did not expose a TCP port');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

await import('../dist-electron/electron/main.js');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function closeAndExit(code) {
  report.finishedAt = new Date().toISOString();
  report.failed = report.checks.filter((item) => !item.ok).length;
  report.passed = report.checks.length - report.failed;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await new Promise((resolve) => server.close(resolve));
  app.exit(code);
}

async function main() {
  await app.whenReady();
  let win = BrowserWindow.getAllWindows()[0];
  for (let index = 0; index < 60 && !win; index += 1) {
    await sleep(250);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('no application window was created');
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error' && !details.message.includes('Electron Security Warning')) {
      report.consoleErrors.push(details.message.slice(0, 500));
    }
  });

  const run = (expression) => win.webContents.executeJavaScript(
    `(async () => { try { return ${expression}; } catch (error) { return { __error: String(error?.message ?? error) }; } })()`,
  );
  for (let index = 0; index < 60; index += 1) {
    const startup = await run('window.metis?.startupStatus?.()');
    if (startup?.ready) break;
    await sleep(250);
  }

  const probe = await run(`window.metis.setupProbe(${JSON.stringify({
    version: 1,
    operationId: 'auto-e2e-probe',
    keyMode: 'replace',
    baseUrl,
    model: 'gpt-4o-mini',
    newApiKey: 'local-test-key-1234',
  })})`);
  check('真实 setup probe 通过本机 OpenAI 兼容端点', probe?.success === true, JSON.stringify(probe));
  const saved = probe?.success
    ? await run(`window.metis.setupSave(${JSON.stringify({
        version: 1,
        operationId: 'auto-e2e-save',
        expectedConfigVersion: probe.configVersion,
        probeId: probe.probeId,
      })})`)
    : null;
  check('真实 setup save 重建 provider 与自主引擎', saved?.success === true, JSON.stringify(saved));
  if (!saved?.success) throw new Error('provider setup failed');

  // Keep the screenshot and navigation assertions focused on the autonomous
  // research workflow rather than the unrelated first-run feature tour.
  await run("localStorage.setItem('metis-onboarding-done', '1')");
  await win.reload();
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(1500);
  const navigated = await run(`(() => {
    const button = document.querySelector('[data-nav-id="autonomous"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check('从真实应用导航进入自主科研页面', navigated === true);
  for (let index = 0; index < 40; index += 1) {
    if (await run('Boolean(document.querySelector(`[data-testid="autonomous-start"]`))')) break;
    await sleep(200);
  }

  await run(`(() => {
    window.__autoE2E = { completed: null, failed: null };
    window.metis.onAutonomousCompleted((event) => { window.__autoE2E.completed = event; });
    window.metis.onAutonomousFailed((event) => { window.__autoE2E.failed = event; });
    const input = document.querySelector('.autonomous-goal-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '利用地方档案研究民国时期城市救济制度的演变');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  const clicked = await run(`(() => {
    const button = document.querySelector('[data-testid="autonomous-start"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  check('从真实页面启动自主科研', clicked === true);

  let terminal = null;
  for (let index = 0; index < 300; index += 1) {
    terminal = await run('window.__autoE2E');
    if (terminal?.completed || terminal?.failed) break;
    await sleep(200);
  }
  check('自主科研到达完成而非失败状态', Boolean(terminal?.completed) && !terminal?.failed, JSON.stringify(terminal));
  const artifactIds = terminal?.completed?.artifactIds ?? [];
  check('完成事件返回真实持久化产物 ID', artifactIds.length === 10, `artifactIds=${artifactIds.length}`);
  check('AgentLoop 真实调用当前项目 list_sources 工具', report.requests.listSourcesToolCalls > 0, report.requests.listSourcesToolCalls);

  const projects = await run('window.metis.researchListProjects()');
  const project = projects?.success
    ? projects.items.find((item) => item.entityKind === 'project' && item.value?.originalIntent?.includes('地方档案'))?.value
    : null;
  check('未预选项目时自动创建持久探索项目', Boolean(project?.id), project?.id);
  const snapshot = project?.id
    ? await run(`window.metis.researchSnapshot({ operation: 'snapshot', projectId: ${JSON.stringify(project.id)} })`)
    : null;
  const artifacts = snapshot?.success ? snapshot.snapshot.artifacts : [];
  const runs = snapshot?.success ? snapshot.snapshot.runs : [];
  check('项目快照包含十个阶段研究成果', artifacts.length === 10, `artifacts=${artifacts.length}`);
  check('阶段成果保持诚实草稿状态', artifacts.length === 10 && artifacts.every((item) => item.reviewStatus === 'draft'));
  check('写作阶段保存为 manuscript', artifacts.some((item) => item.artifactType === 'manuscript'));
  check('持久研究运行最终状态为 completed', runs.some((item) => item.status === 'completed'));

  const recoverable = await run('window.metis.autonomousListSessions()');
  check('成功运行不残留可恢复检查点', Array.isArray(recoverable?.sessions) && recoverable.sessions.length === 0, JSON.stringify(recoverable));
  const deliverableUi = await run(`({
    visible: Boolean(document.querySelector('[data-testid="autonomous-deliverables"]')),
    text: document.querySelector('[data-testid="autonomous-deliverables"]')?.textContent ?? '',
    open: Boolean(document.querySelector('[data-testid="autonomous-open-artifacts"]')),
  })`);
  check('完成页面显示已保存研究成果与打开入口', deliverableUi?.visible && deliverableUi?.open, JSON.stringify(deliverableUi));
  await run(`document.querySelector('[data-testid="autonomous-open-artifacts"]')?.click()`);
  await sleep(1200);
  check('一键进入项目研究成果区', await run('document.body.innerText.includes("研究成果")'));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'autonomous-research-completed.png'), image.toPNG());
  check('完成态截图已生成', image.getSize().width > 0 && image.getSize().height > 0);
  check('渲染器无错误级控制台消息', report.consoleErrors.length === 0, JSON.stringify(report.consoleErrors));

  const failed = report.checks.some((item) => !item.ok);
  await closeAndExit(failed ? 1 : 0);
}

app.on('ready', () => {
  void main().catch(async (error) => {
    check('自主科研 E2E harness', false, error instanceof Error ? error.stack : String(error));
    await closeAndExit(1);
  });
});
