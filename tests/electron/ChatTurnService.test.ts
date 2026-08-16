import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { runEphemeralChatTurn, runPersistedChatTurn, CHAT_DEFAULT_MAX_TURNS } from '../../electron/ChatTurnService.js';
import type { ChatMessage, NormalizedResponse, ProviderUsage, StreamChunk, ToolSpec } from '../../engine/core/types.js';

let store: PersistenceStore;
let tmpDir: string;

function createLoop(response: string): AgentLoop {
  const registry = new ToolRegistry();
  return new AgentLoop({
    provider: new FakeProvider({ response }),
    registry,
    dispatcher: new ToolDispatcher(registry),
    workspace: tmpDir,
  });
}

// ─── UX-CHAT-001: scripted tool-call provider ─────────────────

/** Provider that returns a scripted sequence of responses (tool call → answer). */
class MultiTurnProvider extends BaseProvider {
  private callIndex = 0;
  private readonly responses: NormalizedResponse[];

  constructor(responses: NormalizedResponse[]) {
    super();
    this.responses = responses;
  }

  capabilities() {
    return {
      providerType: 'MultiTurnTest',
      model: 'test-model',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false,
      thinking: false,
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
      retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    void messages; void tools;
    const idx = Math.min(this.callIndex, this.responses.length - 1);
    this.callIndex++;
    return this.responses[idx]!;
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {
    // Not used — streaming is false
  }
}

function makeUsage(p = 10, c = 20, t = 30): ProviderUsage {
  return { promptTokens: p, completionTokens: c, totalTokens: t };
}

function createToolLoop(responses: NormalizedResponse[]): AgentLoop {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo back the input',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to echo' } },
      required: ['message'],
    },
  });
  const dispatcher = new ToolDispatcher(registry);
  dispatcher.registerHandler('echo', async (args: Record<string, unknown>) => `Echo: ${args.message}`);
  return new AgentLoop({
    provider: new MultiTurnProvider(responses),
    registry,
    dispatcher,
    workspace: tmpDir,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-chat-turn-'));
  store = new PersistenceStore(path.join(tmpDir, 'chat.db'));
  store.createSession('session-1');
});

