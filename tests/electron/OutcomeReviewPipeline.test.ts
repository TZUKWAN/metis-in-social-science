/**
 * Phase 8 Review Pipeline 验收（T08.03/T08.04/T08.05/T08.09 + Test Matrix G）：
 * 分段→结构化 issue→anchor 校验→去重→持久化→run 状态；取消；确定性证据覆盖。
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { ChatMessage, NormalizedResponse, ProviderCapabilities, StreamChunk } from '../../engine/core/types.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeWorkbenchService } from '../../electron/OutcomeWorkbenchService.js';
import { OutcomeReviewService } from '../../electron/OutcomeMemoryReviewGraphService.js';
import {
  OutcomeReviewPipelineService,
  segmentDocument,
  evidenceCoverageCandidates,
  extractIssuesJson,
} from '../../electron/OutcomeReviewPipelineService.js';

class ScriptedProvider extends BaseProvider {
  constructor(private readonly responder: (messages: ChatMessage[]) => string) { super(); }
  capabilities(): ProviderCapabilities {
    return {
      providerType: 'ScriptedProvider', model: 'review-test-model', nativeToolCalling: false,
      jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 32_000,
      maxOutputTokens: 4_096, retryableStatusCodes: [],
    };
  }
  async complete(messages: ChatMessage[]): Promise<NormalizedResponse> {
    return { content: this.responder(messages), toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
  }
  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> { /* not used */ }
}

function setup(documentContent: { type: 'word'; blocks: Array<{ id: string; kind: 'heading' | 'paragraph'; text: string }> }) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES ('proj-1','P','','active',1,1,'test')").run();
  const outcomes = new OutcomeRepository(db);
  const created = outcomes.create({ projectId: 'proj-1', categoryId: null, title: '论文', kind: 'word', content: documentContent, note: '', actor: 'human' });
  const workbench = new OutcomeWorkbenchService(db, outcomes);
  workbench.openForEdit('proj-1', created.outcome.id);
  const review = new OutcomeReviewService(db);
  return { db, outcomes, workbench, review, outcomeId: created.outcome.id };
}

function makePipeline(deps: Partial<ConstructorParameters<typeof OutcomeReviewPipelineService>[0][0]> & { responder: (messages: ChatMessage[]) => string }) {
  const { responder, ...rest } = deps;
  return new OutcomeReviewPipelineService({
    workbench: rest.workbench!,
    review: rest.review!,
    db: rest.db!,
    agentLoop: new AgentLoop({ provider: new ScriptedProvider(responder), registry: new ToolRegistry(), dispatcher: new ToolDispatcher(new ToolRegistry()) }),
    modelName: 'review-test-model',
    ...rest,
  } as ConstructorParameters<typeof OutcomeReviewPipelineService>[0][0]);
}

