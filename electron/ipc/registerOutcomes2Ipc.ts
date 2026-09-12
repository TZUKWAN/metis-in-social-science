/**
 * Outcomes 2.0 domain IPC registrar（任务书 §25：新 IPC 走 Domain Registrar，
 * 不再堆 main.ts）。通道前缀 `outcomes2:`，与存量 `outcomes:`（main.ts 直注）
 * 完全分离；存量通道语义不变。
 *
 * 依赖通过 {@link Outcomes2IpcDependencies} 显式注入：main 进程组装
 * OutcomeWorkbenchService / OutcomeMemoryService / OutcomeReviewService /
 * ResearchGraphService（共享 store.raw 与 OutcomeRepository）。
 */
import { z } from 'zod';
import type { DomainIpcContext } from './DomainIpcContext.js';
import type {
  OutcomeMemoryService,
  OutcomeReviewService,
  ResearchGraphService,
} from '../OutcomeMemoryReviewGraphService.js';
import type { OutcomeWorkbenchService } from '../OutcomeWorkbenchService.js';

export interface Outcomes2Services {
  workbench: OutcomeWorkbenchService;
  memory: OutcomeMemoryService;
  review: OutcomeReviewService;
  graph: ResearchGraphService;
}

export interface Outcomes2IpcDependencies {
  /** 返回 null 表示持久化层尚未就绪（启动早期/关闭中）。 */
  ensureServices: () => Outcomes2Services | null;
}

const idSchema = z.string().min(1).max(160);
const projectOutcome = z.strictObject({ projectId: idSchema, outcomeId: idSchema });

