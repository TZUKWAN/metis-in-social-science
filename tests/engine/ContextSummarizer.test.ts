/**
 * Tests for ContextEngine summarizer — long conversation condensation.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextEngine } from '../../engine/context/ContextEngine.js';
import type { ChatMessage } from '../../engine/core/types.js';

function longMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `Message ${i}: ${'x'.repeat(500)}`,
  }));
}

describe('ContextEngine summarizer', () => {
  it('uses the summarizer to condense old messages instead of dropping them', async () => {
    const summarizer = vi.fn(async (msgs: ChatMessage[]) => `SUMMARY of ${msgs.length} messages`);
    const engine = new ContextEngine({
      budget: { modelContextTokens: 4000, modelOutputTokens: 1000, contextThreshold: 0.5, perToolChars: 2000, maxToolResultChars: 8000, maxTurns: 12 },
      summarizer,
    });
    const result = await engine.build(longMessages(50));
    expect(summarizer).toHaveBeenCalled();
    const hasSummary = result.messages.some((m) => m.content.includes('SUMMARY'));
    expect(hasSummary).toBe(true);
  });

  it('drops messages when no summarizer is provided', async () => {
    const engine = new ContextEngine({
      budget: { modelContextTokens: 4000, modelOutputTokens: 1000, contextThreshold: 0.5, perToolChars: 2000, maxToolResultChars: 8000, maxTurns: 12 },
    });
    const result = await engine.build(longMessages(50));
    expect(result.compressed).toBe(true);
    expect(result.messages.length).toBeLessThan(50);
  });
});
