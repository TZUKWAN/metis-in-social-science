/**
 * SSE (Server-Sent Events) stream parser for OpenAI-compatible APIs.
 *
 * Ported from metis/providers/parsers/openai_native.py + metis/providers/openai_compat.py SSE logic.
 *
 * Design goals:
 * - Parse SSE streams from any OpenAI-compatible API (OpenAI, GLM, Kimi, DeepSeek, etc.)
 * - Handle chunked transfer encoding
 * - Emit structured StreamChunk objects
 * - Support tool_calls in streaming responses
 * - Handle reasoning/thinking content
 */

import type { StreamChunk, ToolCall, ProviderUsage } from '../core/types.js';

// ─── SSE Line Parser ──────────────────────────────────────────

/**
 * Parse raw SSE text into individual event data strings.
 * Handles: "data: ...\n\n", "data: [DONE]\n\n", comments, etc.
 */
export function* parseSSELines(rawText: string): Generator<string, void, unknown> {
  let buffer = '';

  for (const char of rawText) {
    buffer += char;
    if (buffer.endsWith('\n\n') || buffer.endsWith('\r\n\r\n')) {
      const event = buffer;
      buffer = '';

      for (const line of event.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          yield data;
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        yield data;
      }
    }
  }
}

// ─── Streaming Tool Call Accumulator ──────────────────────────

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
  index: number;
}

/**
 * Accumulates streaming tool call fragments into complete ToolCall objects.
 */
export class ToolCallAccumulator {
  private readonly tools = new Map<number, AccumulatedToolCall>();

  feed(chunk: { index: number; id?: string; function?: { name?: string; arguments?: string } }): void {
    const existing = this.tools.get(chunk.index);
    if (existing) {
      if (chunk.function?.name) existing.name += chunk.function.name;
      if (chunk.function?.arguments) existing.arguments += chunk.function.arguments;
    } else {
      this.tools.set(chunk.index, {
        id: chunk.id ?? '',
        name: chunk.function?.name ?? '',
        arguments: chunk.function?.arguments ?? '',
        index: chunk.index,
      });
    }
  }

  getComplete(): ToolCall[] {
    return [...this.tools.values()]
      .filter((t) => t.name && t.arguments)
      .map((t) => ({
        name: t.name,
        arguments: safeParseJSON(t.arguments) ?? {},
        id: t.id,
      }));
  }
}

// ─── OpenAI Streaming Response Parser ─────────────────────────

export interface OpenAIStreamDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Parse a single OpenAI-format SSE chunk JSON into our StreamChunk type.
 */
export function parseOpenAIChunk(json: string): StreamChunk | null {
  const parsed: OpenAIStreamChunk = JSON.parse(json);
  const choice = parsed.choices?.[0];
  if (!choice) return null;

  const delta = choice.delta;
  const content = delta?.content ?? '';
  const reasoning = delta?.reasoning_content;
  const toolCalls = delta?.tool_calls;

  const usage: ProviderUsage = parsed.usage
    ? {
        promptTokens: parsed.usage.prompt_tokens,
        completionTokens: parsed.usage.completion_tokens,
        totalTokens: parsed.usage.total_tokens,
      }
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  return {
    content,
    reasoning,
    toolCalls: toolCalls?.map((tc) => ({
      name: tc.function?.name ?? '',
      arguments: safeParseJSON(tc.function?.arguments ?? '') ?? {},
      id: tc.id ?? '',
    })),
    isFinished: choice.finish_reason !== null && choice.finish_reason !== undefined,
    usage,
  };
}

// ─── Response Streamer ────────────────────────────────────────

/**
 * Stream an OpenAI-compatible chat completion response.
 * Yields StreamChunks as they arrive.
 */
export async function* streamOpenAIResponse(
  response: Response,
): AsyncGenerator<StreamChunk, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  const accumulator = new ToolCallAccumulator();
  let totalUsage: ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  try {
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          // Emit final chunk with accumulated tool calls
          const finalTools = accumulator.getComplete();
          if (finalTools.length > 0) {
            yield {
              content: '',
              toolCalls: finalTools,
              isFinished: true,
              usage: totalUsage,
            };
          }
          return;
        }

        try {
          const rawParsed = JSON.parse(data);
          const rawChoice = rawParsed.choices && rawParsed.choices[0];

          if (rawChoice && rawChoice.delta && rawChoice.delta.tool_calls) {
            for (const tc of rawChoice.delta.tool_calls) {
              accumulator.feed({
                index: tc.index,
                id: tc.id,
                function: { name: tc.function ? tc.function.name : undefined, arguments: tc.function ? tc.function.arguments : undefined },
              });
            }
          }

          const chunk = parseOpenAIChunk(data);
          if (!chunk) continue;

          if (chunk.usage.totalTokens > 0) {
            totalUsage = chunk.usage;
          }

          yield chunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function safeParseJSON(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
