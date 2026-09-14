/**
 * Jobs bridge — 后台任务队列 (T10) + PDF 批量导入 (T26)（从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';

export const jobsBridge = {
  // ── Background job queue (T10): long tasks like PDF full-text extraction ──
  listJobs: async () => ipcRenderer.invoke('jobs:list') as Promise<Array<{
    id: string;
    kind: string;
    label: string;
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    progress: number;
    progressNote: string;
    error: string | null;
    finishedAt: number | null;
  }>>,
  cancelJob: async (jobId: string) => ipcRenderer.invoke('jobs:cancel', jobId) as Promise<{ ok: boolean }>,
  retryJob: async (jobId: string) => ipcRenderer.invoke('jobs:retry', jobId) as Promise<{ ok: boolean }>,
  extractBacklog: async () => ipcRenderer.invoke('jobs:extractBacklog') as Promise<{ ok: boolean; jobId: string | null }>,
  onJobsChanged: (callback: (jobs: Array<{ id: string; kind: string; label: string; status: string; progress: number; progressNote: string; error: string | null; finishedAt: number | null }>) => void): (() => void) => {
    const handler = (_event: unknown, jobs: Parameters<typeof callback>[0]) => callback(jobs);
    ipcRenderer.on('jobs:changed', handler as never);
    return () => { ipcRenderer.removeListener('jobs:changed', handler as never); };
  },
  // ── PDF bulk import (T26) ──
  importPdfFiles: async (files: string[]) => ipcRenderer.invoke('import:pdfFiles', files) as Promise<{ ok: boolean; imported: number; enriched: number; error?: string }>,
  openPdfDialog: async () => ipcRenderer.invoke('dialog:openPdf') as Promise<string[]>,
};
