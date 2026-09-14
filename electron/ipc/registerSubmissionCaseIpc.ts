/**
 * Submission case domain IPC registrar — 从 main.ts 迁出（2026-09-15 解耦）。
 * 第一批：纯 SubmissionRepository 的案件 CRUD / 事件 / 短名单管理（13 个）。
 * 依赖 AI/邮件/门户/材料包服务的 47 个 handler 后续按 service 分批迁出。
 */

import {
  SubmissionCaseCreateRequestSchema,
  SubmissionCaseUpdateRequestSchema,
  SubmissionStatusChangeRequestSchema,
  SUBMISSION_STATUSES,
} from '../../engine/submission/SubmissionRuntimeContract.js';

const SUBMISSION_STATUS_SET: ReadonlySet<string> = new Set<string>(SUBMISSION_STATUSES);
type SubmissionStatusName = (typeof SUBMISSION_STATUSES)[number];
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSubmissionCaseIpc(ctx: DomainIpcContext): () => void {
  const dom = ctx.registry.domain('submission-case', ['submission:']);

  // 单 handler 同步执行内的两次访问竞态可忽略：快照与原 main.ts 模块级变量语义一致。
  const submissionRepositoryAccessor = ctx.submissionRepository;

  dom.handle('submission:listSeries', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p = z.string().min(1).safeParse(raw); return p.success && submissionRepositoryAccessor() ? submissionRepositoryAccessor()!.listSeries(p.data) : []; } catch { return []; } });
  dom.handle('submission:listCases', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), status: z.string().optional(), query: z.string().max(200).optional(), includeClosed: z.boolean().optional() }).safeParse(raw);
      if (!p.success || !submissionRepositoryAccessor()) return [];
      const status = SUBMISSION_STATUS_SET.has(p.data.status ?? '') ? (p.data.status as SubmissionStatusName) : undefined;
      return submissionRepositoryAccessor()!.listCases(p.data.projectId, { status, query: p.data.query, includeClosed: p.data.includeClosed });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('submission_duplicate_active')) throw error;
      return [];
    }
  });
  dom.handle('submission:getCase', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepositoryAccessor() ? submissionRepositoryAccessor()!.getCase(p.data.projectId, p.data.caseId) ?? null : null; } catch { return null; } });
  dom.handle('submission:createCase', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = SubmissionCaseCreateRequestSchema.safeParse(raw);
      if (!p.success || !submissionRepositoryAccessor()) {
        console.error('[submission:createCase] rejected:', p.success ? 'repository_unavailable' : JSON.stringify(p.error.issues));
        return null;
      }
      return submissionRepositoryAccessor()!.createCase(p.data);
    } catch (error) {
      // 一稿多投风险：结构化返回，不静默吞掉。
      if (error instanceof Error && error.message.startsWith('submission_duplicate_active')) {
        const [, caseId, journal] = error.message.split(':');
        return { ok: false as const, code: 'duplicate_active' as const, activeCaseId: caseId ?? '', activeJournal: journal ?? '' };
      }
      console.error('[submission:createCase] failed:', error instanceof Error ? error.stack : error);
      return null;
    }
  });
  dom.handle('submission:updateCase', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), patch: SubmissionCaseUpdateRequestSchema }).safeParse(raw); if (!p.success || !submissionRepositoryAccessor()) return null; return submissionRepositoryAccessor()!.updateCase(p.data.projectId, p.data.patch) ?? null; } catch { return null; } });
  dom.handle('submission:changeStatus', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), change: SubmissionStatusChangeRequestSchema }).safeParse(raw);
      if (!p.success || !submissionRepositoryAccessor()) return null;
      // 最终提交是外部副作用，必须走 submission:submit（Human Approval 门控 + 回执），
      // 不允许经通用状态通道直接推到已提交/已重投。
      if (p.data.change.to === 'SUBMITTED' || p.data.change.to === 'RESUBMITTED') {
        return { ok: false as const, code: 'use_submit_flow' as const, message: '正式提交/重投必须通过「确认投稿」流程完成（需人工确认与投稿回执）。' };
      }
      return submissionRepositoryAccessor()!.changeStatus(p.data.projectId, p.data.change) ?? null;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Illegal submission status transition')) {
        return { ok: false as const, code: 'illegal_transition' as const, message: error.message };
      }
      return null;
    }
  });
  dom.handle('submission:listEvents', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepositoryAccessor() ? submissionRepositoryAccessor()!.listEvents(p.data.projectId, p.data.caseId) : []; } catch { return []; } });
  dom.handle('submission:addEvent', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1), type: z.string().min(1).max(60), source: z.enum(['human', 'system', 'browser', 'email', 'agent']).default('human'), sourceId: z.string().max(300).nullable().optional(), actor: z.string().max(120).optional(), description: z.string().max(2000).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).safeParse(raw);
      if (!p.success || !submissionRepositoryAccessor()) return null;
      return submissionRepositoryAccessor()!.addEvent(p.data.projectId, { caseId: p.data.caseId, type: p.data.type, source: p.data.source, sourceId: p.data.sourceId ?? null, actor: p.data.actor, description: p.data.description, metadata: p.data.metadata }) ?? null;
    } catch { return null; }
  });
  dom.handle('submission:archiveCase', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepositoryAccessor() ? submissionRepositoryAccessor()!.archiveCase(p.data.projectId, p.data.caseId) : false; } catch { return false; } });
  dom.handle('submission:checkActive', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), sourceOutcomeId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepositoryAccessor() ? submissionRepositoryAccessor()!.findActiveCase(p.data.projectId, p.data.sourceOutcomeId) ?? null : null; } catch { return null; } });

  dom.handle('submission:shortlist:list', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const parsed = z.object({ projectId: z.string().min(1) }).safeParse(rawRequest);
      if (!parsed.success || !ctx.store()) return [];
      return ctx.store()!.raw.prepare('SELECT id, name, source, url, note, created_at FROM submission_shortlists WHERE project_id = ? ORDER BY created_at DESC')
        .all(parsed.data.projectId) as Array<{ id: string; name: string; source: string; url: string; note: string; created_at: number }>;
    } catch { return []; }
  });
  dom.handle('submission:shortlist:add', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const parsed = z.object({
        projectId: z.string().min(1),
        name: z.string().min(1).max(300),
        source: z.string().max(120).optional(),
        url: z.string().max(2000).optional(),
        note: z.string().max(2000).optional(),
      }).safeParse(rawRequest);
      if (!parsed.success || !ctx.store()) return { ok: false };
      const existing = ctx.store()!.raw.prepare('SELECT id FROM submission_shortlists WHERE project_id = ? AND name = ?')
        .get(parsed.data.projectId, parsed.data.name);
      if (existing) return { ok: true };
      ctx.store()!.raw.prepare('INSERT INTO submission_shortlists (id, project_id, name, source, url, note, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(`sl-${randomUUID()}`, parsed.data.projectId, parsed.data.name, parsed.data.source ?? '', parsed.data.url ?? '', parsed.data.note ?? '', Date.now());
      return { ok: true };
    } catch { return { ok: false }; }
  });
  dom.handle('submission:shortlist:remove', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const parsed = z.object({ projectId: z.string().min(1), name: z.string().min(1) }).safeParse(rawRequest);
      if (!parsed.success || !ctx.store()) return { ok: false };
      const info = ctx.store()!.raw.prepare('DELETE FROM submission_shortlists WHERE project_id = ? AND name = ?')
        .run(parsed.data.projectId, parsed.data.name);
      return { ok: info.changes > 0 };
    } catch { return { ok: false }; }
  });

  return () => dom.dispose();
}