afterEach(() => {
  store?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runPersistedChatTurn', () => {
  it('persists only the new user and current assistant response', async () => {
    const response = await runPersistedChatTurn({
      agentLoop: createLoop('current answer'),
      store,
      sessionId: 'session-1',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'second question' },
      ],
      requestId: 'chat-1',
    });

    expect(response).toMatchObject({
      version: 1,
      turnId: 'chat-1',
      status: 'completed',
      answer: 'current answer',
      citations: [],
      events: [],
    });
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'current answer' },
    ]);
    expect(store.getSession('session-1')?.messageCount).toBe(2);
  });

  it('does not duplicate prior history over consecutive turns', async () => {
    const firstHistory: ChatMessage[] = [{ role: 'user', content: 'first question' }];
    await runPersistedChatTurn({
      agentLoop: createLoop('first answer'),
      store,
      sessionId: 'session-1',
      messages: firstHistory,
      requestId: 'chat-1',
    });

    await runPersistedChatTurn({
      agentLoop: createLoop('second answer'),
      store,
      sessionId: 'session-1',
      messages: [
        ...firstHistory,
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
      requestId: 'chat-2',
    });

    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ]);
  });

  it('replaces the last assistant response when regenerating', async () => {
    store.appendMessage('session-1', 'user', 'question');
    store.appendMessage('session-1', 'assistant', 'old answer');

    await runPersistedChatTurn({
      agentLoop: createLoop('replacement answer'),
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-regenerate',
      options: { mode: 'regenerate' },
    });

    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'replacement answer' },
    ]);
    expect(store.getSession('session-1')?.messageCount).toBe(2);
  });

  it('does not persist an empty interrupted response', async () => {
    const agentLoop = {
      run: async () => ({
        status: 'interrupted' as const,
        finalText: '',
        finalVerified: false,
        messages: [{ role: 'user', content: 'question' }] as ChatMessage[],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        errors: ['interrupted'],
        traceEvents: [],
      }),
    };

    const response = await runPersistedChatTurn({
      agentLoop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-error',
    });

    expect(response).toEqual({
      version: 1,
      turnId: 'chat-error',
      status: 'interrupted',
      answer: '',
      diagnostics: [{ severity: 'error', code: 'agent_interrupted' }],
      citations: [],
      events: [],
    });
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'question' },
    ]);
  });

  it('never exposes or persists an unverified partial answer', async () => {
    const agentLoop = {
      run: async () => ({
        status: 'completed' as const,
        finalText: 'partial Authorization: Bearer should-never-cross-boundary',
        finalVerified: false,
        messages: [] as ChatMessage[],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        errors: [],
        traceEvents: [],
      }),
    };

    const response = await runPersistedChatTurn({
      agentLoop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-unverified',
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    expect(JSON.stringify(response)).not.toContain('should-never-cross-boundary');
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'question' },
    ]);
  });

  it('passes the frozen scenario prompt, tool allowlist and manifest bindings to AgentLoop', async () => {
    const run = vi.fn().mockResolvedValue({
      status: 'completed' as const,
      finalText: 'scenario answer',
      finalVerified: true,
      messages: [] as ChatMessage[],
      turnsUsed: 1,
      toolResults: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
    });
    const controller = new AbortController();
    const liveSteering = { drain: vi.fn().mockReturnValue([]) };
    const fullAccess = {
      mode: 'full_access' as const,
      perActionConfirmation: false as const,
      liveSteering: true as const,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    };
    await runPersistedChatTurn({
      agentLoop: { run },
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-personalized',
      skillPrompt: 'resolved scenario prompt',
      allowedTools: [],
      maxTurns: 7,
      taskContractHash: 'a'.repeat(64),
      promptStackHash: 'b'.repeat(64),
      fullAccess,
      signal: controller.signal,
      liveSteering,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      skillPrompt: 'resolved scenario prompt',
      allowedTools: [],
      maxTurns: 7,
      taskContractHash: 'a'.repeat(64),
      promptStackHash: 'b'.repeat(64),
      fullAccess,
      signal: controller.signal,
      liveSteering,
    }));
  });
});

