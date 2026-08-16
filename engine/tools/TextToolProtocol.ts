/**
 * Text tool protocol — parses JSON tool calls emitted as prose by models whose
 * gateways do not support native function calling (e.g. Qwen3 thinking models
 * behind One-API gateways).
 *
 * The injectToolPrompt convention asks the model to emit:
 *   {"tool": "<name>", "args": { ... }}
 * This module extracts such JSON from the model's text content so the agent
 * loop can treat it as a real tool call.
 *
 * Kept provider-agnostic (no provider import) so both the OpenAICompatProvider
 * (response parsing) and the AgentLoop (streaming aggregation) can share it.
 */

import type { ToolCall } from '../core/types.js';

/**
 * Strip raw tool-call markup that leaks into user-visible text when a model
 * (or its gateway) emits XML-ish function-call blocks the runtime does not
 * execute — e.g. DeepSeek/Qwen emitting literal `<tool_calls>…</tool_calls>`
 * or `<tool_call>…</tool_call>` (paired or truncated/unclosed at the end).
 * The runtime only acts on native tool_calls or the {"tool":…} JSON protocol;
 * anything else must never be shown to users as raw markup.
 */
export function stripTextToolMarkup(text: string): string {
  if (!text || text.indexOf('<tool_call') === -1) return text;
  return text
    // paired blocks
    .replace(/<tool_calls?>[\s\S]*?<\/\s*tool_calls?>/giu, '')
    // unclosed/truncated block running to end of output
    .replace(/<tool_calls?>[\s\S]*$/giu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse a text-protocol tool call from model output.
 * Tolerates surrounding prose / fenced code blocks.
 * Returns a ToolCall if the content is (or contains) such JSON, else null.
 */
export function parseTextToolCall(content: string): ToolCall | null {
  const text = content.trim();
  if (!text) return null;
  // Find the first JSON object that looks like a tool call.
  const candidates: string[] = [];
  // Fenced ```json ... ```
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/u);
  if (fenced?.[1]) candidates.push(fenced[1]);
  // Bare {...}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { tool?: unknown; args?: unknown; arguments?: unknown };
      // Only recognize the {"tool": "...", "args": {...}} shape from
      // injectToolPrompt. We intentionally do NOT accept "name" as a tool
      // indicator — that would misparse ordinary JSON (e.g. skill definitions
      // that happen to have a "name" field) as tool calls.
      if (typeof parsed.tool !== 'string' || !parsed.tool) continue;
      const rawArgs = parsed.args ?? parsed.arguments ?? {};
      const args = (rawArgs && typeof rawArgs === 'object') ? rawArgs as Record<string, unknown> : {};
      return {
        name: parsed.tool,
        arguments: args,
        id: `textcall_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      };
    } catch { /* try next candidate */ }
  }
  return null;
}
