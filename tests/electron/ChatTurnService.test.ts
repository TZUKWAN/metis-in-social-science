import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { runPersistedChatTurn } from '../../electron/ChatTurnService.js';
import type { ChatMessage } from '../../engine/core/types.js';

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
});