describe('Review Pipeline（Phase 8）', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it('segments by headings and persists validated structured issues; run completes', async () => {
    const { db, workbench, review, outcomeId } = setup({
      type: 'word',
      blocks: [
        { id: 'h-1', kind: 'heading', text: '研究方法' },
        { id: 'p-1', kind: 'paragraph', text: '本研究采用问卷调查法。' },
        { id: 'h-2', kind: 'heading', text: '结论' },
        { id: 'p-2', kind: 'paragraph', text: '制度显著影响职业能力形成。' },
      ],
    });
    const draftHash = workbench.getDraft('proj-1', outcomeId)!.contentHash;
    const pipeline = makePipeline({
      workbench, review, db,
      responder: (messages) => {
        const text = messages.at(-1)!.content;
        if (text.includes('研究方法')) {
          return JSON.stringify({ issues: [{ category: 'method', severity: 'major', title: '样本描述缺失', explanation: '未说明样本量与抽样方式。', anchorBlockId: 'p-1' }] });
        }
        return JSON.stringify({ issues: [
          { category: 'evidence', severity: 'critical', title: '核心结论无证据支持', explanation: '', anchorBlockId: 'p-2' },
          { category: 'language', severity: 'minor', title: '伪造锚点应被降级', explanation: '', anchorBlockId: 'p-fake' },
        ] });
      },
    });
    const result = await pipeline.startReview('proj-1', outcomeId, 'full');
    expect(result.ok).toBe(true);
    expect(result.segments).toBe(2);
    // 3 条 AI 候选 + 1 条确定性证据覆盖（结论节强主张且全篇无证据）。
    expect(result.issues).toBe(4);
    const issues = review.listIssues('proj-1', outcomeId);
    expect(issues).toHaveLength(4);
    // anchor 真实定位（p-1/p-2 存在于对应段）。
    const byTitle = new Map(issues.map((issue) => [issue.title, issue]));
    expect(byTitle.get('样本描述缺失')!.anchor!.kind).toBe('word_block');
    expect(byTitle.get('核心结论无证据支持')!.severity).toBe('critical');
    expect(byTitle.get('核心结论无证据支持')!.anchor!.blockId).toBe('p-2');
    // 伪造 anchor → document-level（anchor=null），不伪造定位。
    const faked = issues.find((issue) => issue.title === '伪造锚点应被降级')!;
    expect(faked.anchor).toBeNull();
    // run 状态。
    const runs = review.listRuns('proj-1', outcomeId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.baseDraftHash).toBe(draftHash);
  });

  it('dedupes issues with identical normalized titles across segments', async () => {
    const { db, workbench, review, outcomeId } = setup({
      type: 'word',
      blocks: [
        { id: 'h-1', kind: 'heading', text: '引言' },
        { id: 'p-1', kind: 'paragraph', text: '背景。' },
        { id: 'h-2', kind: 'heading', text: '结论' },
        { id: 'p-2', kind: 'paragraph', text: '结论内容。' },
      ],
    });
    const pipeline = makePipeline({
      workbench, review, db,
      responder: () => JSON.stringify({ issues: [{ category: 'language', severity: 'minor', title: ' 表 达 冗 余 ', explanation: '', anchorBlockId: '' }] }),
    });
    const result = await pipeline.startReview('proj-1', outcomeId, 'full');
    expect(result.ok).toBe(true);
    // 两个 segment 各产一条同题 → 去重后 1 条。
    expect(review.listIssues('proj-1', outcomeId)).toHaveLength(1);
  });

  it('cancellation marks the run cancelled and stops persistence', async () => {
    const { db, workbench, review, outcomeId } = setup({
      type: 'word',
      blocks: [
        { id: 'h-1', kind: 'heading', text: '引言' },
        { id: 'p-1', kind: 'paragraph', text: '背景。' },
        { id: 'h-2', kind: 'heading', text: '结论' },
        { id: 'p-2', kind: 'paragraph', text: '结论。' },
      ],
    });
    const controller = new AbortController();
    const pipeline = makePipeline({
      workbench, review, db, signal: controller.signal,
      responder: () => { controller.abort(); return JSON.stringify({ issues: [{ category: 'structure', severity: 'minor', title: 'x', explanation: '', anchorBlockId: '' }] }); },
    });
    const result = await pipeline.startReview('proj-1', outcomeId, 'full');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('review_cancelled');
    expect(review.listRuns('proj-1', outcomeId)[0]!.status).toBe('cancelled');
  });

  it('deterministic evidence coverage: strong claim without any project evidence → issue', () => {
    const segments = segmentDocument({
      type: 'word',
      blocks: [
        { id: 'h-1', kind: 'heading', text: '结论' },
        { id: 'p-1', kind: 'paragraph', text: '因此，制度显著决定职业能力形成。' },
      ],
    });
    expect(segments[0]!.role).toBe('conclusion');
    const candidates = evidenceCoverageCandidates(segments, 0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.severity).toBe('major');
    // 项目已有证据 → 不再提示。
    expect(evidenceCoverageCandidates(segments, 3)).toHaveLength(0);
  });

  it('extractIssuesJson tolerates fences and prose', () => {
    const raw = ['好的，以下是审查结果：', '```json', '{"issues":[{"category":"method","severity":"minor","title":"t","explanation":"e","anchorBlockId":"p-1"}]}', '```', '请核对。'].join('\n');
    const parsed = extractIssuesJson(raw);
    expect(parsed?.issues).toHaveLength(1);
    expect(parsed?.issues[0]!.anchorBlockId).toBe('p-1');
    expect(extractIssuesJson('没有 JSON')).toBeNull();
  });
});
