/**
 * TopicStreamGate tests — incremental protocol scrubbing for topic streams.
 *
 * Real-world leak (2026-09 刘总报告): DeepSeek-family models emit
 * `<dots_function_call>{"tool":…}` blocks and `<FILE>` result echoes as
 * TEXT inside the assistant stream. These must never reach the chat;
 * they become tool events instead.
 */
import { describe, expect, it } from 'vitest';
import { TopicStreamGate, stripTopicProtocol } from '../../engine/runtime/TopicStreamGate.js';

function feedChunks(gate: TopicStreamGate, chunks: string[]): string {
  let out = '';
  for (const chunk of chunks) out += gate.push(chunk);
  return out + gate.flush();
}

describe('TopicStreamGate — incremental protocol scrubbing', () => {
  it('passes plain prose through untouched', () => {
    const gate = new TopicStreamGate();
    expect(feedChunks(gate, ['你好', '，世界！'])).toBe('你好，世界！');
    expect(gate.drainEvents()).toEqual([]);
  });

  it('handles deltas split in the middle of the opening tag', () => {
    const gate = new TopicStreamGate();
    const out = feedChunks(gate, [
      '前文。',
      '<dots_funct',
      'ion_call> {"tool": "ncpssd_search", "args": {"query": "党史"}}',
      ' 后文。',
    ]);
    expect(out).toBe('前文。 后文。');
    const events = gate.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('ncpssd_search');
  });

  it('swallows result echoes with bare protocol tags (<FILE>)', () => {
    const gate = new TopicStreamGate();
    const out = feedChunks(gate, [
      '<dots_function_call> 中共党史 10 <FILE>',
      '\n后续正文。',
    ]);
    expect(out).toBe('\n后续正文。');
    expect(gate.drainEvents().length).toBeGreaterThanOrEqual(1);
  });

  it('handles multi-call batches separated by re-opened tags', () => {
    const gate = new TopicStreamGate();
    const out = feedChunks(gate, [
      '<dots_function_call> {"tool": "web_search", "args": {"query": "a"}} {"tool": "search_papers", "args": {"query": "b"}}',
      '答案正文。',
    ]);
    expect(out).toBe('答案正文。');
    const events = gate.drainEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('a lone < in prose is preserved', () => {
    const gate = new TopicStreamGate();
    expect(feedChunks(gate, ['x < y'])).toBe('x < y');
  });

  it('an unclosed protocol block at end of stream is flushed as an event, not shown', () => {
    const gate = new TopicStreamGate();
    const out = feedChunks(gate, ['正文。', '<dots_function_call> {"tool": "web_search", "args": {"query": "x"}}']);
    expect(out).toBe('正文。');
    expect(gate.drainEvents().length).toBeGreaterThanOrEqual(1);
  });

  it('stripTopicProtocol (one-shot) matches the incremental behavior', () => {
    const { text, toolEvents } = stripTopicProtocol(
      '开始。<dots_function_call> {"tool": "ncpssd_search", "args": {"query": "q"}} <FILE> 结束。',
    );
    expect(text).toBe('开始。 结束。');
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolEvents.some((e) => e.tool === 'ncpssd_search')).toBe(true);
  });

  it('empty deltas are safe', () => {
    const gate = new TopicStreamGate();
    expect(gate.push('')).toBe('');
    expect(gate.flush()).toBe('');
  });
});
