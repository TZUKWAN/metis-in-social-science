import { describe, expect, it } from 'vitest';
import { presentOutcomeAssistantAnswer, scrubPresentationProtocol } from '../../src/presentation/presentationProtocolScrubber';

describe('scrubPresentationProtocol', () => {
  it('removes complete and truncated text protocols', () => {
    expect(scrubPresentationProtocol('前文。<tool_call>{"tool":"x"}</tool_call>后文。')).toBe('前文。后文。');
    expect(scrubPresentationProtocol('前文。<dots_function_call>{"tool":"x"}')).toBe('前文。');
  });

  it('preserves ordinary comparison text and markdown', () => {
    const text = 'a < b\n\n```json\n{"name":"keep"}\n```';
    expect(scrubPresentationProtocol(text)).toBe(text);
  });

  it('preserves METIS interactive fences byte-for-byte', () => {
    const fence = '```metis-choice-group\n{"question":"选择","options":["A"],"key":"q"}\n```';
    expect(scrubPresentationProtocol(`前文。<tool_calls>{"tool":"x"}</tool_calls>${fence}后文。`)).toBe(`前文。${fence}后文。`);
  });
});

describe('presentOutcomeAssistantAnswer', () => {
  it('projects only the answer body from a persisted assistant envelope', () => {
    const envelope = JSON.stringify({
      answer: '已润色所选段落，并统一了术语。',
      edit: { kind: 'word', replacements: [{ blockId: 'b-3', text: '内部替换文本' }] },
    });
    const projected = presentOutcomeAssistantAnswer(envelope);
    expect(projected).toContain('已润色所选段落');
    expect(projected).not.toContain('blockId');
    expect(projected).not.toContain('内部替换文本');
    expect(projected).not.toContain('"answer"');
  });

  it('leaves plain assistant answers unchanged apart from protocol scrubbing', () => {
    expect(presentOutcomeAssistantAnswer('普通回答。<tool_call>{"x":1}</tool_call>')).toBe('普通回答。');
  });

  it('falls back to scrubbed content for malformed or empty envelopes', () => {
    expect(presentOutcomeAssistantAnswer('{"answer":"","edit":null}')).toBe('{"answer":"","edit":null}');
    expect(presentOutcomeAssistantAnswer('{"answer":')).toBe('{"answer":');
  });

  it('tolerates unescaped quotes inside the model answer', () => {
    const raw = '{"answer":"在偏离"不改变含义"的要求下保持语义。","edit":null}';
    const projected = presentOutcomeAssistantAnswer(raw);
    expect(projected).toContain('在偏离"不改变含义"的要求下保持语义。');
    expect(projected).not.toContain('"edit"');
    expect(projected).not.toContain('"answer"');
  });

  it('projects answers from envelopes truncated by the persistence layer', () => {
    const raw = '{"answer":"已根据要求对所选摘要段落作进一步润色，主要调整包括：统一句式';
    const projected = presentOutcomeAssistantAnswer(`${raw}…（回答过长已截断；本次没有产生可应用的修改）`);
    expect(projected).toContain('已根据要求对所选摘要段落作进一步润色');
    expect(projected).not.toContain('回答过长已截断');
    expect(projected).not.toContain('{"answer"');
  });
});
