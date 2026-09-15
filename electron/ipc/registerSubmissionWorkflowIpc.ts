/**
 * Submission workflow edge domain IPC registrar — 从 main.ts 迁出
 * （2026-09-15 解耦第六批）：差距更新 / 求职信生成 / 投稿助手对话。
 *
 * 依赖（SubmissionRepository / CoverLetterService / JournalProfileRepository /
 * OutcomeRepository / AgentLoop / Provider / 浏览器服务）经 DomainIpcContext
 * 注入；每次 invoke 都通过 accessor 拿当前实例（provider 重启后自动恢复）。
 */
import { z } from 'zod';
import { CoverLetterService } from '../CoverLetterService.js';
import { SUBMISSION_GAP_STATUSES } from '../../engine/submission/JournalProfileContract.js';
import { SubmissionAssistantService } from '../SubmissionAssistantService.js';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSubmissionWorkflowIpc(ctx: DomainIpcContext): () => void {
  const dom = ctx.registry.domain('submission-workflow', ['submission:']);

  dom.handle('submission:gap:update', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1),
        caseId: z.string().min(1),
        itemId: z.string().min(1),
        // patch 只放行 status 字段（UI 侧用于确认/忽略/重开差距项）。
        patch: z.strictObject({ status: z.enum(SUBMISSION_GAP_STATUSES) }),
      }).safeParse(raw);
      if (!p.success || !ctx.journalProfileRepository() || !ctx.submissionRepository()) return null;
      if (!ctx.submissionRepository()!.getCase(p.data.projectId, p.data.caseId)) return null;
      return ctx.journalProfileRepository()!.updateGapItem(p.data.caseId, p.data.itemId, { status: p.data.patch.status }) ?? null;
    } catch { return null; }
  });

  dom.handle('submission:coverLetter:generate', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !ctx.submissionCoverLetterService() || !ctx.submissionRepository() || !ctx.journalProfileRepository() || !ctx.outcomeRepository()) return null;
      // provider 就绪时按当前项目运行时解析 agentLoop 走 LLM 成稿（照 P1 fetchGuidelines 写法）；
      // 未配置时用无 agentLoop 的基础实例，服务内如实降级为模板骨架（extraction: 'template'）。
      const runtime = ctx.resolveProjectOutcomeProvider(p.data.projectId);
      const fallback = ctx.submissionCoverLetterService();
      const service = runtime.status === 'ready'
        ? new CoverLetterService({
            submissionRepository: ctx.submissionRepository()!,
            journalRepository: ctx.journalProfileRepository()!,
            outcomeRepository: ctx.outcomeRepository()!,
            ...(ctx.submissionPackageRepository() ? { packageRepository: ctx.submissionPackageRepository()! } : {}),
            agentLoop: runtime.agentLoop,
            providerProfileBinding: runtime.binding,
          })
        : fallback;
      if (!service) return { ok: false as const, answer: '', error: '求职信服务未初始化。' };
      return await service.generate(p.data);
    } catch { return null; }
  });

  dom.handle('submission:assistant:chat', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      if (!ctx.agentLoop()) return { ok: false as const, answer: '', error: '模型连接尚未配置或尚未就绪。请先在「设置 → 模型连接」完成配置，再使用投稿参谋。' };
      if (!ctx.outcomeRepository()) return { ok: false as const, answer: '', error: '成果服务尚未就绪，请稍后重试。' };
      const parsedInput = z.object({
        projectId: z.string().min(1),
        outcomeId: z.string().min(1),
        instruction: z.string().min(1).max(20_000),
        thinkingLevel: z.string().optional(),
        intent: z.record(z.string(), z.unknown()).optional(),
        shortlist: z.array(z.object({ name: z.string(), source: z.string().optional() })).max(24).optional(),
        // 任务6(2026-09-05):参谋对话记忆——前端回传最近对话,避免每轮失忆。
        history: z.array(z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(20_000),
        })).max(16).optional(),
      }).safeParse(raw);
      if (!parsedInput.success) return { ok: false as const, answer: '', error: '请求无效。' };
      const service = new SubmissionAssistantService({
        agentLoop: ctx.agentLoop(),
        browser: {
          navigate: async (url) => {
            const service = ctx.ensureBrowserService();
            if (!service) return { ok: false, error: 'browser_unavailable' };
            return service.navigate(url);
          },
          extract: async () => {
            const service = ctx.ensureBrowserService();
            if (!service) return { ok: false, error: 'browser_unavailable' };
            return service.extract();
          },
          // 任务2 上下文隔离：参谋注入浏览器上下文前按项目归属校验。
          extractScoped: async (projectId) => {
            const service = ctx.ensureBrowserService();
            if (!service) return { ok: false, error: 'browser_unavailable' };
            return service.extractScoped(projectId ?? null);
          },
        },
        loadOutcome: (projectId, outcomeId) => {
          const repository = ctx.outcomeRepository();
          if (!repository) return null;
          const detail = repository.get(projectId, outcomeId);
          return detail ? { title: detail.outcome.title, content: detail.version.content } : null;
        },
      });
      return await service.chat({ ...parsedInput.data, thinkingLevel: parsedInput.data.thinkingLevel });
    } catch (error) {
      return { ok: false as const, answer: '', error: error instanceof Error ? error.message : String(error) };
    }
  });

  return () => dom.dispose();
}
