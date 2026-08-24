import type {
  AgentPresentationEvent,
  AgentToolResultSource,
} from '../../engine/runtime/ChatRuntimeContract.js';

export type AgentActivityEvent = AgentPresentationEvent & { replayed?: boolean };

export type AssistantRunPhase =
  | 'created' | 'started' | 'args' | 'result' | 'error'
  | 'completed' | 'interrupted' | 'replay';

export type AssistantToolStatus = 'running' | 'completed' | 'error';

export interface AssistantToolPart {
  toolCallId: string;
  name: string;
  arguments: string;
  result?: string;
  error?: string;
  status: AssistantToolStatus;
  sources: AgentToolResultSource[];
  replayed?: boolean;
  /** Highest ordered event incorporated for this tool, used for late delivery. */
  lastSequence?: number;
}

/** Compatibility shape for the legacy ToolCallCard boundary. */
export interface LegacyAssistantToolCall {
  toolCallId?: string;
  name: string;
  arguments: string;
  result?: string;
  error?: string;
  status: AssistantToolStatus;
  sources?: AgentToolResultSource[];
}

export type AssistantMessagePartEvent =
  | {
    kind: 'run'; phase: AssistantRunPhase; status?: AssistantMessageParts['run']['status'];
    eventId?: string; sequence?: number; timestamp?: number; summary?: string;
  }
  | {
    kind: 'tool'; phase: AssistantRunPhase; toolCallId: string; name: string;
    arguments?: string; result?: string; error?: string; status?: AssistantToolStatus;
    sources?: AgentToolResultSource[];
    eventId?: string; sequence?: number; timestamp?: number; summary?: string;
  }
  | { kind: 'activity'; event: AgentActivityEvent; eventId?: string; sequence?: number };

export interface AssistantMessageParts {
  run: {
    status: 'running' | 'completed' | 'interrupted' | 'error' | 'cancelled';
    phases: AssistantRunPhase[];
    events: AgentActivityEvent[];
    lastSequence?: number;
  };
  tools: AssistantToolPart[];
  seenEventIds: string[];
  seenSequences: number[];
  seenEventKeys: string[];
}

export function createAssistantMessageParts(): AssistantMessageParts {
  return {
    run: { status: 'running', phases: [], events: [] },
    tools: [], seenEventIds: [], seenSequences: [], seenEventKeys: [],
  };
}

function eventKey(event: AssistantMessagePartEvent): string {
  const stable = event.kind === 'activity' ? { ...event.event } : { ...event };
  delete stable.eventId;
  delete stable.sequence;
  if ('timestamp' in stable) delete stable.timestamp;
  return JSON.stringify(stable);
}

function eventSequence(event: AgentActivityEvent): number | undefined {
  return 'sequence' in event ? event.sequence : undefined;
}

function sortRunEvents(events: AgentActivityEvent[]): void {
  events.sort((left, right) => {
    const leftSequence = eventSequence(left);
    const rightSequence = eventSequence(right);
    if (leftSequence !== undefined && rightSequence !== undefined) return leftSequence - rightSequence;
    if (leftSequence !== undefined) return -1;
    if (rightSequence !== undefined) return 1;
    return 0;
  });
}

function statusFor(event: Extract<AssistantMessagePartEvent, { kind: 'run' }>): AssistantMessageParts['run']['status'] {
  if (event.status) return event.status;
  if (event.phase === 'completed') return 'completed';
  if (event.phase === 'interrupted') return 'interrupted';
  if (event.phase === 'error') return 'error';
  return 'running';
}

function isTerminalRunStatus(status: AssistantMessageParts['run']['status']): boolean {
  return status !== 'running';
}

function mergeRunStatus(
  previous: AssistantMessageParts['run']['status'],
  incoming: AssistantMessageParts['run']['status'],
): AssistantMessageParts['run']['status'] {
  // A late lifecycle delivery must not reopen a settled run. The final
  // response remains the authoritative status at the ChatPage boundary.
  return isTerminalRunStatus(previous) && incoming === 'running' ? previous : incoming;
}

