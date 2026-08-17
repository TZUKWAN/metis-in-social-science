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
  if (systemText.includes('研究场景设计助手')) {
    return {
      content: JSON.stringify({
        scenario: {
          name: '历史档案研究场景',
          description: '梳理地方历史档案并提取证据形成论断网络。',
          triggerPhrases: ['档案分析', '整理档案'],
          deliverable: '一份关于档案证据链的综述报告',
        },
        agents: [{
          name: '档案梳理员',
          role: '史料整理与证据提取',
          systemPrompt: '负责梳理档案目录、提取关键证据、标注来源边界并形成可追溯论断。',
          skillIds: [],
          toolIds: ['list_sources', 'extract_evidence', 'link_evidence'],
          mcpIds: [],
          maxTurns: 12,
        }],
        workflow: [
          {
            name: '梳理档案目录',
            description: '列出项目档案目录并去重。',
            agent: '档案梳理员',
            skillIds: [],
            toolIds: ['list_sources'],
            mcpIds: [],
            maxTurns: 8,
          },
          {
            name: '提取关键证据',
            description: '从资料中提取证据摘录并建立关联。',
            agent: '档案梳理员',
            skillIds: [],
            toolIds: ['extract_evidence', 'link_evidence'],
            mcpIds: [],
            maxTurns: 8,
          },
        ],
        rules: '## 研究边界\n只使用项目内地方档案作为证据来源，不扩写未经核验的外部事实。\n## 输出规范\n证据摘录必须标注档案目录与页码。',
        paperStructure: [
          { title: '引言', instruction: '交代研究问题、档案背景与研究边界。' },
          { title: '制度演变分析', instruction: '按时间顺序梳理救济制度变化，逐条引用档案证据。' },
          { title: '结论', instruction: '总结研究发现、证据边界与后续研究问题。' },
        ],
      }),
    };
  }
  if (systemText.includes('人文社科科研场景设计师')) {
    return {
      content: JSON.stringify({
        summary: {
          deliverableType: 'theory_paper',
          deliverableTypeLabel: '纯理论论文',
          structureTitles: ['题目', '摘要', '关键词', '1 引言', '2 理论框架', '3 结论'],
          hardRuleCount: 2,
          writingPrincipleCount: 3,
          methods: ['概念分析', '文本分析'],
          adjustable: ['主体章节数量', '二三级标题'],
          recommended: { agents: 1, skills: 2, mcps: 0, rules: 1 },
        },
        materials: [{
          name: '模拟写作方法材料.md',
          kind: 'method_book',
          insights: {
            structureRules: ['正文三到五章，每章承担独立论证功能'],
            writingPrinciples: ['摘要不出现本文', '每节开头给出本节论点'],
            methodSuggestions: ['概念界定先于机制分析'],
            hardRequirements: ['引用必须真实可查'],
          },
        }],
        scenario: {
          name: 'CSSCI 纯理论论文场景',
          description: '面向 CSSCI 的纯理论论文研究场景。',
          triggerPhrases: ['理论论文'],
          deliverable: {
            type: 'theory_paper',
            typeLabel: '纯理论论文',
            sections: [
              { id: 'title', title: '题目', kind: 'title', status: 'locked', purpose: '概括核心论点' },
              { id: 'abstract', title: '摘要', kind: 'abstract', status: 'required', requirements: ['研究问题', '核心论点'], forbidden: ['出现本文'] },
              { id: 'keywords', title: '关键词', kind: 'keywords', status: 'required' },
              { id: 'c1', title: '1 引言', kind: 'chapter', status: 'required', purpose: '提出研究问题', lengthTarget: '1500-2000 字' },
              { id: 'c2', title: '2 理论框架', kind: 'chapter', status: 'required', purpose: '建构理论框架', method: '概念分析' },
              { id: 'c3', title: '3 结论', kind: 'chapter', status: 'locked', purpose: '总结论点与边界' },
              { id: 'r1', title: '机制分析', kind: 'section', status: 'conditional', condition: '理论框架含明确机制时' },
            ],
            structurePolicy: { defaultSections: 3, suggestedMin: 3, suggestedMax: 5 },
            globalLength: '10000-12000 字',
            language: 'zh',
            journalTier: 'core',
          },
          adaptivity: {
            structure: { addSections: true, deleteUnlockedSections: true, splitSections: true, mergeSections: false, reorderSections: false, adjustLength: true },
            content: { reviseQuestion: true, addQuestion: false, reviseHypothesis: true, dropUnsupportedHypothesis: true, adjustFramework: true },
            method: { addMethod: true, replaceUnsuitableMethod: true, addRobustness: false, addHeterogeneity: false, addMechanism: true },
            allowedBacktracks: ['analysis->literature'],
            majorAdjustmentTriggers: ['新证据推翻原假设', '原结构无法解释重要发现'],
          },
          writingRules: ['摘要禁止出现"本文"', '每节开头给出本节论点'],
          methodPolicy: { recommended: ['概念分析'], allowed: ['文本分析'], conditional: [], forbidden: ['问卷调查'] },
          agents: [{
            name: '理论建构智能体',
            role: '理论分析与写作',
            systemPrompt: '负责理论框架建构、论证推进与论文撰写，遵守证据边界。',
            skillIds: [],
            toolIds: ['list_sources', 'draft_claim', 'save_artifact'],
            mcpIds: [],
            maxTurns: 12,
          }],
          workflow: [
            { name: '文献研究', description: '梳理经典文献与理论脉络。', agent: '理论建构智能体', skillIds: [], toolIds: ['list_sources'], mcpIds: [], maxTurns: 8 },
            { name: '理论建构', description: '形成理论框架与核心论点。', agent: '理论建构智能体', skillIds: [], toolIds: ['draft_claim'], mcpIds: [], maxTurns: 8 },
            { name: '论文撰写', description: '按成果结构撰写全文。', agent: '理论建构智能体', skillIds: [], toolIds: ['save_artifact'], mcpIds: [], maxTurns: 8 },
          ],
          rules: '## 研究目标\n产出可投稿 CSSCI 的纯理论论文。\n## 证据边界\n文献性论断必须来自本地文献库。',
        },
      }),
    };
  }
  if (systemText.includes('论文结构模板解析助手')) {
    return {
      content: JSON.stringify({
        sections: [
          { title: '引言', instruction: '交代研究背景与问题。' },
          { title: '研究现状', instruction: '梳理已有研究成果与不足。' },
          { title: '研究方法', instruction: '说明资料、方法与研究边界。' },
          { title: '结论', instruction: '总结发现与后续问题。' },
        ],
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
    JSON.stringify(navIds) === JSON.stringify(['converse', 'projects', 'autonomous', 'settings', 'personalization']),
    JSON.stringify(navIds));

  await navigate('projects', '[data-testid="projects-page"]', '科研项目');
  const openedCreate = await click('[data-testid="projects-new-project"]');
  check('项目', '从科研项目工作台打开新建项目表单', openedCreate === true);
  await setValue('[data-testid="projects-new-project-input"]', '平台模拟：地方救济制度研究');
  await click('[data-testid="projects-create-submit"]');
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

  await run(`window.dispatchEvent(new CustomEvent('metis:open-project', { detail: { projectId: ${JSON.stringify(projectId)}, section: 'artifacts' } }))`);
  await waitFor(`Boolean(document.querySelector('[data-testid="projects-page"]'))`);
  await sleep(300);
  const projectCenterSurface = await run(`({
    page: Boolean(document.querySelector('[data-testid="projects-page"]')),
    activeItem: document.querySelector('[data-testid="projects-project-item"][data-project-id="${projectId}"]')?.getAttribute('aria-current') ?? '',
    artifactsTabSelected: document.querySelector('[data-testid="projects-mode-artifacts"]')?.getAttribute('aria-selected') ?? '',
  })`);
  check('科研项目', '打开项目链接进入科研项目工作台并选中对应项目',
    projectCenterSurface.page === true && projectCenterSurface.activeItem === 'page' && projectCenterSurface.artifactsTabSelected === 'true',
    JSON.stringify(projectCenterSurface));
  if (projectCenterSurface.artifactsTabSelected !== 'true') {
    issue('P1', '科研项目', '研究成果入口未随项目链接激活', JSON.stringify(projectCenterSurface), '打开产物链接时应直接落在科研成果模式页签。');
  }
  const modeTabs = ['chat', 'kanban', 'artifacts'];
  const modeResults = [];
  for (const mode of modeTabs) {
    const clicked = await click(`[data-testid="projects-mode-${mode}"]`);
    await sleep(250);
    const selected = await run(`document.querySelector('[data-testid="projects-mode-${mode}"]')?.getAttribute('aria-selected') ?? ''`);
    modeResults.push({ mode, clicked, selected });
  }
  check('科研项目', '聊天/任务看板/研究成果三个模式页签均可切换',
    modeResults.every((entry) => entry.clicked === true && entry.selected === 'true'),
    JSON.stringify(modeResults));
  if (modeResults.some((entry) => entry.clicked !== true || entry.selected !== 'true')) {
    issue('P1', '科研项目', '部分模式页签无法切换', JSON.stringify(modeResults), '修复模式状态同步并增加真实 Electron 页签切换回归。');
  }
  const projectSplit = await run(`(async () => {
    const handle = document.querySelector('[data-testid="projects-split-sidebar"]');
    const sidebar = document.querySelector('.projects-page__sidebar');
    if (!handle || !sidebar) return { found: false };
    const before = sidebar.getBoundingClientRect().width;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: Math.round(before) }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: Math.round(before) + 120 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = sidebar.getBoundingClientRect().width;
    return { found: true, before: Math.round(before), after: Math.round(after), changed: Math.abs(after - before) > 20 };
  })()`);
  check('科研项目', '项目列表宽度可拖拽调节', projectSplit.found === true && projectSplit.changed === true, JSON.stringify(projectSplit));
  if (!projectSplit.changed) {
    issue('P1', '科研项目', '项目列表宽度写死不可调', JSON.stringify(projectSplit), '科研项目左侧列表宽度应可拖拽调节并持久化。');
  }
  await inspectSurface('科研项目工作台');
  await screenshot('project-center');

  // 研究成果中心：产物按时间倒序展示、类别直显、右键标记「最终版」。
  await click('[data-testid="projects-mode-artifacts"]');
  const artifactVisible = await waitFor(`document.body.innerText.includes('模拟研究阶段报告')`, 5000, 200);
  check('研究成果', '项目产物在研究成果中心可见', artifactVisible === true);
  const artifactSurface = await run(`({
    item: Boolean(document.querySelector('[data-testid="artifacts-center-item"]')),
    categories: [...document.querySelectorAll('.artifacts-center__category')].map((el) => el.textContent.trim()),
    versions: document.querySelector('.artifacts-center__versions')?.textContent?.trim() ?? '',
  })`);
  check('研究成果', '产物条目直接显示类别与版本信息',
    artifactSurface.item === true
      && artifactSurface.categories.includes('论文')
      && artifactSurface.versions.includes('1 个版本'),
    JSON.stringify(artifactSurface));
  if (artifactSurface.item !== true || !artifactSurface.categories.includes('论文')) {
    issue('P1', '研究成果', '产物类别未直接展示', JSON.stringify(artifactSurface), '列表直接显示 论文/源代码/元数据/参考文献 类别徽章，无需进入详情。');
  }
  const contextMenuOpened = await run(`(() => {
    const item = document.querySelector('[data-testid="artifacts-center-item"]');
    if (!item) return false;
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 180 }));
    return true;
  })()`);
  const menuVisible = contextMenuOpened && await waitFor(`Boolean(document.querySelector('[data-testid="artifacts-center-menu"]'))`, 3000);
  const markClicked = menuVisible && await run(`(() => {
    const target = [...document.querySelectorAll('.artifacts-center__menu-item')]
      .find((el) => el.textContent.trim() === '最终版');
    if (!target) return false;
    target.click(); return true;
  })()`);
  // 最终版（verified）受真实性层约束：草稿产物缺交付配置时后端拒绝，
  // 界面必须给出明确提示而不是静默失败。
  const rejectedNotice = markClicked && await waitFor(`document.querySelector('.artifacts-center__notice')?.textContent?.includes('无法标记为最终版') ?? false`, 5000, 200);
  const snapshotAfterReject = await run(`window.metis.researchSnapshot({ operation: 'snapshot', projectId: ${JSON.stringify(projectId)} })`);
  check('研究成果', '最终版标记在缺交付配置时被明确拒绝', markClicked === true && rejectedNotice === true && snapshotAfterReject?.snapshot?.artifacts[0]?.reviewStatus === 'draft',
    JSON.stringify({ markClicked, rejectedNotice, reviewStatus: snapshotAfterReject?.snapshot?.artifacts[0]?.reviewStatus }));
  if (!(markClicked && rejectedNotice)) {
    issue('P1', '研究成果', '最终版标记的拒绝提示缺失', JSON.stringify({ markClicked, rejectedNotice }), '缺少可核验交付配置的产物标记最终版时应显示明确原因。');
  }
  // 待审核等轻量标记直接持久化。
  await run(`(() => {
    const item = document.querySelector('[data-testid="artifacts-center-item"]');
    if (!item) return false;
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 200 }));
    return true;
  })()`);
  const pendingMenu = await waitFor(`Boolean(document.querySelector('[data-testid="artifacts-center-menu"]'))`, 3000);
  const pendingClicked = pendingMenu && await run(`(() => {
    const target = [...document.querySelectorAll('.artifacts-center__menu-item')]
      .find((el) => el.textContent.trim() === '待审核');
    if (!target) return false;
    target.click(); return true;
  })()`);
  const pendingBadge = pendingClicked && await waitFor(`Boolean(document.querySelector('.artifacts-center__status--pending'))`, 5000, 200);
  const pendingSnapshot = await run(`window.metis.researchSnapshot({ operation: 'snapshot', projectId: ${JSON.stringify(projectId)} })`);
  const pendingStatus = pendingSnapshot?.success ? pendingSnapshot.snapshot.artifacts[0]?.reviewStatus : null;
  check('研究成果', '右键标记「待审核」持久化到产物状态', pendingClicked === true && pendingBadge === true && pendingStatus === 'pending',
    JSON.stringify({ pendingClicked, pendingBadge, pendingStatus }));
  if (!(pendingClicked && pendingStatus === 'pending')) {
    issue('P1', '研究成果', '产物标记未持久化', JSON.stringify({ pendingClicked, pendingStatus }), '右键标记应通过 researchReview 写入 reviewStatus 并刷新列表。');
  }
  await screenshot('artifacts-center');

  // 研究备忘录改由持久化接口创建（恢复检查继续使用）。
  const noteSaved = await run(`window.metis.saveNote(${JSON.stringify({
    id: 'platform-note-1',
    scope: 'global',
    title: '平台模拟研究备忘录',
    content: '## 研究备忘\n\n记录资料批判、证据边界和下一步研究问题。',
    tags: [],
    linkedPaperIds: [],
    linkedNoteIds: [],
    updatedAt: Date.now(),
  })})`);
  check('研究写作', '研究备忘录可持久化', noteSaved?.success === true, JSON.stringify(noteSaved));

  await navigate('converse', '.chat-main, .shell-workspace--chat', '协同对话');
  const collabSurface = await run(`({
    page: Boolean(document.querySelector('[data-testid="collab-page"]')),
    host: Boolean(document.querySelector('[data-testid="collab-host"]')),
    tabs: [...document.querySelectorAll('.collab-external__tab')].map((el) => el.textContent.trim()),
    metisChat: Boolean(document.querySelector('.collab-metis__chat .chat-main')),
  })`);
  check('协同对话', '第三方 AI 分屏与 Metis 对话同屏', collabSurface.page === true
    && collabSurface.host === true
    && collabSurface.metisChat === true
    && ['豆包', 'Kimi', '智谱 GLM', 'ChatGPT', 'Claude', 'DeepSeek'].every((name) => collabSurface.tabs.includes(name)),
    JSON.stringify(collabSurface));
  if (!collabSurface.page || collabSurface.tabs.length < 6) {
    issue('P1', '协同对话', '协同对话分屏未完整渲染', JSON.stringify(collabSurface), '协同对话页必须同时提供第三方 AI 嵌入区与 Metis 对话区。');
  }
  const collabSplit = await run(`(async () => {
    const handle = document.querySelector('[data-testid="collab-split-handle"]');
    const external = document.querySelector('.collab-external');
    if (!handle || !external) return { found: false };
    const before = external.getBoundingClientRect().width;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: Math.round(before) }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: Math.round(before) - 160 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = external.getBoundingClientRect().width;
    return { found: true, before: Math.round(before), after: Math.round(after), changed: Math.abs(after - before) > 20 };
  })()`);
  check('协同对话', '分屏宽度可拖拽调节且持久化', collabSplit.found === true && collabSplit.changed === true, JSON.stringify(collabSplit));
  if (!collabSplit.changed) {
    issue('P1', '协同对话', '分屏宽度写死不可调', JSON.stringify(collabSplit), '所有左右分栏都应提供可拖拽分隔条并持久化用户偏好。');
  }
  const collabProject = await run(`({
    select: Boolean(document.querySelector('[data-testid="collab-project-select"]')),
    linkedValue: document.querySelector('[data-testid="collab-project-select"]')?.value ?? '',
    expected: ${JSON.stringify(projectId)},
    noProjectNotice: Boolean(document.querySelector('[data-testid="collab-no-project"]')),
  })`);
  check('协同对话', 'Metis 对话直接链接当前科研项目', collabProject.select === true
    && collabProject.linkedValue === collabProject.expected
    && collabProject.noProjectNotice === false,
    JSON.stringify(collabProject));
  if (collabProject.linkedValue !== collabProject.expected) {
    issue('P1', '协同对话', 'Metis 对话未链接到当前科研项目', JSON.stringify(collabProject), '协同对话右侧应与当前科研项目联动（项目切换器 + 会话归属）。');
  }
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
  // 显式任务命令仍零确认自动执行。先等上一轮直接回答完全结算（发送按钮恢复
  // 为「发送」），否则 isLoading 期间输入会被当成引导指令。
  await waitFor(`[...document.querySelectorAll('button')].some((element) => element.offsetParent !== null && element.textContent.trim() === '发送' && !element.disabled)`, 20_000, 200);
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

  await navigate('projects', '[data-testid="projects-page"]', '科研项目');
  const kanbanTab = await click('[data-testid="projects-mode-kanban"]');
  const boardReady = kanbanTab && await waitFor(`Boolean(document.querySelector('[data-testid="kanban-board"]'))`, 3000);
  check('任务看板', '科研项目内的任务看板可打开', boardReady === true);
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

  await navigate('projects', '[data-testid="projects-page"]', '科研项目');
  const materialsTab = await click('[data-testid="projects-mode-materials"]');
  const materialsReady = materialsTab && await waitFor(`Boolean(document.querySelector('[data-testid="library-page"]'))`, 3000);
  check('项目资料', '科研项目内的资料模式可打开', materialsReady === true);
  const librarySurface = await run(`(() => ({
    searchInput: Boolean(document.querySelector('[data-testid="library-search-input"]')),
    submit: Boolean(document.querySelector('[data-testid="library-search-submit"]')),
    ncpssd: Boolean(document.querySelector('[data-testid="library-source-ncpssd"]')),
    openalex: Boolean(document.querySelector('[data-testid="library-source-openalex"]')),
    coreOnly: Boolean(document.querySelector('[data-testid="library-core-only"]')),
    mineOrEmpty: Boolean(document.querySelector('[data-testid="library-papers-list"], [data-testid="library-empty"]')),
    toolbar: Boolean(document.querySelector('[data-testid="library-toolbar"]')),
  }))()`);
  check('项目资料', '资料模式内检索区与项目文献区完整', librarySurface.searchInput && librarySurface.submit && librarySurface.ncpssd && librarySurface.openalex && librarySurface.coreOnly && librarySurface.mineOrEmpty && librarySurface.toolbar, JSON.stringify(librarySurface));
  await screenshot('project-materials');

  // 方法库 / 订阅 / 投稿入口（T4/T20/T25 的界面可达性）。
  const methodsEntry = await click('[data-testid="library-methods-open"]');
  const methodsPanel = methodsEntry && await waitFor(`Boolean(document.querySelector('[data-testid="methods-panel"]'))`, 3000);
  const builtinCount = methodsPanel ? await run(`document.querySelectorAll('[data-testid="methods-item"]').length`) : 0;
  check('方法库', '方法库面板可打开且内置方法就位', methodsPanel === true && Number(builtinCount) >= 5, `builtinMethods=${builtinCount}`);
  await click('[data-testid="methods-close"]');
  const watchToggle = await click('[data-testid="library-watch-toggle"]');
  const watchPanel = watchToggle && await waitFor(`Boolean(document.querySelector('[data-testid="library-watch-panel"]'))`, 2000);
  check('文献订阅', '订阅面板可开合且输入框可用', watchPanel === true && Boolean(await run(`Boolean(document.querySelector('[data-testid="library-watch-input"]'))`)));
  await click('[data-testid="library-watch-toggle"]');
  await screenshot('project-materials-tools');

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

  // 场景重构：三栏工作台 + AI 创建（描述 + 真实材料文件上传）。
  const workbenchSurface = await run(`(() => ({
    workbench: Boolean(document.querySelector('[data-testid="scenario-workbench"]')),
    aiEntry: Boolean(document.querySelector('[data-testid="sw-ai-create"]')),
    newEntry: Boolean(document.querySelector('[data-testid="sw-new-scenario"]')),
    libraryViews: Array.from(document.querySelectorAll('[data-testid="sw-library-view"]')).map((el) => el.textContent.trim().slice(0, 24)).filter(Boolean),
  }))()`);
  check('场景', '三栏工作台就位（待创建场景后校验五分区与树）', workbenchSurface.workbench === true
    && workbenchSurface.aiEntry === true
    && workbenchSurface.newEntry === true
    && workbenchSurface.libraryViews.length >= 6,
    JSON.stringify(workbenchSurface));

  // 准备一份真实参考材料文件（写作方法书节选），通过材料导入 IPC 上传。
  const materialPath = path.join(profileDir, '模拟写作方法材料.md');
  fs.writeFileSync(materialPath, [
    '# 学术论文写作方法（模拟节选）',
    '',
    '## 结构规则',
    '- 正文三到五章，每章承担独立论证功能。',
    '- 引言交代研究问题与边界，结论不得引入新证据。',
    '',
    '## 写作原则',
    '- 摘要不得出现"本文"，只陈述论点与结论。',
    '- 每节开头给出本节论点，段首句承担论证功能。',
    '',
    '## 方法建议',
    '- 概念界定先于机制分析。',
    '',
    '## 硬性要求',
    '- 引用必须真实可查，不得编造文献。',
    '',
  ].join('\n'), 'utf8');
  const materialImport = await run(`window.metis.importScenarioMaterials({ files: [{ path: ${JSON.stringify(materialPath)}, name: '模拟写作方法材料.md' }] })`);
  const materialId = materialImport?.ok ? materialImport.materials?.[0]?.id : null;
  check('场景', '任意参考材料可导入（txt/md 真实读取）', materialImport?.ok === true && Boolean(materialId), JSON.stringify({ ok: materialImport?.ok, code: materialImport?.code, errors: materialImport?.errors ?? [] }));

  // AI 创建：描述 + 材料 → 分析摘要 → 生成场景。
  const aiOpen = await click('[data-testid="sw-ai-create"]');
  const dialogOpen = aiOpen && await waitFor(`Boolean(document.querySelector('[data-testid="scenario-ai-create"]'))`, 3000);
  const aiTyped = dialogOpen && await run(`(() => {
    const input = document.querySelector('[data-testid="scai-description"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '创建一个 CSSCI 纯理论论文场景：强调理论逻辑与经典文献，不做实证，允许 AI 调整主体章节数量。');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const aiAnalyzed = aiTyped && await click('[data-testid="scai-analyze"]');
  const summaryShown = aiAnalyzed && await waitFor(`Boolean(document.querySelector('[data-testid="scai-summary"]'))`, 60_000, 300);
  check('场景', 'AI 分析材料后给出场景理解摘要', summaryShown === true, String(summaryShown ?? ''));
  const summaryState = summaryShown ? await run(`(() => ({
    type: document.querySelector('[data-testid="scai-summary"]')?.textContent?.includes('纯理论论文') ?? false,
    sources: document.querySelector('[data-testid="scai-summary"]')?.textContent?.includes('模拟写作方法材料') ?? false,
  }))()`) : null;
  check('场景', '摘要包含成果类型与材料学习来源', summaryState?.type === true && summaryState?.sources === true, JSON.stringify(summaryState ?? {}));
  const aiGenerated = summaryShown && await click('[data-testid="scai-generate"]');
  const generatedShown = aiGenerated && await waitFor(`document.body.innerText.includes('CSSCI 纯理论论文场景')`, 30_000, 250);
  check('场景', 'AI 创建生成场景（描述 + 材料综合）', generatedShown === true, String(generatedShown ?? ''));
  if (!generatedShown) {
    issue('P1', '场景', 'AI 创建场景未完成', await run(`document.querySelector('[data-testid="scai-status"]')?.textContent ?? ''`), '检查 scenario:analyzeMaterials 与保存管线。');
  }

  // 生成结果落到真实仓库：场景 + 智能体 + 场景记忆 + 成果结构/自适应/参考材料。
  const aiDefinitions = await run(`window.metis.listPersonalization({ contractVersion: 1, includeDisabled: true })`);
  const aiScenario = aiDefinitions?.definitions?.find?.((d) => d.kind === 'scenario' && d.name === 'CSSCI 纯理论论文场景');
  const aiAgentCount = aiDefinitions?.definitions?.filter?.((d) => d.kind === 'agent' && d.provenance?.origin === 'user')?.length ?? 0;
  check('场景', 'AI 生成的智能体与场景已持久化', aiAgentCount >= 1 && Boolean(aiScenario) && (aiScenario?.agentIds?.length ?? 0) >= 1 && (aiScenario?.workflow?.length ?? 0) >= 2, JSON.stringify({ agents: aiAgentCount, workflowSteps: aiScenario?.workflow?.length ?? 0 }));
  const deliverableState = aiScenario ? {
    type: aiScenario.deliverable?.type,
    sections: aiScenario.deliverable?.sections?.length ?? 0,
    lockedSections: (aiScenario.deliverable?.sections ?? []).filter((sec) => sec.status === 'locked').length,
    conditionalSections: (aiScenario.deliverable?.sections ?? []).filter((sec) => sec.status === 'conditional').length,
    adaptive: Boolean(aiScenario.adaptivity),
    backtracks: aiScenario.adaptivity?.allowedBacktracks?.length ?? 0,
    writingRules: aiScenario.writingRules?.length ?? 0,
    methods: aiScenario.methodPolicy?.recommended?.length ?? 0,
    materials: aiScenario.materials?.length ?? 0,
    insights: aiScenario.materials?.[0]?.insights?.writingPrinciples?.length ?? 0,
  } : null;
  check('场景', '成果结构进入场景定义（锁定/条件部分 + 结构策略）', deliverableState?.type === 'theory_paper'
    && deliverableState.sections >= 6
    && deliverableState.lockedSections >= 2
    && deliverableState.conditionalSections >= 1, JSON.stringify(deliverableState));
  check('场景', '自适应边界与写作规范/方法策略落地', deliverableState?.adaptive === true
    && deliverableState.backtracks >= 1
    && deliverableState.writingRules >= 1
    && deliverableState.methods >= 1, JSON.stringify(deliverableState));
  check('场景', '参考材料及其学习洞察绑定场景', deliverableState?.materials === 1 && deliverableState.insights >= 1, JSON.stringify(deliverableState));
  const aiRules = aiDefinitions?.definitions?.find?.((d) => d.kind === 'rules' && d.scope === 'scenario' && d.scopeId === aiScenario?.id);
  check('场景', 'AI 生成场景记忆 Metis.md 并绑定到场景', Boolean(aiRules) && aiRules.markdown.includes('研究目标') && (aiScenario?.rulesIds ?? []).includes(aiRules?.id), JSON.stringify({ rulesId: aiRules?.id, rulesIds: aiScenario?.rulesIds ?? [] }));

  // 工作台展示生成场景：等待异步刷新 → 选中 → 五分区 → 结构树 → 右栏编辑 → 自适应开关。
  const scenarioItemReady = await waitFor(`(() => {
    const items = Array.from(document.querySelectorAll('[data-testid="sw-scenario-item"]'));
    const target = items.find((item) => item.textContent.includes('CSSCI 纯理论论文场景'));
    if (!target) return false;
    target.click();
    return true;
  })()`, 15_000, 250);
  check('场景', 'AI 生成场景出现在工作台并可选中', Boolean(scenarioItemReady));
  const tabsShown = scenarioItemReady && await waitFor(`JSON.stringify(Array.from(document.querySelectorAll('[data-testid^="sw-tab-"]')).map((el) => el.getAttribute('data-testid'))) === JSON.stringify(['sw-tab-overview', 'sw-tab-structure', 'sw-tab-rules', 'sw-tab-adapt', 'sw-tab-capability'])`, 5000, 200);
  check('场景', '选中后五个一级分区就位', Boolean(tabsShown));
  const structureShown = scenarioItemReady && await click('[data-testid="sw-tab-structure"]');
  const treeState = structureShown && await run(`(() => ({
    rows: document.querySelectorAll('[data-testid="sw-tree-row"]').length,
    lockedIcons: document.querySelectorAll('.sw-tree__row.status-locked').length,
    conditionalIcons: document.querySelectorAll('.sw-tree__row.status-conditional').length,
  }))()`);
  check('场景', '成果结构树直展（含锁定与条件标识）', (treeState?.rows ?? 0) >= 6 && (treeState?.lockedIcons ?? 0) >= 2 && (treeState?.conditionalIcons ?? 0) >= 1, JSON.stringify(treeState ?? {}));
  const sectionOpened = treeState && await run(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="sw-tree-row"]'));
    const target = rows.find((row) => row.textContent.includes('理论框架'));
    if (!target) return false;
    target.click(); return true;
  })()`);
  const contextEditor = sectionOpened && await waitFor(`Boolean(document.querySelector('[data-testid="sw-context-editor"]')?.textContent?.includes('理论框架'))`, 3000);
  check('场景', '点击章节 → 右栏上下文编辑器', contextEditor === true);
  const adaptShown = await click('[data-testid="sw-tab-adapt"]');
  const adaptState = adaptShown && await run(`(() => ({
    groups: document.querySelectorAll('.sw-adapt__group').length,
    checked: document.querySelectorAll('[data-testid^="sw-adapt-"]:checked').length,
    backtracks: document.querySelector('.sw-adapt__backtracks textarea')?.value ?? '',
    triggers: document.querySelector('.sw-adapt__triggers textarea')?.value ?? '',
  }))()`);
  check('场景', '自适应页展示 AI 自主边界（含回溯与触发条件）', (adaptState?.groups ?? 0) >= 3 && (adaptState?.checked ?? 0) >= 5 && adaptState.backtracks.includes('analysis->literature') && adaptState.triggers.length > 0, JSON.stringify(adaptState ?? {}));
  const rulesTabShown = await click('[data-testid="sw-tab-rules"]');
  const rulesState = (rulesTabShown && await run(`document.querySelector('[data-testid="sw-rules"]')?.textContent ?? ''`)) || '';
  check('场景', '规则与方法页含写作规范与方法策略', rulesTabShown === true && rulesState.includes('摘要禁止出现') && rulesState.includes('概念分析'), rulesState.slice(0, 80));
  const capabilityShown = await click('[data-testid="sw-tab-capability"]');
  const capabilityState = capabilityShown && await run(`(() => ({
    agents: document.querySelectorAll('[data-testid="sw-cap-agent"]:checked').length,
    workflowSteps: document.querySelectorAll('[data-testid="sw-workflow-step"]').length,
    advanced: Boolean(document.querySelector('[data-testid="sw-advanced"]')),
  }))()`);
  check('场景', '能力与运行页含绑定/工作流/高级设置', (capabilityState?.agents ?? 0) >= 1 && (capabilityState?.workflowSteps ?? 0) >= 2 && capabilityState.advanced === true, JSON.stringify(capabilityState ?? {}));
  // 参考材料区属于总览页：返回总览校验材料已随场景落库展示。
  await click('[data-testid="sw-tab-overview"]');
  const overviewMaterials = await waitFor(`Boolean(document.querySelector('[data-testid="sw-materials"]')?.textContent?.includes('模拟写作方法材料'))`, 3000);
  check('场景', '总览页展示参考材料及学习洞察', Boolean(overviewMaterials));
  await screenshot('scenario-workbench');
  await screenshot('personalization-center');

  // 模板识别：粘贴模板 → AI 解析为逐节写作指引 → 修改后保存为论文结构。
  await click('[data-testid="template-parse-toggle"]');
  const tplPanel = await waitFor(`Boolean(document.querySelector('[data-testid="template-parse-panel"]'))`, 3000);
  const tplTyped = tplPanel && await run(`(() => {
    const input = document.querySelector('[data-testid="template-parse-input"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '一、引言：交代研究背景与问题。二、研究现状：梳理已有成果。三、研究方法：说明资料与方法。四、结论：总结。');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const tplParsed = tplTyped && await click('[data-testid="template-parse-submit"]');
  const tplSections = tplParsed && await waitFor(`document.querySelectorAll('[data-testid="template-section"]').length >= 3`, 20_000, 250);
  check('场景', '模板识别把粘贴模板解析为逐节写作指引', tplParsed === true && Boolean(tplSections));
  if (!tplSections) {
    issue('P1', '场景', '模板识别未完成', await run(`document.querySelector('[data-testid="template-parse-status"]')?.textContent ?? ''`), '检查模板解析 IPC 与模型连接。');
  }
  const tplNameSet = tplSections && await run(`(() => {
    const input = document.querySelector('[data-testid="template-name-input"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '模拟国社科模板');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const tplSaved = tplNameSet && await click('[data-testid="template-save"]');
  const tplStructures = await run(`window.metis.structureList()`);
  const tplStructure = tplStructures?.ok ? tplStructures.templates?.find?.((t) => t.name === '模拟国社科模板') : null;
  check('场景', '解析后的论文结构可保存并供自主科研使用', tplSaved === true && Boolean(tplStructure) && (tplStructure?.sections?.length ?? 0) >= 3,
    JSON.stringify({ sections: tplStructure?.sections?.map((s) => s.title) }));
  await screenshot('template-recognition');

  // A11Y-003: 先保存一个论文结构模板，让 structure-select 有机会渲染。
  await run(`window.metis.structureSave(${JSON.stringify({
    id: 'structure-platform-1',
    name: '平台模拟论文结构',
    sections: [{ id: 'sec-1', title: '引言', instruction: '简要交代背景与问题。' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isDefault: false,
  })})`);
  await navigate('autonomous', '[data-testid="aw-start-input"]', '自主科研');
  // 重构 R3：顶部精简启动条 + 四项全局指标（进行中/自主决策/今日证据/新发现）。
  const launchSurface = await run(`({
    input: Boolean(document.querySelector('[data-testid="aw-start-input"]')),
    count: Boolean(document.querySelector('[data-testid="aw-start-count"]')),
    mode: Boolean(document.querySelector('[data-testid="aw-start-mode"]')),
    method: Boolean(document.querySelector('[data-testid="aw-start-method"]')),
    output: Boolean(document.querySelector('[data-testid="aw-start-output"]')),
    start: Boolean(document.querySelector('[data-testid="aw-start-button"]')),
    metrics: document.querySelectorAll('[data-testid="aw-metrics"] .aw-metric').length,
    countLabel: Boolean(document.querySelector('[data-testid="aw-start-count"]')?.getAttribute('aria-label')),
  })`);
  check('自主科研', '工作台提供精简启动条与四项全局指标', launchSurface.input === true
    && launchSurface.count === true
    && launchSurface.mode === true
    && launchSurface.method === true
    && launchSurface.output === true
    && launchSurface.start === true
    && launchSurface.metrics === 4
    && launchSurface.countLabel === true,
    JSON.stringify(launchSurface));
  if (!launchSurface.input || launchSurface.metrics !== 4) {
    issue('P1', '自主科研', '空闲态未展示启动条与指标', JSON.stringify(launchSurface), '自主科研空闲态必须回答「现在能做什么」：顶部启动条 + 进行中研究/自主决策/今日证据/新发现四项指标。');
  }
  // 策略编辑器收进旧控制台页（aw-open-console），可访问性检查移至此页执行。
  const consoleOpened = await click('[data-testid="aw-open-console"]');
  const consoleReady = await waitFor(`Boolean(document.querySelector('[data-testid="strategy-select"]'))`, 3000);
  check('自主科研', '旧控制台可经工作台打开并保留策略配置', consoleOpened === true && consoleReady === true);
  const strategySelectLabel = await run(`Boolean(document.querySelector('label[for="strategy-select"]')) && Boolean(document.querySelector('#strategy-select'))`);
  // structures 列表异步加载，结构选择控件在其就绪后才渲染：等待其出现。
  const structureReady = await waitFor(`Boolean(document.querySelector('label[for="structure-select"]')) && Boolean(document.querySelector('#structure-select'))`, 8000, 250);
  check('自主科研', '策略与论文结构选择控件有程序化标签', strategySelectLabel === true && Boolean(structureReady), JSON.stringify({ strategy: strategySelectLabel, structure: Boolean(structureReady) }));
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
  // 重构 R3：三栏工作区细节走查（真实自主项目 + 真实成果数据）。
  // 控制台运行挂在当前活动项目（用户来源）上；此处直接发起一次独立自主运行，
  // 由 ensureAutonomousResearchProject 新建 autonomous_research 来源项目。
  await run(`(() => { window.__platformAuto = { completed: null, failed: null }; return true; })()`);
  await run(`window.metis.autonomousStart({ goal: '地方救济制度演变的证据边界（工作区走查）' })`);
  const wsRunTerminal = await waitFor(`(() => {
    const state = window.__platformAuto;
    return state?.completed || state?.failed ? state : null;
  })()`, 120_000, 500);
  check('工作区', '独立自主运行完成（工作区走查数据源）', Boolean(wsRunTerminal?.completed), JSON.stringify(wsRunTerminal?.completed?.artifactIds ?? []).slice(0, 80));
  await navigate('autonomous', '[data-testid="aw-start-input"]', '自主科研');
  const wsOverview = await run(`window.metis.getAutoWorkspaceOverview([])`);
  const wsProjects = wsOverview?.projects ?? [];
  check('工作区', '工作台 overview 列出真实自主项目', wsProjects.length > 0, `projects=${wsProjects.length}`);
  if (wsProjects.length > 0) {
    const firstId = wsProjects[0].id;
    const wsDetail = await run(`window.metis.getAutoWorkspaceDetail(` + JSON.stringify(firstId) + `)`);
    check('工作区', 'detail IPC 返回真实研究内容', Boolean(wsDetail), JSON.stringify(wsDetail ? {
      question: wsDetail.question?.text?.slice(0, 20),
      version: wsDetail.question?.version,
      judgments: wsDetail.coreJudgments?.length,
      findings: wsDetail.newFindings?.length,
      artifacts: wsDetail.artifacts?.length,
      decisions: wsDetail.decisions?.length,
    } : null));
    await run(`document.querySelector('[data-testid="aw-proj-item"]')?.click()`);
    await sleep(1500);
    const wsUi = await run(`(() => ({
      question: Boolean(document.querySelector('[data-testid="aw-question"]')),
      version: document.querySelector('[data-testid="aw-question"] .aw-version')?.textContent ?? '',
      history: Boolean(document.querySelector('[data-testid="aw-question-history"]')),
      judgment: Boolean(document.querySelector('[data-testid="aw-judgment"]')),
      findings: Boolean(document.querySelector('[data-testid="aw-findings"]')),
      uncertainty: Boolean(document.querySelector('[data-testid="aw-uncertainty"]')),
      artifactCards: document.querySelectorAll('[data-testid="aw-artifact"]').length,
      stats: Boolean(document.querySelector('[data-testid="aw-stats"]')),
      rail: Boolean(document.querySelector('[data-testid="ai-live-rail"]')),
      sticky: getComputedStyle(document.querySelector('.aw-rail') ?? document.body).position === 'sticky',
      subnav: document.querySelectorAll('[data-testid^="aw-subnav-"]').length,
      audit: Boolean(document.querySelector('[data-testid="aw-audit"]')),
    }))()`);
    check('工作区', '三栏布局与左栏项目+六分区导航', wsUi.rail && wsUi.subnav === 6 && wsUi.audit, JSON.stringify({ rail: wsUi.rail, subnav: wsUi.subnav, audit: wsUi.audit }));
    check('工作区', '研究问题直展带版本徽章与历史', wsUi.question && wsUi.version.startsWith('v') && wsUi.history, `version=${wsUi.version}`);
    check('工作区', '核心判断/新发现/不确定性/成果/统计全部直展', wsUi.judgment && wsUi.findings && wsUi.uncertainty && wsUi.artifactCards > 0 && wsUi.stats,
      JSON.stringify({ judgments: wsUi.judgment, findings: wsUi.findings, uncertainty: wsUi.uncertainty, artifacts: wsUi.artifactCards, stats: wsUi.stats }));
    check('工作区', '右 AI LIVE rail 滚动保持可见', wsUi.rail && wsUi.sticky);
    await run(`document.querySelector('[data-testid="aw-subnav-trail"]')?.click()`);
    await sleep(700);
    const trailUi = await run(`Boolean(document.querySelector('[data-testid="aw-trail"]'))`);
    check('工作区', '研究轨迹分区直展真实动态', trailUi);
    await run(`document.querySelector('[data-testid="aw-subnav-overview"]')?.click()`);
    await sleep(500);
    const noApproval = await run(`(() => {
      const text = document.querySelector('[data-testid="aw-page"]')?.textContent ?? '';
      return ['等待用户确认', '待你决策', '等待你审批', '需要你批准', '等待审批'].filter((n) => text.includes(n));
    })()`);
    check('工作区', '三栏工作区无任何审批/决策等待节点', noApproval.length === 0, noApproval.join(','));
    await screenshot('workspace-detail');
  }


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
