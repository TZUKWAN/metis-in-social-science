/**
 * OutcomeWorkbenchService — Outcomes 2.0 编辑核心（任务书 Phase 2/3）。
 *
 * 职责边界：
 *  - Working Draft：读取优先级、autosave 持久化、baseVersion 冲突对账（T01.01/T01.02/T02.x）。
 *  - Snapshot：去重、保留上限（自动 50）、恢复到 Draft 而非 Version（T01.03/T02.05/T02.06）。
 *  - Revision Engine：提案生成（Runtime 计算 beforeHash，模型不可信）、Accept/Reject/
 *    AcceptAll、逐条 hash 验证、set 状态机由本服务统一计算（T03.x，任务书 §28 FAIL 3 的防线）。
 *
 * 铁律：本服务永远不写 outcome_versions；只有显式 saveVersion 路径（renderer 调既有
 * outcomes:save + Office sync）创建正式版本。
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  OutcomeDocumentSchema,
  type OutcomeDocument,
  type OutcomeSummary,
} from '../engine/runtime/OutcomeRuntimeContract.js';
import {
  OUTCOME_SNAPSHOT_AUTO_LIMIT,
  OutcomeRevisionSchema,
  OutcomeRevisionSetSchema,
  OutcomeRevisionTargetInputSchema,
  OutcomeSnapshotReasonSchema,
  OutcomeWorkingDraftSchema,
  type OutcomeRevision,
  type OutcomeRevisionSet,
  type OutcomeRevisionTarget,
  type OutcomeSnapshot,
  type OutcomeWorkingDraft,
} from '../engine/runtime/OutcomeWorkbenchContract.js';
import type { OutcomeRepository } from './OutcomeRepository.js';

export type WorkbenchErrorCode =
  | 'outcome_draft_not_found'
  | 'outcome_draft_conflict'
  | 'outcome_revision_not_found'
  | 'outcome_revision_stale'
  | 'outcome_revision_target_missing'
  | 'outcome_revision_already_resolved'
  | 'outcome_revision_set_stale'
  | 'outcome_not_found'
  | 'invalid_request';

export type WorkbenchResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: WorkbenchErrorCode; message?: string };

const encode = (value: unknown): string => JSON.stringify(value);
const decode = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

/** 与 OutcomeRepository 相同的 canonical hash（sha256(canonical JSON)）。 */
export function outcomeContentHash(document: OutcomeDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

interface DraftRow {
  outcome_id: string; project_id: string; base_version: number; content: string;
  content_hash: string; updated_by: string; updated_at: number;
}
interface SnapshotRow {
  id: string; project_id: string; outcome_id: string; base_version: number; content: string;
  content_hash: string; reason: string; created_at: number;
}
interface RevisionSetRow {
  id: string; project_id: string; outcome_id: string; base_version: number; base_draft_hash: string;
  conversation_id: string | null; review_issue_id: string | null; instruction: string;
  created_by: string; status: string; created_at: number; updated_at: number;
}
interface RevisionRow {
  id: string; revision_set_id: string; sort_order: number; target_json: string; before_json: string | null;
  after_json: string | null; reason: string; source_refs_json: string; evidence_ids_json: string;
  status: string; created_at: number; resolved_at: number | null;
}

const asDraft = (row: DraftRow): OutcomeWorkingDraft => ({
  outcomeId: row.outcome_id, projectId: row.project_id, baseVersion: row.base_version,
  content: decode<OutcomeDocument>(row.content, { type: 'other', text: '', media: null }),
  contentHash: row.content_hash, updatedBy: row.updated_by as OutcomeWorkingDraft['updatedBy'], updatedAt: row.updated_at,
});
const asSnapshot = (row: SnapshotRow): OutcomeSnapshot => ({
  id: row.id, projectId: row.project_id, outcomeId: row.outcome_id, baseVersion: row.base_version,
  content: decode<OutcomeDocument>(row.content, { type: 'other', text: '', media: null }),
  contentHash: row.content_hash, reason: row.reason as OutcomeSnapshot['reason'], createdAt: row.created_at,
});
const asSet = (row: RevisionSetRow): OutcomeRevisionSet => ({
  id: row.id, projectId: row.project_id, outcomeId: row.outcome_id, baseVersion: row.base_version,
  baseDraftHash: row.base_draft_hash, conversationId: row.conversation_id, reviewIssueId: row.review_issue_id,
  instruction: row.instruction, createdBy: row.created_by as OutcomeRevisionSet['createdBy'],
  status: row.status as OutcomeRevisionSet['status'], createdAt: row.created_at, updatedAt: row.updated_at,
});
const asRevision = (row: RevisionRow): OutcomeRevision => ({
  id: row.id, revisionSetId: row.revision_set_id, order: row.sort_order,
  target: decode<OutcomeRevisionTarget>(row.target_json, { kind: 'word_block', blockId: 'unknown', beforeHash: '00000000' }),
  before: decode<unknown>(row.before_json, null), after: decode<unknown>(row.after_json, null),
  reason: row.reason, sourceRefs: decode<OutcomeRevision['sourceRefs']>(row.source_refs_json, []),
  evidenceIds: decode<OutcomeRevision['evidenceIds']>(row.evidence_ids_json, []),
  status: row.status as OutcomeRevision['status'], createdAt: row.created_at, resolvedAt: row.resolved_at,
});

export interface RevisionProposalInput {
  target: RevisionTargetInput;
  after: unknown;
  reason: string;
  sourceRefs?: OutcomeRevision['sourceRefs'];
  evidenceIds?: OutcomeRevision['evidenceIds'];
}

/** 分布式 Omit：保持 discriminated union 的窄化能力（TS 内建 Omit 会塌缩 union）。 */
export type RevisionTargetInput = OutcomeRevisionTarget extends infer T
  ? T extends unknown ? Omit<T, 'beforeHash'> : never
  : never;

export class OutcomeWorkbenchService {
  constructor(
    private readonly db: Database.Database,
    private readonly outcomes: OutcomeRepository,
  ) {}

  private owned(projectId: string, outcomeId: string): OutcomeSummary | undefined {
    return this.outcomes.list(projectId).find((item) => item.id === outcomeId);
  }

  // ── Working Draft（T01.01 / T02.01 / T02.03 / T02.04 对账） ─────────────
  /** 打开成果的读取优先级入口：有 draft → draft；无 → 从 version 初始化。 */
  openForEdit(projectId: string, outcomeId: string, requestedVersion?: number):
    { outcome: OutcomeSummary; draft: OutcomeWorkingDraft; conflict: boolean; requestedHistorical: boolean } | undefined {
    const outcome = this.owned(projectId, outcomeId);
    if (!outcome || outcome.currentVersion < 1) return undefined;
    const requestedHistorical = requestedVersion !== undefined && requestedVersion !== outcome.currentVersion;
    const row = this.db.prepare('SELECT * FROM outcome_working_drafts WHERE outcome_id = ?').get(outcomeId) as DraftRow | undefined;
    if (row) {
      const draft = asDraft(row);
      const conflict = draft.baseVersion < outcome.currentVersion;
      // 历史版本只读打开时绝不覆盖/触碰 current draft。
      return { outcome, draft, conflict, requestedHistorical };
    }
    const base = requestedVersion ?? outcome.currentVersion;
    const version = this.outcomes.get(projectId, outcomeId, base);
    if (!version) return undefined;
    const draft = this.insertDraft(projectId, outcomeId, base, version.version.content, 'human');
    return { outcome, draft, conflict: false, requestedHistorical };
  }

  getDraft(projectId: string, outcomeId: string): OutcomeWorkingDraft | undefined {
    const row = this.db.prepare('SELECT * FROM outcome_working_drafts WHERE outcome_id = ? AND project_id = ?').get(outcomeId, projectId) as DraftRow | undefined;
    return row ? asDraft(row) : undefined;
  }

  /**
   * 保存草稿（autosave 与显式保存共用）。scope 绑定 projectId+outcomeId；
   * outcome.current_version 已前进时返回 conflict（T01.02，禁止自动覆盖）。
   */
  saveDraft(projectId: string, outcomeId: string, input: {
    baseVersion: number; content: unknown; updatedBy: OutcomeWorkingDraft['updatedBy'];
    /** UI 已向用户展示冲突并选择保留草稿副本时允许写入旧 base。 */
    force?: boolean;
  }): WorkbenchResult<{ draft: OutcomeWorkingDraft; conflict: false } | { draft: OutcomeWorkingDraft; conflict: true }> {
    const outcome = this.owned(projectId, outcomeId);
    if (!outcome) return { ok: false, code: 'outcome_not_found' };
    const content = OutcomeDocumentSchema.safeParse(input.content);
    if (!content.success) return { ok: false, code: 'invalid_request', message: 'draft document failed contract validation' };
    const existing = this.getDraft(projectId, outcomeId);
    if (input.baseVersion < outcome.currentVersion && !input.force) {
      return { ok: false, code: 'outcome_draft_conflict', message: `draft base v${input.baseVersion} behind current v${outcome.currentVersion}` };
    }
    const baseVersion = input.baseVersion;
    if (existing) {
      this.db.prepare('UPDATE outcome_working_drafts SET base_version=?, content=?, content_hash=?, updated_by=?, updated_at=? WHERE outcome_id=?')
        .run(baseVersion, encode(content.data), outcomeContentHash(content.data), input.updatedBy, Date.now(), outcomeId);
    } else {
      this.insertDraft(projectId, outcomeId, baseVersion, content.data, input.updatedBy);
    }
    const draft = this.getDraft(projectId, outcomeId)!;
    return { ok: true, value: { draft, conflict: false } };
  }

  clearDraft(projectId: string, outcomeId: string): boolean {
    return this.db.prepare('DELETE FROM outcome_working_drafts WHERE outcome_id = ? AND project_id = ?').run(outcomeId, projectId).changes > 0;
  }

  /** T01.02 冲突解决：discard=放弃草稿并落到当前版本；keep=保留草稿副本（base 不变，明确标记）；rebase=以当前版本重建草稿。 */
  resolveDraftConflict(projectId: string, outcomeId: string, action: 'discard' | 'keep' | 'rebase'): WorkbenchResult<{ draft: OutcomeWorkingDraft | null }> {
    const outcome = this.owned(projectId, outcomeId);
    if (!outcome) return { ok: false, code: 'outcome_not_found' };
    if (action === 'discard') {
      this.clearDraft(projectId, outcomeId);
      const opened = this.openForEdit(projectId, outcomeId);
      return { ok: true, value: { draft: opened?.draft ?? null } };
    }
    if (action === 'rebase') {
      this.clearDraft(projectId, outcomeId);
      const opened = this.openForEdit(projectId, outcomeId);
      return { ok: true, value: { draft: opened?.draft ?? null } };
    }
    const draft = this.getDraft(projectId, outcomeId);
    if (!draft) return { ok: false, code: 'outcome_draft_not_found' };
    return { ok: true, value: { draft } };
  }

  private insertDraft(projectId: string, outcomeId: string, baseVersion: number, content: OutcomeDocument, updatedBy: OutcomeWorkingDraft['updatedBy']): OutcomeWorkingDraft {
    const now = Date.now();
    const draft: OutcomeWorkingDraft = OutcomeWorkingDraftSchema.parse({
      outcomeId, projectId, baseVersion, content, contentHash: outcomeContentHash(content), updatedBy, updatedAt: now,
    });
    this.db.prepare(`INSERT INTO outcome_working_drafts (outcome_id,project_id,base_version,content,content_hash,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(outcome_id) DO UPDATE SET base_version=excluded.base_version, content=excluded.content,
        content_hash=excluded.content_hash, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(outcomeId, projectId, baseVersion, encode(content), draft.contentHash, updatedBy, now);
    return draft;
  }

  // ── Snapshot（T01.03 / T02.05 / T02.06） ────────────────────────────────
  createSnapshot(projectId: string, outcomeId: string, reason: OutcomeSnapshot['reason'], content?: OutcomeDocument, baseVersion?: number): WorkbenchResult<OutcomeSnapshot> {
    const outcome = this.owned(projectId, outcomeId);
    if (!outcome) return { ok: false, code: 'outcome_not_found' };
    OutcomeSnapshotReasonSchema.parse(reason);
    let document: OutcomeDocument;
    let base: number;
    if (content !== undefined) {
      const parsed = OutcomeDocumentSchema.safeParse(content);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      document = parsed.data;
      base = baseVersion ?? outcome.currentVersion;
    } else {
      const draft = this.getDraft(projectId, outcomeId);
      if (draft) { document = draft.content; base = draft.baseVersion; }
      else {
        const version = this.outcomes.get(projectId, outcomeId);
        if (!version) return { ok: false, code: 'outcome_not_found' };
        document = version.version.content;
        base = outcome.currentVersion;
      }
    }
    const hash = outcomeContentHash(document);
    // 同 contentHash 不重复创建。
    const dup = this.db.prepare('SELECT id FROM outcome_snapshots WHERE outcome_id=? AND content_hash=? ORDER BY created_at DESC LIMIT 1').get(outcomeId, hash) as { id: string } | undefined;
    if (dup) {
      const existing = this.db.prepare('SELECT * FROM outcome_snapshots WHERE id = ?').get(dup.id) as SnapshotRow;
      return { ok: true, value: asSnapshot(existing) };
    }
    const now = Date.now();
    const id = `snap-${randomUUID()}`;
    this.db.prepare(`INSERT INTO outcome_snapshots (id,project_id,outcome_id,base_version,content,content_hash,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, projectId, outcomeId, base, encode(document), hash, reason, now);
    // 自动快照保留上限（手动快照不参与淘汰）。
    if (reason === 'autosave' || reason === 'before_ai_revision' || reason === 'before_import' || reason === 'before_office_sync' || reason === 'before_restore') {
      const autos = this.db.prepare("SELECT id FROM outcome_snapshots WHERE outcome_id=? AND reason<>'manual' ORDER BY created_at DESC").all(outcomeId) as Array<{ id: string }>;
      for (const stale of autos.slice(OUTCOME_SNAPSHOT_AUTO_LIMIT)) {
        this.db.prepare('DELETE FROM outcome_snapshots WHERE id = ?').run(stale.id);
      }
    } else {
      const manual = this.db.prepare("SELECT id FROM outcome_snapshots WHERE outcome_id=? AND reason='manual' ORDER BY created_at DESC").all(outcomeId) as Array<{ id: string }>;
      for (const stale of manual.slice(OUTCOME_SNAPSHOT_AUTO_LIMIT)) {
        this.db.prepare('DELETE FROM outcome_snapshots WHERE id = ?').run(stale.id);
      }
    }
    const row = this.db.prepare('SELECT * FROM outcome_snapshots WHERE id = ?').get(id) as SnapshotRow;
    return { ok: true, value: asSnapshot(row) };
  }

  listSnapshots(projectId: string, outcomeId: string): OutcomeSnapshot[] {
    return (this.db.prepare('SELECT * FROM outcome_snapshots WHERE outcome_id=? AND project_id=? ORDER BY created_at DESC')
      .all(outcomeId, projectId) as SnapshotRow[]).map(asSnapshot);
  }

  getSnapshot(projectId: string, snapshotId: string): OutcomeSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM outcome_snapshots WHERE id=? AND project_id=?').get(snapshotId, projectId) as SnapshotRow | undefined;
    return row ? asSnapshot(row) : undefined;
  }

  /** 恢复快照：只写 Working Draft，正式 Version 不变化（T02.06）。 */
  restoreSnapshot(projectId: string, snapshotId: string): WorkbenchResult<{ draft: OutcomeWorkingDraft; snapshot: OutcomeSnapshot }> {
    const snapshot = this.getSnapshot(projectId, snapshotId);
    if (!snapshot) return { ok: false, code: 'outcome_draft_not_found', message: 'snapshot not found' };
    const outcome = this.owned(projectId, snapshot.outcomeId);
    if (!outcome) return { ok: false, code: 'outcome_not_found' };
    const existing = this.getDraft(projectId, snapshot.outcomeId);
    const baseVersion = existing ? existing.baseVersion : outcome.currentVersion;
    const saved = this.saveDraft(projectId, snapshot.outcomeId, {
      baseVersion, content: snapshot.content, updatedBy: 'human', force: true,
    });
    if (!saved.ok) return saved;
    return { ok: true, value: { draft: saved.value.draft, snapshot } };
  }

  purgeSnapshots(projectId: string, outcomeId: string, scope: 'auto' | 'all'): number {
    if (!this.owned(projectId, outcomeId)) return 0;
    if (scope === 'all') {
      return this.db.prepare('DELETE FROM outcome_snapshots WHERE outcome_id=? AND project_id=?').run(outcomeId, projectId).changes;
    }
    return this.db.prepare("DELETE FROM outcome_snapshots WHERE outcome_id=? AND project_id=? AND reason<>'manual'").run(outcomeId, projectId).changes;
  }

  // ── Revision Engine（Phase 3，任务书核心） ──────────────────────────────
  /** Runtime 计算 before/beforeHash：模型提案只给 target 定位与 after。 */
  private resolveTargetBefore(draft: OutcomeWorkingDraft, target: RevisionTargetInput):
    { beforeHash: string; before: unknown } | { error: 'outcome_revision_target_missing' } {
    if (draft.content.type === 'word') {
      const block = draft.content.blocks.find((item) => item.id === (target as { blockId?: string }).blockId);
      if (!block) return { error: 'outcome_revision_target_missing' };
      if (target.kind === 'word_block') return { beforeHash: outcomeContentHash(block as unknown as OutcomeDocument), before: block };
      if (target.kind === 'word_range') {
        const text = block.text ?? '';
        const start = Math.min(target.start, text.length);
        const end = Math.min(target.end, text.length);
        if (start > end) return { error: 'outcome_revision_target_missing' };
        const slice = text.slice(start, end);
        if (!slice) return { error: 'outcome_revision_target_missing' };
        return { beforeHash: outcomeContentHash(slice as unknown as OutcomeDocument), before: slice };
      }
      if (target.kind === 'word_table_cell') {
        const row = block.rows?.[target.row];
        const cell = row?.[target.column];
        if (cell === undefined) return { error: 'outcome_revision_target_missing' };
        return { beforeHash: outcomeContentHash(cell as unknown as OutcomeDocument), before: cell };
      }
      return { error: 'outcome_revision_target_missing' };
    }
    if (draft.content.type === 'ppt') {
      const page = draft.content.pages.find((item) => item.id === (target as { pageId?: string }).pageId);
      if (!page) return { error: 'outcome_revision_target_missing' };
      if (target.kind === 'ppt_page') return { beforeHash: outcomeContentHash(page as unknown as OutcomeDocument), before: page };
      if (target.kind === 'ppt_element') {
        const element = page.elements.find((item) => item.id === (target as { elementId?: string }).elementId);
        if (!element) return { error: 'outcome_revision_target_missing' };
        return { beforeHash: outcomeContentHash(element as unknown as OutcomeDocument), before: element };
      }
      return { error: 'outcome_revision_target_missing' };
    }
    return { error: 'outcome_revision_target_missing' };
  }

  /** 当前 target 的实时 hash（accept 前验证）。target 已不存在 → undefined。 */
  private currentTargetHash(draft: OutcomeWorkingDraft, target: OutcomeRevisionTarget): string | undefined {
    const resolved = this.resolveTargetBefore(draft, target);
    return 'beforeHash' in resolved ? resolved.beforeHash : undefined;
  }

  createRevisionSet(input: {
    projectId: string; outcomeId: string; instruction: string; createdBy: OutcomeRevisionSet['createdBy'];
    conversationId?: string | null; reviewIssueId?: string | null;
    proposals: RevisionProposalInput[];
  }): WorkbenchResult<{ set: OutcomeRevisionSet; revisions: OutcomeRevision[] }> {
    if (input.proposals.length === 0) return { ok: false, code: 'invalid_request', message: 'empty revision set' };
    const outcome = this.owned(input.projectId, input.outcomeId);
    if (!outcome) return { ok: false, code: 'outcome_not_found' };
    let draft = this.getDraft(input.projectId, input.outcomeId);
    if (!draft) {
      const opened = this.openForEdit(input.projectId, input.outcomeId);
      if (!opened) return { ok: false, code: 'outcome_not_found' };
      draft = opened.draft;
    }
    // 逐条 Runtime 验证 + beforeHash 计算；任何 target 缺失 → 整组拒绝（绝不尽力套用）。
    const prepared: Array<{ revision: OutcomeRevision }> = [];
    const now = Date.now();
    const setId = `revset-${randomUUID()}`;
    for (const [index, proposal] of input.proposals.entries()) {
      const targetParse = OutcomeRevisionTargetInputSchema.safeParse(proposal.target);
      if (!targetParse.success) return { ok: false, code: 'invalid_request', message: `proposal ${index} target invalid` };
      const resolved = this.resolveTargetBefore(draft, targetParse.data);
      if ('error' in resolved) return { ok: false, code: resolved.error, message: `proposal ${index} target missing` };
      prepared.push({
        revision: OutcomeRevisionSchema.parse({
          id: `rev-${randomUUID()}`,
          revisionSetId: setId,
          order: index,
          target: { ...targetParse.data, beforeHash: resolved.beforeHash },
          before: resolved.before,
          after: proposal.after,
          reason: proposal.reason.slice(0, 8_000),
          sourceRefs: proposal.sourceRefs ?? [],
          evidenceIds: proposal.evidenceIds ?? [],
          status: 'pending',
          createdAt: now,
          resolvedAt: null,
        }),
      });
    }
    const set = OutcomeRevisionSetSchema.parse({
      id: setId, projectId: input.projectId, outcomeId: input.outcomeId,
      baseVersion: outcome.currentVersion, baseDraftHash: draft.contentHash,
      conversationId: input.conversationId ?? null, reviewIssueId: input.reviewIssueId ?? null,
      instruction: input.instruction.slice(0, 8_000), createdBy: input.createdBy,
      status: 'pending', createdAt: now, updatedAt: now,
    });
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO outcome_revision_sets
        (id,project_id,outcome_id,base_version,base_draft_hash,conversation_id,review_issue_id,instruction,created_by,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(set.id, set.projectId, set.outcomeId, set.baseVersion, set.baseDraftHash, set.conversationId,
          set.reviewIssueId, set.instruction, set.createdBy, set.status, set.createdAt, set.updatedAt);
      for (const item of prepared) {
        this.db.prepare(`INSERT INTO outcome_revisions
          (id,revision_set_id,sort_order,target_json,before_json,after_json,reason,source_refs_json,evidence_ids_json,status,created_at,resolved_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(item.revision.id, setId, item.revision.order, encode(item.revision.target), encode(item.revision.before),
            encode(item.revision.after), item.revision.reason, encode(item.revision.sourceRefs),
            encode(item.revision.evidenceIds), item.revision.status, item.revision.createdAt, null);
      }
    })();
    const revisions = this.listRevisions(setId);
    return { ok: true, value: { set, revisions } };
  }

  getRevisionSet(projectId: string, setId: string): { set: OutcomeRevisionSet; revisions: OutcomeRevision[] } | undefined {
    const row = this.db.prepare('SELECT * FROM outcome_revision_sets WHERE id=? AND project_id=?').get(setId, projectId) as RevisionSetRow | undefined;
    if (!row) return undefined;
    return { set: asSet(row), revisions: this.listRevisions(setId) };
  }

  listRevisionSets(projectId: string, outcomeId: string): OutcomeRevisionSet[] {
    return (this.db.prepare('SELECT * FROM outcome_revision_sets WHERE outcome_id=? AND project_id=? ORDER BY updated_at DESC')
      .all(outcomeId, projectId) as RevisionSetRow[]).map(asSet);
  }

  listRevisions(setId: string): OutcomeRevision[] {
    return (this.db.prepare('SELECT * FROM outcome_revisions WHERE revision_set_id=? ORDER BY sort_order ASC')
      .all(setId) as RevisionRow[]).map(asRevision);
  }

  /**
   * Accept（T03.03）：十步严格流程——pending 检查、set 状态检查、target 存在检查、
   * beforeHash 实时验证、apply 到 Draft、状态持久化，全程不创建 Version。
   */
  acceptRevision(projectId: string, setId: string, revisionId: string): WorkbenchResult<{ draft: OutcomeWorkingDraft; revision: OutcomeRevision; set: OutcomeRevisionSet }> {
    const bundle = this.getRevisionSet(projectId, setId);
    if (!bundle) return { ok: false, code: 'outcome_revision_not_found' };
    const { set } = bundle;
    const revision = bundle.revisions.find((item) => item.id === revisionId);
    if (!revision) return { ok: false, code: 'outcome_revision_not_found' };
    if (set.status === 'stale' || set.status === 'cancelled' || set.status === 'rejected' || set.status === 'accepted') {
      return { ok: false, code: 'outcome_revision_set_stale', message: `set is ${set.status}` };
    }
    if (revision.status !== 'pending') {
      return { ok: false, code: 'outcome_revision_already_resolved', message: `revision is ${revision.status}` };
    }
    let draft = this.getDraft(projectId, set.outcomeId);
    if (!draft) {
      const opened = this.openForEdit(projectId, set.outcomeId);
      if (!opened) return { ok: false, code: 'outcome_not_found' };
      draft = opened.draft;
    }
    // 逐 target 实时 hash 验证（T03.06：用户手改后 → stale，禁止覆盖）。
    const currentHash = this.currentTargetHash(draft, revision.target);
    if (currentHash === undefined) {
      this.db.prepare("UPDATE outcome_revisions SET status='stale', resolved_at=? WHERE id=?").run(Date.now(), revisionId);
      this.refreshSetStatus(setId);
      return { ok: false, code: 'outcome_revision_target_missing' };
    }
    if (currentHash !== revision.target.beforeHash) {
      this.db.prepare("UPDATE outcome_revisions SET status='stale', resolved_at=? WHERE id=?").run(Date.now(), revisionId);
      this.refreshSetStatus(setId);
      return { ok: false, code: 'outcome_revision_stale', message: 'target content changed since the proposal' };
    }
    const applied = this.applyRevisionToDraft(draft, revision);
    if (!applied) {
      this.db.prepare("UPDATE outcome_revisions SET status='stale', resolved_at=? WHERE id=?").run(Date.now(), revisionId);
      this.refreshSetStatus(setId);
      return { ok: false, code: 'outcome_revision_target_missing' };
    }
    const saved = this.saveDraft(projectId, set.outcomeId, {
      baseVersion: draft.baseVersion, content: applied, updatedBy: 'ai_revision', force: true,
    });
    if (!saved.ok) return saved;
    this.db.prepare("UPDATE outcome_revisions SET status='accepted', resolved_at=? WHERE id=?").run(Date.now(), revisionId);
    this.refreshSetStatus(setId);
    return {
      ok: true,
      value: {
        draft: this.getDraft(projectId, set.outcomeId)!,
        revision: this.listRevisions(setId).find((item) => item.id === revisionId)!,
        set: this.getRevisionSet(projectId, setId)!.set,
      },
    };
  }

  /** Reject（T03.04）：不触碰 Draft。 */
  rejectRevision(projectId: string, setId: string, revisionId: string): WorkbenchResult<{ revision: OutcomeRevision; set: OutcomeRevisionSet }> {
    const bundle = this.getRevisionSet(projectId, setId);
    if (!bundle) return { ok: false, code: 'outcome_revision_not_found' };
    const revision = bundle.revisions.find((item) => item.id === revisionId);
    if (!revision) return { ok: false, code: 'outcome_revision_not_found' };
    if (revision.status !== 'pending') {
      return { ok: false, code: 'outcome_revision_already_resolved', message: `revision is ${revision.status}` };
    }
    this.db.prepare("UPDATE outcome_revisions SET status='rejected', resolved_at=? WHERE id=?").run(Date.now(), revisionId);
    this.refreshSetStatus(setId);
    return { ok: true, value: { revision: this.listRevisions(setId).find((item) => item.id === revisionId)!, set: this.getRevisionSet(projectId, setId)!.set } };
  }

  /** Accept All（T03.05）：按 order 逐条独立验证；返回汇总计数。 */
  acceptRevisionSet(projectId: string, setId: string): WorkbenchResult<{
    accepted: number; stale: number; rejected: number; failed: number; draft: OutcomeWorkingDraft | null;
  }> {
    const bundle = this.getRevisionSet(projectId, setId);
    if (!bundle) return { ok: false, code: 'outcome_revision_not_found' };
    let accepted = 0; let stale = 0; let rejected = 0; let failed = 0;
    let draft: OutcomeWorkingDraft | null = this.getDraft(projectId, bundle.set.outcomeId) ?? null;
    for (const revision of bundle.revisions) {
      if (revision.status !== 'pending') {
        if (revision.status === 'accepted') accepted += 1;
        else if (revision.status === 'rejected') rejected += 1;
        else stale += 1;
        continue;
      }
      const result = this.acceptRevision(projectId, setId, revision.id);
      if (result.ok) { accepted += 1; draft = result.value.draft; }
      else if (result.code === 'outcome_revision_stale' || result.code === 'outcome_revision_target_missing') stale += 1;
      else failed += 1;
    }
    return { ok: true, value: { accepted, stale, rejected, failed, draft } };
  }

  rejectRevisionSet(projectId: string, setId: string): WorkbenchResult<{ rejected: number }> {
    const bundle = this.getRevisionSet(projectId, setId);
    if (!bundle) return { ok: false, code: 'outcome_revision_not_found' };
    const now = Date.now();
    this.db.transaction(() => {
      for (const revision of bundle.revisions) {
        if (revision.status === 'pending') {
          this.db.prepare("UPDATE outcome_revisions SET status='rejected', resolved_at=? WHERE id=?").run(now, revision.id);
        }
      }
    })();
    this.refreshSetStatus(setId);
    const fresh = this.getRevisionSet(projectId, setId)!;
    return { ok: true, value: { rejected: fresh.revisions.filter((item) => item.status === 'rejected').length } };
  }

  /** Office sync / 大改后批量对账：逐条 hash 检查（T14.04）。返回标 stale 的条数。 */
  markStaleByHash(projectId: string, outcomeId: string): number {
    const sets = this.listRevisionSets(projectId, outcomeId);
    const draft = this.getDraft(projectId, outcomeId);
    if (!draft) return 0;
    let marked = 0;
    const now = Date.now();
    for (const set of sets) {
      for (const revision of this.listRevisions(set.id)) {
        if (revision.status !== 'pending') continue;
        const currentHash = this.currentTargetHash(draft, revision.target);
        if (currentHash === undefined || currentHash !== revision.target.beforeHash) {
          this.db.prepare("UPDATE outcome_revisions SET status='stale', resolved_at=? WHERE id=?").run(now, revision.id);
          marked += 1;
        }
      }
      this.refreshSetStatus(set.id);
    }
    return marked;
  }

  cancelRevisionSet(projectId: string, setId: string): WorkbenchResult<{ set: OutcomeRevisionSet }> {
    const bundle = this.getRevisionSet(projectId, setId);
    if (!bundle) return { ok: false, code: 'outcome_revision_not_found' };
    this.db.prepare("UPDATE outcome_revision_sets SET status='cancelled', updated_at=? WHERE id=?").run(Date.now(), setId);
    return { ok: true, value: { set: this.getRevisionSet(projectId, setId)!.set } };
  }

  /** T03.09：set 状态由 Repository/Service 统一计算，renderer 不许自己猜。 */
  private refreshSetStatus(setId: string): void {
    const revisions = this.listRevisions(setId);
    const counts = {
      pending: revisions.filter((item) => item.status === 'pending').length,
      accepted: revisions.filter((item) => item.status === 'accepted').length,
      rejected: revisions.filter((item) => item.status === 'rejected').length,
      stale: revisions.filter((item) => item.status === 'stale').length,
    };
    const setRow = this.db.prepare('SELECT status FROM outcome_revision_sets WHERE id=?').get(setId) as { status: string } | undefined;
    if (!setRow) return;
    let status: OutcomeRevisionSet['status'];
    if (setRow.status === 'cancelled') return; // 用户取消是终态
    if (counts.pending === revisions.length) status = 'pending';
    else if (counts.accepted === revisions.length) status = 'accepted';
    else if (counts.rejected > 0 && counts.pending === 0 && counts.accepted === 0) status = 'rejected';
    else if (counts.stale > 0 && counts.pending === 0) status = 'stale';
    else if (counts.pending > 0) status = 'partially_accepted';
    else status = 'partially_accepted';
    this.db.prepare('UPDATE outcome_revision_sets SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), setId);
  }

  /** 把 revision.after 应用到 draft 的对应 target，返回新 document；目标缺失返回 null。 */
  private applyRevisionToDraft(draft: OutcomeWorkingDraft, revision: OutcomeRevision): OutcomeDocument | null {
    const document = draft.content;
    if (document.type === 'word') {
      const index = document.blocks.findIndex((item) => item.id === (revision.target as { blockId?: string }).blockId);
      if (index < 0) return null;
      const blocks = [...document.blocks];
      const block = blocks[index]!;
      if (revision.target.kind === 'word_block') {
        const after = revision.after as { text?: string; style?: Record<string, unknown> };
        blocks[index] = { ...block, text: after.text ?? block.text, ...(after.style ? { style: after.style } : {}) };
      } else if (revision.target.kind === 'word_range') {
        const after = revision.after as { text: string };
        const text = block.text ?? '';
        const start = Math.min(revision.target.start, text.length);
        const end = Math.min(revision.target.end, text.length);
        blocks[index] = { ...block, text: text.slice(0, start) + after.text + text.slice(end) };
      } else if (revision.target.kind === 'word_table_cell') {
        const targetRow = revision.target.row;
        const targetColumn = revision.target.column;
        if (!block.rows || !block.rows[targetRow]) return null;
        const after = revision.after as { text: string };
        const rows = block.rows.map((row, rowIndex) => (
          rowIndex === targetRow
            ? row.map((cell, columnIndex) => (columnIndex === targetColumn ? after.text : cell))
            : row
        ));
        blocks[index] = { ...block, rows };
      } else {
        return null;
      }
      return { ...document, blocks };
    }
    if (document.type === 'ppt') {
      const targetPageId = (revision.target as { pageId?: string }).pageId;
      const pageIndex = document.pages.findIndex((item) => item.id === targetPageId);
      if (pageIndex < 0) return null;
      const pages = [...document.pages];
      const page = pages[pageIndex]!;
      if (revision.target.kind === 'ppt_page') {
        const after = revision.after as { title?: string; elements?: typeof page.elements };
        pages[pageIndex] = {
          ...page,
          ...(after.title !== undefined ? { title: after.title } : {}),
          ...(after.elements !== undefined ? { elements: after.elements } : {}),
        };
      } else if (revision.target.kind === 'ppt_element') {
        const targetElementId = (revision.target as { elementId?: string }).elementId;
        const elementIndex = page.elements.findIndex((item) => item.id === targetElementId);
        if (elementIndex < 0) return null;
        const after = revision.after as { props?: Record<string, unknown> } & Partial<typeof page.elements[number]>;
        const elements = [...page.elements];
        elements[elementIndex] = { ...elements[elementIndex]!, ...after } as typeof elements[number];
        pages[pageIndex] = { ...page, elements };
      } else {
        return null;
      }
      return { ...document, pages };
    }
    return null;
  }
}
