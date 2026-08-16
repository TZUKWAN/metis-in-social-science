/**
 * Autonomous workspace CDP smoke — drives the freshly packaged win-unpacked
 * app over the real metis-app:// entry with the REAL user profile, verifies
 * the R0–R3 3-column autonomous workspace against real system state:
 *   - top-bar launcher + 4 global metrics (values must match IPC)
 *   - left rail: projects (real), 6-section subnav
 *   - center: question + version badge, core judgments, new findings,
 *     uncertainties, artifacts rendered as content previews, stats row
 *   - right AI LIVE rail (sticky) with decisions + timeline
 *   - audit fold present, NO approval nodes, no console errors
 * Saves screenshots as evidence.
 *
 * Usage: node scripts/autonomous-workspace-cdp-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = process.argv[2] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXE = path.join(PROJECT_ROOT, 'release', 'win-unpacked', 'Metis Research Workbench.exe');
const OUT_DIR = path.join(PROJECT_ROOT, 'test-results', 'autonomous-workspace-smoke');
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
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
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

    // 0. Navigate to the autonomous workspace via top bar
    await cdp.evaluate(`document.querySelector('.topbar-nav__item[data-nav-id="autonomous"]')?.click()`);
    await sleep(2500);
    const pageOpen = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="aw-page"]'))`);
    record('自主科研导航打开 3 栏工作台页', pageOpen);

    // 1. Top-bar launcher + metrics (values must equal IPC)
    const launcher = await cdp.evaluate(`(() => ({
      input: Boolean(document.querySelector('[data-testid="aw-start-input"]')),
      count: Boolean(document.querySelector('[data-testid="aw-start-count"]')),
      start: Boolean(document.querySelector('[data-testid="aw-start-button"]')),
      consoleBtn: Boolean(document.querySelector('[data-testid="aw-open-console"]')),
      metricsCount: document.querySelectorAll('[data-testid="aw-metrics"] .aw-metric').length,
      metricValues: Array.from(document.querySelectorAll('[data-testid="aw-metrics"] .aw-metric__value')).map((el) => Number(el.textContent)),
    }))()`);
    record('顶部精简启动条（方向/数量/开始/旧控制台）齐全', launcher.input && launcher.count && launcher.start && launcher.consoleBtn);
    record('四项全局指标渲染', launcher.metricsCount === 4, JSON.stringify(launcher.metricValues));

    const overview = await cdp.evaluate(`window.metis.getAutoWorkspaceOverview([])`);
    const ipcOk = overview && Array.isArray(overview.projects) && overview.metrics;
    record('overview IPC 返回真实项目与指标结构', Boolean(ipcOk), JSON.stringify(ipcOk ? { projects: overview.projects.length, metrics: overview.metrics } : overview));
    if (ipcOk) {
      const expected = [overview.metrics.running, overview.metrics.decisions24h, overview.metrics.evidenceToday, overview.metrics.newFindings7d];
      const domMatchesIpc = launcher.metricValues.every((value, index) => value === expected[index]);
      record('四个指标数值与真实 overview IPC 一致', domMatchesIpc, JSON.stringify({ dom: launcher.metricValues, ipc: expected }));
    }

    // 2. Left rail: projects + subnav
    const leftRail = await cdp.evaluate(`(() => ({
      side: Boolean(document.querySelector('[data-testid="aw-side"]')),
      projectButtons: document.querySelectorAll('[data-testid="aw-proj-item"]').length,
      subnav: Array.from(document.querySelectorAll('[data-testid^="aw-subnav-"]')).map((el) => el.getAttribute('data-testid')),
    }))()`);
    record('左栏项目列表存在', leftRail.side, 'projects=' + leftRail.projectButtons);
    const subnavOk = JSON.stringify(leftRail.subnav) === JSON.stringify(['aw-subnav-overview', 'aw-subnav-findings', 'aw-subnav-theory', 'aw-subnav-evidence', 'aw-subnav-data', 'aw-subnav-trail']);
    const subnavHiddenOk = (overview?.projects ?? []).length === 0 && leftRail.subnav.length === 0;
    record('左栏六分区内部导航（选中项目后显示）', subnavOk || subnavHiddenOk, JSON.stringify(leftRail.subnav));

    // 3. Center: real detail data with a real project
    const projectIds = (overview?.projects ?? []).map((p) => p.id);
    if (projectIds.length > 0) {
      const firstProjectId = projectIds[0];
      await cdp.evaluate(`document.querySelector('[data-testid="aw-proj-item"]')?.click()`);
      await sleep(2000);
      const detail = await cdp.evaluate(`window.metis.getAutoWorkspaceDetail(` + JSON.stringify(firstProjectId) + `)`);
      record('detail IPC 返回真实项目详情', Boolean(detail), JSON.stringify(detail ? { question: detail.question?.text?.slice(0, 24), version: detail.question?.version, judgments: detail.coreJudgments?.length, artifacts: detail.artifacts?.length } : detail));
      if (detail) {
        const center = await cdp.evaluate(`(() => ({
          questionBlock: Boolean(document.querySelector('[data-testid="aw-question"]')),
          versionBadge: document.querySelector('[data-testid="aw-question"] .aw-version')?.textContent ?? null,
          historyToggle: Boolean(document.querySelector('[data-testid="aw-question"] [data-testid="aw-question-history"]')),
          judgmentSection: Boolean(document.querySelector('[data-testid="aw-judgment"]')),
          judgments: document.querySelectorAll('.aw-judgment').length,
          findingsSection: Boolean(document.querySelector('[data-testid="aw-findings"]')),
          findings: document.querySelectorAll('.aw-finding').length,
          uncertaintiesSection: Boolean(document.querySelector('[data-testid="aw-uncertainty"]')),
          uncertainties: document.querySelectorAll('.aw-uncertainty').length,
          artifactCards: document.querySelectorAll('[data-testid="aw-artifact"]').length,
          stats: Boolean(document.querySelector('[data-testid="aw-stats"]')),
        }))()`);
        record('研究问题直展（版本徽章 + 历史入口）', center.questionBlock && center.versionBadge !== null && center.historyToggle, 'version=' + center.versionBadge);
        record('核心判断按置信度直展', center.judgmentSection && (center.judgments > 0 || (detail.coreJudgments ?? []).length === 0), 'judgments=' + center.judgments);
        record('新发现直展', center.findingsSection, 'findings=' + center.findings);
        record('当前不确定性直展', center.uncertaintiesSection, 'uncertainties=' + center.uncertainties);
        record('成果内容直展（非文件卡片）', center.artifactCards > 0 || (detail.artifacts ?? []).length === 0, 'cards=' + center.artifactCards + ' artifacts=' + (detail.artifacts ?? []).length);
        record('统计行存在', center.stats);

        if ((detail.artifacts ?? []).length > 0) {
          const previewText = await cdp.evaluate(`(() => {
            const card = document.querySelector('[data-testid="aw-artifact"]');
            return card?.textContent?.slice(0, 200) ?? '';
          })()`);
          record('成果携带真实内容预览', previewText.length > 0, previewText.slice(0, 60));
        }

        // 4. Right AI LIVE rail
        const rail = await cdp.evaluate(`(() => {
          const aside = document.querySelector('[data-testid="ai-live-rail"]');
          const inner = aside?.querySelector('.aw-rail');
          const style = inner ? getComputedStyle(inner) : null;
          return {
            exists: Boolean(aside),
            sticky: style?.position === 'sticky',
            decisionsTitle: Boolean(document.querySelector('[data-testid="ai-live-decisions"]')),
            timelineTitle: Boolean(document.querySelector('[data-testid="ai-live-timeline"]')),
            decisionItems: document.querySelectorAll('[data-testid="ai-live-decisions"] li').length,
            timelineItems: document.querySelectorAll('[data-testid="ai-live-timeline"] li').length,
          };
        })()`);
        record('右 AI LIVE rail 存在且滚动保持可见(sticky)', rail.exists && rail.sticky);
        record('AI LIVE 含自主决策（只读）与研究动态', rail.decisionsTitle && rail.timelineTitle, 'decisions=' + rail.decisionItems + ' timeline=' + rail.timelineItems);

        // 5. Subnav trail + audit fold + no approval nodes
        await cdp.evaluate(`document.querySelector('[data-testid="aw-subnav-trail"]')?.click()`);
        await sleep(800);
        const trailShown = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="aw-trail"]'))`);
        record('研究轨迹分区可打开', trailShown);
        const audit = await cdp.evaluate(`(() => {
          const details = document.querySelector('[data-testid="aw-audit"]');
          return Boolean(details) && details.tagName === 'DETAILS';
        })()`);
        record('审计轨迹降级为底部折叠区', audit);
        await cdp.evaluate(`document.querySelector('[data-testid="aw-subnav-overview"]')?.click()`);
        await sleep(600);
        const forbidden = await cdp.evaluate(`(() => {
          const text = document.querySelector('[data-testid="aw-page"]')?.textContent ?? '';
          const needles = ['等待用户确认', '待你决策', '等待你审批', '需要你批准', '等待审批'];
          return needles.filter((n) => text.includes(n));
        })()`);
        record('无任何用户审批/决策等待节点', forbidden.length === 0, forbidden.join(','));
        await cdp.screenshot('workspace-detail.png');
        report.screenshots.push('workspace-detail.png');
      }
    } else {
      record('无自主项目时空态渲染（真实空状态）', await cdp.evaluate(`Boolean(document.querySelector('[data-testid="aw-page"] .aw-block__empty'))`));
      await cdp.screenshot('workspace-empty.png');
      report.screenshots.push('workspace-empty.png');
    }

    // 6. Viewport sanity (no horizontal overflow at 1440)
    const overflow = await cdp.evaluate(`(() => ({
      w: document.documentElement.scrollWidth,
      c: document.documentElement.clientWidth,
    }))()`);
    record('1440px 无整页横向滚动', overflow.w <= overflow.c + 1, 'scroll=' + overflow.w + ' client=' + overflow.c);
    await cdp.screenshot('workspace-overview.png');
    report.screenshots.push('workspace-overview.png');

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