// O15: 多模型对比的临时回合——与 runPersistedChatTurn 共用响应口径，但完全
// 不触碰 PersistenceStore（对比的 N 个 profile 并行调用若各自落库会把用户
// 消息写 N 遍）。
describe('runEphemeralChatTurn (O15 multi-model compare)', () => {
  it('returns the profile answer without persisting anything', async () => {
    const response = await runEphemeralChatTurn({
      agentLoop: createLoop('compare answer A'),
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'compare question' }],
      requestId: 'chatcmp-1',
    });

    expect(response).toMatchObject({
      version: 1,
      turnId: 'chatcmp-1',
      status: 'completed',
      answer: 'compare answer A',
      diagnostics: [],
    });
    // 关键断言：不写用户消息、不写助手回答。
    expect(store.getMessages('session-1')).toEqual([]);
    expect(store.getSession('session-1')?.messageCount ?? 0).toBe(0);
  });

  it('supports true parallel fan-out: each profile loop returns its own answer', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'same question' }];
    const [a, b, c] = await Promise.all([
      runEphemeralChatTurn({ agentLoop: createLoop('answer from A'), sessionId: 'session-1', messages, requestId: 'chatcmp-a' }),
      runEphemeralChatTurn({ agentLoop: createLoop('answer from B'), sessionId: 'session-1', messages, requestId: 'chatcmp-b' }),
      runEphemeralChatTurn({ agentLoop: createLoop('answer from C'), sessionId: 'session-1', messages, requestId: 'chatcmp-c' }),
    ]);

    expect(a.answer).toBe('answer from A');
    expect(b.answer).toBe('answer from B');
    expect(c.answer).toBe('answer from C');
    // 并行三个回合后存储仍然为空。
    expect(store.getMessages('session-1')).toEqual([]);
  });

  it('matches runPersistedChatTurn diagnostics on unverified answers', async () => {
    const unverifiedLoop = {
      run: async () => ({
        status: 'completed' as const,
        finalText: 'thin answer',
        finalVerified: false,
        messages: [] as ChatMessage[],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        errors: [],
        traceEvents: [],
      }),
    };
    const response = await runEphemeralChatTurn({
      agentLoop: unverifiedLoop,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chatcmp-unverified',
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    expect(response.diagnostics).toEqual([{ severity: 'error', code: 'answer_unverified' }]);
  });

  it('rejects turns without a user message or with a blank session', async () => {
    const noUser = await runEphemeralChatTurn({
      agentLoop: createLoop('unused'),
      sessionId: 'session-1',
      messages: [{ role: 'assistant', content: 'only assistant' }],
      requestId: 'chatcmp-nouser',
    });
    expect(noUser.status).toBe('error');
    expect(noUser.diagnostics[0]?.code).toBe('missing_user_message');

    const blankSession = await runEphemeralChatTurn({
      agentLoop: createLoop('unused'),
      sessionId: '   ',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chatcmp-blank',
    });
    expect(blankSession.status).toBe('error');
    expect(blankSession.diagnostics[0]?.code).toBe('invalid_session');
  });
});

// ─── UX-CHAT-001: 工具调用回合必须能被最终回答接续 ──────────────

describe('runPersistedChatTurn tool-call continuation (UX-CHAT-001)', () => {
  it('completes a tool call turn followed by the final answer with the default turn budget', async () => {
    // 受控模型：第一轮必须调用 list_sources 类工具，第二轮读取工具结果后作答。
    const loop = createToolLoop([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: '当前项目资料' }, id: 'tc_sources' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: '基于工具结果：资料已核对。', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const response = await runPersistedChatTurn({
      agentLoop: loop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: '请读取当前项目资料并回答一个证据问题。' }],
      requestId: 'chat-tool-chain',
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('基于工具结果：资料已核对。');
    expect(response.diagnostics).toEqual([]);
    // 用户消息与最终回答都被持久化。
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: '请读取当前项目资料并回答一个证据问题。' },
      { role: 'assistant', content: '基于工具结果：资料已核对。' },
    ]);
    expect(store.getSession('session-1')?.messageCount).toBe(2);
  });

  it('defaults to the bounded CHAT_DEFAULT_MAX_TURNS instead of a single turn', async () => {
    const run = vi.fn().mockResolvedValue({
      status: 'completed' as const,
      finalText: 'ok',
      finalVerified: true,
      messages: [] as ChatMessage[],
      turnsUsed: 1,
      toolResults: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
    });
    await runPersistedChatTurn({
      agentLoop: { run },
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-default-turns',
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: CHAT_DEFAULT_MAX_TURNS }));
  });

  it('still enforces an explicit one-turn cap (max_turns_reached, no persistence of an empty answer)', async () => {
    // 显式 maxTurns=1 时，工具调用占满唯一回合 → 有界失败，而不是无限循环。
    const loop = createToolLoop([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'x' }, id: 'tc_cap' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: '永远不会到达的回答', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const response = await runPersistedChatTurn({
      agentLoop: loop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'cap question' }],
      requestId: 'chat-capped',
      maxTurns: 1,
    });

    expect(response.status).toBe('max_turns_reached');
    expect(response.answer).toBe('');
    expect(response.diagnostics[0]?.code).toBe('agent_max_turns_reached');
    // 用户消息已持久化，但空回答不落库。
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'cap question' },
    ]);
  });
});