function runActivity(event: Extract<AssistantMessagePartEvent, { kind: 'run' }>): AgentActivityEvent | undefined {
  const phase = event.phase === 'error' ? 'failed' : event.phase;
  if (!['started', 'completed', 'interrupted', 'failed'].includes(phase)) return undefined;
  return {
    type: 'lifecycle', phase: phase as 'started' | 'completed' | 'interrupted' | 'failed',
    timestamp: event.timestamp ?? 0,
    ...(event.eventId ? { eventId: event.eventId } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
  };
}

function toolActivity(
  event: Extract<AssistantMessagePartEvent, { kind: 'tool' }>,
): Extract<AgentActivityEvent, { type: 'tool_result' }> {
  const failed = event.status === 'error' || event.phase === 'error';
  return {
    type: 'tool_result',
    toolCallId: event.toolCallId,
    toolName: event.name,
    status: failed ? 'failed' : 'completed',
    timestamp: event.timestamp ?? 0,
    ...(event.eventId ? { eventId: event.eventId } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(failed
      ? (event.error !== undefined ? { detail: event.error } : {})
      : (event.result !== undefined ? { detail: event.result } : {})),
    sources: event.sources ?? [],
  };
}

function mergeToolActivity(
  events: AgentActivityEvent[],
  activity: Extract<AgentActivityEvent, { type: 'tool_result' }>,
): void {
  const index = events.findIndex((event) => event.type === 'tool_result' && event.toolCallId === activity.toolCallId);
  if (index < 0) {
    events.push(activity);
    return;
  }
  const previous = events[index];
  if (!previous || previous.type !== 'tool_result') return;
  const previousSequence = eventSequence(previous);
  const incomingSequence = eventSequence(activity);
  const incomingIsOlder = incomingSequence !== undefined
    && previousSequence !== undefined
    && incomingSequence < previousSequence;
  events[index] = {
    ...previous,
    ...activity,
    summary: activity.summary ?? previous.summary,
    detail: incomingIsOlder ? (previous.detail ?? activity.detail) : (activity.detail ?? previous.detail),
    sources: activity.sources.length > 0 || previous.sources.length === 0
      ? activity.sources
      : previous.sources,
  };
}

function mergeTool(
  previous: AssistantToolPart | undefined,
  event: Extract<AssistantMessagePartEvent, { kind: 'tool' }>,
): AssistantToolPart {
  const next = previous ?? {
    toolCallId: event.toolCallId,
    name: event.name,
    arguments: '',
    status: 'running' as const,
    sources: [],
  };
  const status = event.status
    ?? (event.phase === 'error' ? 'error' : event.phase === 'result' || event.phase === 'completed' ? 'completed' : undefined);
  const sequence = event.sequence;
  const incomingIsOlder = sequence !== undefined
    && next.lastSequence !== undefined
    && sequence < next.lastSequence;
  const incomingArguments = event.arguments !== undefined && event.arguments !== ''
    && (!incomingIsOlder || next.arguments === '')
    ? event.arguments
    : next.arguments;
  const incomingResult = event.result !== undefined
    && (!incomingIsOlder || (next.result === undefined && next.error === undefined))
    ? event.result
    : next.result;
  const incomingError = event.error !== undefined
    && (!incomingIsOlder || (next.error === undefined && next.result === undefined))
    ? event.error
    : next.error;
  const incomingSources = event.sources !== undefined && event.sources.length > 0
    && (!incomingIsOlder || next.sources.length === 0)
    ? event.sources
    : next.sources;
  return {
    ...next,
    name: event.name || next.name,
    // An args-only event can legitimately arrive after a result in a replay.
    // Keep every non-empty field, while an older delivery cannot overwrite a
    // newer terminal result or error.
    arguments: incomingArguments,
    ...(incomingResult !== undefined ? { result: incomingResult } : {}),
    ...(incomingError !== undefined ? { error: incomingError } : {}),
    sources: incomingSources,
    ...(status && (!incomingIsOlder || next.status === 'running')
      ? { status: isTerminalRunStatus(status) ? status : next.status } : {}),
    ...(event.phase === 'replay' ? { replayed: true } : {}),
    ...(sequence !== undefined && (next.lastSequence === undefined || sequence > next.lastSequence)
      ? { lastSequence: sequence } : {}),
  };
}

export function reduceAssistantMessageParts(
  state: AssistantMessageParts,
  event: AssistantMessagePartEvent,
): AssistantMessageParts {
  const key = eventKey(event);
  if ((event.eventId && state.seenEventIds.includes(event.eventId))
    || (event.sequence !== undefined && state.seenSequences.includes(event.sequence))
    || state.seenEventKeys.includes(key)) return state;

  const next: AssistantMessageParts = {
    run: { ...state.run, phases: [...state.run.phases], events: [...state.run.events] },
    tools: [...state.tools],
    seenEventIds: event.eventId ? [...state.seenEventIds, event.eventId] : state.seenEventIds,
    seenSequences: event.sequence !== undefined ? [...state.seenSequences, event.sequence] : state.seenSequences,
    seenEventKeys: [...state.seenEventKeys, key],
  };
  if (event.kind === 'activity') {
    next.run.events.push(event.event);
    if (event.sequence !== undefined
      && (next.run.lastSequence === undefined || event.sequence > next.run.lastSequence)) {
      next.run.lastSequence = event.sequence;
    }
  } else if (event.kind === 'run') {
    next.run.phases.push(event.phase);
    const incomingIsOlder = event.sequence !== undefined
      && next.run.lastSequence !== undefined
      && event.sequence < next.run.lastSequence;
    if (!incomingIsOlder) next.run.status = mergeRunStatus(next.run.status, statusFor(event));
    if (event.sequence !== undefined
      && (next.run.lastSequence === undefined || event.sequence > next.run.lastSequence)) {
      next.run.lastSequence = event.sequence;
    }
    const activity = runActivity(event);
    const lateRunningLifecycle = statusFor(event) === 'running'
      && isTerminalRunStatus(next.run.status);
    if (activity && !lateRunningLifecycle) next.run.events.push(activity);
  } else if (event.kind === 'tool') {
    const index = next.tools.findIndex((tool) => tool.toolCallId === event.toolCallId);
    const merged = mergeTool(index >= 0 ? next.tools[index] : undefined, event);
    if (index >= 0) next.tools[index] = merged;
    else next.tools.push(merged);
    if (event.sequence !== undefined
      && (next.run.lastSequence === undefined || event.sequence > next.run.lastSequence)) {
      next.run.lastSequence = event.sequence;
    }
    if (event.phase === 'result' || event.phase === 'error' || event.phase === 'replay' || event.status) {
      const toolEvent = {
        kind: 'tool' as const,
        phase: event.phase,
        toolCallId: event.toolCallId,
        name: event.name,
        ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
        ...(event.sources !== undefined ? { sources: event.sources } : {}),
        ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
        ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
        ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      } satisfies Extract<AssistantMessagePartEvent, { kind: 'tool' }>;
      mergeToolActivity(next.run.events, toolActivity(toolEvent));
    }
  }
  sortRunEvents(next.run.events);
  return next;
}

export function reduceAssistantMessagePartsBatch(
  events: readonly AssistantMessagePartEvent[],
  initial = createAssistantMessageParts(),
): AssistantMessageParts {
  return events.reduce(reduceAssistantMessageParts, initial);
}

function normalizeRunPhase(phase: string): AssistantRunPhase {
  switch (phase) {
    case 'started':
    case 'completed':
    case 'interrupted':
      return phase;
    case 'cancelled':
      return 'interrupted';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'started';
  }
}

export function normalizeAssistantEvent(event: AgentActivityEvent, replayed = false): AssistantMessagePartEvent {
  const identity = {
    ...('eventId' in event && event.eventId ? { eventId: event.eventId } : {}),
    ...('sequence' in event && event.sequence !== undefined ? { sequence: event.sequence } : {}),
  };
  if (event.type === 'lifecycle') {
    return {
      kind: 'run', phase: normalizeRunPhase(event.phase),
      timestamp: event.timestamp, summary: event.summary, ...identity,
    };
  }
  if (event.type === 'tool_result') {
    const failed = event.status === 'failed';
    return {
      kind: 'tool', phase: replayed ? 'replay' : failed ? 'error' : 'result',
      toolCallId: event.toolCallId,
      name: event.toolName,
      ...(failed ? { error: event.detail } : { result: event.detail }),
      status: failed ? 'error' : 'completed', timestamp: event.timestamp,
      summary: event.summary, sources: event.sources, ...identity,
    };
  }
  return { kind: 'activity', event: replayed ? { ...event, replayed: true } : event, ...identity };
}

export function mergeAssistantToolParts(
  primary: AssistantToolPart | undefined,
  supplemental: AssistantToolPart,
): AssistantToolPart {
  if (!primary) return supplemental;
  const primaryIsError = primary.status === 'error';
  const primaryIsCompleted = primary.status === 'completed';
  return {
    ...supplemental,
    ...primary,
    name: primary.name || supplemental.name,
    arguments: primary.arguments || supplemental.arguments,
    ...(primary.result !== undefined || primaryIsError || supplemental.result === undefined
      ? (primary.result !== undefined ? { result: primary.result } : {})
      : { result: supplemental.result }),
    ...(primary.error !== undefined || primaryIsCompleted || supplemental.error === undefined
      ? (primary.error !== undefined ? { error: primary.error } : {})
      : { error: supplemental.error }),
    sources: primary.sources.length > 0 ? primary.sources : supplemental.sources,
    ...(primary.replayed || supplemental.replayed ? { replayed: true } : {}),
    ...(primary.lastSequence === undefined && supplemental.lastSequence !== undefined
      ? { lastSequence: supplemental.lastSequence }
      : primary.lastSequence !== undefined && supplemental.lastSequence !== undefined
        ? { lastSequence: Math.max(primary.lastSequence, supplemental.lastSequence) }
        : {}),
  };
}

export function assistantToolPartFromLegacy(toolCall: LegacyAssistantToolCall): AssistantToolPart {
  return {
    toolCallId: toolCall.toolCallId ?? `legacy-${toolCall.name}`,
    name: toolCall.name,
    arguments: toolCall.arguments,
    ...(toolCall.result !== undefined ? { result: toolCall.result } : {}),
    ...(toolCall.error !== undefined ? { error: toolCall.error } : {}),
    status: toolCall.status,
    sources: toolCall.sources ?? [],
  };
}
