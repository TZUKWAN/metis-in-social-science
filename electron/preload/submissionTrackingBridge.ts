/**
 * Submission tracking bridge — 投稿跟踪 (T20) + 文献监视订阅
 * （从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 * 注意：submissionBridge.ts 覆盖投稿案件工作流；本文件是旧内联 T20 段。
 */
import { ipcRenderer } from 'electron';

export const submissionTrackingBridge = {
  // ── Submission tracking (T20) ──
  listSubmissions: async (projectId?: string) => ipcRenderer.invoke('submissions:list', projectId ?? null) as Promise<Array<{
    id: string;
    projectId: string | null;
    artifactId: string | null;
    title: string;
    journal: string;
    status: 'submitted' | 'under_review' | 'revise' | 'accepted' | 'published' | 'rejected';
    submittedAt: number;
    updatedAt: number;
    comments: Array<{ id: string; text: string; resolved: boolean; revisionNote: string; createdAt: number }>;
    notes: string;
  }>>,

  previewSubmissionMail: async (request: {
    accountId: string; to: string; cc?: string; bcc?: string; subject: string; bodyText: string;
    attachments?: Array<{ filename: string; path?: string; contentBase64?: string }>;
  }) =>
    ipcRenderer.invoke('submission:mail:preview', request) as Promise<{ ok: true; preview: {
      accountId: string; accountLabel: string; from: string; to: string; cc: string; bcc: string;
      subject: string; bodyText: string;
      attachments: Array<{ filename: string; source: 'content' | 'path' | 'empty' }>;
      smtp: { host: string; port: number; secure: boolean } | null;
    } } | { ok: false; code: string; message: string } | null>,
  sendSubmissionMail: async (request: {
    projectId: string; caseId?: string; accountId: string; operationId: string;
    to: string; cc?: string; bcc?: string; subject: string; bodyText: string;
    attachments?: Array<{ filename: string; path?: string; contentBase64?: string }>;
    confirmed: true;
  }) =>
    ipcRenderer.invoke('submission:mail:send', request) as Promise<{ ok: true; alreadySent: boolean; record: import('../../engine/submission/SubmissionCorrespondenceContract.js').SubmissionCorrespondence; messageId?: string } | { ok: false; code: string; message: string } | null>,

  onSubmissionMailChanged: (callback: (notification: { at: number; items: Array<{ projectId: string; records: Array<{ id: string; subject: string; classification: string; caseId: string | null }> }> }) => void) => {
    const listener = (_event: unknown, notification: Parameters<typeof callback>[0]) => callback(notification);
    ipcRenderer.on('submission:mail:changed', listener);
    return () => { ipcRenderer.removeListener('submission:mail:changed', listener); };
  },

  listWatchSubscriptions: async () => ipcRenderer.invoke('watch:list') as Promise<Array<{
    id: string;
    query: string;
    sources: Array<'ncpssd' | 'openalex'>;
    coreOnly: boolean;
    createdAt: number;
    lastCheckedAt: number | null;
    lastNewCount: number;
  }>>,
  addWatchSubscription: async (request: { query: string; sources?: Array<'ncpssd' | 'openalex'>; coreOnly?: boolean }) =>
    ipcRenderer.invoke('watch:add', request) as Promise<{ id: string } | null>,
  removeWatchSubscription: async (id: string) => ipcRenderer.invoke('watch:remove', id) as Promise<boolean>,
  checkWatchNow: async (id: string) => ipcRenderer.invoke('watch:checkNow', id) as Promise<{ ok: boolean; newCount: number; error?: string }>,
};
