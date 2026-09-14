/**
 * Submission review/mail/correspondence domain IPC registrar —
 * 从 main.ts 迁出（2026-09-15 解耦第四批）。
 * 返修轮 5 + 邮件 4 + 通信记录 5 + 截止日同步 1，共 15 个 handler。
 * 各服务经 DomainIpcContext 注入。
 */

import { ReviewCommentPatchSchema } from '../../engine/submission/SubmissionReviewContract.js';
import { z } from 'zod';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSubmissionCommsIpc(ctx: DomainIpcContext): () => void {
  const dom = ctx.registry.domain('submission-comms', ['submission:']);
  const submissionReviewService = ctx.submissionReviewService();
  const submissionReviewRepository = ctx.submissionReviewRepository();
  const mailSendService = ctx.mailSendService();
  const submissionMailService = ctx.submissionMailService();
  const submissionMailboxStore = ctx.submissionMailboxStore();
  const submissionCorrespondenceRepository = ctx.submissionCorrespondenceRepository();
  const submissionDeadlineSync = ctx.submissionDeadlineSync();
  const submissionRepository = ctx.submissionRepository();


  dom.handle('submission:review:createRound', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1), caseId: z.string().min(1),
        decisionLetterText: z.string().min(1).max(200_000),
        deadline: z.number().int().nonnegative().nullable().optional(),
      }).safeParse(raw);
      if (!p.success || !submissionReviewService) return null;
      return submissionReviewService.createRoundFromLetter(p.data);
    } catch { return null; }
  });
  dom.handle('submission:review:list', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionReviewService || !submissionRepository) return [];
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return [];
      return submissionReviewService.listRounds(p.data.projectId, p.data.caseId);
    } catch { return []; }
  });
  dom.handle('submission:review:updateComment', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), commentId: z.string().min(1), patch: ReviewCommentPatchSchema }).safeParse(raw);
      if (!p.success || !submissionReviewRepository) return null;
      return submissionReviewRepository.updateComment(p.data.projectId, p.data.commentId, p.data.patch) ?? null;
    } catch { return null; }
  });
  dom.handle('submission:review:beginRevision', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionReviewService) return { ok: false as const, code: 'unavailable' };
      return await submissionReviewService.beginRevision(p.data);
    } catch { return null; }
  });
  dom.handle('submission:review:generateResponse', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionReviewService) return null;
      return await submissionReviewService.generateResponseLetter(p.data);
    } catch { return null; }
  });
  dom.handle('submission:mail:accounts', (event) => {
    try {
      ctx.requireRendererMainFrame(event);
      return (submissionMailboxStore?.list() ?? []).map((account) => ({
        id: account.id, label: account.label, user: account.user, host: account.host,
        createdAt: account.createdAt, lastCheckedAt: account.lastCheckedAt, lastOkAt: account.lastOkAt,
      }));
    } catch { return []; }
  });
  dom.handle('submission:mail:preview', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({
        accountId: z.string().min(1),
        to: z.string().max(4000), cc: z.string().max(4000).optional(), bcc: z.string().max(4000).optional(),
        subject: z.string().max(4000), bodyText: z.string().max(200_000),
        attachments: z.array(z.strictObject({ filename: z.string().min(1).max(500), path: z.string().max(4000).optional(), contentBase64: z.string().max(40_000_000).optional() })).max(20).optional(),
      }).safeParse(raw);
      if (!p.success || !mailSendService) return null;
      return mailSendService.previewSend({
        accountId: p.data.accountId, to: p.data.to, cc: p.data.cc, bcc: p.data.bcc,
        subject: p.data.subject, bodyText: p.data.bodyText,
        attachments: (p.data.attachments ?? []).map((a) => ({
          filename: a.filename,
          ...(a.path ? { path: a.path } : {}),
          ...(a.contentBase64 ? { content: Buffer.from(a.contentBase64, 'base64') } : {}),
        })),
      });
    } catch { return null; }
  });
  dom.handle('submission:mail:send', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1), caseId: z.string().min(1).optional(),
        accountId: z.string().min(1), operationId: z.string().min(1).max(200),
        to: z.string().max(4000), cc: z.string().max(4000).optional(), bcc: z.string().max(4000).optional(),
        subject: z.string().max(4000), bodyText: z.string().max(200_000),
        attachments: z.array(z.strictObject({ filename: z.string().min(1).max(500), path: z.string().max(4000).optional(), contentBase64: z.string().max(40_000_000).optional() })).max(20).optional(),
        confirmed: z.literal(true),
      }).safeParse(raw);
      if (!p.success || !mailSendService) return null;
      return await mailSendService.sendMail({
        projectId: p.data.projectId, caseId: p.data.caseId, accountId: p.data.accountId,
        operationId: p.data.operationId, to: p.data.to, cc: p.data.cc, bcc: p.data.bcc,
        subject: p.data.subject, bodyText: p.data.bodyText,
        attachments: (p.data.attachments ?? []).map((a) => ({
          filename: a.filename,
          ...(a.path ? { path: a.path } : {}),
          ...(a.contentBase64 ? { content: Buffer.from(a.contentBase64, 'base64') } : {}),
        })),
      });
    } catch { return null; }
  });
  dom.handle('submission:mail:sync', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), accountId: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return await submissionMailService.syncAccount(p.data);
    } catch { return null; }
  });
  dom.handle('submission:correspondence:listByCase', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionCorrespondenceRepository) return [];
      return submissionCorrespondenceRepository.listByCase(p.data.projectId, p.data.caseId);
    } catch { return []; }
  });
  dom.handle('submission:correspondence:listPending', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionCorrespondenceRepository) return [];
      return submissionCorrespondenceRepository.listPending(p.data.projectId);
    } catch { return []; }
  });
  dom.handle('submission:correspondence:confirmMatch', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), id: z.string().min(1), caseId: z.string().min(1).optional() }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return submissionMailService.confirmMatch(p.data);
    } catch { return null; }
  });
  dom.handle('submission:correspondence:rejectMatch', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), id: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return submissionMailService.rejectMatch(p.data);
    } catch { return null; }
  });
  dom.handle('submission:correspondence:createRound', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), id: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return submissionMailService.createRoundFromCorrespondence(p.data);
    } catch { return null; }
  });
  dom.handle('submission:review:syncDeadline', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), caseId: z.string().min(1), roundId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionDeadlineSync) return { ok: false as const, code: 'service_unavailable' };
      return submissionDeadlineSync.syncRoundToGoal(p.data);
    } catch { return { ok: false as const, code: 'service_unavailable' }; }
  });

  return () => dom.dispose();
}
