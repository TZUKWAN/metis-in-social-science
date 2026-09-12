/**
 * Outcomes 2.0 Workbench Contract（任务书 Phase 1：T01.01–T01.09）。
 *
 * 数据可信铁律（任务书 §23，测试强制）：
 * 1. AI extracted node ≠ verified fact；2. AI extracted edge ≠ verified relationship；
 * 3. External chatbot reference ≠ Evidence；4. Claim 复用 canonical claim store；
 * 5. Evidence 必须有 Source；6. Citation 必须来自 Source/Evidence；
 * 7. Revision sourceRefs 必须有 provenance；8. 无 evidence 的 causal edge 不显示 verified；
 * 9. user confirmed ≠ external-source verified；10. Review issue 是判断不是事实；
 * 11. Memory 用户决定优先于 AI 建议；12. Graph UI 显式区分 verified / AI inferred。
 *
 * 版本层铁律（任务书 §1.3）：Draft ≠ Version；Snapshot ≠ Version；Revision ≠ Version。
 * 只有「保存版本」与 Office sync 创建 OutcomeVersion。
 */
import { z } from 'zod';
import {
  OutcomeDocumentSchema,
  OutcomeIdSchema,
  OutcomeSourceSchema,
  version as versionNumber,
  timestamp,
} from './OutcomeRuntimeContract.js';

export const OUTCOME_WORKBENCH_VERSION = 1 as const;

const nonEmptyText = (max: number) => z.string().max(max).refine((value) => value.trim().length > 0);
const hashText = z.string().regex(/^[0-9a-f]{8,64}$/iu);

// ── T01.01 Outcome Working Draft ────────────────────────────────────────
export const OutcomeDraftActorSchema = z.enum(['human', 'ai_revision', 'office_sync']);
export type OutcomeDraftActor = z.infer<typeof OutcomeDraftActorSchema>;

export const OutcomeWorkingDraftSchema = z.strictObject({
  outcomeId: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  /** 草稿基于的正式版本；保存版本/Office sync 后对账，不匹配 → draft_version_conflict。 */
  baseVersion: versionNumber,
  content: OutcomeDocumentSchema,
  contentHash: hashText,
  updatedBy: OutcomeDraftActorSchema,
  updatedAt: timestamp,
});
export type OutcomeWorkingDraft = z.infer<typeof OutcomeWorkingDraftSchema>;

// ── T01.03 Outcome Snapshot ─────────────────────────────────────────────
export const OutcomeSnapshotReasonSchema = z.enum([
  'autosave', 'manual', 'before_ai_revision', 'before_import', 'before_office_sync', 'before_restore',
]);
export type OutcomeSnapshotReason = z.infer<typeof OutcomeSnapshotReasonSchema>;

export const OutcomeSnapshotSchema = z.strictObject({
  id: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema,
  baseVersion: versionNumber,
  content: OutcomeDocumentSchema,
  contentHash: hashText,
  reason: OutcomeSnapshotReasonSchema,
  createdAt: timestamp,
});
export type OutcomeSnapshot = z.infer<typeof OutcomeSnapshotSchema>;

/** 自动快照保留上限（手动快照单独计数，不参与自动淘汰）。 */
export const OUTCOME_SNAPSHOT_AUTO_LIMIT = 50;

// ── T01.04/T01.05 Revision Set + Revision ───────────────────────────────
export const OUTCOME_REVISION_TARGET_VERSION = 1 as const;

/** 修订目标：每个变体必须携带 beforeHash —— Apply 时 current hash ≠ beforeHash 即 revision_stale，绝不「尽力套用」。 */
export const OutcomeRevisionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('word_range'), blockId: OutcomeIdSchema,
    start: z.number().int().min(0), end: z.number().int().min(0), beforeHash: hashText,
  }),
  z.strictObject({ kind: z.literal('word_block'), blockId: OutcomeIdSchema, beforeHash: hashText }),
  z.strictObject({
    kind: z.literal('word_table_cell'), blockId: OutcomeIdSchema,
    row: z.number().int().min(0), column: z.number().int().min(0), beforeHash: hashText,
  }),
  z.strictObject({ kind: z.literal('ppt_element'), pageId: OutcomeIdSchema, elementId: OutcomeIdSchema, beforeHash: hashText }),
  z.strictObject({ kind: z.literal('ppt_page'), pageId: OutcomeIdSchema, beforeHash: hashText }),
]);
export type OutcomeRevisionTarget = z.infer<typeof OutcomeRevisionTargetSchema>;

/** 提案输入：模型只给定位，不给 beforeHash（Runtime 计算并填充）。 */
export const OutcomeRevisionTargetInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('word_range'), blockId: OutcomeIdSchema, start: z.number().int().min(0), end: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal('word_block'), blockId: OutcomeIdSchema }),
  z.strictObject({ kind: z.literal('word_table_cell'), blockId: OutcomeIdSchema, row: z.number().int().min(0), column: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal('ppt_element'), pageId: OutcomeIdSchema, elementId: OutcomeIdSchema }),
  z.strictObject({ kind: z.literal('ppt_page'), pageId: OutcomeIdSchema }),
]);
export type OutcomeRevisionTargetInput = z.infer<typeof OutcomeRevisionTargetInputSchema>;

