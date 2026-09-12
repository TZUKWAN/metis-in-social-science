/**
 * OutcomeGraphExtractionService — 图谱抽取编排（任务书 T09.07/T12.05/T15.05）。
 *
 * scope 恒为 projectId（T09.07，不跨项目）。流程：
 *   分段（复用 Review 的 segmentDocument）→ 逐段 AI 产出 candidateNodes/candidateEdges
 *   → Service 校验（schema/canonical/dedup/provenance，T12.05）→ upsert 入 research graph。
 *
 * 数据可信规则：AI 节点/边一律 provenance=ai_extracted、verificationStatus=unverified；
 * canonical 实体（claim/evidence/source/outcome）按锚定文本映射到权威实体，找不到不硬造。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { ChatMessage } from '../engine/core/types.js';
import type { OutcomeDocument, WordDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import { runEphemeralChatTurn } from './ChatTurnService.js';
import { segmentDocument } from './OutcomeReviewPipelineService.js';
import type { OutcomeWorkbenchService } from './OutcomeWorkbenchService.js';
import type { ResearchGraphService } from './OutcomeMemoryReviewGraphService.js';

export interface GraphExtractionResult {
  ok: boolean;
  code?: 'outcome_not_found' | 'extraction_unavailable' | 'unsupported_kind' | 'extraction_cancelled';
  segments?: number;
  nodes?: number;
  edges?: number;
}

const NODE_KINDS = new Set(['concept', 'theory', 'person', 'institution', 'event', 'place', 'method', 'variable']);
const RELATIONS = new Set(['related_to', 'derives_from', 'challenges', 'applies_to', 'discusses', 'cites', 'explains', 'supports', 'contradicts']);

export class OutcomeGraphExtractionService {
  constructor(private readonly deps: {
    db: Database.Database;
    workbench: OutcomeWorkbenchService;
    graph: ResearchGraphService;
    agentLoop: AgentLoop;
    modelName: string;
    signal?: AbortSignal;
  }) {}

  async extractFromOutcome(projectId: string, outcomeId: string): Promise<GraphExtractionResult> {
    const opened = this.deps.workbench.openForEdit(projectId, outcomeId);
    if (!opened) return { ok: false, code: 'outcome_not_found' };
    const document: OutcomeDocument = opened.draft.content;
    const segments = segmentDocument(document);
    if (segments.length === 0) return { ok: false, code: 'unsupported_kind' };

    // canonical 映射底表：项目已有 claim 的 statement 规范化索引。
    const claimIndex = new Map<string, string>();
    try {
      const rows = this.deps.db.prepare('SELECT id, statement FROM claims WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Array<{ id: string; statement: string }>;
      for (const row of rows) claimIndex.set(row.statement.replace(/\s+/gu, '').toLowerCase(), row.id);
    } catch { /* claims 表不可用时跳过 canonical 映射 */ }

    const labelToNodeId = new Map<string, string>();
    const resolveOrCreateConcept = (label: string, kind: string): string | null => {
      const trimmed = label.trim().slice(0, 200);
      if (!trimmed) return null;
      const normalized = trimmed.toLowerCase();
      const dedup = this.deps.graph.findDeduplicationCandidate(projectId, { canonicalEntityType: null, canonicalEntityId: null, label: normalized });
      if (dedup) { labelToNodeId.set(normalized, dedup.id); return dedup.id; }
      const id = `gn-${randomUUID()}`;
      const upserted = this.deps.graph.upsertNode({
        id, projectId, kind: NODE_KINDS.has(kind) ? kind as never : 'concept',
        label: trimmed, description: 'AI 从成果正文抽取', canonicalEntityType: null, canonicalEntityId: null,
        provenance: 'ai_extracted', verificationStatus: 'unverified', confidence: null,
      });
      if (!upserted.ok) return null;
      labelToNodeId.set(normalized, upserted.node.id);
      return upserted.node.id;
    };
    /** 强主张句已存在于 canonical claim store → claim 节点引用之（T10.01）。 */
    const resolveCanonicalClaim = (statement: string): { nodeId: string; canonicalId: string } | null => {
      const normalized = statement.replace(/\s+/gu, '').toLowerCase();
      const canonicalId = claimIndex.get(normalized);
      if (!canonicalId) return null;
      const dedup = this.deps.graph.findDeduplicationCandidate(projectId, { canonicalEntityType: 'claim', canonicalEntityId: canonicalId, label: statement });
      if (dedup) return { nodeId: dedup.id, canonicalId };
      const id = `gn-${randomUUID()}`;
      const upserted = this.deps.graph.upsertNode({
        id, projectId, kind: 'claim', label: statement.slice(0, 200), description: '',
        canonicalEntityType: 'claim', canonicalEntityId: canonicalId,
        provenance: 'canonical', verificationStatus: 'unverified', confidence: null,
      });
      return upserted.ok ? { nodeId: upserted.node.id, canonicalId } : null;
    };

    let nodeCount = 0;
    let edgeCount = 0;
    let processed = 0;
    for (const segment of segments) {
      if (this.deps.signal?.aborted) return { ok: false, code: 'extraction_cancelled', segments: segments.length, nodes: nodeCount, edges: edgeCount };
      const blockList = segment.blocks.map((block) => `- [${block.id}] ${block.text.slice(0, 400)}`).join('\n');
      const messages: ChatMessage[] = [{
        role: 'user',
        content: [
          `抽取任务：从下面这段研究文本中提取概念、理论、方法、人物等实体，以及它们之间的关系。`,
          `章节：${segment.title}（角色：${segment.role}）`,
          blockList,
          '只输出 JSON：{"nodes":[{"label":"不超过60字","kind":"concept|theory|person|institution|event|place|method|variable","claimStatement":"可选——如果该节点对应文中一个明确的论断原句"}],"edges":[{"sourceLabel":"已列出的节点标签","targetLabel":"已列出的节点标签","relation":"related_to|derives_from|challenges|applies_to|discusses|explains|supports|contradicts"}]}',
          '规则：节点标签必须是文中真实出现的概念/实体；claimStatement 只在该节点代表文中一个可检验判断时填写；关系必须在输入文本中有依据；没有可提取内容输出空数组。',
        ].join('\n'),
      }];
      let raw = '';
      try {
        const response = await runEphemeralChatTurn({
          agentLoop: this.deps.agentLoop,
          sessionId: `graph-extract-${randomUUID()}`,
          requestId: `graph-extract-${randomUUID()}`,
          messages, maxTurns: 1, allowedTools: [], projectId,
        });
        if (response.status === 'completed') raw = response.answer;
      } catch { /* 单段失败跳过，不中断整体 */ }
      const parsed = extractGraphJson(raw);
      if (!parsed) { processed += 1; continue; }
      // 节点先建（canonical claim 优先映射）。
      for (const candidate of parsed.nodes.slice(0, 20)) {
        if (candidate.claimStatement) {
          const canonical = resolveCanonicalClaim(candidate.claimStatement);
          if (canonical) {
            labelToNodeId.set(candidate.label.trim().toLowerCase(), canonical.nodeId);
            nodeCount += 1;
            continue;
          }
        }
        const id = resolveOrCreateConcept(candidate.label, candidate.kind);
        if (id) nodeCount += 1;
      }
      // 边后建（两端必须已存在）。
      for (const candidate of parsed.edges.slice(0, 30)) {
        const sourceId = labelToNodeId.get(candidate.sourceLabel?.trim().toLowerCase() ?? '');
        const targetId = labelToNodeId.get(candidate.targetLabel?.trim().toLowerCase() ?? '');
        if (!sourceId || !targetId || sourceId === targetId) continue;
        if (!RELATIONS.has(candidate.relation)) continue;
        const upserted = this.deps.graph.upsertEdge({
          id: '', projectId, sourceNodeId: sourceId, targetNodeId: targetId,
          relation: candidate.relation as never, provenance: 'ai_extracted',
          evidenceIds: [], sourceIds: [], verificationStatus: 'unverified', confidence: null,
          createdAt: Date.now(),
        });
        if (upserted.ok) edgeCount += 1;
      }
      processed += 1;
    }
    return { ok: true, segments: segments.length, nodes: nodeCount, edges: edgeCount };
  }
}

