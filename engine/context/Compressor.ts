/**
 * Message compression for context budget management.
 *
 * Supports two strategies:
 *   1. Truncation + dropping (fast, no LLM call) — default
 *   2. LLM summarization (slower, preserves semantics) — for small-context models
 *
 * Ported from metis/context/compressor.py.
 */

import { COMPRESS_PREVIEW_CHARS } from '../core/Config.js';
import type { ChatMessage } from '../core/types.js';

export interface CompressionResult {
  messages: ChatMessage[];
  compressed: boolean;
  originalChars: number;
  finalChars: number;
  /** Whether LLM summarization was used (vs truncation) */
  summarized: boolean;
}

/**
 * Compress messages to fit within a character budget.
 *
 * @param messages - Full message history
 * @param maxChars - Character budget
 * @param summarizer - Optional LLM summarizer function. If provided,
 *   old non-system messages are summarized instead of being dropped.
 */
export async function compressMessages(
  messages: ChatMessage[],
  maxChars: number,
  summarizer?: (msgs: ChatMessage[]) => Promise<string>,
): Promise<CompressionResult> {
  const originalChars = countChars(messages);
  if (originalChars <= maxChars) {
    return { messages, compressed: false, originalChars, finalChars: originalChars, summarized: false };
  }

  // Step 1: Truncate large tool results
  let compressed = messages.map((msg) => truncateToolResult(msg));

  let finalChars = countChars(compressed);
  if (finalChars <= maxChars) {
    return { messages: compressed, compressed: true, originalChars, finalChars, summarized: false };
  }

  // Step 2: If summarizer is available, summarize old messages instead of dropping
  if (summarizer) {
    const result = await summarizeOldMessages(compressed, maxChars, summarizer);
    // summarizeOldMessages returns a synthetic summary message + recent messages
    return {
      messages: result,
      compressed: true,
      originalChars,
      finalChars: countChars(result),
      summarized: true,
    };
  }

  // Step 3: Fallback — drop oldest messages (keep system + last N)
  const systemMessages = compressed.filter((m) => m.role === 'system');
  const nonSystemMessages = compressed.filter((m) => m.role !== 'system');

  const keepCount = Math.max(4, Math.floor(nonSystemMessages.length * 0.5));
  const keptNonSystem = nonSystemMessages.slice(-keepCount);

  compressed = [...systemMessages, ...keptNonSystem];

  finalChars = countChars(compressed);
  return { messages: compressed, compressed: true, originalChars, finalChars, summarized: false };
}

/**
 * Summarize old messages by calling the LLM summarizer and merging
 * the result into a single system-level summary message, then keeping
 * recent messages intact.
 *
 * Strategy:
 *   - Split messages into "old" (first 50%) and "recent" (last 50%)
 *   - Call summarizer on old messages to produce a condensed summary
 *   - Replace old messages with a single system message containing the summary
 *   - Keep recent messages intact
 */
async function summarizeOldMessages(
  _messages: ChatMessage[],
  _maxChars: number,
  _summarizer: (msgs: ChatMessage[]) => Promise<string>,
): Promise<ChatMessage[]> {
  const systemMessages = _messages.filter((m) => m.role === 'system');
  const nonSystem = _messages.filter((m) => m.role !== 'system');

  if (nonSystem.length <= 6) {
    return _messages.map((m) => truncateToolResult(m));
  }

  const splitPoint = Math.floor(nonSystem.length * 0.5);
  const oldMessages = nonSystem.slice(0, splitPoint);
  const recentMessages = nonSystem.slice(splitPoint);

  let summaryContent: string;
  try {
    summaryContent = await _summarizer(oldMessages);
  } catch {
    summaryContent = `[Autocompact: ${oldMessages.length} messages summarized]`;
  }

  const summaryMessage: ChatMessage = {
    role: 'system',
    content: summaryContent,
    metadata: {
      summarizedCount: oldMessages.length,
      originalChars: countChars(oldMessages),
    },
  };

  return [...systemMessages, summaryMessage, ...recentMessages];
}

// ─── Helpers ──────────────────────────────────────────────────

function countChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + (msg.content?.length ?? 0), 0);
}

/**
 * Compute semantic importance score for a message (0-1).
 * Higher score = more important, lower = more drop-able.
 *
 * Scoring factors:
 *   - Role weight: user(1.0) > assistant(0.8) > system(0.6) > tool(0.4)
 *   - Recency bonus: messages in last 25% of list get +0.2
 *   - Content markers: +0.15 for research questions, findings, decisions, errors
 *   - Penalty: very long tool results (-0.1), very short messages (-0.05)
 */
export function scoreMessageImportance(
  msg: ChatMessage,
  index: number,
  total: number,
): number {
  let score: number;

  // Role-based base score
  switch (msg.role) {
    case 'user': score = 1.0; break;
    case 'assistant': score = 0.8; break;
    case 'system': score = 0.6; break;
    default: score = 0.4; break; // tool
  }

  // Recency bonus (later messages more important)
  if (index > total * 0.75) score += 0.2;
  else if (index > total * 0.5) score += 0.1;

  // Content signal boost (key semantic markers)
  const content = msg.content?.toLowerCase() ?? '';
  const signals = [
    'research question', 'hypothesis', 'finding', 'conclusion',
    'methodology', 'result', 'key insight', 'important',
    'error:', 'failed:', 'decision:', 'next step',
  ];
  const signalCount = signals.filter((s) => content.includes(s)).length;
  if (signalCount > 0) score += Math.min(0.15, signalCount * 0.05);

  // Penalties
  if (msg.role === 'tool' && content.length > 2000) score -= 0.1;
  if (content.length < 10) score -= 0.05;

  return Math.max(0, Math.min(1.0, score));
}

function truncateToolResult(msg: ChatMessage): ChatMessage {
  if (msg.role !== 'tool' || !msg.content) return msg;
  if (msg.content.length <= COMPRESS_PREVIEW_CHARS) return msg;

  const truncated = msg.content.slice(0, COMPRESS_PREVIEW_CHARS) +
    `\n... [truncated ${msg.content.length - COMPRESS_PREVIEW_CHARS} chars]`;

  return { ...msg, content: truncated };
}
