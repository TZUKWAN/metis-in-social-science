/**
 * OutcomeMemoryReviewGraphService — Outcomes 2.0 记忆 / 审查 / 图谱数据层
 * （任务书 Phase 7 / Phase 8 持久化 / Phase 9 基础层）。
 *
 * 数据可信规则（§23）在本层的落点：
 *  - AI 提取的图节点/边一律 unverified + ai_extracted，绝不默认 verified；
 *  - 用户确认：provenance=user_confirmed 且 verification 最高到 supported（≠ external verified）；
 *  - canonical 节点必须指向真实存在的 claim/evidence/source/outcome/artifact；
 *  - Memory 用户编辑走 revision 并发检查；AI 只能 propose，接受才生效。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  OutcomeMemorySchema,
  OutcomeReviewIssueSchema,
  ResearchGraphEdgeSchema,
  ResearchGraphNodeSchema,
  type OutcomeMemory,
  type OutcomeMemoryProposal,
  type OutcomeReviewIssue,
  type ResearchGraphEdge,
  type ResearchGraphNode,
} from '../engine/runtime/OutcomeWorkbenchContract.js';

const encode = (value: unknown): string => JSON.stringify(value);
const decode = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

export type MemoryErrorCode = 'outcome_memory_revision_conflict' | 'outcome_not_found' | 'invalid_request' | 'proposal_not_found';
export type GraphErrorCode =
  | 'research_graph_node_not_found'
  | 'research_graph_edge_not_found'
  | 'research_graph_scope_mismatch'
  | 'research_graph_canonical_entity_missing'
  | 'invalid_request';

// ─────────────────────────────────────────────────────────────────────────
export class OutcomeMemoryService {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string, outcomeId: string): OutcomeMemory | null {
    const row = this.db.prepare('SELECT memory_json, revision, updated_at FROM outcome_memory WHERE outcome_id=? AND project_id=?')
      .get(outcomeId, projectId) as { memory_json: string; revision: number; updated_at: number } | undefined;
    if (!row) return null;
    const parsed = OutcomeMemorySchema.safeParse({ ...decode<Record<string, unknown>>(row.memory_json, {}), outcomeId, projectId, updatedAt: row.updated_at, revision: row.revision });
    return parsed.success ? parsed.data : null;
  }

  /** 保存（手工编辑）：revision 并发检查，冲突返回 outcome_memory_revision_conflict。 */
  save(memory: OutcomeMemory): { ok: true; memory: OutcomeMemory } | { ok: false; code: MemoryErrorCode } {
    const parsed = OutcomeMemorySchema.safeParse(memory);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const value = parsed.data;
    const row = this.db.prepare('SELECT revision FROM outcome_memory WHERE outcome_id=?').get(value.outcomeId) as { revision: number } | undefined;
    if (row && row.revision !== value.revision) return { ok: false, code: 'outcome_memory_revision_conflict' };
    const nextRevision = (row?.revision ?? 0) + 1;
    const now = Date.now();
    this.db.prepare(`INSERT INTO outcome_memory (outcome_id,project_id,memory_json,revision,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(outcome_id) DO UPDATE SET memory_json=excluded.memory_json, revision=excluded.revision, updated_at=excluded.updated_at`)
      .run(value.outcomeId, value.projectId, encode({ ...value, revision: undefined, updatedAt: undefined }), nextRevision, now);
    return { ok: true, memory: { ...value, revision: nextRevision, updatedAt: now } };
  }

  /** T07.03：AI 只写 pending proposal；用户接受才进正式 memory。 */
  propose(proposal: Pick<OutcomeMemoryProposal, 'projectId' | 'outcomeId' | 'field' | 'value' | 'reason'>): OutcomeMemoryProposal {
    const id = `memprop-${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO outcome_memory_proposals (id,project_id,outcome_id,field,value_json,reason,status,created_at,resolved_at)
      VALUES (?,?,?,?,?,?, 'pending', ?, NULL)`)
      .run(id, proposal.projectId, proposal.outcomeId, proposal.field, encode(proposal.value), proposal.reason.slice(0, 4_000), now);
    return { ...proposal, id, status: 'pending', createdAt: now };
  }

  listProposals(projectId: string, outcomeId: string, status: 'pending' | 'accepted' | 'rejected' = 'pending'): OutcomeMemoryProposal[] {
    const rows = this.db.prepare('SELECT * FROM outcome_memory_proposals WHERE outcome_id=? AND project_id=? AND status=? ORDER BY created_at DESC')
      .all(outcomeId, projectId, status) as Array<{ id: string; project_id: string; outcome_id: string; field: string; value_json: string; reason: string; status: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id, projectId: row.project_id, outcomeId: row.outcome_id,
      field: row.field as OutcomeMemoryProposal['field'], value: decode<unknown>(row.value_json, null),
      reason: row.reason, status: row.status as OutcomeMemoryProposal['status'], createdAt: row.created_at,
    }));
  }

  acceptProposal(projectId: string, proposalId: string): { ok: true; memory: OutcomeMemory | null } | { ok: false; code: MemoryErrorCode } {
    const row = this.db.prepare('SELECT * FROM outcome_memory_proposals WHERE id=? AND project_id=? AND status=?')
      .get(proposalId, projectId, 'pending') as { id: string; outcome_id: string; field: string; value_json: string } | undefined;
    if (!row) return { ok: false, code: 'proposal_not_found' };
    const current = this.get(projectId, row.outcome_id);
    const now = Date.now();
    const base: OutcomeMemory = current ?? OutcomeMemorySchema.parse({
      outcomeId: row.outcome_id, projectId, revision: 0, updatedAt: now,
    });
    const value = decode<unknown>(row.value_json, null);
    let next: OutcomeMemory;
    if (row.field === 'goal') next = { ...base, goal: String(value ?? '') };
    else if (row.field === 'audience') next = { ...base, audience: String(value ?? '') };
    else if (row.field === 'venueTarget') next = { ...base, venueTarget: String(value ?? '') };
    else {
      const LIST_FIELDS = ['coreJudgments', 'terminology', 'writingRules', 'confirmedDecisions', 'rejectedApproaches', 'unresolvedIssues'];
      if (LIST_FIELDS.includes(row.field)) {
        // 列表字段：接受 = 追加去重（value 可为单条字符串/对象或数组）。
        const field = row.field as keyof OutcomeMemory;
        const existing = (base[field] ?? []) as unknown[];
        const incoming = Array.isArray(value) ? value : [value];
        const merged = [...existing, ...incoming.filter((item) => !existing.some((candidate) => encode(candidate) === encode(item)))];
        next = { ...base, [field]: merged } as OutcomeMemory;
      } else {
        next = base;
      }
    }
    const saved = this.save({ ...next, updatedAt: now, revision: current?.revision ?? 0 });
    if (!saved.ok) return saved;
    this.db.prepare("UPDATE outcome_memory_proposals SET status='accepted', resolved_at=? WHERE id=?").run(now, proposalId);
    return { ok: true, memory: saved.memory };
  }

  rejectProposal(projectId: string, proposalId: string): boolean {
    return this.db.prepare("UPDATE outcome_memory_proposals SET status='rejected', resolved_at=? WHERE id=? AND project_id=? AND status='pending'")
      .run(Date.now(), proposalId, projectId).changes > 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────
export interface ReviewRunRecord {
  id: string; projectId: string; outcomeId: string; mode: string;
  baseVersion: number; baseDraftHash: string;
  status: 'running' | 'completed' | 'cancelled' | 'stale';
  progress: Record<string, unknown>;
  createdAt: number; updatedAt: number;
}

interface ReviewRunRow {
  id: string; project_id: string; outcome_id: string; mode: string; base_version: number;
  base_draft_hash: string; status: string; progress_json: string; created_at: number; updated_at: number;
}
interface ReviewIssueRow {
  id: string; project_id: string; outcome_id: string; review_run_id: string | null; base_version: number;
  base_draft_hash: string; category: string; severity: string; title: string; explanation: string;
  anchor_json: string | null; source_refs_json: string; evidence_ids_json: string; status: string;
  created_at: number; updated_at: number;
}

const asRun = (row: ReviewRunRow): ReviewRunRecord => ({
  id: row.id, projectId: row.project_id, outcomeId: row.outcome_id, mode: row.mode,
  baseVersion: row.base_version, baseDraftHash: row.base_draft_hash,
  status: row.status as ReviewRunRecord['status'], progress: decode<Record<string, unknown>>(row.progress_json, {}),
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const asIssue = (row: ReviewIssueRow): OutcomeReviewIssue => ({
  id: row.id, projectId: row.project_id, outcomeId: row.outcome_id, reviewRunId: row.review_run_id,
  baseVersion: row.base_version, baseDraftHash: row.base_draft_hash,
  category: row.category as OutcomeReviewIssue['category'], severity: row.severity as OutcomeReviewIssue['severity'],
  title: row.title, explanation: row.explanation, anchor: decode<OutcomeReviewIssue['anchor']>(row.anchor_json, null),
  sourceRefs: decode<OutcomeReviewIssue['sourceRefs']>(row.source_refs_json, []),
  evidenceIds: decode<OutcomeReviewIssue['evidenceIds']>(row.evidence_ids_json, []),
  status: row.status as OutcomeReviewIssue['status'], createdAt: row.created_at, updatedAt: row.updated_at,
});

export class OutcomeReviewService {
  constructor(private readonly db: Database.Database) {}

  startRun(projectId: string, outcomeId: string, mode: string, baseVersion: number, baseDraftHash: string): ReviewRunRecord {
    const id = `revrun-${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO outcome_review_runs (id,project_id,outcome_id,mode,base_version,base_draft_hash,status,progress_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?, 'running', '{}', ?, ?)`)
      .run(id, projectId, outcomeId, mode.slice(0, 64), baseVersion, baseDraftHash, now, now);
    const row = this.db.prepare('SELECT * FROM outcome_review_runs WHERE id=?').get(id) as ReviewRunRow;
    return asRun(row);
  }

  updateProgress(runId: string, progress: Record<string, unknown>): void {
    this.db.prepare('UPDATE outcome_review_runs SET progress_json=?, updated_at=? WHERE id=?').run(encode(progress), Date.now(), runId);
  }

  completeRun(runId: string, finalStatus: 'completed' | 'cancelled' | 'stale' = 'completed'): void {
    this.db.prepare('UPDATE outcome_review_runs SET status=?, updated_at=? WHERE id=?').run(finalStatus, Date.now(), runId);
  }

  getRun(projectId: string, runId: string): ReviewRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM outcome_review_runs WHERE id=? AND project_id=?').get(runId, projectId) as ReviewRunRow | undefined;
    return row ? asRun(row) : undefined;
  }

  listRuns(projectId: string, outcomeId: string): ReviewRunRecord[] {
    return (this.db.prepare('SELECT * FROM outcome_review_runs WHERE outcome_id=? AND project_id=? ORDER BY created_at DESC')
      .all(outcomeId, projectId) as ReviewRunRow[]).map(asRun);
  }

  /** T08.03/T15.04：Service 校验 anchor/category/severity 后持久化 issue 候选。 */
  addIssue(issue: Omit<OutcomeReviewIssue, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: OutcomeReviewIssue['status'] }): OutcomeReviewIssue {
    const id = `issue-${randomUUID()}`;
    const now = Date.now();
    const value = OutcomeReviewIssueSchema.parse({ ...issue, id, status: issue.status ?? 'open', createdAt: now, updatedAt: now });
    this.db.prepare(`INSERT INTO outcome_review_issues
      (id,project_id,outcome_id,review_run_id,base_version,base_draft_hash,category,severity,title,explanation,anchor_json,source_refs_json,evidence_ids_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, value.projectId, value.outcomeId, value.reviewRunId, value.baseVersion, value.baseDraftHash,
        value.category, value.severity, value.title, value.explanation, encode(value.anchor),
        encode(value.sourceRefs), encode(value.evidenceIds), value.status, now, now);
    return value;
  }

  listIssues(projectId: string, outcomeId: string, status?: OutcomeReviewIssue['status']): OutcomeReviewIssue[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM outcome_review_issues WHERE outcome_id=? AND project_id=? AND status=? ORDER BY created_at DESC').all(outcomeId, projectId, status)
      : this.db.prepare('SELECT * FROM outcome_review_issues WHERE outcome_id=? AND project_id=? ORDER BY created_at DESC').all(outcomeId, projectId);
    return (rows as ReviewIssueRow[]).map(asIssue);
  }

  updateIssueStatus(projectId: string, issueId: string, status: OutcomeReviewIssue['status']): OutcomeReviewIssue | undefined {
    this.db.prepare('UPDATE outcome_review_issues SET status=?, updated_at=? WHERE id=? AND project_id=?').run(status, Date.now(), issueId, projectId);
    const row = this.db.prepare('SELECT * FROM outcome_review_issues WHERE id=?').get(issueId) as ReviewIssueRow | undefined;
    return row ? asIssue(row) : undefined;
  }

  /** T08.09/T14.03：草稿/版本大改后，anchor/baselineHash 不再匹配的 issue 标 stale。 */
  markStaleByDraftHash(projectId: string, outcomeId: string, currentDraftHash: string | null): number {
    const rows = this.db.prepare("SELECT id, base_draft_hash FROM outcome_review_issues WHERE outcome_id=? AND project_id=? AND status IN ('open','in_progress')")
      .all(outcomeId, projectId) as Array<{ id: string; base_draft_hash: string }>;
    let marked = 0;
    const now = Date.now();
    for (const row of rows) {
      if (currentDraftHash === null || row.base_draft_hash !== currentDraftHash) {
        this.db.prepare("UPDATE outcome_review_issues SET status='stale', updated_at=? WHERE id=?").run(now, row.id);
        marked += 1;
      }
    }
    return marked;
  }
}

// ─────────────────────────────────────────────────────────────────────────
interface GraphNodeRow {
  id: string; project_id: string; kind: string; label: string; description: string;
  canonical_entity_type: string | null; canonical_entity_id: string | null; provenance: string;
  verification_status: string; confidence: number | null; created_at: number; updated_at: number;
}
interface GraphEdgeRow {
  id: string; project_id: string; source_node_id: string; target_node_id: string; relation: string;
  provenance: string; evidence_ids_json: string; source_ids_json: string; verification_status: string;
  confidence: number | null; created_at: number; updated_at: number;
}

const asNode = (row: GraphNodeRow): ResearchGraphNode => ({
  id: row.id, projectId: row.project_id, kind: row.kind as ResearchGraphNode['kind'], label: row.label,
  description: row.description, canonicalEntityType: row.canonical_entity_type as ResearchGraphNode['canonicalEntityType'],
  canonicalEntityId: row.canonical_entity_id, provenance: row.provenance as ResearchGraphNode['provenance'],
  verificationStatus: row.verification_status as ResearchGraphNode['verificationStatus'],
  confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at,
});
const asEdge = (row: GraphEdgeRow): ResearchGraphEdge => ({
  id: row.id, projectId: row.project_id, sourceNodeId: row.source_node_id, targetNodeId: row.target_node_id,
  relation: row.relation as ResearchGraphEdge['relation'], provenance: row.provenance as ResearchGraphEdge['provenance'],
  evidenceIds: decode<ResearchGraphEdge['evidenceIds']>(row.evidence_ids_json, []),
  sourceIds: decode<ResearchGraphEdge['sourceIds']>(row.source_ids_json, []),
  verificationStatus: row.verification_status as ResearchGraphEdge['verificationStatus'],
  confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at,
});

export class ResearchGraphService {
  constructor(private readonly db: Database.Database) {}

  /** canonical 校验：claim/evidence/source/outcome/artifact 节点必须指向真实实体（T09.02）。 */
  private assertCanonical(projectId: string, entityType: string | null, entityId: string | null): GraphErrorCode | null {
    if (entityType === null || entityId === null) return null;
    const table = { claim: 'claims', evidence: 'evidence', source: 'sources', outcome: 'outcomes', artifact: 'research_artifacts' }[entityType];
    if (!table) return 'research_graph_canonical_entity_missing';
    const owned = this.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND project_id=?`).get(entityId, projectId);
    return owned ? null : 'research_graph_canonical_entity_missing';
  }

  upsertNode(input: Omit<ResearchGraphNode, 'createdAt' | 'updatedAt'> & { createdAt?: number }):
    { ok: true; node: ResearchGraphNode } | { ok: false; code: GraphErrorCode } {
    const parsed = ResearchGraphNodeSchema.safeParse({ ...input, createdAt: input.createdAt ?? Date.now(), updatedAt: Date.now() });
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const canonicalError = this.assertCanonical(input.projectId, input.canonicalEntityType ?? null, input.canonicalEntityId ?? null);
    if (canonicalError) return { ok: false, code: canonicalError };
    const now = Date.now();
    this.db.prepare(`INSERT INTO research_graph_nodes
      (id,project_id,kind,label,description,canonical_entity_type,canonical_entity_id,provenance,verification_status,confidence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, description=excluded.description,
        kind=excluded.kind, canonical_entity_type=excluded.canonical_entity_type, canonical_entity_id=excluded.canonical_entity_id,
        provenance=excluded.provenance, verification_status=excluded.verification_status, confidence=excluded.confidence,
        updated_at=excluded.updated_at`)
      .run(parsed.data.id, input.projectId, parsed.data.kind, parsed.data.label, parsed.data.description,
        parsed.data.canonicalEntityType, parsed.data.canonicalEntityId, parsed.data.provenance,
        parsed.data.verificationStatus, parsed.data.confidence, parsed.data.createdAt, now);
    const row = this.db.prepare('SELECT * FROM research_graph_nodes WHERE id=?').get(parsed.data.id) as GraphNodeRow;
    return { ok: true, node: asNode(row) };
  }

  upsertEdge(input: Omit<ResearchGraphEdge, 'createdAt' | 'updatedAt'> & { createdAt?: number }):
    { ok: true; edge: ResearchGraphEdge } | { ok: false; code: GraphErrorCode } {
    const parsed = ResearchGraphEdgeSchema.safeParse({
      ...input,
      id: input.id && input.id.trim() ? input.id : `gedge-${randomUUID()}`,
      createdAt: input.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const value = parsed.data;
    const sourceExists = this.db.prepare('SELECT 1 FROM research_graph_nodes WHERE id=? AND project_id=?').get(value.sourceNodeId, input.projectId);
    const targetExists = this.db.prepare('SELECT 1 FROM research_graph_nodes WHERE id=? AND project_id=?').get(value.targetNodeId, input.projectId);
    if (!sourceExists || !targetExists) return { ok: false, code: 'research_graph_node_not_found' };
    const now = Date.now();
    const id = value.id;
    this.db.prepare(`INSERT INTO research_graph_edges
      (id,project_id,source_node_id,target_node_id,relation,provenance,evidence_ids_json,source_ids_json,verification_status,confidence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET relation=excluded.relation, provenance=excluded.provenance,
        evidence_ids_json=excluded.evidence_ids_json, source_ids_json=excluded.source_ids_json,
        verification_status=excluded.verification_status, confidence=excluded.confidence, updated_at=excluded.updated_at`)
      .run(id, input.projectId, value.sourceNodeId, value.targetNodeId, value.relation, value.provenance,
        encode(value.evidenceIds), encode(value.sourceIds), value.verificationStatus, value.confidence, value.createdAt, now);
    const row = this.db.prepare('SELECT * FROM research_graph_edges WHERE id=?').get(id) as GraphEdgeRow;
    return { ok: true, edge: asEdge(row) };
  }

  listNodes(projectId: string, filter?: { kinds?: string[]; verification?: string[] }): ResearchGraphNode[] {
    const rows = this.db.prepare('SELECT * FROM research_graph_nodes WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as GraphNodeRow[];
    return rows.map(asNode).filter((node) => (
      (!filter?.kinds || filter.kinds.includes(node.kind))
      && (!filter?.verification || filter.verification.includes(node.verificationStatus))
    ));
  }

  listEdges(projectId: string, filter?: { relations?: string[]; verification?: string[] }): ResearchGraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM research_graph_edges WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as GraphEdgeRow[];
    return rows.map(asEdge).filter((edge) => (
      (!filter?.relations || filter.relations.includes(edge.relation))
      && (!filter?.verification || filter.verification.includes(edge.verificationStatus))
    ));
  }

  getNode(projectId: string, nodeId: string): ResearchGraphNode | undefined {
    const row = this.db.prepare('SELECT * FROM research_graph_nodes WHERE id=? AND project_id=?').get(nodeId, projectId) as GraphNodeRow | undefined;
    return row ? asNode(row) : undefined;
  }

  /** 用户确认：provenance=user_confirmed；verification 最高到 supported（§23.9：≠ external verified）。 */
  confirmNode(projectId: string, nodeId: string): { ok: true; node: ResearchGraphNode } | { ok: false; code: GraphErrorCode } {
    const node = this.getNode(projectId, nodeId);
    if (!node) return { ok: false, code: 'research_graph_node_not_found' };
    return this.upsertNode({
      ...node,
      provenance: node.provenance === 'canonical' ? 'canonical' : 'user_created',
      verificationStatus: node.verificationStatus === 'verified' ? 'verified' : 'supported',
    });
  }

  confirmEdge(projectId: string, edgeId: string): { ok: true; edge: ResearchGraphEdge } | { ok: false; code: GraphErrorCode } {
    const edge = this.listEdges(projectId).find((item) => item.id === edgeId);
    if (!edge) return { ok: false, code: 'research_graph_edge_not_found' };
    return this.upsertEdge({
      ...edge,
      provenance: edge.provenance === 'canonical' ? 'canonical' : 'user_confirmed',
      verificationStatus: edge.verificationStatus === 'verified' ? 'verified' : 'supported',
    });
  }

  rejectNode(projectId: string, nodeId: string): { ok: true; node: ResearchGraphNode } | { ok: false; code: GraphErrorCode } {
    const node = this.getNode(projectId, nodeId);
    if (!node) return { ok: false, code: 'research_graph_node_not_found' };
    return this.upsertNode({ ...node, verificationStatus: 'rejected' });
  }

  rejectEdge(projectId: string, edgeId: string): { ok: true; edge: ResearchGraphEdge } | { ok: false; code: GraphErrorCode } {
    const edge = this.listEdges(projectId).find((item) => item.id === edgeId);
    if (!edge) return { ok: false, code: 'research_graph_edge_not_found' };
    return this.upsertEdge({ ...edge, verificationStatus: 'rejected' });
  }

  // ── Projection（Phase 10/11/12）：权威数据 → 确定性投影 DTO，UI 只读。──

  /**
   * Claim–Evidence Graph（T11.02/T11.03）：claims/claim_evidence_links/evidence/sources
   * 权威数据直接投影，绝不复制存储。布局 DTO：claim 左 / evidence 中 / source 右。
   */
  projectClaimEvidenceGraph(projectId: string): {
    ok: true;
    claims: Array<{ id: string; statement: string; claimType: string; status: string;
      supports: number; contradicts: number; qualifies: number }>;
    evidences: Array<{ id: string; snippet: string; sourceId: string; sourceTitle: string | null;
      anchorType: string; pageNumber: number | null; confidence: number }>;
    links: Array<{ id: string; claimId: string; evidenceId: string; relation: string; weight: number }>;
  } | { ok: false; code: GraphErrorCode } {
    try {
      const claims = (this.db.prepare('SELECT id, statement, claim_type, status FROM claims WHERE project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC').all(projectId) as Array<{ id: string; statement: string; claim_type: string; status: string }>)
        .map((claim) => ({ id: claim.id, statement: claim.statement, claimType: claim.claim_type, status: claim.status, supports: 0, contradicts: 0, qualifies: 0 }));
      const claimIndex = new Map(claims.map((claim) => [claim.id, claim]));
      const links = (this.db.prepare(`SELECT l.id, l.claim_id AS claimId, l.evidence_id AS evidenceId, l.relation, l.weight
        FROM claim_evidence_links l JOIN claims c ON c.id = l.claim_id
        WHERE c.project_id = ? AND c.deleted_at IS NULL`).all(projectId) as Array<{ id: string; claimId: string; evidenceId: string; relation: string; weight: number }>);
      for (const link of links) {
        const claim = claimIndex.get(link.claimId);
        if (claim && link.relation in claim) (claim as unknown as Record<string, number>)[link.relation] += 1;
      }
      const evidences = (this.db.prepare(`SELECT e.id, e.snippet, e.source_id, e.anchor_type, e.page_number, e.confidence, s.title AS source_title
        FROM evidence e LEFT JOIN sources s ON s.id = e.source_id
        WHERE e.project_id = ? AND e.deleted_at IS NULL`).all(projectId) as Array<{ id: string; snippet: string; source_id: string; anchor_type: string; page_number: number | null; confidence: number; source_title: string | null }>)
        .map((evidence) => ({
          id: evidence.id, snippet: evidence.snippet.slice(0, 300), sourceId: evidence.source_id,
          sourceTitle: evidence.source_title, anchorType: evidence.anchor_type,
          pageNumber: evidence.page_number, confidence: evidence.confidence,
        }));
      return { ok: true, claims, evidences, links };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  }

  /**
   * Argument Graph（T10.01/T10.02）：从 research graph 中的 claim/section/concept 节点
   * 与结构关系投影 top-down 分层 DAG（研究问题/论断/支持/结论层），不含伪精确分数。
   */
  projectArgumentGraph(projectId: string): {
    ok: true;
    layers: Array<{ layer: number; kind: string; nodes: ResearchGraphNode[] }>;
    edges: ResearchGraphEdge[];
    unverifiedCount: number;
  } | { ok: false; code: GraphErrorCode } {
    const nodes = this.listNodes(projectId);
    if (nodes.length === 0) return { ok: true, layers: [], edges: [], unverifiedCount: 0 };
    const edges = this.listEdges(projectId);
    const layerOf = (kind: string): number => ({ concept: 0, theory: 0, claim: 1, method: 1, section: 1, outcome: 2, source: 1, evidence: 1, document: 0, person: 0, institution: 0, event: 0, place: 0, variable: 1 }[kind] ?? 1);
    const layers = new Map<number, ResearchGraphNode[]>();
    for (const node of nodes) {
      const layer = layerOf(node.kind);
      const bucket = layers.get(layer) ?? [];
      bucket.push(node);
      layers.set(layer, bucket);
    }
    return {
      ok: true,
      layers: [...layers.entries()].sort(([a], [b]) => a - b).map(([layer, bucket]) => ({ layer, kind: bucket[0]?.kind ?? 'claim', nodes: bucket })),
      edges,
      unverifiedCount: nodes.filter((node) => node.verificationStatus === 'unverified').length,
    };
  }

  /**
   * Project Knowledge Graph（T12.06/T12.07）：全量节点/边 + 过滤参数；
   * hiddenConnection 列出 AI 推断且未验证的关系（必须带依据并经确认流程）。
   */
  projectKnowledgeGraph(projectId: string, filter?: {
    kinds?: string[]; relations?: string[]; verification?: string[]; limit?: number;
  }): { nodes: ResearchGraphNode[]; edges: ResearchGraphEdge[]; hiddenConnections: Array<{ edge: ResearchGraphEdge; sourceLabel: string; targetLabel: string }> } {
    const nodes = this.listNodes(projectId, { kinds: filter?.kinds, verification: filter?.verification }).slice(0, filter?.limit ?? 500);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = this.listEdges(projectId, { relations: filter?.relations, verification: filter?.verification })
      .filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId));
    const labels = new Map(nodes.map((node) => [node.id, node.label]));
    const hiddenConnections = edges
      .filter((edge) => edge.provenance === 'ai_extracted' && edge.verificationStatus === 'unverified')
      .slice(0, 20)
      .map((edge) => ({
        edge,
        sourceLabel: labels.get(edge.sourceNodeId) ?? edge.sourceNodeId,
        targetLabel: labels.get(edge.targetNodeId) ?? edge.targetNodeId,
      }));
    return { nodes, edges, hiddenConnections };
  }

  /** T09.06 去重第 1/2 层：canonical 完全相同 → 同一节点；label 规范化相同 → 候选复用。 */
  findDeduplicationCandidate(projectId: string, input: { canonicalEntityType: string | null; canonicalEntityId: string | null; label: string }): ResearchGraphNode | undefined {
    if (input.canonicalEntityType && input.canonicalEntityId) {
      const row = this.db.prepare('SELECT * FROM research_graph_nodes WHERE project_id=? AND canonical_entity_type=? AND canonical_entity_id=? LIMIT 1')
        .get(projectId, input.canonicalEntityType, input.canonicalEntityId) as GraphNodeRow | undefined;
      if (row) return asNode(row);
    }
    const normalized = input.label.trim().toLowerCase();
    if (!normalized) return undefined;
    const row = this.db.prepare('SELECT * FROM research_graph_nodes WHERE project_id=? AND lower(label)=? LIMIT 1')
      .get(projectId, normalized) as GraphNodeRow | undefined;
    return row ? asNode(row) : undefined;
  }
}
