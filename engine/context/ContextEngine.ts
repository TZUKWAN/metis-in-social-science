/**
 * Context engine — builds the final message list within token budget.
 *
 * Ported from metis/context/engine.py.
 */

import { CONTEXT_CHARS_PER_TOKEN } from '../core/Config.js';
import type { BudgetConfig, ChatMessage } from '../core/types.js';
import { estimateMessagesTokens, estimateToolSchemaTokens } from './TokenEstimator.js';
import { compressMessages } from './Compressor.js';

export interface ContextBuildResult {
  messages: ChatMessage[];
  compressed: boolean;
  originalChars: number;
  finalChars: number;
  maxChars: number;
  summary: string;
  originalTokens: number;
  finalTokens: number;
  toolSchemaTokens: number;
}

export class ContextEngine {
  private readonly budget: BudgetConfig;
  private readonly charsPerToken: number;
  private readonly overrideMaxContextTokens?: number;

  constructor(options: {
    budget: BudgetConfig;
    charsPerToken?: number;
    overrideMaxContextTokens?: number;
  }) {
    this.budget = options.budget;
    this.charsPerToken = options.charsPerToken ?? CONTEXT_CHARS_PER_TOKEN;
    this.overrideMaxContextTokens = options.overrideMaxContextTokens;
  }

  get maxContextTokens(): number {
    return this.overrideMaxContextTokens ?? this.budget.modelContextTokens;
  }

  get maxChars(): number {
    return Math.floor(this.maxContextTokens * this.charsPerToken * this.budget.contextThreshold);
  }

  /** Expose budget for context overflow recovery. */
  get config(): BudgetConfig {
    return this.budget;
  }

  /**
   * Build the final message list within budget.
   * 1. Calculate tool schema token cost
   * 2. Subtract from total budget
   * 3. If messages exceed remaining budget, compress
   */
  async build(
    messages: ChatMessage[],
    toolSchemas?: object[],
  ): Promise<ContextBuildResult> {
    const toolSchemaTokens = toolSchemas ? estimateToolSchemaTokens(toolSchemas) : 0;
    const toolSchemaChars = toolSchemaTokens * this.charsPerToken;

    const maxChars = Math.max(1000, this.maxChars - toolSchemaChars);
    const originalChars = countChars(messages);
    const originalTokens = estimateMessagesTokens(messages);

    const compression = await compressMessages(messages, maxChars);

    const finalTokens = estimateMessagesTokens(compression.messages);

    return {
      messages: compression.messages,
      compressed: compression.compressed,
      originalChars,
      finalChars: compression.finalChars,
      maxChars,
      summary: compression.compressed
        ? `Compressed ${originalChars} → ${compression.finalChars} chars`
        : 'No compression needed',
      originalTokens,
      finalTokens,
      toolSchemaTokens,
    };
  }
}

function countChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + (msg.content?.length ?? 0), 0);
}
