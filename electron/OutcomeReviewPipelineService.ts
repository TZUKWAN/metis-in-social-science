/**
 * OutcomeReviewPipelineService — 结构化审查管线（任务书 Phase 8，T08.01–T08.09）。
 *
 * 禁止只发一句「帮我审查这篇论文」；必须走：
 *   Document segmentation → Section role inference →（确定性）证据覆盖检查 →
 *   逐 segment 结构化 AI 检查 → Service 校验候选（anchor 真实存在、类别/严重度合法）→
 *   去重 → 持久化 OutcomeReviewIssue → run 状态收尾。
 *
 * 数据可信规则 §23.10：Review issue 是判断不是事实——AI 只产候选，Service 决定入库；
 * anchor 无法定位时落 document-level（不伪造定位）。
 */
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../engine/core/types.js';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import {
  OutcomeIdSchema,
  type OutcomeDocument,
  type WordDocument,
} from '../engine/runtime/OutcomeRuntimeContract.js';
import type {
  OutcomeReviewIssue,
  OutcomeReviewSeverity,
} from '../engine/runtime/OutcomeWorkbenchContract.js';
import { runEphemeralChatTurn } from './ChatTurnService.js';
import type { OutcomeWorkbenchService } from './OutcomeWorkbenchService.js';
import type { OutcomeReviewService } from './OutcomeMemoryReviewGraphService.js';

export type ReviewMode =
  | 'full' | 'argument' | 'evidence' | 'theory' | 'method' | 'structure' | 'language' | 'submission_check';

export const REVIEW_MODES: readonly ReviewMode[] = [
  'full', 'argument', 'evidence', 'theory', 'method', 'structure', 'language', 'submission_check',
];

export interface ReviewSegment {
  id: string;
  /** Word：section 标题块 id 或首块 id；PPT：pageId。 */
  anchorBlockId: string;
  title: string;
  role: string;
  blocks: Array<{ id: string; kind: string; text: string }>;
}

const SEGMENT_CHAR_BUDGET = 6_000;
const MAX_SEGMENTS = 12;
const ROLE_RULES: Array<{ role: string; keywords: RegExp }> = [
  { role: 'introduction', keywords: /引言|绪论|研究背景|问题提出/iu },
  { role: 'theory', keywords: /理论|文献综述|分析框架|概念界定/iu },
  { role: 'method', keywords: /方法|研究设计|数据与变量|模型设定|样本/iu },
  { role: 'findings', keywords: /结果|发现|实证分析|检验/iu },
  { role: 'discussion', keywords: /讨论|机制|解释/iu },
  { role: 'conclusion', keywords: /结论|结语|政策建议|局限/iu },
];

/** 确定性分段：Word 按一级/二级标题切 section（无标题时按块数均分），PPT 按页。 */
export function segmentDocument(document: OutcomeDocument): ReviewSegment[] {
  if (document.type === 'word') return segmentWord(document);
  if (document.type === 'ppt') {
    return document.pages.slice(0, MAX_SEGMENTS).map((page) => ({
      id: page.id, anchorBlockId: page.id, title: page.title, role: 'slides',
      blocks: page.elements
        .filter((element) => element.type === 'text')
        .map((element) => ({ id: element.id, kind: 'text', text: String(element.props?.text ?? '') }))
        .filter((block) => block.text.trim().length > 0),
    }));
  }
  if (document.type === 'other' && document.text.trim()) {
    return [{ id: 'doc-1', anchorBlockId: 'doc-1', title: '全文', role: 'document', blocks: [{ id: 'doc-1', kind: 'text', text: document.text }] }];
  }
  return [];
}

function segmentWord(document: WordDocument): ReviewSegment[] {
  const textBlocks = document.blocks.filter((block) => typeof block.text === 'string');
  const headings = textBlocks.filter((block) => block.kind === 'heading');
  const sections: Array<{ title: string; anchorBlockId: string; blocks: typeof textBlocks }> = [];
  if (headings.length >= 2) {
    let current: { title: string; anchorBlockId: string; blocks: typeof textBlocks } | null = null;
    for (const block of document.blocks) {
      if (typeof block.text !== 'string') continue;
      if (block.kind === 'heading') {
        if (current && current.blocks.length > 0) sections.push(current);
        current = { title: block.text.slice(0, 80), anchorBlockId: block.id, blocks: [] };
        continue;
      }
      if (!current) current = { title: '开篇', anchorBlockId: block.id, blocks: [] };
      current.blocks.push({ id: block.id, kind: block.kind, text: block.text });
    }
    if (current && current.blocks.length > 0) sections.push(current);
  } else {
    // 无标题结构：按字符预算聚合块。
    let current: { title: string; anchorBlockId: string; blocks: typeof textBlocks; chars: number } | null = null;
    for (const block of textBlocks) {
      if (!current || current.chars >= SEGMENT_CHAR_BUDGET) {
        if (current) sections.push(current);
        current = { title: `第 ${sections.length + 1} 部分`, anchorBlockId: block.id, blocks: [], chars: 0 };
      }
      current.blocks.push({ id: block.id, kind: block.kind, text: block.text ?? '' });
      current.chars += (block.text ?? '').length;
    }
    if (current && current.blocks.length > 0) sections.push(current);
  }
  return sections.slice(0, MAX_SEGMENTS).map((section) => {
    const joined = section.blocks.map((block) => block.text).join('\n');
    const role = ROLE_RULES.find((rule) => rule.keywords.test(section.title))?.role
      ?? ROLE_RULES.find((rule) => rule.keywords.test(joined.slice(0, 400)))?.role
      ?? 'body';
    return {
      id: section.anchorBlockId, anchorBlockId: section.anchorBlockId, title: section.title, role,
      blocks: section.blocks.map((block) => ({ id: block.id, kind: block.kind, text: block.text ?? '' })),
    };
  });
}

