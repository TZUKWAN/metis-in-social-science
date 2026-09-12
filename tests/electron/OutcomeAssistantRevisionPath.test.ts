/**
 * T03.01 验收（任务书 CASE 03/05 的服务层等价）：
 * 有 workbench 依赖时，AI 修改默认产生 Revision Set 提案——
 * currentVersion 不变、原 draft 未被覆盖、可预览 after、Accept 后写草稿仍不写版本。
 * 无 workbench 的自动化管线（SubmissionOptimization）保持旧直改路径（既有测试覆盖）。
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { ChatMessage, NormalizedResponse, ProviderCapabilities, StreamChunk } from '../../engine/core/types.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeAssistantService } from '../../electron/OutcomeAssistantService.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeWorkbenchService, outcomeContentHash } from '../../electron/OutcomeWorkbenchService.js';

class ControlledProvider extends BaseProvider {
  constructor(private readonly response: string) { super(); }
  capabilities(): ProviderCapabilities {
    return {
      providerType: 'ControlledProvider', model: 'revision-path-model', nativeToolCalling: false,
      jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 32_000,
      maxOutputTokens: 4_096, retryableStatusCodes: [],
    };
  }
  async complete(_messages: ChatMessage[]): Promise<NormalizedResponse> {
    return { content: this.response, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
  }
  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> { /* not used */ }
}

describe('OutcomeAssistant 默认 Revision 路径（T03.01）', () => {
  let db: Database.Database;
  let repository: OutcomeRepository;
  let workbench: OutcomeWorkbenchService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES ('project-a','P','','active',1,1,'user')").run();
    repository = new OutcomeRepository(db);
    workbench = new OutcomeWorkbenchService(db, repository);
  });

  afterEach(() => { if (db) db.close(); });

  it('润色当前段落后：version 不变、RevisionSet 出现、原文仍在、可预览 after；Accept 后仍不写版本', async () => {
    const created = repository.create({
      projectId: 'project-a', categoryId: null, title: '论文', kind: 'word', note: '', actor: 'human',
      content: { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '原始段落内容。' }], page: {}, header: '', footer: '' },
    });
    const outcomeId = created.outcome.id;
    workbench.openForEdit('project-a', outcomeId);
    // 用户先把草稿改成自己的最新表达（确保提案基于 draft 而非 version）。
    const draftBefore = workbench.getDraft('project-a', outcomeId)!;
    workbench.saveDraft('project-a', outcomeId, {
      baseVersion: 1,
      content: { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '用户手改后的段落。' }], page: {}, header: '', footer: '' },
      updatedBy: 'human',
    });
    const draftHashBefore = workbench.getDraft('project-a', outcomeId)!.contentHash;

    const provider = new ControlledProvider(JSON.stringify({
      answer: '我建议把这段改得更学术。',
      edit: { kind: 'word', replacements: [{ blockId: 'p-1', text: '更学术的表述。' }], note: '学术化润色' },
    }));
    const assistant = new OutcomeAssistantService({
      repository,
      agentLoop: new AgentLoop({ provider, registry: new ToolRegistry(), dispatcher: new ToolDispatcher(new ToolRegistry()) }),
      modelName: 'revision-path-model',
      workbench,
    });
    const result = await assistant.chat({ projectId: 'project-a', outcomeId, instruction: '润色当前段落' });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    // 默认路径：不产生 applied（不写版本），产生 proposed。
    expect(result.applied).toBeUndefined();
    const proposed = result.proposed as { set: { id: string; createdBy: string; baseDraftHash: string }; revisions: Array<{ target: { kind: string; blockId: string; beforeHash: string }; after: { text: string } }> };
    expect(proposed).toBeTruthy();
    expect(proposed.set.createdBy).toBe('ai');
    // beforeHash 基于 draft 的当前内容（用户手改后），而非 version。
    expect(proposed.revisions[0]!.target.beforeHash).toBe(outcomeContentHash({ id: 'p-1', kind: 'paragraph', text: '用户手改后的段落。' }));
    // 提案未应用：draft 未变、version 未增。
    expect(workbench.getDraft('project-a', outcomeId)!.contentHash).toBe(draftHashBefore);
    expect(repository.list('project-a').find((item) => item.id === outcomeId)!.currentVersion).toBe(1);
    // Accept → 写入 draft，仍不写版本。
    const accepted = workbench.acceptRevision('project-a', proposed.set.id, (proposed.revisions[0] as { id: string }).id);
    expect(accepted.ok).toBe(true);
    const draftAfter = workbench.getDraft('project-a', outcomeId)!;
    expect((draftAfter.content as { blocks: Array<{ text?: string }> }).blocks[0]!.text).toBe('更学术的表述。');
    expect(repository.list('project-a').find((item) => item.id === outcomeId)!.currentVersion).toBe(1);
    void draftBefore;
  });

  it('AI 目标在草稿中已不存在 → 不产生提案、不崩溃，diagnostics 说明原因', async () => {
    const created = repository.create({
      projectId: 'project-a', categoryId: null, title: '论文2', kind: 'word', note: '', actor: 'human',
      content: { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '只有一段。' }], page: {}, header: '', footer: '' },
    });
    workbench.openForEdit('project-a', created.outcome.id);
    const provider = new ControlledProvider(JSON.stringify({
      answer: '尝试改一个不存在的段落。',
      edit: { kind: 'word', replacements: [{ blockId: 'p-404', text: 'x' }], note: '' },
    }));
    const assistant = new OutcomeAssistantService({
      repository,
      agentLoop: new AgentLoop({ provider, registry: new ToolRegistry(), dispatcher: new ToolDispatcher(new ToolRegistry()) }),
      modelName: 'revision-path-model',
      workbench,
    });
    const result = await assistant.chat({ projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改' });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.proposed).toBeUndefined();
    expect(result.applied).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === 'edit_target_not_found')).toBe(true);
  });
});
