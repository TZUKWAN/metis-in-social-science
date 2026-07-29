/**
 * Abstract base class for LLM providers.
 *
 * Ported from metis/providers/base.py.
 */

import type {
  ChatMessage,
  NormalizedResponse,
  ProviderCapabilities,
  StreamChunk,
  ToolSpec,
} from '../core/types.js';

export abstract class BaseProvider {
  /** Return this provider's capabilities. */
  abstract capabilities(): ProviderCapabilities;

  /** Non-streaming completion. */
  abstract complete(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): Promise<NormalizedResponse>;

  /** Streaming completion. Yields chunks as they arrive. */
  abstract completeStream(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk, void, unknown>;

  /** Lightweight health check. */
  async healthCheck(): Promise<Record<string, unknown>> {
    return { status: 'unknown' };
  }

  /** Clean up resources (HTTP clients, etc). */
  async close(): Promise<void> {
    // no-op by default
  }
}
