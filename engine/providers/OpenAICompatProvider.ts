/**
 * OpenAI-compatible chat completions provider.
 *
 * Ported from metis/providers/openai_compat.py.
 * Supports: OpenAI, GLM, Kimi, DeepSeek, any OpenAI-compatible API.
 */

import { BaseProvider } from './BaseProvider.js';
import { fetch } from 'undici';
import { streamOpenAIResponse } from './SSEParser.js';
import {
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  MAX_TIMEOUT_MS,
} from '../core/Config.js';
import { getRateLimiter } from '../core/RateLimiter.js';
import type {
  ChatMessage,
  NormalizedResponse,
  ProviderCapabilities,
  StreamChunk,
  ToolSpec,
  ToolCall,
  ProviderUsage,
} from '../core/types.js';

export interface OpenAICompatProviderConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  retryBackoffSeconds?: number;
  /** User-declared multimodal support (gates inline image content). */
  vision?: boolean;
}

interface OpenAIMessage {
  role: string;
  content: string | null | Array<{
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
  }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Known Model Capabilities ─────────────────────────────────

const MODEL_CAPS: Record<string, Partial<ProviderCapabilities>> = {
  // Large / flagship models
  'gpt-4o': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: true, streaming: true, thinking: false },
  'gpt-4o-mini': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: true, streaming: true, thinking: false },
  'gpt-4': { maxContextTokens: 8192, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  // GLM series — native priority support
  'glm-4': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'glm-4.5': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: true },
  'glm-4.7': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: true },
  'glm-4.9': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: true },
  'glm-4.7-flash': { maxContextTokens: 200000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false, maxConcurrency: 2 },
  'deepseek-chat': { maxContextTokens: 64000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  'deepseek-reasoner': { maxContextTokens: 64000, maxOutputTokens: 8192, nativeToolCalling: false, streaming: true, thinking: true },
  'claude-3-5-sonnet': { maxContextTokens: 200000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  'claude-3-5-haiku': { maxContextTokens: 200000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  // Qwen3.5 / Qwen3.6 series
  'qwen3.5': { maxContextTokens: 128000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  'qwen3.5-122b-a10b': { maxContextTokens: 128000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  'qwen3.6': { maxContextTokens: 128000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  // Small / lightweight models (7B-14B class)
  'qwen2.5-14b': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'qwen2.5-7b': { maxContextTokens: 32768, maxOutputTokens: 2048, nativeToolCalling: true, streaming: true, thinking: false },
  'qwen2.5-3b': { maxContextTokens: 32768, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'llama3.1-8b': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'llama3.1-70b': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'llama3.2-3b': { maxContextTokens: 4096, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'mistral-7b': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'mixtral-8x7b': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'gemma2-9b': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'gemma2-27b': { maxContextTokens: 8192, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'phi-3-mini': { maxContextTokens: 4096, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'phi-3-small': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'phi-4': { maxContextTokens: 16384, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'yi-1.5-9b': { maxContextTokens: 4096, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'command-r': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
};

const DEFAULT_CAPS: Omit<ProviderCapabilities, 'model'> = {
  providerType: 'OpenAICompatProvider',
  nativeToolCalling: false,
  jsonSchemaOutput: false,
  streaming: true,
  thinking: false,
  maxContextTokens: 32000,
  maxOutputTokens: 4096,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

function detectCapabilities(model: string): ProviderCapabilities {
  const normalizedModel = model.toLowerCase();

  // Exact match takes priority (case-insensitive).
  for (const key of Object.keys(MODEL_CAPS)) {
    if (key.toLowerCase() === normalizedModel) {
      return { ...DEFAULT_CAPS, model, ...MODEL_CAPS[key] };
    }
  }

  // Then longest-prefix match (case-insensitive).
  const entries = Object.entries(MODEL_CAPS).sort((a, b) => b[0].length - a[0].length);
  for (const [key, caps] of entries) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedModel.startsWith(normalizedKey + '-') ||
      normalizedModel.startsWith(normalizedKey + '.')
    ) {
      return { ...DEFAULT_CAPS, model, ...caps };
    }
  }
  return { ...DEFAULT_CAPS, model };
}

// ─── Provider Implementation ──────────────────────────────────

export class OpenAICompatProvider extends BaseProvider {
  public readonly baseUrl: string;
  public readonly apiKey: string;
  public readonly model: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoffSeconds: number;
  private readonly caps: ProviderCapabilities;
  private readonly rateLimiter: ReturnType<typeof getRateLimiter>;

  constructor(config: OpenAICompatProviderConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.timeout = Math.min(config.timeout ?? 60_000, MAX_TIMEOUT_MS);
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBackoffSeconds = config.retryBackoffSeconds ?? 2;
    this.caps = {
      ...detectCapabilities(this.model),
      ...(config.vision ? { vision: true } : {}),
    };
    this.rateLimiter = getRateLimiter(this.model, this.caps.maxConcurrency ?? 2);
  }

  capabilities(): ProviderCapabilities {
    return { ...this.caps };
  }

  // ─── Non-streaming ─────────────────────────────────────────

  async complete(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): Promise<NormalizedResponse> {
    const response = await this.withRetry(() =>
      this.rateLimiter.execute(() =>
        this.callFetch('/chat/completions', this.buildRequestBody(messages, tools, params, false))
      )
    );
    const json = await response.json() as Record<string, unknown>;
    return this.parseResponse(json);
  }

  // ─── Streaming ─────────────────────────────────────────────

  async *completeStream(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const response = await this.withRetry(() =>
      this.rateLimiter.execute(() =>
        this.callFetch('/chat/completions', this.buildRequestBody(messages, tools, params, true))
      )
    );

    if (!response.ok) {
      const statusText = response.statusText || 'request failed';
      throw new Error(`Provider error ${response.status}: ${statusText}`);
    }

    yield* streamOpenAIResponse(response);
  }

  // ─── Health Check ──────────────────────────────────────────

  override async healthCheck(): Promise<Record<string, unknown>> {
    return this.rateLimiter.execute(async () => {
      try {
        const response = await fetch(`${this.baseUrl}/models`, {
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(10000),
        }) as unknown as Response;

        if (response.status === 404) {
          // Fallback: probe with a lightweight chat completion
          return this.probeHealthViaChat();
        }

        return {
          status: response.ok ? 'healthy' : 'unhealthy',
          statusCode: response.status,
          model: this.model,
        };
      } catch (err) {
        return {
          status: 'unhealthy',
          error: err instanceof Error ? err.message : String(err),
          model: this.model,
        };
      }
    });
  }

  // ─── Internals ─────────────────────────────────────────────

  private async probeHealthViaChat(): Promise<Record<string, unknown>> {
    try {
      const body = {
        model: this.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      };
      const response = await this.callFetch('/chat/completions', body);
      return {
        status: response.ok ? 'healthy' : 'unhealthy',
        statusCode: response.status,
        model: this.model,
        fallback: 'chat_probe',
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        error: err instanceof Error ? err.message : String(err),
        model: this.model,
        fallback: 'chat_probe',
      };
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildRequestBody(
    messages: ChatMessage[],
    tools: ToolSpec[] | undefined,
    params: Record<string, unknown> | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.formatMessages(messages),
      temperature: params?.temperature ?? DEFAULT_TEMPERATURE,
      stream,
    };

    if (tools && tools.length > 0) {
      if (this.caps.nativeToolCalling) {
        body.tools = this.formatTools(tools);
      } else {
        // Fallback: inject tool instructions into system prompt for non-native models
        body.messages = this.injectToolPrompt(body.messages as OpenAIMessage[], tools);
      }
    }

    if (params?.max_tokens) {
      body.max_tokens = params.max_tokens;
    }

    if (params?.timeout) {
      body.timeout = params.timeout;
    }

    // GLM-specific thinking parameter (user-selectable)
    if (this.caps.thinking && params?.thinking === true) {
      body.thinking = { type: 'enabled' };
    }

    return body;
  }

  private formatMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map((msg) => {
      const formatted: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      // METIS-WX-2 vision: inline images become standard OpenAI image_url
      // content blocks (data URIs). Text + images share one message so
      // multimodal models see them together. Only when the model declares
      // vision — otherwise image content is dropped to avoid 4xx errors.
      if (msg.images && msg.images.length > 0 && this.caps.vision) {
        formatted.content = [
          { type: 'text', text: msg.content ?? '' },
          ...msg.images.map((image) => ({
            type: 'image_url' as const,
            image_url: {
              url: `data:${image.mime ?? 'image/jpeg'};base64,${image.dataBase64}`,
            },
          })),
        ];
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        formatted.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === 'string'
                ? tc.arguments
                : JSON.stringify(tc.arguments),
          },
        }));
      }

      // Embed status/code envelope for tool messages so the wire always carries
      // an un-confusable, non-user-controllable status signal.
      if (msg.role === 'tool' && msg.metadata && typeof msg.metadata === 'object') {
        const meta = msg.metadata as Record<string, unknown>;
        const status = typeof meta.status === 'string' ? meta.status : 'unknown';
        const code = typeof meta.code === 'string' ? meta.code : '';
        const envelope = code ? `[status=${status} code=${code}]` : `[status=${status}]`;
        // Prepend the envelope so it is always present and non-removable.
        formatted.content = formatted.content ? `${envelope} ${formatted.content}` : envelope;
      }

      if (msg.toolCallId) {
        formatted.tool_call_id = msg.toolCallId;
      }

      if (msg.name) {
        formatted.name = msg.name;
      }

      return formatted;
    });
  }

  private formatTools(tools: ToolSpec[]): OpenAIToolDef[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Inject tool definitions as text into the system prompt for models
   * that do not support native function calling (common in 7B-class models).
   */
  private injectToolPrompt(messages: OpenAIMessage[], tools: ToolSpec[]): OpenAIMessage[] {
    const toolDescriptions = tools.map((t) =>
      `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`,
    ).join('\n\n');
    const toolBlock = `\n\n## Available Tools\n\nYou have access to the following tools. To use a tool, respond with a JSON object:\n\n{\n  "tool": "<tool_name>",\n  "args": { ... }\n}\n\n${toolDescriptions}\n\nUse tools when needed to complete the task. Return ONLY the JSON tool call, no extra text.`;

    const updated = [...messages];
    const sysIdx = updated.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0 && updated[sysIdx]) {
      updated[sysIdx] = { ...updated[sysIdx], content: (updated[sysIdx].content ?? '') + toolBlock };
    } else {
      updated.unshift({ role: 'system', content: toolBlock });
    }
    return updated;
  }

  private parseResponse(json: Record<string, unknown>): NormalizedResponse {
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      throw new Error('No choices in provider response');
    }

    const message = choice.message as Record<string, unknown> | undefined;
    const refusal = message?.refusal as string | undefined;
    const messageContent = (message?.content as string) ?? '';
    const content = messageContent || refusal || '';
    const finishReason = (choice.finish_reason as string | null) ?? '';

    // Parse tool calls
    const toolCalls: ToolCall[] = [];
    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls) {
      for (const tc of rawToolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn !== 'object') {
          toolCalls.push({
            name: '',
            arguments: {},
            id: (tc.id as string) ?? '',
          });
          continue;
        }
        const argsStr = (fn.arguments as string) ?? '{}';
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argsStr);
        } catch {
          args = {};
        }
        toolCalls.push({
          name: (fn.name as string) ?? '',
          arguments: args,
          id: (tc.id as string) ?? '',
        });
      }
    }

    // Parse usage
    const rawUsage = json.usage as Record<string, number> | undefined;
    const usage: ProviderUsage = rawUsage
      ? {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
          totalTokens: rawUsage.total_tokens ?? 0,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Parse reasoning (for models that support thinking)
    const reasoning = (message?.reasoning_content as string) ?? undefined;

    return {
      content,
      reasoning,
      toolCalls,
      finishReason,
      usage,
      raw: json,
    };
  }

  private async callFetch(path: string, body: Record<string, unknown>): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const requestTimeout = typeof body.timeout === 'number'
      ? Math.min(body.timeout as number, MAX_TIMEOUT_MS)
      : this.timeout;
    // Do not send timeout to the remote API
    const { timeout: _timeout, ...bodyWithoutTimeout } = body;
    void _timeout;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(bodyWithoutTimeout),
      signal: AbortSignal.timeout(requestTimeout),
    }) as unknown as Response;

    if (!response.ok) {
      const statusText = response.statusText || 'request failed';
      throw new Error(`Provider error ${response.status}: ${statusText}`);
    }

    return response;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check if error is retryable
        const statusMatch = lastError?.message?.match(/Provider error (\d+)/) ?? undefined;
        const status = statusMatch?.[1] ? parseInt(statusMatch[1], 10) : 0;
        if (!this.caps.retryableStatusCodes.includes(status) && status !== 0) {
          throw lastError;
        }

        if (attempt < this.maxRetries) {
          const backoff = this.retryBackoffSeconds * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoff * 1000));
        }
      }
    }
    throw lastError ?? new Error('Retry failed');
  }
}
