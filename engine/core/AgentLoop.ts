/**
 * Turn-based agent loop — the heart of the Metis Workbench engine.
 *
 * Ported from metis/runtime/loop.py (AgentLoop class).
 *
 * Flow per turn:
 *   1. Build context within budget (ContextEngine)
 *   2. Call LLM provider (streaming if supported)
 *   3. If response has tool_calls → dispatch tools → append results → loop
 *   4. If no tool_calls → finalize → return AgentRunResult
 *
 * Safety mechanisms ported from Metis:
 *   - Temperature escalation (repair/loop detection)
 *   - Response loop detection (3 identical consecutive turns)
 *   - Per-session tool call counting + limits
 *   - Evidence chain recording
 *   - HITL approval before dangerous tool dispatch
 *   - Behavior gate checks per turn
 *   - Context overflow recovery (aggressive recompression)
 *   - Per-turn timeout with graceful handling
 */

import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  ChatMessage,
  NormalizedResponse,
  ProviderUsage,
  ToolCall,
  ToolResult,
  ToolSpec,
  TraceEvent,
} from './types.js';
import { HookBus, type HookContext } from './HookBus.js';
import { BaseProvider } from '../providers/BaseProvider.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { ToolDispatcher } from '../tools/ToolDispatcher.js';
import { parseTextToolCall } from '../tools/TextToolProtocol.js';
import {
  type ToolPresenterRegistry,
  createToolPresenterRegistry,
  presentForProvider,
  buildBuiltinDecoders,
} from '../tools/ToolPresenter.js';
import {
  safeDeserializeProviderFeedback,
  safeSerializeProviderFeedback,
  safeTruncateContent,
  MAX_PROVIDER_CONTENT_LENGTH,
} from '../runtime/ToolPresentationContract.js';
import { ContextEngine } from '../context/ContextEngine.js';
import { EvidenceLedger } from '../evidence/EvidenceLedger.js';
import { ApprovalStore, evaluateHardSafetyBoundary } from '../hitl/HITLCore.js';
import { BehaviorRegistry, type BehaviorContext } from '../behavior/BehaviorRegistry.js';
import {
  FullAccessPolicySchema,
  type FullAccessPolicy,
} from '../runtime/PersonalizationRuntimeContract.js';
import {
  LiveSteeringEventSchema,
  type LiveSteeringEvent,
  type LiveSteeringInstruction,
  type LiveSteeringSource,
} from '../runtime/LiveSteeringContract.js';
import {
  DEFAULT_MAX_TURNS,
  PER_TURN_TIMEOUT_MS,
  TEMP_BASE,
  TEMP_PER_TURN,
  TEMP_REPAIR_BOOST,
  TEMP_LOOP_BOOST,
  TEMP_MAX,
  MAX_TOOLS_PER_SESSION,
  MAX_TOOL_REPAIR_RETRIES,
  MAX_SAME_TOOL_PER_SESSION,
} from './Config.js';
import type { BudgetConfig } from './types.js';

// ─── Loop Options ─────────────────────────────────────────────

export interface AgentLoopOptions {
  provider: BaseProvider;
  registry: ToolRegistry;
  dispatcher?: ToolDispatcher;
  hooks?: HookBus;
  workspace?: string;
  budget?: BudgetConfig;
  contextEngine?: ContextEngine;
  evidenceLedger?: EvidenceLedger;
  approvalStore?: ApprovalStore;
  behaviorRegistry?: BehaviorRegistry;
  maxToolsPerSession?: number;
  maxToolRepairRetries?: number;
  perTurnTimeout?: number;
  /** Called after every tool dispatch with the raw outcome (learning/telmetry). */
  onToolResult?: (outcome: { name: string; status: 'ok' | 'error' }) => void;
}

// ─── Internal Types ───────────────────────────────────────────

interface TurnState {
  repairFailureCounts: Map<string, number>;
  exhaustedRetryKeys: Set<string>;
  turnSignatures: string[];
  toolCallCount: number;
}

/**
 * Mutable accumulator for an agent run's evolving state.
 * Passed between sub-methods to avoid sprawling parameter lists.
 */
interface RunContext {
  messages: ChatMessage[];
  allToolResults: ToolResult[];
  usageTotals: ProviderUsage;
  errors: string[];
  traceEvents: TraceEvent[];
  state: TurnState;
  sessionId: string;
  maxTurns: number;
  allowedTools?: string[];
  allowedToolPermissions?: string[];
  fullAccess?: FullAccessPolicy;
  signal?: AbortSignal;
  liveSteering?: LiveSteeringSource;
  lastSteeringSequence: number;
  projectId?: string;
}

// ─── Sentinel: early-return signals from sub-methods ──────────

/** Signals that the loop should return immediately with this result. */
class LoopReturn {
  readonly result: AgentRunResult;
  constructor(result: AgentRunResult) {
    this.result = result;
  }
}

/** Signals that the current turn should be skipped (continue to next). */
class LoopContinue {}

/** Internal signal used to distinguish cancellation from provider failures. */
class AgentInterruptedError extends Error {
  constructor() {
    super('Agent run interrupted');
    this.name = 'AgentInterruptedError';
  }
}

interface SteeringOutcome {
  kind: 'none' | 'redirect' | 'interrupt' | 'invalid';
  instructions: LiveSteeringInstruction[];
  reason?: string;
}

type TurnOutcome = LoopReturn | LoopContinue | void;

// ─── AgentLoop ────────────────────────────────────────────────

export class AgentLoop {
  private readonly provider: BaseProvider;
  private readonly registry: ToolRegistry;
  private readonly dispatcher: ToolDispatcher;
  private readonly hooks: HookBus;
  private readonly contextEngine: ContextEngine;
  private readonly evidenceLedger: EvidenceLedger;
  private readonly approvalStore: ApprovalStore;
  private readonly behaviorRegistry: BehaviorRegistry;
  private readonly maxToolsPerSession: number;
  private readonly maxToolRepairRetries: number;
  private readonly onToolResult?: (outcome: { name: string; status: 'ok' | 'error' }) => void;
  private readonly workspace: string;
  private readonly presenterRegistry: ToolPresenterRegistry;