/** 确定性证据覆盖检查（不依赖模型）：结论/发现类 section 里有强主张句但全篇无证据引用 → issue 候选。 */
export function evidenceCoverageCandidates(segments: ReviewSegment[], evidenceRefCount: number): Array<{
  anchorBlockId: string; severity: OutcomeReviewSeverity; title: string; explanation: string;
}> {
  if (evidenceRefCount > 0) return [];
  const findings = segments.filter((segment) => segment.role === 'findings' || segment.role === 'conclusion');
  const issues: Array<{ anchorBlockId: string; severity: OutcomeReviewSeverity; title: string; explanation: string }> = [];
  for (const segment of findings) {
    const strong = segment.blocks.find((block) => /因此|表明|证明|说明|显著|必然|决定性/.test(block.text));
    if (strong) {
      issues.push({
        anchorBlockId: strong.id,
        severity: 'major',
        title: `「${segment.title}」包含强结论但全文没有已挂接的证据`,
        explanation: `该节存在强判断表述（如「${strong.text.slice(0, 60)}…」），而当前成果未引用任何证据。请在证据面板补充证据或弱化表述。`,
      });
      break; // 每次审查最多一条确定性覆盖提示，避免噪音。
    }
  }
  return issues;
}

export interface ReviewPipelineDeps {
  workbench: OutcomeWorkbenchService;
  review: OutcomeReviewService;
  agentLoop: AgentLoop;
  modelName: string;
  /** 运行库连接：确定性证据覆盖规则直接查询项目证据计数。 */
  db: import('better-sqlite3').Database;
  signal?: AbortSignal;
}

export interface ReviewPipelineResult {
  ok: boolean;
  code?: 'outcome_not_found' | 'review_unavailable' | 'review_cancelled' | 'unsupported_kind';
  runId?: string;
  segments?: number;
  issues?: number;
}

const REVIEW_MODEL_INSTRUCTION = [
  '你是研究成果审查器。只输出 JSON：{"issues":[{"category":"argument|evidence|citation|theory|method|structure|consistency|language|format","severity":"critical|major|minor","title":"不超过80字","explanation":"不超过300字","anchorBlockId":"本段中真实存在的块ID"}]}。',
  '规则：只能指出本段真实存在的问题；anchorBlockId 必须来自输入给出的块列表；没有问题就输出 issues:[]；不得编造引用或事实。',
].join('\n');