/** 从模型回答稳健抽取 nodes/edges JSON（容忍围栏与前后缀）。 */
export function extractGraphJson(raw: string): {
  nodes: Array<{ label: string; kind: string; claimStatement?: string }>;
  edges: Array<{ sourceLabel: string; targetLabel: string; relation: string }>;
} | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
  const candidate = fenced ? fenced[1]! : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(candidate.slice(start, end + 1)) as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(value.nodes)) return null;
    return {
      nodes: value.nodes
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && typeof (item as { label?: unknown }).label === 'string')
        .map((item) => ({
          label: String(item.label),
          kind: String(item.kind ?? 'concept'),
          ...(typeof item.claimStatement === 'string' && item.claimStatement.trim() ? { claimStatement: item.claimStatement } : {}),
        })),
      edges: Array.isArray(value.edges)
        ? value.edges
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .filter((item) => typeof item.sourceLabel === 'string' && typeof item.targetLabel === 'string' && typeof item.relation === 'string')
          .map((item) => ({ sourceLabel: String(item.sourceLabel), targetLabel: String(item.targetLabel), relation: String(item.relation) }))
        : [],
    };
  } catch {
    return null;
  }
}

/** 抽取服务需要读 Word 文本段——为类型引用保留（segmentDocument 接受 OutcomeDocument）。 */
export type ExtractionDocument = OutcomeDocument | WordDocument;
