/**
 * Tests for AgentLoop real streaming with fallback.
 */

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import type { BaseProvider } from '../../engine/providers/BaseProvider.js';
import type { StreamChunk, NormalizedResponse } from '../../engine/core/types.js';

function fakeStreamingProvider(chunks: StreamChunk[]): BaseProvider {
  return {
    capabilities: () => ({ providerType: 'test', model: 'test-model', nativeToolCalling: true, jsonSchemaOutput: false, streaming: true }),
    async complete() { throw new Error('should not call complete when streaming works'); },
    async *completeStream() { for (const chunk of chunks) yield chunk; },
    async healthCheck() { return {}; },
    async close() {},
  } as unknown as BaseProvider;
}

function fakeNonStreamingProvider(response: NormalizedResponse): BaseProvider {
  return {
    capabilities: () => ({ providerType: 'test', model: 'test-model', nativeToolCalling: true, jsonSchemaOutput: false, streaming: false }),
    async complete() { return response; },
    completeStream: (() => { throw new Error('no streaming'); }) as unknown as BaseProvider['completeStream'],
    async healthCheck() { return {}; },
    async close() {},
  } as unknown as BaseProvider;
}

describe('AgentLoop streaming', () => {
  it('uses real streaming when provider supports it', async () => {
    const provider = fakeStreamingProvider([
      { content: 'Hello', isFinished: false, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      { content: ' world', isFinished: false, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      { content: '!', isFinished: true, usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
    ]);
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const chunks: string[] = [];
    loop.hooks.register('model.stream_chunk', async (ctx) => {
      chunks.push((ctx as { content?: string }).content ?? '');
    });
    const result = await loop.run({ messages: [{ role: 'user', content: 'hi' }], maxTurns: 1 });
    expect(result.finalText).toBe('Hello world!');
    expect(chunks).toEqual(['Hello', ' world', '!']);
  });

  it('falls back to complete() when streaming fails', async () => {
    const provider = fakeNonStreamingProvider({
      content: 'Fallback answer',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    });
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const chunks: string[] = [];
    loop.hooks.register('model.stream_chunk', async (ctx) => {
      chunks.push((ctx as { content?: string }).content ?? '');
    });
    const result = await loop.run({ messages: [{ role: 'user', content: 'hi' }], maxTurns: 1 });
    expect(result.finalText).toBe('Fallback answer');
    expect(chunks).toEqual(['Fallback answer', '']);
  });
});