  // Per-session tool counting
  private readonly sessionToolCounts = new Map<string, Map<string, number>>();
  private readonly sessionLastActivity = new Map<string, number>();
  private static readonly MAX_TRACKED_SESSIONS = 1000;
  private static readonly SESSION_ACTIVITY_TTL = 3600_000; // 1 hour in ms

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.dispatcher = options.dispatcher ?? new ToolDispatcher(options.registry, options.hooks);
    this.hooks = options.hooks ?? new HookBus();
    this.evidenceLedger = options.evidenceLedger ?? new EvidenceLedger();
    this.approvalStore = options.approvalStore ?? new ApprovalStore();
    this.behaviorRegistry = options.behaviorRegistry ?? new BehaviorRegistry();
    this.maxToolsPerSession = options.maxToolsPerSession ?? MAX_TOOLS_PER_SESSION;
    this.maxToolRepairRetries = options.maxToolRepairRetries ?? MAX_TOOL_REPAIR_RETRIES;
    this.onToolResult = options.onToolResult;
    this.workspace = options.workspace ?? '.';

    // Build a per-loop immutable presenter registry. Built-in presenters are
    // bound to an internal manifest and always win over spec.decodeResult for
    // built-in names; non-built-in custom presenters may still be registered.
    const builtinDecoders = buildBuiltinDecoders();
    const mergedDecoders = new Map<string, import('../tools/ToolPresenter.js').ToolDecoder>(builtinDecoders);
    for (const spec of this.registry.list()) {
      if (!mergedDecoders.has(spec.name) && spec.decodeResult) {
        mergedDecoders.set(spec.name, spec.decodeResult);
      }
    }
    this.presenterRegistry = createToolPresenterRegistry([], mergedDecoders);

    // Build context engine from provider capabilities or explicit budget
    const caps = this.provider.capabilities();
    const budget = options.budget ?? {
      modelContextTokens: caps.maxContextTokens,
      modelOutputTokens: caps.maxOutputTokens,
      contextThreshold: 0.8,
      perToolChars: 2000,
      maxToolResultChars: 8000,
      maxTurns: DEFAULT_MAX_TURNS,
    };

