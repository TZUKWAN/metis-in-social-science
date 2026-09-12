/**
 * T09.07/T12.05 图谱抽取编排验收：
 * 分段→AI 候选→canonical claim 映射→概念节点 unverified→关系边→项目隔离。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { ChatMessage, NormalizedResponse, ProviderCapabilities, StreamChunk } from '../../engine/core/types.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeWorkbenchService } from '../../electron/OutcomeWorkbenchService.js';
import { ResearchGraphService } from '../../electron/OutcomeMemoryReviewGraphService.js';
import { OutcomeGraphExtractionService, extractGraphJson } from '../../electron/OutcomeGraphExtractionService.js';

class ScriptedProvider extends BaseProvider {
  constructor(private readonly responder: (messages: ChatMessage[]) => string) { super(); }
  capabilities(): ProviderCapabilities {
    return { providerType: 'ScriptedProvider', model: 'extract-test-model', nativeToolCalling: false, jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 32_000, maxOutputTokens: 4_096, retryableStatusCodes: [] };
  }
  async complete(messages: ChatMessage[]): Promise<NormalizedResponse> {
    return { content: this.responder(messages), toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
  }
  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> { /* not used */ }
}

describe('OutcomeGraphExtraction（T09.07/T12.05）', () => {
  it('extracts concepts as unverified nodes, maps canonical claims, links edges; project isolated', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES ('proj-1','P','','active',1,1,'test')").run();
    const now = Date.now();
    db.prepare("INSERT INTO claims (id,project_id,statement,claim_type,confidence,status,metadata,created_at,updated_at) VALUES ('clm-1','proj-1','制度显著影响职业能力形成','finding',0.5,'supported','{}',?,?)").run(now, now);
    const outcomes = new OutcomeRepository(db);
    const created = outcomes.create({
      projectId: 'proj-1', categoryId: null, title: '论文', kind: 'word', note: '', actor: 'human',
      content: {
        type: 'word',
        blocks: [
          { id: 'h-1', kind: 'heading', text: '理论框架' },
          { id: 'p-1', kind: 'paragraph', text: '本研究以制度理论为分析框架，讨论技能形成体制。' },
          { id: 'p-2', kind: 'paragraph', text: '制度显著影响职业能力形成。' },
        ],
        page: {}, header: '', footer: '',
      },
    });
    const workbench = new OutcomeWorkbenchService(db, outcomes);
    workbench.openForEdit('proj-1', created.outcome.id);
    const graph = new ResearchGraphService(db);
    const provider = new ScriptedProvider((messages) => {
      const text = messages.at(-1)!.content;
      if (text.includes('理论框架')) {
        return JSON.stringify({
          nodes: [
            { label: '制度理论', kind: 'theory' },
            { label: '技能形成体制', kind: 'concept', claimStatement: '制度显著影响职业能力形成' },
          ],
          edges: [{ sourceLabel: '制度理论', targetLabel: '技能形成体制', relation: 'explains' }],
        });
      }
      return JSON.stringify({ nodes: [], edges: [] });
    });
    const extractor = new OutcomeGraphExtractionService({
      db, workbench, graph,
      agentLoop: new AgentLoop({ provider, registry: new ToolRegistry(), dispatcher: new ToolDispatcher(new ToolRegistry()) }),
      modelName: 'extract-test-model',
    });
    const result = await extractor.extractFromOutcome('proj-1', created.outcome.id);
    expect(result.ok).toBe(true);
    expect(result.nodes).toBe(2);
    expect(result.edges).toBe(1);
    // canonical claim 节点：指向权威 clm-1，provenance=canonical。
    const claimNode = graph.listNodes('proj-1').find((node) => node.canonicalEntityId === 'clm-1');
    expect(claimNode).toBeTruthy();
    expect(claimNode!.provenance).toBe('canonical');
    // AI 概念节点：unverified + ai_extracted（§23.1）。
    const concept = graph.listNodes('proj-1').find((node) => node.label === '制度理论');
    expect(concept!.verificationStatus).toBe('unverified');
    expect(concept!.provenance).toBe('ai_extracted');
    // 边：AI 推断未验证。
    const edge = graph.listEdges('proj-1')[0]!;
    expect(edge.verificationStatus).toBe('unverified');
    // 项目隔离。
    expect(graph.listNodes('proj-2')).toHaveLength(0);
  });

  it('extractGraphJson tolerates fences/prose and rejects malformed payloads', () => {
    const raw = ['```json', '{"nodes":[{"label":"A","kind":"concept"}],"edges":[{"sourceLabel":"A","targetLabel":"A","relation":"related_to"}]}', '```'].join('\n');
    const parsed = extractGraphJson(raw);
    expect(parsed?.nodes).toHaveLength(1);
    expect(parsed?.edges).toHaveLength(1);
    expect(extractGraphJson('nothing here')).toBeNull();
    expect(extractGraphJson('{"issues":[]}')).toBeNull();
  });
});
