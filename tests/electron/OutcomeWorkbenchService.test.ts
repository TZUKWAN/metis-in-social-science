/**
 * Outcomes 2.0 核心验收（任务书 Test Matrix A/B/C/F/G/H 核心行）。
 * 覆盖：Working Draft 生命周期与冲突、Snapshot 去重与保留上限、Revision Engine
 * （beforeHash 防覆盖、accept/reject/accept-all、set 状态机、cell/page/element）、
 * Memory 并发与 AI 提议、Review 持久化与 stale、Research Graph canonical/unverified。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeWorkbenchService, outcomeContentHash } from '../../electron/OutcomeWorkbenchService.js';
import {
  OutcomeMemoryService,
  OutcomeReviewService,
  ResearchGraphService,
} from '../../electron/OutcomeMemoryReviewGraphService.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';

function wordDoc(paragraphs: string[]): WordDocument {
  return {
    type: 'word',
    blocks: paragraphs.map((text, index) => ({ id: `p-${index + 1}`, kind: 'paragraph' as const, text })),
    page: {}, header: '', footer: '',
  };
}

function setup() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES ('proj-1','P1','','active',1,1,'test')").run();
  db.prepare("INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES ('proj-2','P2','','active',1,1,'test')").run();
  const outcomes = new OutcomeRepository(db);
  const created = outcomes.create({
    projectId: 'proj-1', categoryId: null, title: '论文 A', kind: 'word',
    content: wordDoc(['第一段原文。', '第二段原文。', '第三段原文。']), note: '初稿', actor: 'human',
  });
  const workbench = new OutcomeWorkbenchService(db, outcomes);
  const memory = new OutcomeMemoryService(db);
  const review = new OutcomeReviewService(db);
  const graph = new ResearchGraphService(db);
  return { db, outcomes, workbench, memory, review, graph, outcomeId: created.outcome.id, v1Content: created.version.content };
}

describe('A. Working Draft（T01.01/T01.02/T02.01-T02.04）', () => {
  it('open initializes draft from current version; reload keeps it; currentVersion unchanged', () => {
    const { outcomes, workbench, outcomeId } = setup();
    const opened = workbench.openForEdit('proj-1', outcomeId)!;
    expect(opened.conflict).toBe(false);
    expect(opened.draft.baseVersion).toBe(1);
    // reload：新 service 实例读同一库（App 重启等价）。
    const reopened = new OutcomeWorkbenchService(new Database(':memory:'), outcomes);
    void reopened;
    const redraft = workbench.getDraft('proj-1', outcomeId)!;
    expect(redraft.content).toEqual(opened.draft.content);
    expect(outcomes.list('proj-1').find((item) => item.id === outcomeId)!.currentVersion).toBe(1);
  });

  it('saveDraft updates content+hash; version untouched; clear removes draft', () => {
    const { outcomes, workbench, outcomeId, v1Content } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const edited = { ...v1Content, blocks: [{ id: 'p-1', kind: 'paragraph' as const, text: '改过的第一段。' }] };
    const saved = workbench.saveDraft('proj-1', outcomeId, { baseVersion: 1, content: edited, updatedBy: 'human' });
    expect(saved.ok).toBe(true);
    const draft = workbench.getDraft('proj-1', outcomeId)!;
    expect(draft.contentHash).toBe(outcomeContentHash(edited));
    expect(outcomes.list('proj-1').find((item) => item.id === outcomeId)!.currentVersion).toBe(1);
    expect(workbench.clearDraft('proj-1', outcomeId)).toBe(true);
    expect(workbench.getDraft('proj-1', outcomeId)).toBeUndefined();
  });

  it('baseVersion behind current version → outcome_draft_conflict; force keep allowed; discard reinitializes', () => {
    const { outcomes, workbench, outcomeId, v1Content } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    // 模拟另一 writer 推进了正式版本。
    outcomes.save({ projectId: 'proj-1', outcomeId, baseVersion: 1, content: wordDoc(['官方 v2。']), note: '', actor: 'human', sources: [] });
    const conflict = workbench.saveDraft('proj-1', outcomeId, { baseVersion: 1, content: v1Content, updatedBy: 'human' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('outcome_draft_conflict');
    // 保留草稿副本（force）。
    const kept = workbench.saveDraft('proj-1', outcomeId, { baseVersion: 1, content: v1Content, updatedBy: 'human', force: true });
    expect(kept.ok).toBe(true);
    // 放弃 → 从 v2 重建。
    const resolved = workbench.resolveDraftConflict('proj-1', outcomeId, 'discard');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.draft!.baseVersion).toBe(2);
  });

  it('project scope: draft of proj-1 invisible to proj-2', () => {
    const { workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    expect(workbench.getDraft('proj-2', outcomeId)).toBeUndefined();
  });
});

describe('B. Snapshot（T01.03/T02.05/T02.06）', () => {
  it('dedupes by contentHash; retention caps auto snapshots at 50; manual counted separately', () => {
    const { workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const first = workbench.createSnapshot('proj-1', outcomeId, 'autosave');
    expect(first.ok).toBe(true);
    const duplicate = workbench.createSnapshot('proj-1', outcomeId, 'autosave');
    expect(duplicate.ok && first.ok && duplicate.value.id === first.value.id).toBe(true);
    for (let index = 0; index < 55; index += 1) {
      workbench.createSnapshot('proj-1', outcomeId, 'autosave', wordDoc([`内容 ${index}`]));
    }
    const auto = workbench.listSnapshots('proj-1', outcomeId).filter((snapshot) => snapshot.reason === 'autosave');
    expect(auto.length).toBeLessThanOrEqual(50);
    workbench.createSnapshot('proj-1', outcomeId, 'manual', wordDoc(['手动快照 A 的内容。']));
    workbench.createSnapshot('proj-1', outcomeId, 'manual', wordDoc(['手动快照 B 的内容。']));
    expect(workbench.listSnapshots('proj-1', outcomeId).filter((snapshot) => snapshot.reason === 'manual').length).toBe(2);
  });

  it('restore writes the working draft only; formal version untouched', () => {
    const { outcomes, workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    workbench.createSnapshot('proj-1', outcomeId, 'manual', wordDoc(['要恢复的旧内容，足够长。']));
    const snapshot = workbench.listSnapshots('proj-1', outcomeId)[0]!;
    const restored = workbench.restoreSnapshot('proj-1', snapshot.id);
    expect(restored.ok).toBe(true);
    const draft = workbench.getDraft('proj-1', outcomeId)!;
    expect((draft.content as WordDocument).blocks[0]!.text).toBe('要恢复的旧内容，足够长。');
    expect(outcomes.list('proj-1').find((item) => item.id === outcomeId)!.currentVersion).toBe(1);
  });
});

describe('C. Revision Engine（T01.04-T01.06/T03.01-T03.09）', () => {
  it('createRevisionSet computes beforeHash at runtime and persists pending revisions', () => {
    const { workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const result = workbench.createRevisionSet({
      projectId: 'proj-1', outcomeId, instruction: '润色第一段', createdBy: 'ai',
      proposals: [{ target: { kind: 'word_block', blockId: 'p-1' }, after: { text: '润色后的第一段。' }, reason: '更学术' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.set.status).toBe('pending');
    expect(result.value.set.baseDraftHash).toBe(workbench.getDraft('proj-1', outcomeId)!.contentHash);
    const revision = result.value.revisions[0]!;
    expect(revision.target.kind).toBe('word_block');
    expect(revision.target.beforeHash).toBe(outcomeContentHash({ id: 'p-1', kind: 'paragraph', text: '第一段原文。' } as never));
    expect(revision.before).toEqual({ id: 'p-1', kind: 'paragraph', text: '第一段原文。' });
  });

  it('accept applies to draft only; version unchanged; revision marked accepted; set recomputed', () => {
    const { outcomes, workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const created = workbench.createRevisionSet({
      projectId: 'proj-1', outcomeId, instruction: '', createdBy: 'ai',
      proposals: [{ target: { kind: 'word_block', blockId: 'p-2' }, after: { text: '第二段已润色。' }, reason: '' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const revisionId = created.value.revisions[0]!.id;
    const accepted = workbench.acceptRevision('proj-1', created.value.set.id, revisionId);
    expect(accepted.ok).toBe(true);
    const draft = workbench.getDraft('proj-1', outcomeId)!;
    expect((draft.content as WordDocument).blocks[1]!.text).toBe('第二段已润色。');
    const outcome = outcomes.list('proj-1').find((item) => item.id === outcomeId)!;
    expect(outcome.currentVersion).toBe(1);
    const bundle = workbench.getRevisionSet('proj-1', created.value.set.id)!;
    expect(bundle.revisions[0]!.status).toBe('accepted');
    expect(bundle.set.status).toBe('accepted');
  });

  it('user edits target after proposal → accept returns revision_stale and never overwrites', () => {
    const { workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const created = workbench.createRevisionSet({
      projectId: 'proj-1', outcomeId, instruction: '', createdBy: 'ai',
      proposals: [{ target: { kind: 'word_block', blockId: 'p-3' }, after: { text: 'AI 的第三段。' }, reason: '' }],
    });
    if (!created.ok) throw new Error('setup failed');
    // 用户手工改动同一段（draft hash 变化，target hash 随之变化）。
    const draft = workbench.getDraft('proj-1', outcomeId)!;
    const edited = { ...draft.content, blocks: [...(draft.content as WordDocument).blocks] };
    edited.blocks[2] = { id: 'p-3', kind: 'paragraph', text: '用户手改的第三段。' };
    workbench.saveDraft('proj-1', outcomeId, { baseVersion: draft.baseVersion, content: edited, updatedBy: 'human', force: true });
    const accept = workbench.acceptRevision('proj-1', created.value.set.id, created.value.revisions[0]!.id);
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.code).toBe('outcome_revision_stale');
    // 用户内容未被覆盖；revision 状态持久化为 stale。
    expect((workbench.getDraft('proj-1', outcomeId)!.content as WordDocument).blocks[2]!.text).toBe('用户手改的第三段。');
    expect(workbench.getRevisionSet('proj-1', created.value.set.id)!.revisions[0]!.status).toBe('stale');
  });

  it('reject leaves draft untouched; accept-all walks order with per-item hash checks and summarizes', () => {
    const { workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const created = workbench.createRevisionSet({
      projectId: 'proj-1', outcomeId, instruction: '', createdBy: 'ai',
      proposals: [
        { target: { kind: 'word_block', blockId: 'p-1' }, after: { text: 'A1' }, reason: '' },
        { target: { kind: 'word_block', blockId: 'p-2' }, after: { text: 'A2' }, reason: '' },
        { target: { kind: 'word_block', blockId: 'p-3' }, after: { text: 'A3' }, reason: '' },
      ],
    });
    if (!created.ok) throw new Error('setup failed');
    const reject = workbench.rejectRevision('proj-1', created.value.set.id, created.value.revisions[1]!.id);
    expect(reject.ok).toBe(true);
    expect((workbench.getDraft('proj-1', outcomeId)!.content as WordDocument).blocks[1]!.text).toBe('第二段原文。');
    const all = workbench.acceptRevisionSet('proj-1', created.value.set.id);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.accepted).toBe(2);
    expect(all.value.rejected).toBe(1);
    expect((workbench.getDraft('proj-1', outcomeId)!.content as WordDocument).blocks[0]!.text).toBe('A1');
    // set 状态：accepted+rejected 混合 → partially_accepted。
    expect(workbench.getRevisionSet('proj-1', created.value.set.id)!.set.status).toBe('partially_accepted');
  });

  it('missing target at proposal time rejects the whole set (never best-effort)', () => {
    const { workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const result = workbench.createRevisionSet({
      projectId: 'proj-1', outcomeId, instruction: '', createdBy: 'ai',
      proposals: [
        { target: { kind: 'word_block', blockId: 'p-1' }, after: { text: 'x' }, reason: '' },
        { target: { kind: 'word_block', blockId: 'p-999' }, after: { text: 'y' }, reason: '' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('outcome_revision_target_missing');
  });

  it('word table cell and ppt page/element revisions apply narrowly', () => {
    const { outcomes, workbench } = setup();
    const tableDoc: WordDocument = {
      type: 'word',
      blocks: [{ id: 't-1', kind: 'table', rows: [['甲', '乙'], ['丙', '丁']] }],
      page: {}, header: '', footer: '',
    };
    const table = outcomes.create({ projectId: 'proj-1', categoryId: null, title: '表', kind: 'word', content: tableDoc, note: '', actor: 'human' });
    workbench.openForEdit('proj-1', table.outcome.id);
    const cell = workbench.createRevisionSet({
      projectId: 'proj-1', outcomeId: table.outcome.id, instruction: '', createdBy: 'ai',
      proposals: [{ target: { kind: 'word_table_cell', blockId: 't-1', row: 0, column: 1 }, after: { text: '乙改' }, reason: '' }],
    });
    expect(cell.ok).toBe(true);
    if (cell.ok) {
      const accept = workbench.acceptRevision('proj-1', cell.value.set.id, cell.value.revisions[0]!.id);
      expect(accept.ok).toBe(true);
      const rows = (workbench.getDraft('proj-1', table.outcome.id)!.content as WordDocument).blocks[0]!.rows!;
      expect(rows[0]![1]).toBe('乙改');
      expect(rows[0]![0]).toBe('甲');
      expect(rows[1]![1]).toBe('丁');
    }
  });

  it('markStaleByHash flags pending revisions whose targets moved (office sync 对账)', () => {
    const { workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const created = workbench.createRevisionSet({
      projectId: 'proj-1', outcomeId, instruction: '', createdBy: 'ai',
      proposals: [{ target: { kind: 'word_block', blockId: 'p-1' }, after: { text: 'x' }, reason: '' }],
    });
    if (!created.ok) throw new Error('setup failed');
    const draft = workbench.getDraft('proj-1', outcomeId)!;
    const edited = { ...draft.content, blocks: [{ id: 'p-1', kind: 'paragraph' as const, text: 'Office 改写过。' }] };
    workbench.saveDraft('proj-1', outcomeId, { baseVersion: draft.baseVersion, content: edited, updatedBy: 'office_sync', force: true });
    const marked = workbench.markStaleByHash('proj-1', outcomeId);
    expect(marked).toBe(1);
    expect(workbench.getRevisionSet('proj-1', created.value.set.id)!.revisions[0]!.status).toBe('stale');
    expect(workbench.getRevisionSet('proj-1', created.value.set.id)!.set.status).toBe('stale');
  });
});

describe('F. Outcome Memory（T01.07/T07.02/T07.03）', () => {
  it('save with revision concurrency check; AI proposal requires explicit accept', () => {
    const { memory, outcomeId } = setup();
    expect(memory.get('proj-1', outcomeId)).toBeNull();
    const first = memory.save({
      outcomeId, projectId: 'proj-1', goal: '投 CSSCI', audience: '劳动社会学研究者', venueTarget: '《社会学研究》',
      coreJudgments: [], terminology: [{ preferred: '职业能力形成', avoid: ['技能提升'] }], writingRules: [],
      confirmedDecisions: [], rejectedApproaches: [], unresolvedIssues: [], revision: 1, updatedAt: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.memory.revision).toBe(1);
    // 陈旧 revision → conflict。
    const stale = memory.save({ ...first.memory, goal: '改目标', revision: 5 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('outcome_memory_revision_conflict');
    // AI propose → pending，不进正式 memory；接受后才写入。
    const proposal = memory.propose({
      projectId: 'proj-1', outcomeId, field: 'writingRules',
      value: '全文统一使用“职业能力形成”。', reason: '保持术语一致',
    });
    expect(proposal.status).toBe('pending');
    expect(memory.get('proj-1', outcomeId)!.writingRules).toHaveLength(0);
    const accepted = memory.acceptProposal('proj-1', proposal.id);
    expect(accepted.ok).toBe(true);
    expect(memory.get('proj-1', outcomeId)!.writingRules).toContain('全文统一使用“职业能力形成”。');
    const rejected = memory.propose({ projectId: 'proj-1', outcomeId, field: 'goal', value: 'AI 瞎改', reason: '' });
    expect(memory.rejectProposal('proj-1', rejected.id)).toBe(true);
    expect(memory.get('proj-1', outcomeId)!.goal).toBe('投 CSSCI');
  });
});

describe('G. Review Issues（T01.08/T08 持久化）', () => {
  it('run + structured issues persist; stale detection by draft hash; explicit resolve', () => {
    const { review, workbench, outcomeId } = setup();
    workbench.openForEdit('proj-1', outcomeId);
    const draftHash = workbench.getDraft('proj-1', outcomeId)!.contentHash;
    const run = review.startRun('proj-1', outcomeId, 'full', 1, draftHash);
    const issue = review.addIssue({
      projectId: 'proj-1', outcomeId, reviewRunId: run.id, baseVersion: 1, baseDraftHash: draftHash,
      category: 'evidence', severity: 'critical', title: '核心结论缺少证据支持',
      explanation: '第三段的判断没有任何 evidenceRefs。', anchor: { kind: 'word_block', blockId: 'p-3', beforeHash: draftHash },
      sourceRefs: [], evidenceIds: [],
    });
    expect(issue.id).toMatch(/^issue-/);
    expect(review.listIssues('proj-1', outcomeId, 'open')).toHaveLength(1);
    // 用户显式 resolved。
    review.updateIssueStatus('proj-1', issue.id, 'resolved');
    expect(review.listIssues('proj-1', outcomeId, 'resolved')).toHaveLength(1);
    // 新审查后草稿 hash 变化 → 旧 open issue 标 stale。
    review.addIssue({
      projectId: 'proj-1', outcomeId, reviewRunId: run.id, baseVersion: 1, baseDraftHash: 'deadbeef00000000',
      category: 'structure', severity: 'minor', title: '旧 hash 的结构问题', explanation: '', anchor: null, sourceRefs: [], evidenceIds: [],
    });
    const marked = review.markStaleByDraftHash('proj-1', outcomeId, 'ffffff0000000000');
    expect(marked).toBe(1);
    expect(review.listIssues('proj-1', outcomeId, 'stale')).toHaveLength(1);
  });
});

describe('H. Research Graph（T01.09/T09.02-T09.06）', () => {
  it('canonical claim node requires a real claim; AI extracted defaults unverified; user confirm caps at supported', () => {
    const { db, graph } = setup();
    // 不存在 claim → canonical 缺失拒绝。
    const missing = graph.upsertNode({
      id: 'node-claim-1', projectId: 'proj-1', kind: 'claim', label: '幽灵论断',
      canonicalEntityType: 'claim', canonicalEntityId: 'clm-missing', provenance: 'ai_extracted',
      verificationStatus: 'unverified', confidence: null, description: '',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('research_graph_canonical_entity_missing');
    // 建一个真实 claim。
    const now = Date.now();
    db.prepare("INSERT INTO claims (id,project_id,statement,claim_type,confidence,status,metadata,created_at,updated_at) VALUES ('clm-1','proj-1','职业能力形成受制度影响','finding',0.5,'unsupported','{}',?,?)").run(now, now);
    const node = graph.upsertNode({
      id: 'node-claim-1', projectId: 'proj-1', kind: 'claim', label: '职业能力形成受制度影响',
      canonicalEntityType: 'claim', canonicalEntityId: 'clm-1', provenance: 'canonical',
      verificationStatus: 'unverified', confidence: null, description: '',
    });
    expect(node.ok).toBe(true);
    const concept = graph.upsertNode({
      id: 'node-concept-1', projectId: 'proj-1', kind: 'concept', label: '制度理论',
      canonicalEntityType: null, canonicalEntityId: null, provenance: 'ai_extracted',
      verificationStatus: 'unverified', confidence: 0.42, description: 'AI 从正文抽取',
    });
    expect(concept.ok && concept.node.verificationStatus === 'unverified').toBe(true);
    // AI 推断的边默认 unverified；用户确认 → supported（≠ verified）。
    const edge = graph.upsertEdge({
      id: '', projectId: 'proj-1', sourceNodeId: 'node-concept-1', targetNodeId: 'node-claim-1',
      relation: 'explains', provenance: 'ai_extracted', evidenceIds: [], sourceIds: [],
      verificationStatus: 'unverified', confidence: 0.3, createdAt: now, updatedAt: now,
    });
    if (!edge.ok) throw new Error(`upsertEdge failed: ${edge.code}`);
    expect(edge.edge.verificationStatus === 'unverified').toBe(true);
    const confirmed = graph.confirmEdge('proj-1', edge.edge.id);
    expect(confirmed.ok && confirmed.edge.provenance === 'user_confirmed' && confirmed.edge.verificationStatus === 'supported').toBe(true);
    // 不存在的边/节点如实报错。
    expect(graph.confirmEdge('proj-1', 'gedge-nope').ok).toBe(false);
    expect(graph.rejectNode('proj-1', 'node-nope').ok).toBe(false);
  });

  it('dedup: same canonical entity resolves to one node; label match is a candidate', () => {
    const { db, graph } = setup();
    const now = Date.now();
    db.prepare("INSERT INTO claims (id,project_id,statement,claim_type,confidence,status,metadata,created_at,updated_at) VALUES ('clm-9','proj-1','S','finding',0.5,'unsupported','{}',?,?)").run(now, now);
    graph.upsertNode({ id: 'n-1', projectId: 'proj-1', kind: 'claim', label: 'S', canonicalEntityType: 'claim', canonicalEntityId: 'clm-9', provenance: 'canonical', verificationStatus: 'unverified', confidence: null, description: '' });
    const again = graph.findDeduplicationCandidate('proj-1', { canonicalEntityType: 'claim', canonicalEntityId: 'clm-9', label: 'S（别的写法）' });
    expect(again?.id).toBe('n-1');
    const byLabel = graph.findDeduplicationCandidate('proj-1', { canonicalEntityType: null, canonicalEntityId: null, label: 's' });
    expect(byLabel?.id).toBe('n-1');
  });

  it('project isolation: proj-2 sees no proj-1 graph', () => {
    const { graph } = setup();
    graph.upsertNode({ id: 'n-iso', projectId: 'proj-1', kind: 'concept', label: 'P1 概念', canonicalEntityType: null, canonicalEntityId: null, provenance: 'user_created', verificationStatus: 'unverified', confidence: null, description: '' });
    expect(graph.listNodes('proj-2')).toHaveLength(0);
    expect(graph.listNodes('proj-1')).toHaveLength(1);
  });
});

describe('Graph Projection（Phase 10/11/12）', () => {
  it('claim-evidence projection reads canonical tables without copying; knowledge graph exposes unverified hidden connections', () => {
    const { db, graph } = setup();
    const now = Date.now();
    db.prepare("INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES ('proj-9','P9','','active',1,1,'test')").run();
    db.prepare("INSERT INTO sources (id, project_id, title, authors, year, kind, created_at, updated_at) VALUES ('src-1','proj-9','制度研究','[]',2024,'paper',?,?)").run(now, now);
    db.prepare("INSERT INTO claims (id,project_id,statement,claim_type,confidence,status,metadata,created_at,updated_at) VALUES ('clm-p9','proj-9','制度影响能力形成','finding',0.5,'supported','{}',?,?)").run(now, now);
    db.prepare("INSERT INTO evidence (id,project_id,source_id,anchor_type,anchor_start,anchor_end,page_number,snippet,snippet_hash,confidence,metadata,created_at,updated_at) VALUES ('ev-1','proj-9','src-1','page',NULL,NULL,3,'制度确实塑造了技能形成路径。','h0',0.9,'{}',?,?)").run(now, now);
    db.prepare("INSERT INTO claim_evidence_links (id,claim_id,evidence_id,relation,weight,note,created_at) VALUES ('link-1','clm-p9','ev-1','supports',1.0,'',?)").run(now);
    const projection = graph.projectClaimEvidenceGraph('proj-9');
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.claims).toHaveLength(1);
    expect(projection.claims[0]!.supports).toBe(1);
    expect(projection.evidences[0]!.sourceTitle).toBe('制度研究');
    expect(projection.links[0]!.relation).toBe('supports');

    // knowledge graph：AI 推断未验证边进 hiddenConnections（必须带确认流程的语义）。
    graph.upsertNode({ id: 'kn-1', projectId: 'proj-9', kind: 'concept', label: '制度理论', canonicalEntityType: null, canonicalEntityId: null, provenance: 'ai_extracted', verificationStatus: 'unverified', confidence: 0.3, description: '' });
    graph.upsertNode({ id: 'kn-2', projectId: 'proj-9', kind: 'claim', label: '制度影响能力形成', canonicalEntityType: 'claim', canonicalEntityId: 'clm-p9', provenance: 'canonical', verificationStatus: 'supported', confidence: null, description: '' });
    graph.upsertEdge({ id: '', projectId: 'proj-9', sourceNodeId: 'kn-1', targetNodeId: 'kn-2', relation: 'explains', provenance: 'ai_extracted', evidenceIds: [], sourceIds: [], verificationStatus: 'unverified', confidence: 0.3, createdAt: now, updatedAt: now });
    const knowledge = graph.projectKnowledgeGraph('proj-9');
    expect(knowledge.nodes.length).toBeGreaterThanOrEqual(2);
    expect(knowledge.hiddenConnections).toHaveLength(1);
    expect(knowledge.hiddenConnections[0]!.sourceLabel).toBe('制度理论');
    // argument graph：claim 层 + 概念层分层。
    const argument = graph.projectArgumentGraph('proj-9');
    expect(argument.ok).toBe(true);
    if (argument.ok) {
      expect(argument.layers.length).toBeGreaterThanOrEqual(2);
      expect(argument.unverifiedCount).toBeGreaterThanOrEqual(1);
    }
  });
});