    this.contextEngine = options.contextEngine ?? new ContextEngine({
      budget,
      overrideMaxContextTokens: caps.maxContextTokens > 0 ? caps.maxContextTokens : undefined,
    });
  }

  /** Register a hook handler on the internal HookBus. */
  registerHook(
    event: string,
    handler: (ctx: HookContext) => HookContext | void | null | Promise<HookContext | void | null>,
    options?: { priority?: number; name?: string },
  ): void {
    this.hooks.register(event, handler as import('./HookBus.js').HookHandler | import('./HookBus.js').AsyncHookHandler, options);
  }

  /** Unregister a hook handler from the internal HookBus. */
  unregisterHook(event: string, handlerName?: string): void {
    this.hooks.unregister(event, handlerName);
  }

  // ─── Main Entry Point ──────────────────────────────────────

  /**
   * Run the agent loop to completion.
   * Orchestrates turns; delegates to sub-methods for each phase.
   */
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const messages = [...request.messages];

    const fullAccessResult = request.fullAccess === undefined
      ? undefined
      : FullAccessPolicySchema.safeParse(request.fullAccess);
    const fullAccess = fullAccessResult?.success ? fullAccessResult.data : undefined;

    // Inject skill prompt as system message if provided
    if (request.skillPrompt) {
      const hasSystem = messages.some((m) => m.role === 'system');
      if (hasSystem) {
        // Prepend skill prompt to existing system message
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) {
          const sysMsg = messages[sysIdx];
          if (sysMsg) {
            messages[sysIdx] = {
              ...sysMsg,
              content: `${request.skillPrompt}\n\n${sysMsg.content}`,
            };
          }
        }
      } else {
        messages.unshift({ role: 'system', content: request.skillPrompt });
      }
    }

    const ctx: RunContext = {
      messages,
      allToolResults: [],
      usageTotals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
      state: {
        repairFailureCounts: new Map(),
        exhaustedRetryKeys: new Set(),
        turnSignatures: [],
        toolCallCount: 0,
      },
      sessionId: request.sessionId,
      maxTurns: request.maxTurns,
      allowedTools: request.allowedTools,
      allowedToolPermissions: request.allowedToolPermissions,
      fullAccess,
      signal: request.signal,
      liveSteering: request.liveSteering,
      lastSteeringSequence: 0,
      projectId: request.projectId,
    };

    if (fullAccessResult && !fullAccessResult.success) {
      ctx.errors.push('Invalid Full Access policy');
      this.trace(ctx.traceEvents, 'agent.request_rejected', ctx.sessionId, {
        code: 'invalid_full_access_policy',
      });
      return this.makeResult('error', '', ctx, 0);
    }
    if (request.signal !== undefined && !isAbortSignalLike(request.signal)) {
      ctx.errors.push('Invalid cancellation signal');
      this.trace(ctx.traceEvents, 'agent.request_rejected', ctx.sessionId, {
        code: 'invalid_abort_signal',
      });
      return this.makeResult('error', '', ctx, 0);
    }

    this.initSession(ctx, request.requestId);

    let currentTurnIndex = 0;
    try {
      for (let turnIndex = 0; turnIndex < ctx.maxTurns; turnIndex++) {
        currentTurnIndex = turnIndex;
        ctx.state.turnSignatures.push('');
        const outcome = await this.executeTurn(ctx, turnIndex);

        if (outcome instanceof LoopReturn) return outcome.result;
        if (outcome instanceof LoopContinue) continue;
      }

      return await this.handleMaxTurnsReached(ctx);
    } catch (err) {
      return this.handleFatalError(ctx, err, currentTurnIndex);
    } finally {
      this.cleanupSession(ctx.sessionId);
    }
  }

  // ─── Session Lifecycle ─────────────────────────────────────

  private initSession(ctx: RunContext, requestId: string): void {
    this.pruneSessionState();
    this.sessionLastActivity.set(ctx.sessionId, Date.now());

    this.trace(ctx.traceEvents, 'agent.start', ctx.sessionId, {
      max_turns: ctx.maxTurns,
      request_id: requestId,
    });

    // Fire pre_run hook (sync is fine for init)
    this.hooks.emitAsync('agent.pre_run', { sessionId: ctx.sessionId } as unknown as HookContext).catch(() => {});
  }

  private cleanupSession(sessionId: string): void {
    this.sessionToolCounts.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
  }

  // ─── Single Turn Execution ─────────────────────────────────

  /**
   * Execute one turn of the agent loop.
   * Returns LoopReturn to signal early exit, LoopContinue to skip to next turn,
   * or void to continue to the next iteration normally.
   */
  private async executeTurn(ctx: RunContext, turnIndex: number): Promise<TurnOutcome> {
    const interruptedBeforeTurn = this.interruptIfRequested(ctx, turnIndex, 'before_turn');
    if (interruptedBeforeTurn) return interruptedBeforeTurn;

    const steeringBeforeTurn = await this.consumeLiveSteering(ctx, turnIndex, 'before_turn', true);
    const steeringReturn = this.steeringOutcomeToReturn(ctx, steeringBeforeTurn, turnIndex);
    if (steeringReturn) return steeringReturn;

    // Behavior gate
    const blocked = await this.checkBehaviorGate(ctx, turnIndex);
    if (blocked) return blocked;

    // Build context + compute temperature
    const toolSchemas = this.registry.schemas(ctx.allowedTools);
    const contextResult = await this.contextEngine.build(ctx.messages, toolSchemas);
    const temperature = computeTemperature(turnIndex, ctx.state.repairFailureCounts, ctx.state.turnSignatures);

    this.trace(ctx.traceEvents, 'model.request', ctx.sessionId, {
      turn: turnIndex + 1,
      message_count: contextResult.messages.length,
      tool_count: toolSchemas.length,
      compressed: contextResult.compressed,
      temperature,
    });

    if (contextResult.compressed) {
      await this.hooks.emitAsync('context.compressed', {
        sessionId: ctx.sessionId,
        turn: turnIndex + 1,
        originalChars: contextResult.originalChars,
        finalChars: contextResult.finalChars,
      } as unknown as HookContext);
    }

    // Call provider with overflow recovery
    const interruptedBeforeModel = this.interruptIfRequested(ctx, turnIndex, 'before_model');
    if (interruptedBeforeModel) return interruptedBeforeModel;

    const response = await this.callProviderWithRecovery(
      ctx, contextResult.messages, toolSchemas, temperature, turnIndex,
    );
    if (response instanceof LoopReturn) return response;
    if (response instanceof LoopContinue) return response;
    // response is now NormalizedResponse

    // Record response
    this.trace(ctx.traceEvents, 'model.response', ctx.sessionId, {
      turn: turnIndex + 1,
      tool_call_count: response.toolCalls.length,
      finish_reason: response.finishReason,
    });
    mergeUsage(ctx.usageTotals, response.usage);

    // A provider may not support cooperative cancellation. Re-check immediately after it
    // returns and before its content is appended, so stale text can never become a fake final.
    const interruptedAfterModel = this.interruptIfRequested(ctx, turnIndex + 1, 'after_model');
    if (interruptedAfterModel) return interruptedAfterModel;

    const steeringAfterModel = await this.consumeLiveSteering(ctx, turnIndex, 'after_model', true);
    const steeringAfterModelReturn = this.steeringOutcomeToReturn(ctx, steeringAfterModel, turnIndex + 1);
    if (steeringAfterModelReturn) return steeringAfterModelReturn;
    if (steeringAfterModel.kind === 'redirect') {
      this.trace(ctx.traceEvents, 'model.response_superseded', ctx.sessionId, {
        turn: turnIndex + 1,
        instruction_count: steeringAfterModel.instructions.length,
      });
      return new LoopContinue();
    }

    // Loop detection
    const loopResult = this.checkLoopDetection(ctx, response, turnIndex);
    if (loopResult) return loopResult;

    // Append assistant message
    await this.appendAssistantMessage(ctx, response, turnIndex);

    // No tool calls → finalize
    if (response.toolCalls.length === 0) {
      return this.finalizeTurn(ctx, response, turnIndex);
    }

    // Dispatch tool calls
    return this.dispatchToolCalls(ctx, response.toolCalls, turnIndex);
  }

  // ─── Behavior Gate ─────────────────────────────────────────

  private async checkBehaviorGate(ctx: RunContext, turnIndex: number): Promise<LoopReturn | null> {
    const behaviorCtx: BehaviorContext = {
      sessionId: ctx.sessionId,
      turnIndex,
      maxTurns: ctx.maxTurns,
    };
    const gateResult = await this.behaviorRegistry.checkAll(behaviorCtx);
    if (!gateResult.allowed) {
      this.trace(ctx.traceEvents, 'agent.blocked', ctx.sessionId, {
        turn: turnIndex + 1,
        blocked_by: gateResult.blockedBy,
      });
      return new LoopReturn(this.makeResult('interrupted', '', ctx, turnIndex));
    }
    return null;
  }

  // ─── Provider Call with Recovery ───────────────────────────

  /**
   * Call the LLM provider, handling context overflow with aggressive recompression.
   * Returns LoopContinue if the turn should be skipped, or the response otherwise.
   */
  private async callProviderWithRecovery(
    ctx: RunContext,
    messages: ChatMessage[],
    toolSchemas: ReturnType<ToolRegistry['schemas']>,
    temperature: number,
    turnIndex: number,
  ): Promise<NormalizedResponse | LoopContinue | LoopReturn> {
    try {
      return await this.callProvider(
        messages,
        toolSchemas,
        temperature,
        ctx.sessionId,
        turnIndex + 1,
        ctx.signal,
      );
    } catch (err) {
      if (err instanceof AgentInterruptedError) {
        return this.interruptedReturn(ctx, turnIndex, 'during_model');
      }
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (isContextError(errorMsg)) {
        return await this.recoverFromContextOverflow(ctx, messages, toolSchemas, temperature, turnIndex, errorMsg);
      }

      ctx.errors.push(`Turn ${turnIndex + 1} provider error: ${errorMsg}`);
      return new LoopContinue();
    }
  }

  /**
   * Attempt to recover from a context overflow by recompressing at 70% threshold.
   */
  private async recoverFromContextOverflow(
    ctx: RunContext,
    messages: ChatMessage[],
    toolSchemas: ReturnType<ToolRegistry['schemas']>,
    temperature: number,
    turnIndex: number,
    errorMsg: string,
  ): Promise<NormalizedResponse | LoopContinue | LoopReturn> {
    this.trace(ctx.traceEvents, 'context.overflow', ctx.sessionId, {
      turn: turnIndex + 1,
      error: errorMsg,
    });

    const budget = this.contextEngine.config;
    const savedThreshold = budget.contextThreshold;
    budget.contextThreshold = savedThreshold * 0.7;

    try {
      const tightResult = await this.contextEngine.build(messages, toolSchemas);
      return await this.callProvider(
        tightResult.messages,
        toolSchemas,
        temperature,
        ctx.sessionId,
        turnIndex + 1,
        ctx.signal,
      );
    } catch (retryErr) {
      if (retryErr instanceof AgentInterruptedError) {
        return this.interruptedReturn(ctx, turnIndex, 'during_context_recovery');
      }
      ctx.errors.push(
        `Turn ${turnIndex + 1} context overflow recovery failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
      );
      return new LoopContinue();
    } finally {
      budget.contextThreshold = savedThreshold;
    }
  }

  // ─── Loop Detection ────────────────────────────────────────

  private checkLoopDetection(ctx: RunContext, response: NormalizedResponse, turnIndex: number): LoopReturn | null {
    const sig = turnSignature(response);
    ctx.state.turnSignatures[turnIndex] = sig;

    if (detectLoop(ctx.state.turnSignatures)) {
      this.trace(ctx.traceEvents, 'agent.loop_detected', ctx.sessionId, {
        turn: turnIndex + 1,
        pattern: sig,
      });
      ctx.errors.push('Response loop detected: same pattern repeated for 3 consecutive turns');
      return new LoopReturn(this.makeResult('interrupted', '', ctx, turnIndex + 1));
    }

    return null;
  }

  // ─── Message Append ────────────────────────────────────────

  private async appendAssistantMessage(ctx: RunContext, response: NormalizedResponse, turnIndex: number): Promise<void> {
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: response.content ?? '',
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    };
    ctx.messages.push(assistantMsg);

    await this.hooks.emitAsync('model.post_call', {
      sessionId: ctx.sessionId,
      turn: turnIndex + 1,
      usage: response.usage,
    } as unknown as HookContext);
  }

  // ─── Turn Finalization ─────────────────────────────────────

  private async finalizeTurn(ctx: RunContext, response: NormalizedResponse, turnIndex: number): Promise<LoopReturn> {
    this.trace(ctx.traceEvents, 'agent.complete', ctx.sessionId, {
      turn: turnIndex + 1,
      final_text_length: response.content.length,
    });

    await this.hooks.emitAsync('agent.post_run', {
      sessionId: ctx.sessionId,
      status: 'completed',
    } as unknown as HookContext);

    return new LoopReturn(this.makeResultFromResponse('completed', response, ctx, turnIndex + 1));
  }

  // ─── Tool Call Dispatch ────────────────────────────────────

  /**
   * Dispatch all tool calls from a response, serially.
   */
  private async dispatchToolCalls(ctx: RunContext, toolCalls: ToolCall[], turnIndex: number): Promise<TurnOutcome> {
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
      const call = toolCalls[callIndex];
      if (!call) continue;

      const interrupted = this.interruptIfRequested(ctx, turnIndex + 1, 'before_tool');
      if (interrupted) {
        this.appendPendingToolErrors(ctx, toolCalls.slice(callIndex), 'Agent run interrupted before tool execution');
        return interrupted;
      }

      const steering = await this.consumeLiveSteering(ctx, turnIndex, 'before_tool', false);
      if (steering.kind !== 'none') {
        this.appendPendingToolErrors(
          ctx,
          toolCalls.slice(callIndex),
          steering.kind === 'redirect'
            ? 'Tool call superseded by live user steering'
            : 'Agent run interrupted before tool execution',
        );
        if (steering.kind === 'redirect') {
          this.appendSteeringInstructions(ctx, steering.instructions);
          this.trace(ctx.traceEvents, 'tool.calls_superseded', ctx.sessionId, {
            turn: turnIndex + 1,
            pending_count: toolCalls.length - callIndex,
          });
          return new LoopContinue();
        }
        return this.steeringOutcomeToReturn(ctx, steering, turnIndex + 1)
          ?? this.interruptedReturn(ctx, turnIndex + 1, 'invalid_live_steering');
      }

      ctx.state.toolCallCount++;

      // Session tool limit
      if (ctx.state.toolCallCount > this.maxToolsPerSession) {
        ctx.errors.push(`Session tool call limit exceeded: ${ctx.state.toolCallCount} calls, max=${this.maxToolsPerSession}`);
        this.trace(ctx.traceEvents, 'tool.session_limit', ctx.sessionId, {
          turn: turnIndex + 1,
          total: ctx.state.toolCallCount,
          limit: this.maxToolsPerSession,
        });
        // Generate valid feedback for the blocked call before interrupting
        this.appendToolError(ctx, call, 'Session tool call limit exceeded');
        return new LoopReturn(this.makeResult('interrupted', '', ctx, turnIndex + 1));
      }

      const result = await this.dispatchSingleTool(ctx, call, turnIndex);
      if (result instanceof LoopReturn) return result;
    }

    return undefined; // continue to next turn
  }

  /**
   * Dispatch a single tool call: check exhausted retries, HITL approval, then execute.
   */
  private async dispatchSingleTool(ctx: RunContext, call: ToolCall, turnIndex: number): Promise<LoopReturn | void> {
    const exhaustedKey = `${call.name}:${call.id}`;

    // The provider-visible schema is not a security boundary: a faulty or hostile model can
    // still return an arbitrary tool name. Enforce the run snapshot allowlist again here.
    if (ctx.allowedTools !== undefined && !ctx.allowedTools.includes(call.name)) {
      ctx.errors.push(`Unauthorized tool call blocked: ${call.name}`);
      this.trace(ctx.traceEvents, 'tool.blocked_allowlist', ctx.sessionId, {
        turn: turnIndex + 1,
        tool_name: call.name,
      });
      this.appendToolError(ctx, call, 'Tool is not allowed by the active scenario');
      return new LoopReturn(this.makeResult('interrupted', '', ctx, turnIndex + 1));
    }

    const requiredPermissions = this.registry.get(call.name)?.permissions ?? [];
    if (
      ctx.allowedToolPermissions !== undefined
      && requiredPermissions.some((permission) => !ctx.allowedToolPermissions?.includes(permission))
    ) {
      ctx.errors.push(`Tool permission denied: ${call.name}`);
      this.trace(ctx.traceEvents, 'tool.blocked_permission', ctx.sessionId, {
        turn: turnIndex + 1,
        tool_name: call.name,
      });
      this.appendToolError(ctx, call, 'Tool permission denied by the active scenario');
      return new LoopReturn(this.makeResult('interrupted', '', ctx, turnIndex + 1));
    }

    const hardSafety = evaluateHardSafetyBoundary(call.name, call.arguments);
    if (!hardSafety.allowed) {
      ctx.errors.push(`Hard safety boundary blocked tool: ${call.name}`);
      this.trace(ctx.traceEvents, 'tool.blocked_hard_safety', ctx.sessionId, {
        turn: turnIndex + 1,
        tool_name: call.name,
        code: hardSafety.code,
      });
      this.appendToolError(ctx, call, 'Tool blocked by hard safety boundary');
      return new LoopReturn(this.makeResult('interrupted', '', ctx, turnIndex + 1));
    }

    // Exhausted retry check
    if (ctx.state.exhaustedRetryKeys.has(exhaustedKey)) {
      this.appendToolError(ctx, call, `Retry budget exhausted for ${call.name}`);
      return;
    }

    // Same-tool-per-session count
    const toolCounts = this.getToolCounts(ctx.sessionId);
    const sameToolCount = (toolCounts.get(call.name) ?? 0) + 1;
    if (sameToolCount > MAX_SAME_TOOL_PER_SESSION) {
      this.appendToolError(
        ctx,
        call,
        `Tool ${call.name} exceeded per-session same-tool limit (${MAX_SAME_TOOL_PER_SESSION})`,
      );
      return;
    }
    toolCounts.set(call.name, sameToolCount);

    // HITL approval check
    const blocked = await this.checkHitlApproval(ctx, call, turnIndex);
    if (blocked) return blocked;

    // Dispatch tool
    const toolContext = {
      sessionId: ctx.sessionId,
      workspace: this.workspace,
      turnIndex,
      provider: this.provider,
      signal: ctx.signal,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    };

    const toolResult = await this.dispatcher.dispatch(call, toolContext);

    // Notify the learning/telemetry hook with the raw outcome.
    try {
      this.onToolResult?.({ name: call.name, status: toolResult.status });
    } catch { /* observers must never break tool dispatch */ }

    // Record evidence
    this.evidenceLedger.record(toolResult, ctx.sessionId, call.arguments);

    // Track repair failures
    if (toolResult.status === 'error') {
      const failureKey = `${call.name}:${toolResult.error ?? 'unknown'}`;
      const failCount = (ctx.state.repairFailureCounts.get(failureKey) ?? 0) + 1;
      ctx.state.repairFailureCounts.set(failureKey, failCount);
      if (failCount > this.maxToolRepairRetries) {
        ctx.state.exhaustedRetryKeys.add(exhaustedKey);
      }
    }

    // Convert raw tool result to strict provider-safe feedback before it can
    // enter the message history / provider context.
    const allowedToolNames = this.getAllowedToolNames(ctx);
    const feedback = presentForProvider(toolResult, this.presenterRegistry, allowedToolNames);
    const serialized = safeSerializeProviderFeedback(feedback, allowedToolNames);

    // Record result
    ctx.allToolResults.push(toolResult);
    ctx.messages.push({
      role: feedback.role,
      content: compactFeedback(serialized, allowedToolNames),
      toolCallId: feedback.toolCallId,
      name: feedback.name,
      metadata: { status: feedback.status, code: feedback.code },
    });

    this.trace(ctx.traceEvents, 'tool.dispatched', ctx.sessionId, {
      turn: turnIndex + 1,
      tool_name: call.name,
      status: toolResult.status,
      tool_call_id: call.id,
    });

    return this.interruptIfRequested(ctx, turnIndex + 1, 'after_tool') ?? undefined;
  }

  // ─── HITL Approval ─────────────────────────────────────────

  private async checkHitlApproval(ctx: RunContext, call: ToolCall, turnIndex: number): Promise<LoopReturn | null> {
    if (ctx.fullAccess?.perActionConfirmation === false) {
      this.trace(ctx.traceEvents, 'hitl.skipped_full_access', ctx.sessionId, {
        turn: turnIndex + 1,
        tool_name: call.name,
      });
      return null;
    }

    const approvalReq = this.approvalStore.checkRequired(call.name, call.arguments, ctx.sessionId);
    if (!approvalReq) return null;

    this.trace(ctx.traceEvents, 'hitl.approval_required', ctx.sessionId, {
      turn: turnIndex + 1,
      tool_name: call.name,
      reason: approvalReq.reason,
    });

    const approved = await this.approvalStore.requestApproval(approvalReq);
    if (!approved) {
      this.appendToolError(ctx, call, 'User rejected approval');
      return new LoopReturn(this.makeResult("interrupted", "User rejected tool approval", ctx, turnIndex + 1));
    }

    return null;
  }

  // ─── Tool Error Helper ─────────────────────────────────────

  private interruptIfRequested(
    ctx: RunContext,
    turnsUsed: number,
    phase: string,
  ): LoopReturn | null {
    return ctx.signal?.aborted
      ? this.interruptedReturn(ctx, turnsUsed, phase)
      : null;
  }

  private interruptedReturn(ctx: RunContext, turnsUsed: number, phase: string): LoopReturn {
    this.trace(ctx.traceEvents, 'agent.interrupted', ctx.sessionId, { phase });
    return new LoopReturn(this.makeResult('interrupted', '', ctx, turnsUsed));
  }

  private async consumeLiveSteering(
    ctx: RunContext,
    turnIndex: number,
    phase: string,
    appendInstructions: boolean,
  ): Promise<SteeringOutcome> {
    if (!ctx.liveSteering) return { kind: 'none', instructions: [] };

    let rawEvents: readonly unknown[];
    try {
      const drained = await ctx.liveSteering.drain({
        sessionId: ctx.sessionId,
        afterSequence: ctx.lastSteeringSequence,
      });
      if (!Array.isArray(drained) || drained.length > 100) {
        throw new Error('Invalid steering batch');
      }
      rawEvents = drained;
    } catch {
      ctx.errors.push('Live steering source failed validation');
      this.trace(ctx.traceEvents, 'steering.invalid', ctx.sessionId, {
        turn: turnIndex + 1,
        phase,
        code: 'source_failure',
      });
      return { kind: 'invalid', instructions: [] };
    }

    const events: LiveSteeringEvent[] = [];
    for (const rawEvent of rawEvents) {
      const parsed = LiveSteeringEventSchema.safeParse(rawEvent);
      if (
        !parsed.success
        || parsed.data.sessionId !== ctx.sessionId
        || parsed.data.sequence <= ctx.lastSteeringSequence
      ) {
        ctx.errors.push('Live steering event failed validation');
        this.trace(ctx.traceEvents, 'steering.invalid', ctx.sessionId, {
          turn: turnIndex + 1,
          phase,
          code: 'event_invalid',
        });
        return { kind: 'invalid', instructions: [] };
      }
      ctx.lastSteeringSequence = parsed.data.sequence;
      events.push(parsed.data);
    }

    const interrupt = events.find((event) => event.type === 'interrupt');
    if (interrupt?.type === 'interrupt') {
      this.trace(ctx.traceEvents, 'steering.interrupt', ctx.sessionId, {
        turn: turnIndex + 1,
        phase,
        steering_id: interrupt.id,
        sequence: interrupt.sequence,
      });
      return { kind: 'interrupt', instructions: [], reason: interrupt.reason };
    }

    const instructions = events.filter(
      (event): event is LiveSteeringInstruction => event.type === 'instruction',
    );
    if (instructions.length === 0) return { kind: 'none', instructions: [] };

    if (appendInstructions) this.appendSteeringInstructions(ctx, instructions);
    this.trace(ctx.traceEvents, 'steering.applied', ctx.sessionId, {
      turn: turnIndex + 1,
      phase,
      count: instructions.length,
      last_sequence: ctx.lastSteeringSequence,
    });
    return { kind: 'redirect', instructions };
  }

  private steeringOutcomeToReturn(
    ctx: RunContext,
    outcome: SteeringOutcome,
    turnsUsed: number,
  ): LoopReturn | null {
    if (outcome.kind === 'interrupt') {
      return this.interruptedReturn(ctx, turnsUsed, 'live_steering');
    }
    if (outcome.kind === 'invalid') {
      return this.interruptedReturn(ctx, turnsUsed, 'invalid_live_steering');
    }
    return null;
  }

  private appendSteeringInstructions(
    ctx: RunContext,
    instructions: readonly LiveSteeringInstruction[],
  ): void {
    for (const instruction of instructions) {
      ctx.messages.push({
        role: 'user',
        content: instruction.content,
        metadata: {
          liveSteering: true,
          steeringId: instruction.id,
          sequence: instruction.sequence,
        },
      });
    }
  }

  private appendPendingToolErrors(
    ctx: RunContext,
    calls: readonly ToolCall[],
    error: string,
  ): void {
    for (const call of calls) this.appendToolError(ctx, call, error);
  }

  private appendToolError(ctx: RunContext, call: ToolCall, error: string): void {
    const blockedResult: ToolResult = {
      toolName: call.name,
      content: '',
      status: 'error',
      toolCallId: call.id,
      error,
      metadata: {},
    };
    const allowedToolNames = this.getAllowedToolNames(ctx);
    const feedback = presentForProvider(blockedResult, this.presenterRegistry, allowedToolNames);
    const serialized = safeSerializeProviderFeedback(feedback, allowedToolNames);
    ctx.allToolResults.push(blockedResult);
    ctx.messages.push({
      role: feedback.role,
      content: compactFeedback(serialized, allowedToolNames),
      toolCallId: feedback.toolCallId,
      name: feedback.name,
      metadata: { status: feedback.status, code: feedback.code },
    });
  }

  // ─── End-of-Loop Handlers ──────────────────────────────────

  private async handleMaxTurnsReached(ctx: RunContext): Promise<AgentRunResult> {
    const result = this.makeResult(
      'max_turns_reached',
      `[Agent reached the maximum turn limit (${ctx.maxTurns}). The task may be incomplete.]`,
      ctx,
      ctx.maxTurns,
    );

    await this.hooks.emitAsync('agent.post_run', {
      sessionId: ctx.sessionId,
      status: result.status,
    } as unknown as HookContext);

    return result;
  }

  private handleFatalError(ctx: RunContext, err: unknown, turnIndex: number): AgentRunResult {
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.trace(ctx.traceEvents, 'agent.error', ctx.sessionId, { error: errorMsg });

    return {
      status: 'error',
      finalText: '',
      finalVerified: false,
      messages: ctx.messages,
      turnsUsed: Math.min(turnIndex + 1, ctx.maxTurns),
      toolResults: ctx.allToolResults,
      usage: ctx.usageTotals,
      errors: [...ctx.errors, errorMsg],
      traceEvents: ctx.traceEvents,
    };
  }

  // ─── Provider Call ─────────────────────────────────────────

  private async callProvider(
    messages: ChatMessage[],
    tools: ReturnType<ToolRegistry['schemas']>,
    temperature: number,
    sessionId: string,
    turn: number,
    signal?: AbortSignal,
  ): Promise<NormalizedResponse> {
    const caps = this.provider.capabilities();
    const perTurnTimeout = computePerTurnTimeout(caps.maxOutputTokens);
    const params: Record<string, unknown> = {
      temperature,
      timeout: perTurnTimeout,
      ...(signal ? { signal } : {}),
    };

    // Prefer real streaming when the provider supports it: iterate completeStream
    // and emit each chunk as it arrives. Fall back to complete() on failure (e.g.
    // Electron main async-generator hang) and simulate the same chunk sequence.
    let usedRealStream = false;
    let finalContent = '';
    let finalReasoning: string | undefined;
    let finalToolCalls: ToolCall[] = [];
    let finalFinishReason = 'stop';
    let finalUsage: import('./types.js').ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      for await (const chunk of this.provider.completeStream(
        messages,
        tools.length > 0 ? tools as unknown as ToolSpec[] : undefined,
        params,
      )) {
        usedRealStream = true;
        finalContent += chunk.content ?? '';
        if (chunk.reasoning) finalReasoning = (finalReasoning ?? '') + chunk.reasoning;
        if (chunk.toolCalls) {
          // SSE streams deliver tool-call deltas: fragments without a name are
          // meaningless on their own, and later chunks carry the full arguments.
          // Keep the most complete version per id instead of accumulating both.
          for (const tc of chunk.toolCalls) {
            if (!tc.name || tc.name.trim() === '') continue;
            const idx = finalToolCalls.findIndex((existing) => existing.id !== '' && tc.id !== '' && existing.id === tc.id);
            if (idx >= 0) finalToolCalls[idx] = tc;
            else finalToolCalls.push(tc);
          }
        }
        if (chunk.isFinished && chunk.usage) finalUsage = chunk.usage;
        await this.hooks.emitAsync('model.stream_chunk', {
          sessionId,
          turn,
          content: chunk.content ?? '',
          isFinished: chunk.isFinished,
        } as unknown as HookContext);
      }
      // Infer finishReason from tool calls presence (normalized shape).
      if (finalToolCalls.length > 0) finalFinishReason = 'tool_calls';
    } catch {
      // Streaming failed (e.g. Electron async generator hang) — fall back to complete().
      usedRealStream = false;
    }

    if (!usedRealStream) {
      const response = await waitForAbortable(
        this.provider.complete(
          messages,
          tools.length > 0 ? tools as unknown as ToolSpec[] : undefined,
          params,
        ),
        signal,
      );
      finalContent = response.content;
      finalReasoning = response.reasoning;
      finalToolCalls = response.toolCalls;
      finalFinishReason = response.finishReason;
      finalUsage = response.usage;
      // Simulate streaming for the fallback path.
      await this.hooks.emitAsync('model.stream_chunk', {
        sessionId,
        turn,
        content: response.content,
        isFinished: false,
      } as unknown as HookContext);
      await this.hooks.emitAsync('model.stream_chunk', {
        sessionId,
        turn,
        content: '',
        isFinished: true,
      } as unknown as HookContext);
    }

    // Text tool protocol: when the model does not support native function
    // calling, it emits {"tool":"<name>","args":{...}} as prose. The provider's
    // parseResponse handles the non-streaming path; for the streaming path
    // (where chunks only carry content), parse the aggregated finalContent
    // here so tool dispatch still happens.
    let resolvedContent = finalContent;
    let resolvedToolCalls = finalToolCalls;
    if (resolvedToolCalls.length === 0 && !this.provider.capabilities().nativeToolCalling && finalContent) {
      const parsed = parseTextToolCall(finalContent);
      if (parsed) {
        resolvedToolCalls = [parsed];
        resolvedContent = '';
        finalFinishReason = 'tool_calls';
      }
    }

    return {
      content: resolvedContent,
      reasoning: finalReasoning,
      toolCalls: resolvedToolCalls,
      finishReason: finalFinishReason,
      usage: finalUsage,
      raw: { streamed: usedRealStream },
    };
  }

  // ─── Result Builders ───────────────────────────────────────

  private makeResult(
    status: AgentRunStatus,
    finalText: string,
    ctx: RunContext,
    turnsUsed: number,
  ): AgentRunResult {
    return {
      status,
      finalText,
      finalVerified: status === 'completed' && ctx.errors.length === 0,
      messages: ctx.messages,
      turnsUsed,
      toolResults: ctx.allToolResults,
      usage: ctx.usageTotals,
      errors: ctx.errors,
      traceEvents: ctx.traceEvents,
    };
  }

  private makeResultFromResponse(
    status: AgentRunStatus,
    response: NormalizedResponse,
    ctx: RunContext,
    turnsUsed: number,
  ): AgentRunResult {
    return {
      status,
      finalText: response.content,
      finalVerified: status === 'completed' && ctx.errors.length === 0,
      messages: ctx.messages,
      turnsUsed,
      toolResults: ctx.allToolResults,
      usage: ctx.usageTotals,
      errors: ctx.errors,
      traceEvents: ctx.traceEvents,
    };
  }

  // ─── Trace & Session Helpers ───────────────────────────────

  private trace(
    events: TraceEvent[],
    event: string,
    sessionId: string,
    attributes: Record<string, unknown>,
  ): void {
    events.push({
      timestamp: Date.now(),
      event,
      sessionId,
      attributes,
    });
  }

  private getToolCounts(sessionId: string): Map<string, number> {
    let counts = this.sessionToolCounts.get(sessionId);
    if (!counts) {
      counts = new Map();
      this.sessionToolCounts.set(sessionId, counts);
    }
    return counts;
  }

  private getAllowedToolNames(ctx: RunContext): string[] {
    const base = ctx.allowedTools !== undefined
      ? ctx.allowedTools
      : this.registry.list().map((spec) => spec.name);
    // The recovery sentinel must be a valid enum value at the boundary.
    return [...new Set([...base, '__recovery__'])];
  }

  private pruneSessionState(): void {
    const now = Date.now();
    const staleThreshold = now - AgentLoop.SESSION_ACTIVITY_TTL;

    for (const [sid, lastActive] of this.sessionLastActivity) {
      if (lastActive < staleThreshold) {
        this.sessionToolCounts.delete(sid);
        this.sessionLastActivity.delete(sid);
      }
    }

    if (this.sessionLastActivity.size > AgentLoop.MAX_TRACKED_SESSIONS) {
      const sorted = [...this.sessionLastActivity.entries()].sort((a, b) => a[1] - b[1]);
      const toEvict = sorted.slice(0, sorted.length - AgentLoop.MAX_TRACKED_SESSIONS);
      for (const [sid] of toEvict) {
        this.sessionToolCounts.delete(sid);
        this.sessionLastActivity.delete(sid);
      }
    }
  }
}

// ─── Module-level Functions ───────────────────────────────────

/**
 * Compute per-turn timeout based on model's max output tokens.
 * Base 90s + 25s per 1K output tokens, clamped to [120, 600].
 */
function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AbortSignal>;
  return typeof candidate.aborted === 'boolean'
    && typeof candidate.addEventListener === 'function'
    && typeof candidate.removeEventListener === 'function';
}

async function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new AgentInterruptedError();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AgentInterruptedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function computePerTurnTimeout(maxOutputTokens: number): number {
  if (maxOutputTokens <= 0) return PER_TURN_TIMEOUT_MS;
  const calculated = 90_000 + Math.floor(maxOutputTokens / 1000) * 25_000;
  return Math.max(120_000, Math.min(600_000, calculated));
}

/**
 * Adjust temperature based on turn state to encourage response diversity.
 */
function computeTemperature(
  turnIndex: number,
  repairFailureCounts: Map<string, number>,
  turnSignatures: string[],
): number {
  const turnBoost = Math.min(turnIndex * TEMP_PER_TURN, 0.35);
  const repairBoost = repairFailureCounts.size > 0 ? TEMP_REPAIR_BOOST : 0;
  let loopBoost = 0;
  // Compare the last two *completed* turns (indices length-2 and length-3) so
  // the current turn (length-1, still empty until the response arrives) can
  // immediately get a temperature boost when the loop is already forming.
  if (turnSignatures.length >= 3) {
    const last = turnSignatures[turnSignatures.length - 2];
    const prev = turnSignatures[turnSignatures.length - 3];
    if (last && prev && last === prev) {
      loopBoost = TEMP_LOOP_BOOST;
    }
  }
  const temp = TEMP_BASE + turnBoost + repairBoost + loopBoost;
  return Math.round(Math.max(0, Math.min(TEMP_MAX, temp)) * 100) / 100;
}

/**
 * Generate a simplified signature for a response (for loop detection).
 */
function turnSignature(response: NormalizedResponse): string {
  const tcNames = response.toolCalls.map((tc) => tc.name).join(',');
  return `${response.finishReason}|${tcNames}|${response.content.slice(0, 100)}`;
}

/**
 * Compute per-turn timeout based on model's max output tokens.
 * Kept as a utility for external callers.
 */
export { computePerTurnTimeout };

/**
 * Detect if the last 3 turn signatures are identical (response loop).
 */
function detectLoop(signatures: string[]): boolean {
  if (signatures.length < 3) return false;
  const len = signatures.length;
  // Check last 3 non-empty signatures
  const last3: string[] = [];
  for (let i = len - 1; i >= 0 && last3.length < 3; i--) {
    const sig = signatures[i];
    if (sig) last3.push(sig);
  }
  if (last3.length < 3) return false;
  return last3[0] === last3[1] && last3[1] === last3[2];
}

/**
 * Merge provider usage into totals.
 */
function mergeUsage(totals: ProviderUsage, usage: ProviderUsage): void {
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
}

/**
 * Check if an error message indicates context overflow.
 */
function isContextError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('context') || lower.includes('too long') || lower.includes('length') || lower.includes('token limit');
}

/**
 * Compact provider feedback content for inclusion in message history.
 * Performs a final strict parse at the boundary, then length-aware truncation.
 * The returned string is the validated content (not JSON) so the provider
 * message history remains human-readable.
 */
function compactFeedback(serialized: string, allowedToolNames: readonly string[], maxChars = MAX_PROVIDER_CONTENT_LENGTH): string {
  const feedback = safeDeserializeProviderFeedback(serialized, allowedToolNames);
  return safeTruncateContent(feedback.content, maxChars);
}