export function registerOutcomes2Ipc(ctx: DomainIpcContext, deps: Outcomes2IpcDependencies): () => void {
  const { requireRendererMainFrame } = ctx;
  const domain = ctx.registry.domain('outcomes2', ['outcomes2:']);
  const services = (): Outcomes2Services | null => deps.ensureServices();

  // ── Working Draft ──────────────────────────────────────────
  domain.handle('outcomes2:draft:open', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, outcomeId: idSchema, version: z.number().int().min(1).optional() }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return services()?.workbench.openForEdit(parsed.data.projectId, parsed.data.outcomeId, parsed.data.version) ?? { ok: false, code: 'outcome_draft_not_found' };
    } catch { return { ok: false, code: 'outcome_draft_not_found' }; }
  });

  domain.handle('outcomes2:draft:get', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = projectOutcome.safeParse(raw);
      if (!parsed.success) return null;
      return services()?.workbench.getDraft(parsed.data.projectId, parsed.data.outcomeId) ?? null;
    } catch { return null; }
  });

  domain.handle('outcomes2:draft:save', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({
        projectId: idSchema, outcomeId: idSchema, baseVersion: z.number().int().min(1),
        content: z.unknown(), updatedBy: z.enum(['human', 'ai_revision', 'office_sync']), force: z.boolean().optional(),
      }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return services()?.workbench.saveDraft(parsed.data.projectId, parsed.data.outcomeId, {
        baseVersion: parsed.data.baseVersion, content: parsed.data.content, updatedBy: parsed.data.updatedBy, force: parsed.data.force,
      }) ?? { ok: false, code: 'outcome_draft_not_found' };
    } catch { return { ok: false, code: 'invalid_request' }; }
  });

  domain.handle('outcomes2:draft:clear', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = projectOutcome.safeParse(raw);
      if (!parsed.success) return { ok: false };
      return { ok: services()?.workbench.clearDraft(parsed.data.projectId, parsed.data.outcomeId) === true };
    } catch { return { ok: false }; }
  });

  domain.handle('outcomes2:draft:resolveConflict', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, outcomeId: idSchema, action: z.enum(['discard', 'keep', 'rebase']) }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return services()?.workbench.resolveDraftConflict(parsed.data.projectId, parsed.data.outcomeId, parsed.data.action)
        ?? { ok: false, code: 'outcome_not_found' as const };
    } catch { return { ok: false, code: 'invalid_request' as const }; }
  });

  // ── Snapshot ───────────────────────────────────────────────
  domain.handle('outcomes2:snapshot:create', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({
        projectId: idSchema, outcomeId: idSchema,
        reason: z.enum(['autosave', 'manual', 'before_ai_revision', 'before_import', 'before_office_sync', 'before_restore']),
        content: z.unknown().optional(), baseVersion: z.number().int().min(1).optional(),
      }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return services()?.workbench.createSnapshot(parsed.data.projectId, parsed.data.outcomeId, parsed.data.reason, parsed.data.content as import('../../engine/runtime/OutcomeRuntimeContract.js').OutcomeDocument | undefined, parsed.data.baseVersion)
        ?? { ok: false, code: 'outcome_not_found' as const };
    } catch { return { ok: false, code: 'invalid_request' as const }; }
  });

  domain.handle('outcomes2:snapshot:list', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = projectOutcome.safeParse(raw);
      if (!parsed.success) return [];
      return services()?.workbench.listSnapshots(parsed.data.projectId, parsed.data.outcomeId) ?? [];
    } catch { return []; }
  });

  domain.handle('outcomes2:snapshot:restore', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, snapshotId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'outcome_draft_not_found' };
      return services()?.workbench.restoreSnapshot(parsed.data.projectId, parsed.data.snapshotId)
        ?? { ok: false, code: 'outcome_draft_not_found' as const };
    } catch { return { ok: false, code: 'outcome_draft_not_found' as const }; }
  });

  domain.handle('outcomes2:snapshot:purge', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, outcomeId: idSchema, scope: z.enum(['auto', 'all']).default('auto') }).safeParse(raw);
      if (!parsed.success) return { ok: false, deleted: 0 };
      return { ok: true, deleted: services()?.workbench.purgeSnapshots(parsed.data.projectId, parsed.data.outcomeId, parsed.data.scope) ?? 0 };
    } catch { return { ok: false, deleted: 0 }; }
  });

  // ── Revision Engine ────────────────────────────────────────
  domain.handle('outcomes2:revision:create', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({
        projectId: idSchema, outcomeId: idSchema, instruction: z.string().max(8_000),
        createdBy: z.enum(['ai', 'review_issue', 'conversation', 'user']),
        conversationId: idSchema.nullable().optional(), reviewIssueId: idSchema.nullable().optional(),
        proposals: z.array(z.strictObject({
          target: z.unknown(), after: z.unknown(), reason: z.string().max(8_000),
          sourceRefs: z.array(z.unknown()).max(64).optional(), evidenceIds: z.array(idSchema).max(256).optional(),
        })).min(1).max(200),
      }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return services()?.workbench.createRevisionSet({
        projectId: parsed.data.projectId, outcomeId: parsed.data.outcomeId, instruction: parsed.data.instruction,
        createdBy: parsed.data.createdBy, conversationId: parsed.data.conversationId ?? null,
        reviewIssueId: parsed.data.reviewIssueId ?? null,
        proposals: parsed.data.proposals as Array<{ target: never; after: unknown; reason: string }>,
      }) ?? { ok: false, code: 'outcome_not_found' as const };
    } catch { return { ok: false, code: 'invalid_request' as const }; }
  });

  domain.handle('outcomes2:revision:listSets', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = projectOutcome.safeParse(raw);
      if (!parsed.success) return [];
      return services()?.workbench.listRevisionSets(parsed.data.projectId, parsed.data.outcomeId) ?? [];
    } catch { return []; }
  });

  domain.handle('outcomes2:revision:getSet', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, setId: idSchema }).safeParse(raw);
      if (!parsed.success) return null;
      return services()?.workbench.getRevisionSet(parsed.data.projectId, parsed.data.setId) ?? null;
    } catch { return null; }
  });

  domain.handle('outcomes2:revision:accept', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, setId: idSchema, revisionId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'outcome_revision_not_found' };
      return services()?.workbench.acceptRevision(parsed.data.projectId, parsed.data.setId, parsed.data.revisionId)
        ?? { ok: false, code: 'outcome_revision_not_found' as const };
    } catch { return { ok: false, code: 'outcome_revision_not_found' as const }; }
  });

  domain.handle('outcomes2:revision:reject', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, setId: idSchema, revisionId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'outcome_revision_not_found' };
      return services()?.workbench.rejectRevision(parsed.data.projectId, parsed.data.setId, parsed.data.revisionId)
        ?? { ok: false, code: 'outcome_revision_not_found' as const };
    } catch { return { ok: false, code: 'outcome_revision_not_found' as const }; }
  });

  domain.handle('outcomes2:revision:acceptSet', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, setId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'outcome_revision_not_found' };
      return services()?.workbench.acceptRevisionSet(parsed.data.projectId, parsed.data.setId)
        ?? { ok: false, code: 'outcome_revision_not_found' as const };
    } catch { return { ok: false, code: 'outcome_revision_not_found' as const }; }
  });

  domain.handle('outcomes2:revision:rejectSet', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, setId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'outcome_revision_not_found' };
      return services()?.workbench.rejectRevisionSet(parsed.data.projectId, parsed.data.setId)
        ?? { ok: false, code: 'outcome_revision_not_found' as const };
    } catch { return { ok: false, code: 'outcome_revision_not_found' as const }; }
  });

  domain.handle('outcomes2:revision:cancelSet', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, setId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'outcome_revision_not_found' };
      return services()?.workbench.cancelRevisionSet(parsed.data.projectId, parsed.data.setId)
        ?? { ok: false, code: 'outcome_revision_not_found' as const };
    } catch { return { ok: false, code: 'outcome_revision_not_found' as const }; }
  });

  domain.handle('outcomes2:revision:markStaleByHash', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = projectOutcome.safeParse(raw);
      if (!parsed.success) return { ok: false, marked: 0 };
      return { ok: true, marked: services()?.workbench.markStaleByHash(parsed.data.projectId, parsed.data.outcomeId) ?? 0 };
    } catch { return { ok: false, marked: 0 }; }
  });

  // ── Outcome Memory ─────────────────────────────────────────
  domain.handle('outcomes2:memory:get', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = projectOutcome.safeParse(raw);
      if (!parsed.success) return null;
      return services()?.memory.get(parsed.data.projectId, parsed.data.outcomeId) ?? null;
    } catch { return null; }
  });

  domain.handle('outcomes2:memory:save', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (typeof raw !== 'object' || raw === null) return { ok: false, code: 'invalid_request' };
      return services()?.memory.save(raw as Parameters<OutcomeMemoryService['save']>[0])
        ?? { ok: false, code: 'outcome_not_found' as const };
    } catch { return { ok: false, code: 'invalid_request' as const }; }
  });

  domain.handle('outcomes2:memory:propose', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({
        projectId: idSchema, outcomeId: idSchema,
        field: z.enum(['goal', 'audience', 'venueTarget', 'coreJudgments', 'terminology', 'writingRules', 'confirmedDecisions', 'rejectedApproaches', 'unresolvedIssues']),
        value: z.unknown(), reason: z.string().max(4_000),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return services()?.memory.propose({
        projectId: parsed.data.projectId, outcomeId: parsed.data.outcomeId,
        field: parsed.data.field, value: parsed.data.value, reason: parsed.data.reason,
      }) ?? null;
    } catch { return null; }
  });

  domain.handle('outcomes2:memory:listProposals', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, outcomeId: idSchema, status: z.enum(['pending', 'accepted', 'rejected']).default('pending') }).safeParse(raw);
      if (!parsed.success) return [];
      return services()?.memory.listProposals(parsed.data.projectId, parsed.data.outcomeId, parsed.data.status) ?? [];
    } catch { return []; }
  });

  domain.handle('outcomes2:memory:acceptProposal', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, proposalId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'proposal_not_found' };
      return services()?.memory.acceptProposal(parsed.data.projectId, parsed.data.proposalId)
        ?? { ok: false, code: 'proposal_not_found' as const };
    } catch { return { ok: false, code: 'proposal_not_found' as const }; }
  });

  domain.handle('outcomes2:memory:rejectProposal', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, proposalId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false };
      return { ok: services()?.memory.rejectProposal(parsed.data.projectId, parsed.data.proposalId) === true };
    } catch { return { ok: false }; }
  });

  // ── Review ─────────────────────────────────────────────────
  domain.handle('outcomes2:review:start', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({
        projectId: idSchema, outcomeId: idSchema, mode: z.string().max(64),
        baseVersion: z.number().int().min(1), baseDraftHash: z.string().min(8).max(64),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return services()?.review.startRun(parsed.data.projectId, parsed.data.outcomeId, parsed.data.mode, parsed.data.baseVersion, parsed.data.baseDraftHash) ?? null;
    } catch { return null; }
  });

  domain.handle('outcomes2:review:listRuns', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = projectOutcome.safeParse(raw);
      if (!parsed.success) return [];
      return services()?.review.listRuns(parsed.data.projectId, parsed.data.outcomeId) ?? [];
    } catch { return []; }
  });

  domain.handle('outcomes2:review:listIssues', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, outcomeId: idSchema, status: z.enum(['open', 'in_progress', 'resolved', 'ignored', 'stale']).optional() }).safeParse(raw);
      if (!parsed.success) return [];
      return services()?.review.listIssues(parsed.data.projectId, parsed.data.outcomeId, parsed.data.status) ?? [];
    } catch { return []; }
  });

  domain.handle('outcomes2:review:issue:add', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (typeof raw !== 'object' || raw === null) return null;
      return services()?.review.addIssue(raw as Parameters<OutcomeReviewService['addIssue']>[0]) ?? null;
    } catch { return null; }
  });

  domain.handle('outcomes2:review:issue:update', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({
        projectId: idSchema, issueId: idSchema,
        status: z.enum(['open', 'in_progress', 'resolved', 'ignored', 'stale']),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return services()?.review.updateIssueStatus(parsed.data.projectId, parsed.data.issueId, parsed.data.status) ?? null;
    } catch { return null; }
  });

  domain.handle('outcomes2:review:cancel', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, runId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false };
      const run = services()?.review.getRun(parsed.data.projectId, parsed.data.runId);
      if (!run) return { ok: false };
      services()?.review.completeRun(parsed.data.runId, 'cancelled');
      return { ok: true };
    } catch { return { ok: false }; }
  });

  domain.handle('outcomes2:review:markStaleByDraftHash', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, outcomeId: idSchema, currentDraftHash: z.string().min(8).max(64).nullable() }).safeParse(raw);
      if (!parsed.success) return { ok: false, marked: 0 };
      return { ok: true, marked: services()?.review.markStaleByDraftHash(parsed.data.projectId, parsed.data.outcomeId, parsed.data.currentDraftHash) ?? 0 };
    } catch { return { ok: false, marked: 0 }; }
  });

  // ── Research Graph ─────────────────────────────────────────
  domain.handle('outcomes2:graph:upsertNode', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (typeof raw !== 'object' || raw === null) return { ok: false, code: 'invalid_request' };
      return services()?.graph.upsertNode(raw as Parameters<ResearchGraphService['upsertNode']>[0])
        ?? { ok: false, code: 'invalid_request' as const };
    } catch { return { ok: false, code: 'invalid_request' as const }; }
  });

  domain.handle('outcomes2:graph:upsertEdge', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (typeof raw !== 'object' || raw === null) return { ok: false, code: 'invalid_request' };
      return services()?.graph.upsertEdge(raw as Parameters<ResearchGraphService['upsertEdge']>[0])
        ?? { ok: false, code: 'invalid_request' as const };
    } catch { return { ok: false, code: 'invalid_request' as const }; }
  });

  domain.handle('outcomes2:graph:nodes', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema }).safeParse(raw);
      if (!parsed.success) return [];
      return services()?.graph.listNodes(parsed.data.projectId) ?? [];
    } catch { return []; }
  });

  domain.handle('outcomes2:graph:edges', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema }).safeParse(raw);
      if (!parsed.success) return [];
      return services()?.graph.listEdges(parsed.data.projectId) ?? [];
    } catch { return []; }
  });

  domain.handle('outcomes2:graph:confirmNode', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, nodeId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'research_graph_node_not_found' };
      return services()?.graph.confirmNode(parsed.data.projectId, parsed.data.nodeId)
        ?? { ok: false, code: 'research_graph_node_not_found' as const };
    } catch { return { ok: false, code: 'research_graph_node_not_found' as const }; }
  });

  domain.handle('outcomes2:graph:confirmEdge', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, edgeId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'research_graph_edge_not_found' };
      return services()?.graph.confirmEdge(parsed.data.projectId, parsed.data.edgeId)
        ?? { ok: false, code: 'research_graph_edge_not_found' as const };
    } catch { return { ok: false, code: 'research_graph_edge_not_found' as const }; }
  });

  domain.handle('outcomes2:graph:rejectNode', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, nodeId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'research_graph_node_not_found' };
      return services()?.graph.rejectNode(parsed.data.projectId, parsed.data.nodeId)
        ?? { ok: false, code: 'research_graph_node_not_found' as const };
    } catch { return { ok: false, code: 'research_graph_node_not_found' as const }; }
  });

  domain.handle('outcomes2:graph:rejectEdge', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({ projectId: idSchema, edgeId: idSchema }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'research_graph_edge_not_found' };
      return services()?.graph.rejectEdge(parsed.data.projectId, parsed.data.edgeId)
        ?? { ok: false, code: 'research_graph_edge_not_found' as const };
    } catch { return { ok: false, code: 'research_graph_edge_not_found' as const }; }
  });

  domain.handle('outcomes2:graph:dedupCandidate', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.strictObject({
        projectId: idSchema, label: z.string().max(500),
        canonicalEntityType: z.string().max(32).nullable().optional(),
        canonicalEntityId: idSchema.nullable().optional(),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return services()?.graph.findDeduplicationCandidate(parsed.data.projectId, {
        canonicalEntityType: parsed.data.canonicalEntityType ?? null,
        canonicalEntityId: parsed.data.canonicalEntityId ?? null,
        label: parsed.data.label,
      }) ?? null;
    } catch { return null; }
  });

  return () => domain.dispose();
}
