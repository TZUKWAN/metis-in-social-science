/**
 * Submission portal domain IPC registrar — 从 main.ts 迁出（2026-09-15 解耦第五批）。
 * 投稿门户自动化 5 个 handler，纯 service 转发。
 */

import { PortalFieldActionSchema } from '../../engine/submission/SubmissionPortalContract.js';
import { z } from 'zod';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSubmissionPortalIpc(ctx: DomainIpcContext): () => void {
  const dom = ctx.registry.domain('submission-portal', ['submission:']);

  dom.handle('submission:portal:open', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), caseId: z.string().min(1), portalUrl: z.string().max(2000).optional() }).safeParse(raw);
      if (!p.success || !ctx.submissionPortalService()) return null;
      return await ctx.submissionPortalService()!.openPortal(p.data);
    } catch { return null; }
  });
  dom.handle('submission:portal:planFill', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !ctx.submissionPortalService()) return null;
      return await ctx.submissionPortalService()!.planFill(p.data);
    } catch { return null; }
  });
  dom.handle('submission:portal:execute', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1), caseId: z.string().min(1),
        actions: z.array(PortalFieldActionSchema).max(50),
        confirmed: z.boolean().optional(),
      }).safeParse(raw);
      if (!p.success || !ctx.submissionPortalService()) return null;
      return await ctx.submissionPortalService()!.executeAutoSteps(p.data);
    } catch { return null; }
  });
  dom.handle('submission:portal:confirmSubmitted', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1), caseId: z.string().min(1),
        remoteSubmissionId: z.string().max(300).optional(), receiptNote: z.string().max(5000).optional(),
      }).safeParse(raw);
      if (!p.success || !ctx.submissionPortalService()) return null;
      return ctx.submissionPortalService()!.confirmSubmitted(p.data);
    } catch { return null; }
  });
  dom.handle('submission:portal:markUncertain', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), caseId: z.string().min(1), reason: z.string().min(1).max(2000) }).safeParse(raw);
      if (!p.success || !ctx.submissionPortalService()) return null;
      return ctx.submissionPortalService()!.markUncertain(p.data);
    } catch { return null; }
  });

  return () => dom.dispose();
}
