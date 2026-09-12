/**
 * Presentation-side guard for internal execution copy (agentloop/provider/mcp/
 * runtime). Shared by the goal card and the chat page so production surfaces
 * never leak runtime implementation terms.
 */
const INTERNAL_EXECUTION_COPY = /\b(?:agentloop|provider|mcp|runtime)\b/i;

export function isInternalExecutionCopy(value: string | undefined): boolean {
  return Boolean(value && INTERNAL_EXECUTION_COPY.test(value));
}
