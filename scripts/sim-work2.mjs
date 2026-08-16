/**
 * Whole-platform background user simulation.
 *
 * Runs the real Electron main/preload/renderer, but keeps its BrowserWindow
 * hidden and uses an isolated temporary profile. A deterministic local
 * OpenAI-compatible endpoint exercises chat and autonomous research plumbing;
 * it is not evidence of real-model academic quality.
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { app, BrowserWindow } from 'electron';

process.env.METIS_BACKGROUND_AUDIT = '1';
app.setName('metis-platform-background-simulation');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-platform-sim-'));
app.setPath('userData', profileDir);
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const outDir = path.resolve('platform-simulation');
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'platform-simulation-report.json');
const report = {
  startedAt: new Date().toISOString(),
  mode: 'real-electron-hidden-window-isolated-profile',
  providerKind: 'deterministic-local-openai-compatible-test-server',
  isolatedProfile: profileDir,
  checks: [],
  issues: [],
  surfaces: [],
  screenshots: [],
  console: [],
  requests: { total: 0, streaming: 0, toolCalls: {}, byPath: {} },
  metrics: {},
};

function check(category, name, ok, detail = undefined) {
  const entry = { category, name, ok, ...(detail === undefined ? {} : { detail }) };
  report.checks.push(entry);
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${category}] ${name}${detail === undefined ? '' : ` — ${String(detail).slice(0, 240)}`}`);
  return ok;
}

function issue(priority, area, title, evidence, recommendation) {
  const key = `${priority}\0${area}\0${title}`;
  if (report.issues.some((entry) => entry.key === key)) return;
  report.issues.push({ key, priority, area, title, evidence, recommendation });
  console.log(`ISSUE ${priority} [${area}] ${title}`);
}

function completionPayload(content, toolCall) {
  return {
    id: `platform-sim-${Date.now()}`,
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
    usage: { prompt_tokens: 40, completion_tokens: 90, total_tokens: 130 },
  };
}

function chooseProviderResponse(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemText = messages
    .filter((message) => message?.role === 'system')
    .map((message) => String(message.content ?? ''))
    .join('\n');
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => tool?.function?.name).filter(Boolean)
    : [];
  const toolMessages = messages.filter((message) => message?.role === 'tool');

  if (tools.includes('metis_probe')) {
    return {
      content: '',
      toolCall: {
        id: 'platform-probe',
        type: 'function',
        function: { name: 'metis_probe', arguments: '{"ok":true}' },
      },
    };
  }
  if (systemText.includes('人文社会科学研究设计模块')) {
    return {
      content: JSON.stringify({
        family: 'historical',
        confidence: 0.93,
        rationale: '问题涉及制度演变、地方档案与历时解释，采用历史研究和史料批判路径。',
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
            reasoning: '软件链路和阶段边界完整；保持草稿并继续下一方法阶段。',
          }
        : {
            decision: 'done',
            qualityScore: 0.9,
            reasoning: '方法阶段已执行完毕，产物与限制均已记录。',
          }),
    };
  }
  if (tools.includes('list_sources') && toolMessages.length === 0) {
    report.requests.toolCalls.list_sources = (report.requests.toolCalls.list_sources ?? 0) + 1;
    return {
      content: '',
      toolCall: {
        id: `platform-list-sources-${report.requests.toolCalls.list_sources}`,
        type: 'function',
        function: { name: 'list_sources', arguments: '{}' },
      },
    };
  }
  if (body.response_format?.type === 'json_object') {
    return { content: '{"ok":true,"summary":"结构化验证响应"}' };
  }

  const last = String(messages.at(-1)?.content ?? '').slice(0, 240);
  const usedProjectSources = toolMessages.length > 0;
  return {
    content: [
      '# 模拟研究响应',
      '',
      '这是后台平台体验测试的受控响应，用来验证真实界面、流式通信、工具调用与持久化链路。',
      `请求摘要：${last}`,
      '',
      '## 研究边界',
      usedProjectSources
        ? '已读取当前项目资料目录，但不会把测试资料扩写为未经核验的外部事实。'
        : '没有声称完成真实外部检索，学术判断保持草稿。',
      '',
      '## 下一步',
      '继续核对来源、证据锚点、论断与研究产物之间的可追溯关系。',
    ].join('\n'),
  };
}

const providerServer = http.createServer(async (request, response) => {
  report.requests.total += 1;
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  report.requests.byPath[url.pathname] = (report.requests.byPath[url.pathname] ?? 0) + 1;
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini', context_window: 128000, modalities: ['text'] }] }));
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const selected = chooseProviderResponse(body);
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
      id: `platform-stream-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: selected.toolCall ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 90, total_tokens: 130 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(completionPayload(selected.content, selected.toolCall)));
});

await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(0, '127.0.0.1', resolve);
});
const address = providerServer.address();
if (!address || typeof address === 'string') throw new Error('local provider did not expose a TCP port');
const providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;

await import('../dist-electron/electron/main.js');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function closeAndExit(code) {
  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.checks.filter((entry) => entry.ok).length,
    failed: report.checks.filter((entry) => !entry.ok).length,
    issues: report.issues.length,
    consoleErrors: report.console.filter((entry) => entry.level === 'error').length,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await new Promise((resolve) => providerServer.close(resolve));
  app.exit(code);
}

async function main() {
  await app.whenReady();
  let win = BrowserWindow.getAllWindows()[0];
  for (let index = 0; index < 80 && !win; index += 1) {
    await sleep(200);
    win = BrowserWindow.getAllWindows()[0];
  }
  if (!win) throw new Error('main window was not created');
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }

  win.webContents.on('console-message', (details) => {
    if (details.message.includes('Electron Security Warning')) return;
    report.console.push({ level: details.level, message: details.message.slice(0, 800), sourceId: details.sourceId });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    issue('P0', '稳定性', '渲染进程退出', details.reason, '定位崩溃原因并增加进程恢复测试。');
  });

  const run = (expression) => win.webContents.executeJavaScript(
    `(async () => { try { return ${expression}; } catch (error) { return { __error: String(error?.message ?? error), __stack: String(error?.stack ?? '') }; } })()`,
  );
  const waitFor = async (expression, timeoutMs = 12_000, intervalMs = 150) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await run(expression);
      if (last) return last;
      await sleep(intervalMs);
    }
    return last;
  };
  const setValue = (selector, value, elementType = 'input') => run(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const prototype = ${elementType === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const click = (selector) => run(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return false;
    element.click();
    return true;
  })()`);
  const clickVisibleText = (text, selector = 'button') => run(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => candidate.offsetParent !== null && candidate.textContent.trim().includes(${JSON.stringify(text)}));
    if (!element || element.disabled) return false;
    element.click();
    return true;
  })()`);
  const screenshot = async (name) => {
    await run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await sleep(80);
    const image = await win.webContents.capturePage();
    const file = `${name}.png`;
    fs.writeFileSync(path.join(outDir, file), image.toPNG());
    report.screenshots.push(file);
    return image.getSize();
  };
  const inspectSurface = async (name) => {
    const result = await run(`(() => {
      const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
      const describe = (element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') ?? '',
        className: String(element.className).slice(0, 160),
        testId: element.getAttribute('data-testid') ?? '',
        name: element.getAttribute('name') ?? '',
        text: (element.textContent ?? '').trim().slice(0, 100),
      });
      const unlabeledButtons = [...document.querySelectorAll('button')].filter(visible).filter((element) => {
        return !(element.textContent || '').trim() && !element.getAttribute('aria-label') && !element.getAttribute('title');
      }).map(describe);
      const unlabeledInputs = [...document.querySelectorAll('input, textarea, select')].filter(visible).filter((element) => {
        const id = element.id;
        return !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')
          && !(id && document.querySelector('label[for="' + CSS.escape(id) + '"]'))
          && !element.closest('label') && !element.getAttribute('placeholder');
      }).map(describe);
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id).filter(Boolean);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const root = document.documentElement;
      const overflow = root.scrollWidth > root.clientWidth + 1;
      const overflowingElements = [...document.querySelectorAll('body *')].filter(visible)
        .filter((element) => element.scrollWidth > element.clientWidth + 4 && getComputedStyle(element).overflowX === 'visible')
        .slice(0, 12)
        .map((element) => ({ tag: element.tagName, className: String(element.className).slice(0, 120), delta: element.scrollWidth - element.clientWidth }));
      return {
        title: document.title,
        textLength: document.body.innerText.length,
        activeTopNavIds: [...document.querySelectorAll('[data-nav-id][aria-current="page"]')]
          .map((element) => element.getAttribute('data-nav-id')),
        unlabeledButtons,
        unlabeledInputs,
        duplicateIds,
        horizontalOverflow: overflow,
        width: root.clientWidth,
        scrollWidth: root.scrollWidth,
        overflowingElements,
      };
    })()`);
    report.surfaces.push({ name, ...result });
    if (result.horizontalOverflow) {
      issue('P1', name, '页面出现整体横向滚动', `client=${result.width}, scroll=${result.scrollWidth}`, '修正容器最小宽度和响应式布局，并增加最小桌面宽度回归。');
    }
    if (result.unlabeledButtons.length > 0) {
      issue('P2', name, '存在无可访问名称的可见按钮', JSON.stringify(result.unlabeledButtons), '为图标按钮补充 aria-label 或可见文本。');
    }
    if (result.unlabeledInputs.length > 0) {
      issue('P2', name, '存在缺少标签或提示的表单控件', JSON.stringify(result.unlabeledInputs), '补充关联 label、aria-label 或明确 placeholder。');
    }
    if (result.duplicateIds.length > 0) {
      issue('P1', name, '页面存在重复 DOM id', result.duplicateIds.join(', '), '生成组件级唯一 ID，避免标签和无障碍引用串联。');
    }
    return result;
  };
  const navigate = async (navId, marker, name) => {
    const started = Date.now();
    const clicked = await click(`[data-nav-id="${navId}"]`);
    const found = clicked && await waitFor(`Boolean(document.querySelector(${JSON.stringify(marker)}))`);
    const latencyMs = Date.now() - started;
    check('导航', `${name}可打开`, Boolean(found), `latency=${latencyMs}ms`);
    const activeNavIds = await run(`[...document.querySelectorAll('[data-nav-id][aria-current="page"]')].map((element) => element.getAttribute('data-nav-id'))`);
    check('导航', `${name}入口状态与页面一致`, Array.isArray(activeNavIds) && activeNavIds.length === 1 && activeNavIds[0] === navId, JSON.stringify(activeNavIds));
    if (!Array.isArray(activeNavIds) || activeNavIds.length !== 1 || activeNavIds[0] !== navId) {
      issue('P1', name, '顶部导航选中状态与当前页面不一致', JSON.stringify({ expected: navId, activeNavIds }), '统一页面状态与导航选中态的单一数据源，并增加跨组连续跳转回归。');
    }
    report.metrics[`navigation.${navId}.ms`] = latencyMs;
    if (!found) issue('P0', name, '顶部导航无法打开目标页面', `navId=${navId}, marker=${marker}`, '修复路由和懒加载边界并增加真实 Electron 导航测试。');
    if (latencyMs > 1800) issue('P2', name, '首次打开等待感明显', `${latencyMs}ms`, '预加载关键模块或增加清晰骨架屏，目标首次可交互时间低于 1.2 秒。');
    await inspectSurface(name);
    await screenshot(`surface-${navId}`);
    return Boolean(found);
  };

  check('隔离', '模拟窗口保持隐藏，不抢占前台', !win.isVisible(), `visible=${win.isVisible()}`);
  check('隔离', '使用独立临时用户目录', app.getPath('userData') === profileDir, profileDir);
  const startup = await waitFor('window.metis?.startupStatus?.().then((value) => value?.ready)', 20_000);
  check('启动', '真实主进程、预加载与渲染器就绪', Boolean(startup));

  const probe = await run(`window.metis.setupProbe(${JSON.stringify({
    version: 1,
    operationId: 'platform-sim-probe',
    keyMode: 'replace',
    baseUrl: providerBaseUrl,
    model: 'gpt-4o-mini',
    newApiKey: 'local-platform-simulation-key',
  })})`);
  check('配置', '模型连接探测通过', probe?.success === true, probe?.code ?? 'ok');
  const saved = probe?.success ? await run(`window.metis.setupSave(${JSON.stringify({
    version: 1,
    operationId: 'platform-sim-save',
    expectedConfigVersion: probe.configVersion,
    probeId: probe.probeId,
  })})`) : null;
  check('配置', '保存配置并重建运行引擎', saved?.success === true, saved?.code ?? 'ok');
  await run("localStorage.setItem('metis-onboarding-done', '1')");
  await win.reload();
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(1200);
  check('配置', '配置后重载不再出现首启门禁', !(await run("Boolean(document.querySelector('[data-testid=\"first-run-skip\"]'))")));

  const navIds = await run(`[...document.querySelectorAll('[data-nav-id]')].map((element) => element.getAttribute('data-nav-id'))`);
  check('信息架构', '正常模式顶部入口完整且无技术管理入口',
    JSON.stringify(navIds) === JSON.stringify(['converse', 'write', 'autonomous', 'kanban', 'browser', 'settings', 'personalization']),
    JSON.stringify(navIds));

  await navigate('write', '.notes-page', '研究写作');
  const openedCreate = await click('.research-workspace-sidebar__create');
  check('项目', '从研究工作区打开新建项目表单', openedCreate === true);
  await setValue('.research-workspace-create input', '平台模拟：地方救济制度研究');
  const intentTextareas = await run(`[...document.querySelectorAll('.research-workspace-create textarea')].length`);
  if (intentTextareas > 0) {
    await setValue('.research-workspace-create textarea', '检验人文社科研究工作台的完整使用链路', 'textarea');
  }
  await click('.research-workspace-create button[type="submit"]');
  const projectVisible = await waitFor(`document.body.innerText.includes('平台模拟：地方救济制度研究')`);
  check('项目', '通过真实界面创建研究项目', Boolean(projectVisible));
  const projectList = await run('window.metis.researchListProjects()');
  const project = projectList?.success
    ? projectList.items.find((item) => item.entityKind === 'project' && item.value.title === '平台模拟：地方救济制度研究')?.value
    : null;
  check('项目', '新项目进入持久研究仓库', Boolean(project?.id), project?.id ?? JSON.stringify(projectList));
  if (!project?.id) throw new Error('project creation failed');
  const projectId = project.id;

  const paper = await run(`window.metis.savePaper(${JSON.stringify({
    id: 'platform-paper-1',
    title: '地方救济制度研究的资料路径',
    authors: ['模拟研究者'],
    year: 2024,
    venue: '模拟研究资料库',
    abstract: '用于平台链路测试的本地资料，不代表真实学术来源。',
    tags: ['历史研究', '测试资料'],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    addedAt: Date.now(),
  })})`);
  check('资料', '规范文献记录可持久化', paper?.success === true, paper?.code);

  const sourceId = 'platform-source-1';
  const evidenceId = 'platform-evidence-1';
  const claimId = 'platform-claim-1';
  const artifactId = 'platform-artifact-1';
  const snippet = '本条仅用于验证资料、证据、编码、论断和产物之间的项目级关系。';
  const snippetHash = createHash('sha256').update(snippet).digest('hex');
  const mutations = [
    {
      operation: 'create', entityKind: 'source', projectId,
      value: { id: sourceId, kind: 'archive', title: '模拟地方档案目录', authors: [], year: 1935, venue: '模拟档案馆', identifier: '', identifierType: 'other', externalUrl: null, tags: ['档案'], deliverableSourceKind: null, deliverableRuleKind: null, sourceVersionHash: null },
    },
    {
      operation: 'create', entityKind: 'evidence', projectId,
      value: { id: evidenceId, sourceId, anchorType: 'page', anchorStart: null, anchorEnd: null, pageNumber: 12, snippet, snippetHash, sourceVersionHash: null, confidence: 0.8 },
    },
    {
      operation: 'create', entityKind: 'note_code', projectId,
      value: { id: 'platform-code-1', evidenceId, code: '制度演变', content: '用于验证编码与证据关联。', author: 'human', confidence: 0.8, accepted: 'accepted', tags: ['历史研究'] },
    },
    {
      operation: 'create', entityKind: 'claim', projectId,
      value: { id: claimId, statement: '模拟论断：救济制度呈现地方化调整。', claimType: 'assertion', confidence: 0.6, status: 'supported' },
    },
  ];
  const mutationResults = [];
  for (const mutation of mutations) {
    mutationResults.push(await run(`window.metis.researchCrud(${JSON.stringify(mutation)})`));
  }
  check('研究对象', '资料、证据、编码和论断均可写入项目', mutationResults.every((result) => result?.success === true), JSON.stringify(mutationResults));
  const linked = await run(`window.metis.researchLink(${JSON.stringify({
    operation: 'link', projectId,
    link: { id: 'platform-claim-evidence-link-1', claimId, evidenceId, relation: 'supports', weight: 0.8, note: '模拟证据关系' },
  })})`);
  check('研究对象', '论断和证据可建立可追溯关联', linked?.success === true, linked?.code);
  const artifact = await run(`window.metis.researchVersion(${JSON.stringify({
    operation: 'save_version', projectId, artifactId, expectedVersion: null,
    title: '模拟研究阶段报告', artifactType: 'report', reviewStatus: 'draft',
    inputs: [{ kind: 'source', id: sourceId }, { kind: 'evidence', id: evidenceId }, { kind: 'claim', id: claimId }],
    capabilityId: 'writing', method: 'historical simulation', citedSourceIds: [sourceId],
    citationRequests: [], rendererKind: 'markdown', contentRef: null, media: [], inputHash: null,
    content: '# 模拟研究阶段报告\n\n用于验证研究产物版本、来源和证据谱系。', createdBy: 'user', branchFromVersion: null,
  })})`);
  check('研究成果', '研究产物以版本化草稿保存', artifact?.success === true, JSON.stringify(artifact));

  const snapshot = await run(`window.metis.researchSnapshot({ operation: 'snapshot', projectId: ${JSON.stringify(projectId)} })`);
  check('研究对象', '项目快照聚合完整研究对象', snapshot?.success === true
    && snapshot.snapshot.sources.length === 1
    && snapshot.snapshot.evidence.length === 1
    && snapshot.snapshot.noteCodes.length === 1
    && snapshot.snapshot.claims.length === 1
    && snapshot.snapshot.artifacts.length === 1,
  snapshot?.success ? JSON.stringify({ sources: snapshot.snapshot.sources.length, evidence: snapshot.snapshot.evidence.length, noteCodes: snapshot.snapshot.noteCodes.length, claims: snapshot.snapshot.claims.length, artifacts: snapshot.snapshot.artifacts.length }) : JSON.stringify(snapshot));

  await run(`window.dispatchEvent(new CustomEvent('metis:open-project', { detail: { projectId: ${JSON.stringify(projectId)}, section: 'sources' } }))`);
  await waitFor(`Boolean(document.querySelector('.research-workspace-sidebar'))`);
  await sleep(500);
  const sectionLabels = ['项目设计', '资料来源', '证据摘录', '笔记与编码', '论断网络', '研究成果', '任务', '执行记录', '回收站'];
  const sectionResults = [];
  for (const label of sectionLabels) {
    const found = await run(`(() => {
      const button = [...document.querySelectorAll('.research-navigation-item')]
        .find((element) => element.textContent.includes(${JSON.stringify(label)}));
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`);
    const active = found && await waitFor(`[...document.querySelectorAll('.research-navigation-item')]
      .some((element) => element.textContent.includes(${JSON.stringify(label)}) && element.getAttribute('aria-current') === 'page')`, 3000, 100);
    await sleep(250);
    const stable = active && await run(`[...document.querySelectorAll('.research-navigation-item')]
      .some((element) => element.textContent.includes(${JSON.stringify(label)}) && element.getAttribute('aria-current') === 'page')`);
    sectionResults.push({ label, found: Boolean(found), active: Boolean(active), stable: Boolean(stable) });
  }
  check('研究工作区', '九个项目研究分区均可切换', Array.isArray(sectionResults) && sectionResults.every((entry) => entry.found && entry.active), JSON.stringify(sectionResults));
  if (sectionResults.some((entry) => !entry.found || !entry.active || !entry.stable)) {
    issue('P1', '研究工作区', '部分研究分区无法稳定切换', JSON.stringify(sectionResults), '修复分区状态同步和挂载副作用，并用真实 Electron 连续切换九分区做回归。');
  }
  await inspectSurface('项目研究工作区');
  await screenshot('project-research-workspace');

  await navigate('write', '.notes-page', '研究写作');
  const createdNote = await clickVisibleText('新建研究备忘录');
  check('研究写作', '可从界面新建研究备忘录', createdNote === true);
  await waitFor(`Boolean(document.querySelector('.note-title-input'))`);
  await setValue('.note-title-input', '平台模拟研究备忘录');
  await setValue('[data-testid="note-content-input"]', '## 研究备忘\n\n记录资料批判、证据边界和下一步研究问题。', 'textarea');
  await sleep(700);
  const notePreviewClicked = await clickVisibleText('预览');
  const previewVisible = await waitFor(`Boolean(document.querySelector('[data-testid="note-preview"]'))`);
  check('研究写作', '研究备忘录可编辑并切换 Markdown 预览', notePreviewClicked === true && Boolean(previewVisible));
  const noteList = await run('window.metis.listNotes()');
  check('研究写作', '研究备忘录自动保存', Array.isArray(noteList) && noteList.some((entry) => entry.title === '平台模拟研究备忘录'), JSON.stringify(noteList));
  await screenshot('writing-note-preview');

  await navigate('converse', '.chat-main, .shell-workspace--chat', '研究对话');
  const listSourcesBeforeChat = report.requests.toolCalls.list_sources ?? 0;
  const chatTyped = await run(`(() => {
    const input = [...document.querySelectorAll('textarea')].find((element) => element.offsetParent !== null);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '什么是当前项目现有资料中最需要补足的关键证据？请直接简要回答。');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const chatSent = chatTyped && await run(`(() => {
    const button = [...document.querySelectorAll('button')].find((element) => element.offsetParent !== null && element.textContent.trim() === '发送');
    if (!button || button.disabled) return false;
    button.click(); return true;
  })()`);
  check('研究对话', '可输入并发送项目研究问题', chatSent === true);
  const chatAnswered = await waitFor(`document.body.innerText.includes('模拟研究响应')`, 20_000, 250);
  check('研究对话', '流式回答完成且未泄漏工具标记', Boolean(chatAnswered)
    && !(await run("document.body.innerText.includes('<tool_calls>')")));
  const listSourcesAfterChat = report.requests.toolCalls.list_sources ?? 0;
  check('研究对话', '工具调用回合被最终回答接续（list_sources → 回答）',
    chatAnswered === true && listSourcesAfterChat > listSourcesBeforeChat,
    JSON.stringify({ before: listSourcesBeforeChat, after: listSourcesAfterChat }));
  if (chatAnswered && listSourcesAfterChat <= listSourcesBeforeChat) {
    issue('P0', '研究对话', '研究对话未发生真实的项目资料工具调用', JSON.stringify({ before: listSourcesBeforeChat, after: listSourcesAfterChat }), '确认普通研究对话的 allowedTools 包含项目资料工具，并增加真实工具调用聊天回归。');
  }
  const blankAssistantBubbles = await run(`[...document.querySelectorAll('.chat-message.assistant')].filter((element) => (element.textContent ?? '').trim() === '').length`);
  check('研究对话', '回答完成后无空白助手消息气泡', chatAnswered === true && blankAssistantBubbles === 0, `blank=${blankAssistantBubbles}`);
  if (chatAnswered && blankAssistantBubbles > 0) {
    issue('P1', '研究对话', '失败或中断后残留空白流式消息', `blank=${blankAssistantBubbles}`, '非成功结算时删除空占位气泡，部分内容标记为未完成草稿。');
  }
  if (!chatAnswered) {
    const chatDiagnostic = await run(`(async () => {
      const sessionId = 'session-platform-chat-contract-diag';
      await window.metis.createSession(sessionId, ${JSON.stringify(projectId)});
      return window.metis.agentChat(sessionId, [{ role: 'user', content: '请读取当前项目资料并说明一个仍待核验的证据问题。' }], undefined, { mode: 'send', projectId: ${JSON.stringify(projectId)} });
    })()`);
    report.metrics.chatDiagnostic = chatDiagnostic;
    const diagnosticCode = chatDiagnostic?.diagnostics?.[0]?.code ?? chatDiagnostic?.status ?? 'unknown';
    issue('P0', '研究对话', '调用项目资料工具后无法生成最终回答', `界面显示研究操作未能完成；底层诊断=${diagnosticCode}；普通对话默认 maxTurns=1，工具调用占满唯一回合。`, '普通研究对话至少允许“工具调用 + 基于工具结果作答”两轮，并按工具链动态设置轮数；增加真实工具调用聊天回归。');
  }
  const sessionCountAudit = await run(`Promise.all([
    window.metis.listSessions(),
    Promise.resolve({
      activeMeta: document.querySelector('.chat-session-item.active .chat-session-meta')?.textContent?.trim() ?? '',
      visibleMessages: document.querySelectorAll('.chat-message').length,
    }),
  ])`);
  const persistedSession = sessionCountAudit?.[0]?.sessions
    ?.filter?.((entry) => entry.projectId === projectId)
    ?.sort?.((left, right) => right.lastActivity - left.lastActivity)?.[0];
  report.metrics.chatSessionCount = {
    persisted: persistedSession?.messageCount ?? null,
    activeMeta: sessionCountAudit?.[1]?.activeMeta ?? '',
    visibleMessages: sessionCountAudit?.[1]?.visibleMessages ?? null,
  };
  if ((persistedSession?.messageCount ?? 0) > 0 && /(^|\D)0\s*条消息/u.test(sessionCountAudit?.[1]?.activeMeta ?? '')) {
    issue('P1', '研究对话', '会话列表的消息数未随当前对话更新', JSON.stringify(report.metrics.chatSessionCount), '消息写入成功后同步刷新当前会话的 messageCount 和 lastActivity，避免用户误判对话未保存。');
  }
  const chatHistory = persistedSession?.id
    ? await run(`window.metis.getMessages(${JSON.stringify(persistedSession.id)})`)
    : null;
  const answerPersisted = Array.isArray(chatHistory) && JSON.stringify(chatHistory).includes('模拟研究响应');
  check('研究对话', '基于工具结果的最终回答已持久化', answerPersisted === true, JSON.stringify({ persistedMessages: Array.isArray(chatHistory) ? chatHistory.length : null }));
  if (chatAnswered && !answerPersisted) {
    issue('P0', '研究对话', '最终回答未写入持久化会话', JSON.stringify({ sessionId: persistedSession?.id, chatHistory }), '回合结算后应把助手回答写入会话历史并刷新会话摘要。');
  }
  await screenshot('conversation-answer');

  // UX-CHAT-003: 低置信度任务表达必须直接回答，并给出非阻塞转任务建议。
  const goalsBeforeAmbiguous = await run(`window.metis.listGoals()`);
  const taskLikeTyped = await run(`(() => {
    const input = [...document.querySelectorAll('textarea')].find((element) => element.offsetParent !== null);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '基于当前项目资料，提出三个需要继续核验的历史研究问题。');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const taskLikeSent = taskLikeTyped && await run(`(() => {
    const button = [...document.querySelectorAll('button')].find((element) => element.offsetParent !== null && element.textContent.trim() === '发送');
    if (!button || button.disabled) return false;
    button.click(); return true;
  })()`);
  const suggestionBar = taskLikeSent && await waitFor(`Boolean(document.querySelector('[data-testid="goal-suggestion-bar"]'))`, 8_000, 200);
  const noGoalCardAfterAmbiguous = await run(`!document.querySelector('.goal-card-inline')`);
  const goalsAfterAmbiguous = await run(`window.metis.listGoals()`);
  const goalCountUnchanged = (goalsBeforeAmbiguous?.goals?.length ?? 0) === (goalsAfterAmbiguous?.goals?.length ?? 0);
  check('研究对话', '提出研究问题默认直接回答且不误建任务', Boolean(suggestionBar) && noGoalCardAfterAmbiguous === true && goalCountUnchanged,
    JSON.stringify({ suggestionBar, noGoalCardAfterAmbiguous, goalCountUnchanged }));
  if (!suggestionBar || !noGoalCardAfterAmbiguous || !goalCountUnchanged) {
    issue('P1', '研究对话', '宽泛关键词仍会把“请提出研究问题”转成任务', JSON.stringify({ suggestionBar, noGoalCardAfterAmbiguous, goalCountUnchanged }), '任务意图需同时满足动作与交付物/持续执行信号；低置信度时直接回答并提供非阻塞转任务按钮。');
  }
  // 显式任务命令仍零确认自动执行。
  const goalsBeforeExplicit = await run(`window.metis.listGoals()`);
  const explicitTyped = await run(`(() => {
    const input = [...document.querySelectorAll('textarea')].find((element) => element.offsetParent !== null);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '/goal 核对模拟档案的来源边界并整理为研究报告');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const explicitSent = explicitTyped && await run(`(() => {
    const button = [...document.querySelectorAll('button')].find((element) => element.offsetParent !== null && element.textContent.trim() === '发送');
    if (!button || button.disabled) return false;
    button.click(); return true;
  })()`);
  const explicitGoalCard = explicitSent && await waitFor(`Boolean(document.querySelector('.goal-card-inline'))`, 20_000, 200);
  const goalsAfterExplicit = await run(`window.metis.listGoals()`);
  const explicitCreated = (goalsAfterExplicit?.goals?.length ?? 0) > (goalsBeforeExplicit?.goals?.length ?? 0);
  check('研究对话', '显式任务命令零确认自动执行', Boolean(explicitGoalCard) && explicitCreated,
    JSON.stringify({ explicitGoalCard, goalsBefore: goalsBeforeExplicit?.goals?.length, goalsAfter: goalsAfterExplicit?.goals?.length }));
  if (!explicitGoalCard || !explicitCreated) {
    issue('P1', '研究对话', '显式任务命令未进入执行流程', JSON.stringify({ explicitGoalCard, explicitCreated }), '显式 /goal、/task 命令必须继续零确认创建并执行任务。');
  }
  await screenshot('conversation-auto-goal');

  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  const globalSearchVisible = await waitFor(`Boolean(document.querySelector('.modal-overlay .modal input.search-input'))`, 3000);
  check('快捷操作', 'Ctrl+K 打开全局搜索', Boolean(globalSearchVisible));
  const ctrlKSurface = await run(`({
    hasGlobalSearch: Boolean(document.querySelector('.modal-overlay .modal input.search-input')),
    hasCommandBar: Boolean(document.querySelector('.command-bar-backdrop')),
    shellTooltip: document.querySelector('.shell-command-bar-trigger')?.getAttribute('title') ?? '',
    modalRole: document.querySelector('.modal-overlay')?.getAttribute('role') ?? '',
    modalAriaModal: document.querySelector('.modal-overlay')?.getAttribute('aria-modal') ?? '',
  })`);
  if (ctrlKSurface.hasGlobalSearch && /Ctrl\+K|⌘\+K/u.test(ctrlKSurface.shellTooltip)) {
    issue('P1', '快捷操作', 'Ctrl+K 的界面提示与实际行为冲突', `实际打开全局搜索；命令按钮提示=${ctrlKSurface.shellTooltip}`, '统一快捷键：Ctrl+K 只对应一种功能，命令面板改用 Ctrl+Shift+P 并同步按钮文案。');
  }
  if (ctrlKSurface.hasGlobalSearch && (ctrlKSurface.modalRole !== 'dialog' || ctrlKSurface.modalAriaModal !== 'true')) {
    issue('P2', '全局搜索', '搜索弹层缺少对话框语义', JSON.stringify(ctrlKSurface), '为弹层补充 role="dialog"、aria-modal="true"、可访问名称和焦点约束。');
  }
  const searchDialogName = await run(`document.querySelector('.modal-overlay')?.getAttribute('aria-label') ?? ''`);
  const searchInitialFocus = await run(`document.activeElement?.classList?.contains('search-input') ?? false`);
  check('全局搜索', '弹层有可访问名称且打开时焦点进入输入框', Boolean(searchDialogName) && searchInitialFocus === true, JSON.stringify({ ariaLabel: searchDialogName, focused: searchInitialFocus }));
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const searchFocusReleased = await run(`!document.querySelector('.modal-overlay')`);
  check('全局搜索', 'Esc 关闭后弹层卸载', searchFocusReleased === true);

  await navigate('kanban', '[data-testid="kanban-board"]', '任务看板');
  const rawRefreshKey = await run(`document.body.innerText.includes('common.refresh')`);
  const refreshLabel = await run(`document.querySelector('.kanban-header .btn-toggle')?.textContent?.trim() ?? ''`);
  check('任务看板', '刷新按钮显示本地化文案', refreshLabel === '刷新' || refreshLabel === 'Refresh', refreshLabel);
  if (rawRefreshKey || !(refreshLabel === '刷新' || refreshLabel === 'Refresh')) {
    issue('P1', '任务看板', '刷新按钮缺少本地化文案', JSON.stringify({ rawRefreshKey, refreshLabel }), '补齐中英文 common.refresh 词条，并增加界面不得出现 i18n key 的回归测试。');
  }
  const goalsBeforeTask = await run(`window.metis.listGoals()`);
  const addTask = await click('[data-testid="kanban-add-todo"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="kanban-new-task-input-todo"]'))`, 3000);
  await setValue('[data-testid="kanban-new-task-input-todo"]', '核对模拟档案的来源边界');
  const savedTask = addTask && await click('[data-testid="kanban-create-todo"]');
  await waitFor(`document.querySelectorAll('[data-testid="kanban-card"]').length > ${(goalsBeforeTask?.goals?.length ?? 0)}`, 5000, 150);
  const goalsAfterTask = await run(`window.metis.listGoals()`);
  const beforeGoalIds = new Set(goalsBeforeTask?.goals?.map?.((entry) => entry.goalId) ?? []);
  const createdTaskSummary = goalsAfterTask?.goals?.find?.((entry) => !beforeGoalIds.has(entry.goalId));
  const createdTaskGoalId = createdTaskSummary?.goalId ?? null;
  check('任务', '可在看板通过界面创建项目研究任务记录', savedTask === true && Boolean(createdTaskGoalId), JSON.stringify(createdTaskSummary));
  if (createdTaskGoalId && createdTaskSummary?.label !== '核对模拟档案的来源边界') {
    issue('P1', '任务看板', '所有任务标题被替换成 Research goal', JSON.stringify({ expected: '核对模拟档案的来源边界', actual: createdTaskSummary?.label, goalId: createdTaskGoalId }), 'Goal 列表使用持久化的 goal.description，不要在 presentGoalSummary 中硬编码展示标题。');
  }
  check('任务', '看板新建任务继承当前活动项目', createdTaskGoalId ? createdTaskSummary?.projectId === projectId : false,
    JSON.stringify({ expectedProjectId: projectId, actual: createdTaskSummary?.projectId }));
  if (createdTaskGoalId && createdTaskSummary?.projectId !== projectId) {
    issue('P1', '任务看板', '新建任务未归属当前活动项目', JSON.stringify({ expectedProjectId: projectId, actual: createdTaskSummary?.projectId, goalId: createdTaskGoalId }), '内联创建区显示项目归属选择，优先继承当前活动项目或明确的项目筛选值；「未关联」必须是显式选择。');
  }
  const taskCard = createdTaskGoalId ? await run(`(() => {
    const card = document.querySelector('[data-goal-id="${createdTaskGoalId}"]');
    if (!card) return false;
    card.click(); return true;
  })()`) : false;
  const detailVisible = await waitFor(`Boolean(document.querySelector('[data-testid="kanban-detail"]'))`);
  check('任务', '任务卡可打开详情并保留上下文', taskCard === true && Boolean(detailVisible));
  await screenshot('task-board-detail');

  await navigate('browser', '[data-testid="browser-web-shell"]', '资料浏览器');
  const browserTabs = await run(`['browser-tab-scholar','browser-tab-cnki','browser-tab-papers'].map((id) => ({ id, exists: Boolean(document.querySelector('[data-testid="' + id + '"]')) }))`);
  check('资料浏览器', '学术搜索、知网和已下载论文入口完整', browserTabs.every((entry) => entry.exists), JSON.stringify(browserTabs));
  await click('[data-testid="browser-tab-papers"]');
  const downloadedSurface = await waitFor(`Boolean(document.querySelector('[data-testid="browser-papers-shell"]'))`);
  check('资料浏览器', '已下载论文页可切换且空状态明确', Boolean(downloadedSurface));
  await screenshot('browser-downloaded-papers');

  await navigate('settings', '.settings-page, .settings-group', '设置');
  const settingsAudit = await run(`(() => ({
    sections: document.querySelectorAll('.settings-group').length,
    storage: Boolean(document.querySelector('[data-testid="storage-section"]')),
    wechat: Boolean(document.querySelector('[data-testid="wechat-bot-section"]')),
    keyMasked: document.body.innerText.includes('••••••••'),
    hasPlainTestKey: document.body.innerText.includes('local-platform-simulation-key'),
  }))()`);
  check('设置', '存储、微信及模型配置分区可见', settingsAudit.sections >= 5 && settingsAudit.storage && settingsAudit.wechat, JSON.stringify(settingsAudit));
  check('设置', '已保存模型密钥只显示掩码', settingsAudit.keyMasked && !settingsAudit.hasPlainTestKey);
  const archiveSelectLabel = await run(`Boolean(document.querySelector('label[for="project-archive-select"]')) && Boolean(document.querySelector('#project-archive-select'))`);
  check('设置', '项目归档选择控件有程序化标签', archiveSelectLabel === true);
  await screenshot('settings-overview');

  await navigate('personalization', '.personalization-page, .personalization-center', '场景中心');
  const personalization = await run(`window.metis.listPersonalization({ contractVersion: 1, includeDisabled: true })`);
  check('场景', '场景中心连接真实个性化仓库', personalization?.ok === true && Array.isArray(personalization.definitions), JSON.stringify({ ok: personalization?.ok, count: personalization?.definitions?.length }));
  await screenshot('personalization-center');

  // A11Y-003: 先保存一个论文结构模板，让 structure-select 有机会渲染。
  await run(`window.metis.structureSave(${JSON.stringify({
    id: 'structure-platform-1',
    name: '平台模拟论文结构',
    sections: [{ id: 'sec-1', title: '引言', instruction: '简要交代背景与问题。' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isDefault: false,
  })})`);
  await navigate('autonomous', '[data-testid="autonomous-start"]', '自主科研');
  const strategySelectLabel = await run(`Boolean(document.querySelector('label[for="strategy-select"]')) && Boolean(document.querySelector('#strategy-select'))`);
  const structureSelectLabel = await run(`Boolean(document.querySelector('label[for="structure-select"]')) && Boolean(document.querySelector('#structure-select'))`);
  check('自主科研', '策略与论文结构选择控件有程序化标签', strategySelectLabel === true && structureSelectLabel === true, JSON.stringify({ strategy: strategySelectLabel, structure: structureSelectLabel }));
  await click('[data-testid="strategy-editor-toggle"]');
  const editorOpen = await waitFor(`Boolean(document.querySelector('[data-testid="strategy-editor"]'))`, 3000);
  const newStrategyButton = await waitFor(`Boolean(document.querySelector('[data-testid="strategy-new"]'))`, 3000);
  await click('[data-testid="strategy-new"]');
  const editorFormOpen = await waitFor(`Boolean(document.querySelector('[data-testid="strategy-name"]'))`, 3000);
  const editorUnlabeled = editorFormOpen ? await run(`(() => {
    const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
    return [...document.querySelectorAll('[data-testid="strategy-editor"] input, [data-testid="strategy-editor"] select, [data-testid="strategy-editor"] textarea')]
      .filter(visible)
      .filter((element) => !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')
        && !(element.id && document.querySelector('label[for="' + CSS.escape(element.id) + '"]'))
        && !element.closest('label') && !element.getAttribute('placeholder'))
      .length;
  })()`) : -1;
  check('自主科研', '策略编辑器动态表单控件均有可访问名称', editorOpen === true && editorFormOpen === true && editorUnlabeled === 0, `unlabeled=${editorUnlabeled}`);
  await click('[data-testid="strategy-editor-toggle"]');
  await run(`(() => {
    window.__platformAuto = { completed: null, failed: null };
    window.metis.onAutonomousCompleted((event) => { window.__platformAuto.completed = event; });
    window.metis.onAutonomousFailed((event) => { window.__platformAuto.failed = event; });
    const input = document.querySelector('.autonomous-goal-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '利用当前项目资料探索地方救济制度的演变及其证据边界');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const autoStarted = await click('[data-testid="autonomous-start"]');
  check('自主科研', '无需方法确认即可直接开始探索', autoStarted === true);
  const autoTerminal = await waitFor(`(() => {
    const state = window.__platformAuto;
    return state?.completed || state?.failed ? state : null;
  })()`, 90_000, 200);
  check('自主科研', '自主研究完成且未停在人工确认', Boolean(autoTerminal?.completed) && !autoTerminal?.failed, JSON.stringify(autoTerminal));
  const autoArtifacts = autoTerminal?.completed?.artifactIds ?? [];
  check('自主科研', '每个方法阶段形成持久成果', autoArtifacts.length >= 8, `artifactIds=${autoArtifacts.length}`);
  check('自主科研', '自主阶段真实读取当前项目资料工具', (report.requests.toolCalls.list_sources ?? 0) > 0, report.requests.toolCalls.list_sources ?? 0);
  const progressText = await run(`document.querySelector('[data-testid="autonomous-progress"]')?.textContent ?? ''`);
  const progressMatch = progressText.match(/(\d+)\s*\/\s*(\d+)/u);
  check('自主科研', '完成进度达到真实总阶段数', Boolean(progressMatch) && progressMatch[1] === progressMatch[2], progressText);
  await screenshot('autonomous-completed');

  const beforeReload = await run(`Promise.all([
    window.metis.listNotes(),
    window.metis.listGoals(),
    window.metis.researchSnapshot({ operation: 'snapshot', projectId: ${JSON.stringify(projectId)} }),
  ])`);
  await win.reload();
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(1300);
  const afterReload = await run(`Promise.all([
    window.metis.listNotes(),
    window.metis.listGoals(),
    window.metis.researchSnapshot({ operation: 'snapshot', projectId: ${JSON.stringify(projectId)} }),
    window.metis.autonomousListSessions(),
  ])`);
  check('恢复', '重载后项目、笔记和任务仍存在',
    afterReload?.[0]?.some?.((entry) => entry.title === '平台模拟研究备忘录')
      && afterReload?.[1]?.goals?.some?.((entry) => entry.goalId === createdTaskGoalId)
      && afterReload?.[2]?.success === true,
    JSON.stringify({ notes: afterReload?.[0]?.length, goals: afterReload?.[1]?.goals?.length, snapshot: afterReload?.[2]?.success }));
  check('恢复', '成功自主运行不遗留恢复检查点', Array.isArray(afterReload?.[3]?.sessions) && afterReload[3].sessions.length === 0, JSON.stringify(afterReload?.[3]));

  for (const width of [1400, 1100, 1000]) {
    win.setSize(width, 900, false);
    await sleep(300);
    const geometry = await run(`(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      navOverflow: document.querySelector('.topbar-nav')?.scrollWidth > document.querySelector('.topbar-nav')?.clientWidth + 1,
    }))()`);
    check('布局', `${width}px 桌面宽度无整页横向滚动`, !geometry.overflow, JSON.stringify(geometry));
    if (geometry.overflow) issue('P1', '全局布局', `${width}px 出现横向滚动`, JSON.stringify(geometry), '建立 1000/1100/1400 三档真实 Electron 布局回归。');
  }
  win.setSize(1400, 900, false);

  const rendererMemory = await win.webContents.executeJavaScript(`({
    usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null,
    totalJSHeapSize: performance.memory?.totalJSHeapSize ?? null,
    domNodes: document.querySelectorAll('*').length,
  })`);
  const processMemory = await process.getProcessMemoryInfo();
  report.metrics.renderer = rendererMemory;
  report.metrics.processMemoryKb = processMemory;
  const uniqueErrors = [...new Set(report.console.filter((entry) => entry.level === 'error').map((entry) => entry.message))];
  check('稳定性', '模拟期间无渲染器错误级控制台消息', uniqueErrors.length === 0, JSON.stringify(uniqueErrors));
  if (uniqueErrors.length > 0) issue('P1', '稳定性', '模拟使用期间出现渲染器错误', uniqueErrors.join('\n'), '逐条复现并修正，纳入后台模拟回归。');

  // A failure in a product assertion is reported but does not abort evidence
  // collection. Harness/renderer crashes still produce a non-zero exit.
  await closeAndExit(0);
}

app.on('ready', () => {
  void main().catch(async (error) => {
    check('测试框架', '后台平台模拟器完整运行', false, error instanceof Error ? error.stack : String(error));
    await closeAndExit(1);
  });
});