/** 项目证据计数：evidence 表按项目统计（文献桥接管线维护的权威数据）。 */
export function countProjectEvidence(db: import('better-sqlite3').Database, projectId: string): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE project_id = ?').get(projectId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export class OutcomeReviewPipelineService {
  constructor(private readonly deps: ReviewPipelineDeps) {}

  async startReview(projectId: string, outcomeId: string, mode: ReviewMode): Promise<ReviewPipelineResult> {
    const opened = this.deps.workbench.openForEdit(projectId, outcomeId);
    if (!opened) return { ok: false, code: 'outcome_not_found' };
    const document = opened.draft.content;
    const segments = segmentDocument(document);
    if (segments.length === 0) return { ok: false, code: 'unsupported_kind' };
    const draftHash = opened.draft.contentHash;
    const run = this.deps.review.startRun(projectId, outcomeId, mode, opened.draft.baseVersion, draftHash);
    const acceptedCategories = mode === 'full'
      ? null
      : new Set([mode === 'submission_check' ? 'format' : mode, ...(mode === 'argument' ? ['structure', 'theory'] : []), ...(mode === 'evidence' ? ['citation', 'method'] : [])]);

    let created = 0;
    try {
      // 1) 确定性证据覆盖检查（不依赖模型；全篇无证据引用且结论节含强主张）。
      const evidenceRefCount = countProjectEvidence(this.deps.db, projectId);
      for (const candidate of evidenceCoverageCandidates(segments, evidenceRefCount)) {
        const segment = segments.find((item) => item.blocks.some((block) => block.id === candidate.anchorBlockId));
        const anchor = segment && OutcomeIdSchema.safeParse(candidate.anchorBlockId).success
          ? { kind: 'word_block' as const, blockId: candidate.anchorBlockId, beforeHash: draftHash.slice(0, 16).padEnd(16, '0') }
          : null;
        this.deps.review.addIssue({
          projectId, outcomeId, reviewRunId: run.id, baseVersion: opened.draft.baseVersion, baseDraftHash: draftHash,
          category: 'evidence', severity: candidate.severity, title: candidate.title, explanation: candidate.explanation,
          anchor, sourceRefs: [], evidenceIds: [],
        });
        created += 1;
      }
      // 2) 逐 segment 结构化 AI 检查（顺序执行控制并发；取消即时停止）。
      let processed = 0;
      for (const segment of segments) {
        if (this.deps.signal?.aborted) {
          this.deps.review.completeRun(run.id, 'cancelled');
          return { ok: false, code: 'review_cancelled', runId: run.id, segments: segments.length, issues: created };
        }
        const issues = await this.reviewSegment(projectId, outcomeId, run.id, segment, acceptedCategories, opened.draft.baseVersion, draftHash);
        created += issues;
        processed += 1;
        this.deps.review.updateProgress(run.id, { processed, total: segments.length, issues: created });
      }
      this.deps.review.completeRun(run.id, 'completed');
      return { ok: true, runId: run.id, segments: segments.length, issues: created };
    } catch {
      this.deps.review.completeRun(run.id, 'cancelled');
      return { ok: false, code: 'review_unavailable', runId: run.id, segments: segments.length, issues: created };
    }
  }

  /** 单段审查：模型候选 → Service 校验（anchor/类别/严重度/去重）→ 持久化。 */
  private async reviewSegment(
    projectId: string, outcomeId: string, runId: string, segment: ReviewSegment,
    acceptedCategories: Set<string> | null, baseVersion: number, baseDraftHash: string,
  ): Promise<number> {
    if (this.deps.signal?.aborted) return 0;
    const blockList = segment.blocks.map((block) => `- [${block.id}] ${block.text.slice(0, 500)}`).join('\n');
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [
        `审查模式：${runId ? 'segment' : 'segment'}`,
        `章节：${segment.title}（角色推断：${segment.role}）`,
        '块列表：',
        blockList,
        REVIEW_MODEL_INSTRUCTION,
      ].join('\n'),
    }];
    let raw: string;
    try {
      const response = await runEphemeralChatTurn({
        agentLoop: this.deps.agentLoop,
        sessionId: `outcome-review-${randomUUID()}`,
        requestId: `outcome-review-${randomUUID()}`,
        messages,
        maxTurns: 1,
        allowedTools: [],
        projectId,
      });
      if (response.status !== 'completed') return 0;
      raw = response.answer;
    } catch {
      return 0;
    }
    const parsed = extractIssuesJson(raw);
    if (!parsed) return 0;
    const validIds = new Set(segment.blocks.map((block) => block.id));
    const existing = this.deps.review.listIssues(projectId, outcomeId);
    let created = 0;
    for (const candidate of parsed.issues.slice(0, 6)) {
      const category = candidate.category;
      const severity = candidate.severity;
      const title = String(candidate.title ?? '').trim();
      if (!title) continue;
      if (acceptedCategories && !acceptedCategories.has(category)) continue;
      // anchor 必须指向本段真实存在的块；无法验证 → document-level（不伪造）。
      const anchorBlockId = typeof candidate.anchorBlockId === 'string' ? candidate.anchorBlockId : '';
      const anchor: OutcomeReviewIssue['anchor'] = anchorBlockId && validIds.has(anchorBlockId) && OutcomeIdSchema.safeParse(anchorBlockId).success
        ? { kind: 'word_block', blockId: anchorBlockId, beforeHash: baseDraftHash.slice(0, 16).padEnd(16, '0') }
        : null;
      // 去重：同 title（规范化）已存在 → 跳过。
      const normalizedTitle = title.replace(/\s+/gu, '');
      if (existing.some((issue) => issue.title.replace(/\s+/gu, '') === normalizedTitle)) continue;
      this.deps.review.addIssue({
        projectId, outcomeId, reviewRunId: runId, baseVersion, baseDraftHash,
        category: category as OutcomeReviewIssue['category'],
        severity: (['critical', 'major', 'minor'].includes(severity) ? severity : 'minor') as OutcomeReviewSeverity,
        title: title.slice(0, 500),
        explanation: String(candidate.explanation ?? '').slice(0, 8_000),
        anchor,
        sourceRefs: [], evidenceIds: [],
      });
      created += 1;
    }
    return created;
  }
}

/** 从模型回答中稳健抽取 issues JSON（容忍代码围栏与前后缀文本）。 */
export function extractIssuesJson(raw: string): { issues: Array<{ category: string; severity: string; title?: string; explanation?: string; anchorBlockId?: string }> } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
  const candidate = fenced ? fenced[1]! : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(candidate.slice(start, end + 1)) as { issues?: unknown };
    if (!Array.isArray(value.issues)) return null;
    return {
      issues: value.issues
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          category: String(item.category ?? 'structure'),
          severity: String(item.severity ?? 'minor'),
          title: typeof item.title === 'string' ? item.title : '',
          explanation: typeof item.explanation === 'string' ? item.explanation : '',
          anchorBlockId: typeof item.anchorBlockId === 'string' ? item.anchorBlockId : '',
        })),
    };
  } catch {
    return null;
  }
}
