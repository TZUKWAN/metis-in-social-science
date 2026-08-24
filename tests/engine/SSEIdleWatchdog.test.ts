/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { streamOpenAIResponse } from '../../engine/providers/SSEParser.js';

function fakeResponse(read: () => Promise<{ done: boolean; value?: Uint8Array }>) {
  return {
    body: {
      getReader: () => ({
        read,
        cancel: () => Promise.resolve(),
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response;
}

describe('streamOpenAIResponse idle watchdog', () => {
  it('aborts a dead stream that never delivers bytes within the idle window', async () => {
    // 模拟网关假死：连接保持打开，但永远不产生任何字节。
    const response = fakeResponse(() => new Promise(() => undefined));
    const started = Date.now();
    await expect(async () => {
      for await (const chunk of streamOpenAIResponse(response, 50)) void chunk;
    }).rejects.toThrowError(/idle/u);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('still completes a healthy stream that delivers bytes promptly', async () => {
    const encoder = new TextEncoder();
    const payload = [
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ].map((line) => encoder.encode(line));
    let index = 0;
    const response = fakeResponse(async () => (
      index < payload.length
        ? { done: false, value: payload[index++] }
        : { done: true }
    ));
    const chunks: string[] = [];
    for await (const chunk of streamOpenAIResponse(response, 1000)) chunks.push(chunk.content ?? '');
    expect(chunks.join('')).toContain('你好');
    expect(chunks.join('')).toContain('世界');
  });

  it('resets the idle window on every chunk so slow-but-active streams survive', async () => {
    const encoder = new TextEncoder();
    const lines = [
      'data: {"choices":[{"delta":{"content":"甲"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"乙"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].map((line) => encoder.encode(line));
    let index = 0;
    const response = fakeResponse(async () => {
      // 每个分块间隔 80ms：低于 150ms 窗口但累计超过窗口，慢流不应被掐。
      await new Promise((resolve) => setTimeout(resolve, 80));
      return index < lines.length ? { done: false, value: lines[index++] } : { done: true };
    });
    const chunks: string[] = [];
    for await (const chunk of streamOpenAIResponse(response, 150)) chunks.push(chunk.content ?? '');
    expect(chunks.join('')).toContain('甲乙');
  });
});