export const OutcomeRevisionSetStatusSchema = z.enum([
  'pending', 'partially_accepted', 'accepted', 'rejected', 'stale', 'cancelled',
]);
export type OutcomeRevisionSetStatus = z.infer<typeof OutcomeRevisionSetStatusSchema>;

export const OutcomeRevisionSetCreatorSchema = z.enum(['ai', 'review_issue', 'conversation', 'user']);
export type OutcomeRevisionSetCreator = z.infer<typeof OutcomeRevisionSetCreatorSchema>;

export const OutcomeRevisionSetSchema = z.strictObject({
  id: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema,
  baseVersion: versionNumber,
  /** 提案生成时的草稿内容指纹；set 级 staleness 判定用。 */
  baseDraftHash: hashText,
  conversationId: OutcomeIdSchema.nullable().default(null),
  /** createdBy=review_issue 时关联的 issue id（T08.07）。 */
  reviewIssueId: OutcomeIdSchema.nullable().default(null),
  instruction: z.string().max(8_000),
  createdBy: OutcomeRevisionSetCreatorSchema,
  status: OutcomeRevisionSetStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type OutcomeRevisionSet = z.infer<typeof OutcomeRevisionSetSchema>;

export const OutcomeRevisionStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'stale']);
export type OutcomeRevisionStatus = z.infer<typeof OutcomeRevisionStatusSchema>;

export const OutcomeRevisionSchema = z.strictObject({
  id: OutcomeIdSchema,
  revisionSetId: OutcomeIdSchema,
  order: z.number().int().min(0),
  target: OutcomeRevisionTargetSchema,
  /** 应用前的原内容片段（Runtime 从当前 draft 读取，模型不可信 before）。 */
  before: z.unknown(),
  /** 应用后的新内容片段。 */
  after: z.unknown(),
  reason: z.string().max(8_000),
  sourceRefs: z.array(OutcomeSourceSchema).max(64).default([]),
  evidenceIds: z.array(OutcomeIdSchema).max(256).default([]),
  status: OutcomeRevisionStatusSchema,
  createdAt: timestamp,
  resolvedAt: timestamp.nullable().default(null),
});
export type OutcomeRevision = z.infer<typeof OutcomeRevisionSchema>;

// ── T01.07 Outcome Memory ───────────────────────────────────────────────
export const OutcomeMemoryTermSchema = z.strictObject({
  preferred: nonEmptyText(200),
  avoid: z.array(z.string().max(200)).max(20).default([]),
  note: z.string().max(1_000).optional(),
});
export type OutcomeMemoryTerm = z.infer<typeof OutcomeMemoryTermSchema>;

export const OutcomeMemorySchema = z.strictObject({
  outcomeId: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  goal: z.string().max(4_000).default(''),
  audience: z.string().max(1_000).default(''),
  venueTarget: z.string().max(500).default(''),
  coreJudgments: z.array(z.string().max(2_000)).max(32).default([]),
  terminology: z.array(OutcomeMemoryTermSchema).max(64).default([]),
  writingRules: z.array(z.string().max(1_000)).max(32).default([]),
  confirmedDecisions: z.array(z.string().max(2_000)).max(32).default([]),
  rejectedApproaches: z.array(z.string().max(2_000)).max(32).default([]),
  unresolvedIssues: z.array(z.string().max(2_000)).max(32).default([]),
  updatedAt: timestamp,
  /** 并发检查：保存时必须等于当前 revision，写入时 +1。 */
  revision: z.number().int().min(1).max(1_000_000),
});
export type OutcomeMemory = z.infer<typeof OutcomeMemorySchema>;

/** T07.03：AI 只能 propose，用户确认后才写入正式 memory。 */
export const OutcomeMemoryProposalSchema = z.strictObject({
  id: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema,
  field: z.enum(['goal', 'audience', 'venueTarget', 'coreJudgments', 'terminology', 'writingRules', 'confirmedDecisions', 'rejectedApproaches', 'unresolvedIssues']),
  /** 建议追加/设置的值（JSON 形态随 field 而定）。 */
  value: z.unknown(),
  reason: z.string().max(4_000),
  status: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
  createdAt: timestamp,
});
export type OutcomeMemoryProposal = z.infer<typeof OutcomeMemoryProposalSchema>;

// ── T01.08 Review Issue ─────────────────────────────────────────────────
export const OutcomeReviewSeveritySchema = z.enum(['critical', 'major', 'minor']);
export type OutcomeReviewSeverity = z.infer<typeof OutcomeReviewSeveritySchema>;

export const OutcomeReviewCategorySchema = z.enum([
  'argument', 'evidence', 'citation', 'theory', 'method', 'structure', 'consistency', 'language', 'format',
]);
export type OutcomeReviewCategory = z.infer<typeof OutcomeReviewCategorySchema>;

export const OutcomeReviewIssueStatusSchema = z.enum(['open', 'in_progress', 'resolved', 'ignored', 'stale']);
export type OutcomeReviewIssueStatus = z.infer<typeof OutcomeReviewIssueStatusSchema>;

