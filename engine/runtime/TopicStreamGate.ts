/** Backward-compatible topic facade over the shared stream protocol gate. */
import {
  UnifiedStreamProtocolGate,
  stripUnifiedProtocol,
  type UnifiedGateResult,
  type UnifiedToolEvent,
} from './UnifiedStreamProtocolGate.js';

/** Kept as a named alias for topic consumers; shared events add only metadata. */
export type TopicToolEvent = UnifiedToolEvent;
export type TopicGateResult = UnifiedGateResult;

/**
 * Topic chat keeps its historical class/function names while inheriting the
 * shared implementation directly. No callback adapter is needed: protocol is
 * optional and existing consumers read only `tool` and `raw`.
 */
export class TopicStreamGate extends UnifiedStreamProtocolGate {}

export function stripTopicProtocol(text: string): TopicGateResult {
  return stripUnifiedProtocol(text);
}
