/**
 * Submission plan domain IPC registrar — 从 main.ts 迁出（2026-09-15 解耦）。
 * 投稿计划 create/latest/approve/apply/verify 5 个 handler。
 * 依赖经 DomainIpcContext 注入（快照语义与原模块级 let 一致）。
 */

import { OutcomeAssistantService } from '../OutcomeAssistantService.js';
import { OutcomeProjectContextService } from '../OutcomeProjectContextService.js';
import { SubmissionGapService } from '../SubmissionGapService.js';
import { SubmissionOptimizationService } from '../SubmissionOptimizationService.js';
import { z } from 'zod';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSubmissionPlanIpc(ctx: DomainIpcContext): () => void {
  const dom = ctx.registry.domain('submission-plan', ['submission:']);

  const submissionRepository = ctx.submissionRepository();
  const journalProfileRepository = ctx.journalProfileRepository();
  const outcomeRepository = ctx.outcomeRepository();
  const artifactPromptService = ctx.artifactPromptService();
  const officePromptProfileService = ctx.officePromptProfileService();

  dom.handle('submission:plan:create', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1), gapItemIds: z.array(z.string().min(1)).max(100).optional() }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository }),
      }).createPlanFromGaps(p.data);
    } catch { return null; }
  });

  dom.handle('submission:plan:latest', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository) return null;
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return null;
      const plan = journalProfileRepository.latestPlanForCase(p.data.caseId);
      if (!plan) return null;
      return { plan, items: journalProfileRepository.listPlanItems(plan.id) };
    } catch { return null; }
  });

  dom.handle('submission:plan:approve', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), planId: z.string().min(1), selectedItemIds: z.array(z.string().min(1)).max(200).optional() }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      // 越权防护：方案所属 case 必须属于当前项目。
      const plan = journalProfileRepository.getPlan(p.data.planId);
      if (!plan || !submissionRepository.getCase(p.data.projectId, plan.caseId)) {
        return { ok: false as const, code: 'plan_not_found' as const };
      }
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository }),
      }).approvePlan(p.data);
    } catch { return null; }
  });

  dom.handle('submission:plan:apply', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), planId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      // 自动修改依赖成果助手（LLM）；provider 未配置时结构化拒绝，不产生半执行状态。
      const runtime = ctx.resolveProjectOutcomeProvider(p.data.projectId);
      if (runtime.status !== 'ready') return { ok: false as const, code: 'provider_not_configured' as const };
      const assistant = new OutcomeAssistantService({
        repository: outcomeRepository,
        agentLoop: runtime.agentLoop,
        modelName: runtime.binding.model,
        providerProfileBinding: runtime.binding,
        projectContext: new OutcomeProjectContextService(outcomeRepository, { read: ctx.readOutcomeProjectMetis }),
        resolveBehaviorPrompt: (promptId, outcomeId) => officePromptProfileService?.resolveForBasePrompt(promptId, outcomeId ?? null) ?? artifactPromptService?.resolve(promptId) ?? null,
        getGlobalPrompt: (officeKind, outcomeId) => officePromptProfileService?.resolveGlobal(officeKind, outcomeId ?? null) ?? null,
      });
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository, agentLoop: runtime.agentLoop }),
        assistant,
      }).applyPlan(p.data);
    } catch { return null; }
  });

  dom.handle('submission:plan:verify', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), planId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      const plan = journalProfileRepository.getPlan(p.data.planId);
      if (!plan || !submissionRepository.getCase(p.data.projectId, plan.caseId)) {
        return { ok: false as const, code: 'plan_not_found' as const };
      }
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository }),
      }).verifyPlan(p.data);
    } catch { return null; }
  });

  return () => dom.dispose();
}