export const OutcomeReviewIssueSchema = z.strictObject({
  id: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema,
  /** 生成本次审查的审查运行 id（同一成果可多次审查）。 */
  reviewRunId: OutcomeIdSchema.nullable().default(null),
  baseVersion: versionNumber,
  baseDraftHash: hashText,
  category: OutcomeReviewCategorySchema,
  severity: OutcomeReviewSeveritySchema,
  title: nonEmptyText(500),
  explanation: z.string().max(8_000),
  /** 无法定位时缺省 = document-level（不得伪造 anchor）。 */
  anchor: OutcomeRevisionTargetSchema.nullable().default(null),
  sourceRefs: z.array(OutcomeSourceSchema).max(64).default([]),
  evidenceIds: z.array(OutcomeIdSchema).max(256).default([]),
  status: OutcomeReviewIssueStatusSchema.default('open'),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type OutcomeReviewIssue = z.infer<typeof OutcomeReviewIssueSchema>;

// ── T01.09 Research Graph ───────────────────────────────────────────────
export const ResearchGraphNodeKindSchema = z.enum([
  'concept', 'theory', 'person', 'institution', 'event', 'place', 'method', 'variable',
  'document', 'source', 'evidence', 'claim', 'outcome', 'section',
]);
export type ResearchGraphNodeKind = z.infer<typeof ResearchGraphNodeKindSchema>;

export const ResearchGraphNodeProvenanceSchema = z.enum(['canonical', 'explicit_source', 'ai_extracted', 'user_created']);
export type ResearchGraphNodeProvenance = z.infer<typeof ResearchGraphNodeProvenanceSchema>;

export const ResearchGraphVerificationSchema = z.enum(['verified', 'supported', 'unverified', 'rejected']);
export type ResearchGraphVerification = z.infer<typeof ResearchGraphVerificationSchema>;

export const ResearchGraphNodeSchema = z.strictObject({
  id: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  kind: ResearchGraphNodeKindSchema,
  label: nonEmptyText(500),
  description: z.string().max(4_000).default(''),
  /** canonical 引用：claim/evidence/source/outcome/section 节点必须指回权威实体，禁止复制。 */
  canonicalEntityType: z.enum(['claim', 'evidence', 'source', 'outcome', 'artifact', 'section']).nullable().default(null),
  canonicalEntityId: OutcomeIdSchema.nullable().default(null),
  provenance: ResearchGraphNodeProvenanceSchema,
  verificationStatus: ResearchGraphVerificationSchema,
  confidence: z.number().finite().min(0).max(1).nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ResearchGraphNode = z.infer<typeof ResearchGraphNodeSchema>;

export const ResearchGraphRelationSchema = z.enum([
  'supports', 'contradicts', 'qualifies', 'explains', 'causes', 'derives_from', 'cites', 'discusses',
  'applies_to', 'contains', 'refines', 'challenges', 'precedes', 'related_to',
]);
export type ResearchGraphRelation = z.infer<typeof ResearchGraphRelationSchema>;

export const ResearchGraphEdgeProvenanceSchema = z.enum(['canonical', 'explicit_source', 'citation', 'ai_extracted', 'user_confirmed']);
export type ResearchGraphEdgeProvenance = z.infer<typeof ResearchGraphEdgeProvenanceSchema>;

export const ResearchGraphEdgeSchema = z.strictObject({
  id: OutcomeIdSchema,
  projectId: OutcomeIdSchema,
  sourceNodeId: OutcomeIdSchema,
  targetNodeId: OutcomeIdSchema,
  relation: ResearchGraphRelationSchema,
  provenance: ResearchGraphEdgeProvenanceSchema,
  evidenceIds: z.array(OutcomeIdSchema).max(256).default([]),
  sourceIds: z.array(OutcomeIdSchema).max(256).default([]),
  verificationStatus: ResearchGraphVerificationSchema,
  confidence: z.number().finite().min(0).max(1).nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ResearchGraphEdge = z.infer<typeof ResearchGraphEdgeSchema>;

// ── 统一错误码（任务书 §27）────────────────────────────────────────────
export const OUTCOME_WORKBENCH_ERROR_CODES = [
  'outcome_draft_not_found',
  'outcome_draft_conflict',
  'outcome_revision_not_found',
  'outcome_revision_stale',
  'outcome_revision_target_missing',
  'outcome_revision_already_resolved',
  'outcome_revision_set_stale',
  'outcome_memory_revision_conflict',
  'outcome_review_not_found',
  'outcome_review_stale',
  'outcome_review_cancelled',
  'research_graph_node_not_found',
  'research_graph_edge_not_found',
  'research_graph_scope_mismatch',
  'research_graph_canonical_entity_missing',
] as const;
export type OutcomeWorkbenchErrorCode = (typeof OUTCOME_WORKBENCH_ERROR_CODES)[number];
export const OutcomeWorkbenchErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum(OUTCOME_WORKBENCH_ERROR_CODES),
  message: z.string().max(1_000).optional(),
});
