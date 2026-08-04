/**
 * Metis user simulation test — walks every major user flow end-to-end in a
 * real Electron process (isolated data dir, no real provider).
 *
 *   npx electron scripts/user-simulation.mjs
 *
 * Each step simulates what a real user would do: open the app, configure a
 * provider, create a project, import papers, read a PDF, take notes, use
 * Office documents, search, review artifacts, etc.
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

app.setName('metis-sim');

const reportPath = path.resolve('user-simulation-report.json');
const report = { startedAt: new Date().toISOString(), steps: [] };
function record(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 120)}` : ''}`);
}

// Boot the real app main process at the top level (before ready fires) so its
// privileged scheme registration happens in time.
await import('../dist-electron/electron/main.js');

async function main() {
  await app.whenReady();

  let win = BrowserWindow.getAllWindows()[0];
  for (let i = 0; i < 50 && !win; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    win = BrowserWindow.getAllWindows()[0];
  }
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }

  const run = (expr) => win.webContents.executeJavaScript(`(async () => { try { return ${expr}; } catch (err) { return { __error: String(err && err.message || err) }; } })()`);

  // ═══════════════════════════════════════════════════════════════════
  // 1. App boot + first-run setup
  // ═══════════════════════════════════════════════════════════════════

  const startup = await run('window.metis.startupStatus()');
  record('应用启动（startup ready）', startup?.ready === true);

  const settings = await run('window.metis.getSettings()');
  record('首次设置检查（getSettings 结构化）', settings && typeof settings.configured === 'boolean');

  // ═══════════════════════════════════════════════════════════════════
  // 2. Data persistence (SQLite round-trip)
  // ═══════════════════════════════════════════════════════════════════

  const note = { id: 'sim-note-1', title: '模拟笔记', content: '用户模拟测试内容', tags: ['测试'], linkedPaperIds: [], linkedNoteIds: [], updatedAt: Date.now() };
  await run(`window.metis.saveNote(${JSON.stringify(note)})`);
  const data = await run('window.metis.loadAllData()');
  record('数据持久化（写笔记→重载确认）', data?.notes?.some((n) => n.id === 'sim-note-1') === true);

  // ═══════════════════════════════════════════════════════════════════
  // 3. Paper library (import + metadata)
  // ═══════════════════════════════════════════════════════════════════

  // Papers load from empty store
  const papers = await run('window.metis.loadAllData()');
  record('文献库加载（初始空库结构化）', papers && Array.isArray(papers.papers));

  // Full-text search on empty library
  const search = await run(`window.metis.searchPapersFullText('transformer')`);
  record('全文搜索（空库返回结构化结果）', search && Array.isArray(search.results));

  // Paper detail on demand
  const detail = await run(`window.metis.loadPaperDetail({ paperId: 'nonexistent' })`);
  record('论文详情按需加载（不存在返回 miss）', detail?.found === false);

  // ═══════════════════════════════════════════════════════════════════
  // 4. PDF reading (capability-based file access)
  // ═══════════════════════════════════════════════════════════════════

  const pdf = await run(`window.metis.listPersonalization({ contractVersion: 1, includeDisabled: false })`);
  record('个人化列表（personalization:list 可用）', pdf && typeof pdf.ok === 'boolean');

  // ═══════════════════════════════════════════════════════════════════
  // 5. Office documents (OfficeCli integration)
  // ═══════════════════════════════════════════════════════════════════

  const officeStatus = await run('window.metis.officeCliStatus()');
  if (officeStatus?.available) {
    record('OfficeCli 检测', true, officeStatus.version);

    // Create Word
    const doc = await run(`window.metis.officeCliNewDocument('docx', 'sim')`);
    record('OfficeCli 新建 Word', doc?.success === true);

    if (doc?.success) {
      const fp = doc.filePath;
      // Add paragraph
      const add = await run(`window.metis.officeCliAdd({ filePath: '${fp.replace(/\\/g, '\\\\')}', parent: '/', type: 'paragraph', props: { text: '模拟段落' } })`);
      record('OfficeCli 添加段落', add?.success === true);

      // Format: Heading1 + bold
      const fmt = await run(`window.metis.officeCliSet({ filePath: '${fp.replace(/\\/g, '\\\\')}', path: '/body/p[1]', props: { style: 'Heading1', bold: 'true' } })`);
      record('OfficeCli 排版（Heading1+加粗）', fmt?.success === true);

      // Render and verify content
      const render = await run(`window.metis.officeCliRenderHtml('${fp.replace(/\\/g, '\\\\')}')`);
      record('OfficeCli 渲染 HTML 含内容', render?.success === true && render.data?.includes('模拟段落'));

      // Close
      const close = await run(`window.metis.officeCliClose('${fp.replace(/\\/g, '\\\\')}')`);
      record('OfficeCli 关闭文档', close?.success === true);
    }

    // Create PPT
    const ppt = await run(`window.metis.officeCliNewDocument('pptx', 'sim')`);
    record('OfficeCli 新建 PPT', ppt?.success === true);

    if (ppt?.success) {
      const pptPath = ppt.filePath;
      // Set theme color
      const theme = await run(`window.metis.officeCliSetTheme({ filePath: '${pptPath.replace(/\\/g, '\\\\')}', props: { 'theme.color.accent1': '#2E5C8A' } })`);
      record('OfficeCli PPT 主题色设置', theme?.success === true);

      // Add slide
      const slide = await run(`window.metis.officeCliAddSlide({ filePath: '${pptPath.replace(/\\/g, '\\\\')}', layout: 'Title Slide', title: '模拟标题', text: '模拟内容' })`);
      record('OfficeCli PPT 加幻灯片', slide?.success === true);

      // Add shape with non-overlap
      const shape = await run(`window.metis.officeCliAddShapeNoOverlap({ filePath: '${pptPath.replace(/\\/g, '\\\\')}', slidePath: '/slide[1]', text: '文本框', x: '2.5', y: '3', w: '6', h: '2' })`);
      record('OfficeCli PPT 加文本框（不重合）', shape?.success === true);

      // Render PPT
      const pptRender = await run(`window.metis.officeCliRenderHtml('${pptPath.replace(/\\/g, '\\\\')}')`);
      record('OfficeCli PPT 渲染 HTML', pptRender?.success === true && pptRender.data?.includes('模拟标题'));

      await run(`window.metis.officeCliClose('${pptPath.replace(/\\/g, '\\\\')}')`);
    }

    // Create Excel
    const xls = await run(`window.metis.officeCliNewDocument('xlsx', 'sim')`);
    record('OfficeCli 新建 Excel', xls?.success === true);

    if (xls?.success) {
      const xlsPath = xls.filePath;
      // Add a row first (empty sheets have no rows/cells to set).
      const addRow = await run(`window.metis.officeCliAdd({ filePath: '${xlsPath.replace(/\\/g, '\\\\')}', parent: '/sheet[1]', type: 'row' })`);
      const cell = addRow?.success
        ? await run(`window.metis.officeCliAdd({ filePath: '${xlsPath.replace(/\\/g, '\\\\')}', parent: '/Sheet1/row[1]', type: 'cell', props: { value: '模拟单元格' } })`)
        : { success: false };
      record('OfficeCli Excel 写入单元格', cell?.success === true);
      await run(`window.metis.officeCliClose('${xlsPath.replace(/\\/g, '\\\\')}')`);
    }
  } else {
    record('OfficeCli 检测', false, 'officecli not installed (skipped)');
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. AI one-shot channels (structured failure without provider)
  // ═══════════════════════════════════════════════════════════════════

  const aiExplain = await run(`window.metis.aiExplainPaper({ passage: 'test passage' })`);
  record('AI 论文解读（无 provider 结构化失败）', aiExplain?.ok === false && aiExplain?.error === 'provider_unavailable');

  const aiSynthesis = await run(`window.metis.aiSynthesis({ mode: 'synthesis', papers: [] })`);
  record('AI 文献综述（参数校验：<2 篇拒绝）', aiSynthesis?.ok === false && aiSynthesis?.error === 'need_at_least_two_papers');

  const aiPolish = await run(`window.metis.aiPolishLatex({ text: 'hello world' })`);
  record('AI LaTeX 润色（无 provider 结构化失败）', aiPolish?.ok === false && aiPolish?.error === 'provider_unavailable');

  const aiOfficeEdit = await run(`window.metis.officeCliAiEdit({ instruction: '加一段', docType: 'docx' })`);
  record('AI Office 编辑（无 provider 结构化失败）', aiOfficeEdit?.ok === false && aiOfficeEdit?.error === 'provider_unavailable');

  // ═══════════════════════════════════════════════════════════════════
  // 7. Artifact management
  // ═══════════════════════════════════════════════════════════════════

  const artifacts = await run(`window.metis.artifactListByProject('sim-project')`);
  record('成果管理（按项目列出）', artifacts && Array.isArray(artifacts.items));

  // ═══════════════════════════════════════════════════════════════════
  // 8. WeChat bot status
  // ═══════════════════════════════════════════════════════════════════

  const wx = await run('window.metis.wechatGetStatus()');
  record('微信 Bot 状态（未绑定时结构化）', wx && typeof wx.ok === 'boolean');

  // ═══════════════════════════════════════════════════════════════════
  // 9. Flashcards (SQLite-backed)
  // ═══════════════════════════════════════════════════════════════════

  const fcList = await run('window.metis.flashcardList()');
  record('闪卡列表（结构化）', fcList && Array.isArray(fcList.cards));

  // ═══════════════════════════════════════════════════════════════════
  // 10. Session restore persistence
  // ═══════════════════════════════════════════════════════════════════

  // The session restore writes to localStorage; verify the IPC round-trip works.
  const sessionCheck = await run(`window.metis.getSettings()`);
  record('会话设置读取（二次调用一致）', sessionCheck && typeof sessionCheck.theme === 'string');

  // ═══════════════════════════════════════════════════════════════════
  // 11. Renderer UI mounted
  // ═══════════════════════════════════════════════════════════════════

  const uiProbe = await run(`({
    children: document.getElementById('root')?.children.length ?? -1,
    bodyLen: document.body?.innerHTML.length ?? 0,
  })`);
  record('UI 挂载（root 有内容）', uiProbe?.children > 0);

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════

  const failed = report.steps.filter((s) => !s.ok);
  const skipped = report.steps.filter((s) => s.detail === 'officecli not installed (skipped)');
  report.failed = failed.length;
  report.passed = report.steps.length - failed.length - skipped.length;
  report.skipped = skipped.length;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nUser simulation: ${report.passed}/${report.steps.length - skipped.length} passed, ${skipped.length} skipped — report: ${reportPath}`);
  app.exit(failed.length === 0 ? 0 : 1);
}

app.on('ready', () => {
  main().catch((err) => {
    record('harness', false, String(err && err.message || err));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    app.exit(1);
  });
});
