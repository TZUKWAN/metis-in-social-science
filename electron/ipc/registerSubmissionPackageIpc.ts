/**
 * Submission package/preflight domain IPC registrar — 从 main.ts 迁出
 * （2026-09-15 解耦第三批）：预检 2 + 材料包 8 + 正式提交 1。
 * 服务经 DomainIpcContext 注入。
 */

import { z } from 'zod';
import { SUBMISSION_PACKAGE_FILE_TYPES } from '../../engine/submission/SubmissionPackageContract.js';
import path from 'node:path';
import fs from 'node:fs';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSubmissionPackageIpc(ctx: DomainIpcContext): () => void {

  const submissionRepository = ctx.submissionRepository();
  const submissionOwnedPackage = ctx.submissionOwnedPackage;
  const submissionPreflightService = ctx.submissionPreflightService();
  const submissionPackageService = ctx.submissionPackageService();
  const submissionPackageRepository = ctx.submissionPackageRepository();

  const dom = ctx.registry.domain('submission-package', ['submission:']);

  dom.handle('submission:preflight:run', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPreflightService) return null;
      return await submissionPreflightService.run(p.data);
    } catch { return null; }
  });
  dom.handle('submission:preflight:latest', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageRepository || !submissionRepository) return null;
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return null;
      const run = submissionPackageRepository.latestPreflightRun(p.data.caseId);
      if (!run) return null;
      return { run, checks: submissionPackageRepository.listPreflightChecks(run.id) };
    } catch { return null; }
  });
  dom.handle('submission:package:assemble', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.assemble(p.data);
    } catch { return null; }
  });
  dom.handle('submission:package:latest', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageRepository || !submissionRepository) return null;
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return null;
      const pkg = submissionPackageRepository.latestPackageForCase(p.data.caseId);
      if (!pkg) return null;
      return { package: pkg, files: submissionPackageRepository.listPackageFiles(pkg.id) };
    } catch { return null; }
  });
  dom.handle('submission:package:attachOutcome', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1),
        packageId: z.string().min(1),
        outcomeId: z.string().min(1),
        type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
        required: z.boolean().optional(),
        note: z.string().max(20000).optional(),
      }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.attachOutcome(p.data);
    } catch { return null; }
  });
  dom.handle('submission:package:attachFile', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1),
        packageId: z.string().min(1),
        type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
        filePath: z.string().min(1).max(2000),
        required: z.boolean().optional(),
      }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      // filePath 必须是已存在常规文件的绝对路径；拒绝目录与相对路径（选择对话框由 UI 复用现有通道）。
      const filePath = p.data.filePath;
      if (!path.isAbsolute(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { ok: false as const, code: 'file_not_found' as const };
      }
      return await submissionPackageService.attachFile(p.data);
    } catch { return null; }
  });
  dom.handle('submission:package:removeFile', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1), fileId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageRepository) return false;
      // 项目归属校验：package 所属 case 必须属于该项目；frozen 由仓储层硬边界拒绝。
      if (!submissionOwnedPackage(p.data.projectId, p.data.packageId)) return false;
      return submissionPackageRepository.removePackageFile(p.data.packageId, p.data.fileId);
    } catch { return false; }
  });
  dom.handle('submission:package:export', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.exportToDisk(p.data);
    } catch { return null; }
  });
  dom.handle('submission:package:freeze', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      // preflight 门控（最近一次预检必须 passed）在服务内执行并返回真实 blockers。
      return await submissionPackageService.freeze(p.data);
    } catch { return null; }
  });
  dom.handle('submission:package:validate', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.validate(p.data);
    } catch { return null; }
  });
  dom.handle('submission:submit', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1),
        caseId: z.string().min(1),
        submissionMethod: z.enum(['portal_web', 'email', 'offline_manual']),
        portalUrl: z.string().max(2000).optional(),
        remoteSubmissionId: z.string().max(300).optional(),
        notes: z.string().max(5000).optional(),
        confirmed: z.literal(true),
      }).safeParse(raw);
      if (!p.success || !submissionRepository || !submissionPackageRepository) {
        return p.success && !p.data.confirmed ? { ok: false as const, code: 'approval_required' as const } : null;
      }
      const { projectId, caseId } = p.data;
      const submissionCase = submissionRepository.getCase(projectId, caseId);
      if (!submissionCase) return { ok: false as const, code: 'case_not_found' as const };
      // 预检门控：最近一次预检必须存在且无必须处理项。
      const run = submissionPackageRepository.latestPreflightRun(caseId);
      if (!run || !run.passed) return { ok: false as const, code: 'preflight_not_passed' as const };
      // 材料包门控：必须已冻结（正式提交前冻结 Package）。
      const pkg = submissionPackageRepository.latestPackageForCase(caseId);
      if (!pkg || pkg.status !== 'frozen') return { ok: false as const, code: 'package_not_frozen' as const };
      // 回执信息：remoteSubmissionId 是外部副作用的幂等凭证（人工从投稿系统回填）。
      submissionRepository.updateCase(projectId, {
        caseId,
        submissionMethod: p.data.submissionMethod,
        ...(p.data.portalUrl !== undefined ? { submissionPortalUrl: p.data.portalUrl } : {}),
        ...(p.data.remoteSubmissionId !== undefined ? { remoteSubmissionId: p.data.remoteSubmissionId } : {}),
        ...(p.data.notes !== undefined ? { notes: p.data.notes } : {}),
      }, 'human');
      // 状态链：READY_TO_SUBMIT → SUBMITTING → SUBMITTED；READY_TO_RESUBMIT → RESUBMITTED。
      const before = submissionRepository.getCase(projectId, caseId)!;
      if (before.status === 'READY_TO_SUBMIT') {
        if (!submissionRepository.changeStatus(projectId, { caseId, to: 'SUBMITTING', reason: '进入提交流程（人工确认）', source: 'human', actor: 'human' })) {
          return { ok: false as const, code: 'illegal_transition' as const };
        }
        if (!submissionRepository.changeStatus(projectId, { caseId, to: 'SUBMITTED', reason: `投稿回执：${p.data.remoteSubmissionId ?? '（无编号）'}`, source: 'human', actor: 'human' })) {
          return { ok: false as const, code: 'illegal_transition' as const };
        }
      } else if (before.status === 'READY_TO_RESUBMIT') {
        if (!submissionRepository.changeStatus(projectId, { caseId, to: 'RESUBMITTED', reason: '重新提交（人工确认）', source: 'human', actor: 'human' })) {
          return { ok: false as const, code: 'illegal_transition' as const };
        }
      } else if (before.status !== 'SUBMITTING' && before.status !== 'SUBMISSION_STATE_UNCERTAIN') {
        return { ok: false as const, code: 'illegal_status' as const };
      }
      const current = submissionRepository.getCase(projectId, caseId)!;
      submissionRepository.addEvent(projectId, {
        caseId, type: 'submission_receipt', source: 'human', actor: 'human',
        description: `投稿确认完成：${current.targetJournalName} · ${p.data.submissionMethod === 'email' ? '邮件投稿' : '网页投稿'}${p.data.remoteSubmissionId ? ` · 编号 ${p.data.remoteSubmissionId}` : ''}`,
        metadata: { method: p.data.submissionMethod, portalUrl: p.data.portalUrl ?? '', remoteSubmissionId: p.data.remoteSubmissionId ?? '', packageId: pkg.id },
      });
      return { ok: true as const, submissionCase: current };
    } catch { return null; }
  });

  return () => dom.dispose();
}
