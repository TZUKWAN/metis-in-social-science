/**
 * Research browser domain IPC registrar — 从 main.ts 迁出（2026-09-14 拆分）。
 *
 * 嵌入式 WebContentsView 研究浏览器的 20 个 browser:* handler：显示/导航/
 * 交互（点击/键入/滚动）/采集/下载管理。服务经 DomainIpcContext 注入；
 * 与协同对话视图互斥（同一时间只显示一个嵌入视图）的语义保持不变。
 */
import { parseBrowserBounds } from './sharedGuards.js';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerBrowserIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, browserService, ensureBrowserService, collabService, researchRepository, jobQueueService } = ctx;
  const dom = ctx.registry.domain('browser', ['browser:']);

  const deny = (err: unknown) => ({ ok: false, error: String((err as Error).message ?? err) });

  // ── 显示 / 导航 ──────────────────────────────────────────
  dom.handle('browser:show', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds) return { ok: false, error: 'browser_invalid_bounds' };
      // 与协同对话视图互斥：同一时间只显示一个嵌入视图。
      collabService()?.hide();
      service.show(bounds);
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:hide', (event) => {
    try {
      requireRendererMainFrame(event);
      browserService()?.hide();
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:setBounds', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds || !browserService()) return { ok: false, error: 'browser_invalid_bounds' };
      browserService()!.setBounds(bounds);
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:navigate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      // 任务2 上下文隔离：渲染端可显式声明该次导航归属的项目（对象参数）；
      // 旧字符串参数与未声明归属的导航都记为「归属未知」（null）。
      if (typeof raw === 'object' && raw !== null) {
        const payload = raw as { url?: unknown; projectId?: unknown };
        const url = typeof payload.url === 'string' ? payload.url : '';
        const projectId = typeof payload.projectId === 'string' && payload.projectId.trim() ? payload.projectId.trim() : null;
        service.setActiveOwnership(projectId);
        return await service.navigate(url);
      }
      service.setActiveOwnership(null);
      const url = typeof raw === 'string' ? raw : '';
      return await service.navigate(url);
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:back', (event) => { try { requireRendererMainFrame(event); browserService()?.goBack(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  dom.handle('browser:forward', (event) => { try { requireRendererMainFrame(event); browserService()?.goForward(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  dom.handle('browser:reload', (event) => { try { requireRendererMainFrame(event); browserService()?.reload(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  dom.handle('browser:stop', (event) => { try { requireRendererMainFrame(event); browserService()?.stop(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });

  dom.handle('browser:focusRenderer', (event) => {
    try {
      requireRendererMainFrame(event);
      event.sender.focus();
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  // ── 状态 / 交互 / 采集 ────────────────────────────────────
  dom.handle('browser:state', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      return service ? { ok: true, state: service.getState() } : { ok: false, error: 'browser_unavailable' };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:click', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const { x, y } = (raw as { x?: number; y?: number }) ?? {};
      if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, error: 'browser_invalid_point' };
      service.click(x, y);
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:type', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const text = typeof raw === 'string' ? raw.slice(0, 4000) : '';
      if (!text) return { ok: false, error: 'browser_invalid_text' };
      service.type(text);
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:key', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const keyCode = typeof raw === 'string' ? raw : '';
      if (!keyCode) return { ok: false, error: 'browser_invalid_key' };
      service.key(keyCode);
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:scroll', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const { deltaX, deltaY } = (raw as { deltaX?: number; deltaY?: number }) ?? {};
      service.scroll(Number(deltaX) || 0, Number(deltaY) || 0);
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:screenshot', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.screenshot();
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:extract', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.extract();
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:collect', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.collect();
    } catch (err) {
      return deny(err);
    }
  });

  // ── 下载管理 ──────────────────────────────────────────────
  dom.handle('browser:listDownloads', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return { ok: true, downloads: service.listPendingDownloads() };
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:acceptDownload', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const request = (raw as { id?: string; projectId?: string | null }) ?? {};
      if (!request.id) return { ok: false, error: 'download_not_found' };
      // 项目自定义目录优先（批2）：PDF 归档到 projectDir/pdfs。
      let projectDir: string | null = null;
      try {
        const repository = researchRepository();
        if (request.projectId && repository) {
          const project = repository.getProject(request.projectId, false);
          projectDir = (project?.metadata as { projectDir?: string } | undefined)?.projectDir ?? null;
        }
      } catch { /* 目录读取失败回退默认 */ }
      const outcome = await service.acceptDownload({ id: request.id, projectId: request.projectId ?? null, projectDir });
      // PDF 归档成功后自动入队全文抽取（T2：AI 可读全文的入口）。
      if (outcome.ok && outcome.paperId && outcome.savedPath) {
        jobQueueService()?.enqueueExtract(outcome.paperId, outcome.savedPath);
      }
      return outcome;
    } catch (err) {
      return deny(err);
    }
  });

  dom.handle('browser:cancelDownload', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = typeof raw === 'string' ? raw : '';
      if (!id || !browserService()) return { ok: false, error: 'download_not_found' };
      browserService()!.cancelDownload(id);
      return { ok: true };
    } catch (err) {
      return deny(err);
    }
  });

  return () => dom.dispose();
}
