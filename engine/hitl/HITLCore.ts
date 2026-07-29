/**
 * HITL (Human-in-the-Loop) approval store and rule engine.
 *
 * Ported from metis/hitl/core.py + metis/hitl/store.py + metis/hitl/rules.py.
 */

import { randomUUID } from 'node:crypto';

// ─── Approval Types ───────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  metadata: Record<string, unknown>;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

// ─── Rule Engine ──────────────────────────────────────────────

export interface HITLRule {
  id: string;
  name: string;
  description: string;
  /** Return true if this action requires approval. */
  evaluate: (toolName: string, args: Record<string, unknown>) => boolean;
  enabled: boolean;
}

// ─── Approval Store ───────────────────────────────────────────

export class ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly rules: HITLRule[] = [];
  private handler?: ApprovalHandler;

  /** Register an approval handler (e.g., one that shows UI). */
  setHandler(handler: ApprovalHandler): void {
    this.handler = handler;
  }

  /** Add a HITL rule. */
  addRule(rule: HITLRule): void {
    this.rules.push(rule);
  }

  /** Remove a rule by id. */
  removeRule(ruleId: string): void {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx !== -1) this.rules.splice(idx, 1);
  }

  /**
   * Check if a tool call requires approval.
   * Returns the approval request if required, null otherwise.
   */
  checkRequired(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
  ): ApprovalRequest | null {
    const matchingRule = this.rules.find(
      (r) => r.enabled && r.evaluate(toolName, args),
    );

    if (!matchingRule) return null;

    const request: ApprovalRequest = {
      id: `apr_${randomUUID()}`,
      sessionId,
      toolName,
      toolArgs: args,
      reason: matchingRule.description,
      status: 'pending',
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
      metadata: { ruleId: matchingRule.id, ruleName: matchingRule.name },
    };

    this.requests.set(request.id, request);
    return request;
  }

  /**
   * Request approval through the handler.
   * Returns true if approved, false if rejected or no handler.
   */
  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (!this.handler) {
      // No handler → fail-safe: reject
      request.status = 'rejected';
      request.resolvedAt = Date.now();
      return false;
    }

    const approved = await this.handler(request);
    request.status = approved ? 'approved' : 'rejected';
    request.resolvedAt = Date.now();
    return approved;
  }

  /** Get a pending request. */
  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  /** List all pending requests. */
  getPending(sessionId?: string): ApprovalRequest[] {
    const all = [...this.requests.values()].filter((r) => r.status === 'pending');
    if (sessionId) return all.filter((r) => r.sessionId === sessionId);
    return all;
  }

  /** Get all rules. */
  getRules(): HITLRule[] {
    return [...this.rules];
  }

  /** Enable or disable a rule by id. */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return false;
    rule.enabled = enabled;
    return true;
  }
}

// ─── Built-in Rules ───────────────────────────────────────────

export const WRITE_APPROVAL_RULE: HITLRule = {
  id: 'require-write-approval',
  name: 'Write Approval',
  description: 'Require approval for file write and command execution operations',
  evaluate: (toolName: string) => ['write_file', 'execute_command', 'create_directory'].includes(toolName),
  enabled: true,
};

export const DANGEROUS_COMMAND_RULE: HITLRule = {
  id: 'dangerous-command-check',
  name: 'Dangerous Command Check',
  description: 'Require approval for potentially destructive shell commands',
  evaluate: (_toolName: string, args: Record<string, unknown>) => {
    const cmd = String(args.command ?? '').toLowerCase();
    const dangerousPatterns = ['rm -rf', 'del /', 'format ', 'mkfs', 'dd if=', '> /dev/', 'shutdown', 'reboot'];
    return dangerousPatterns.some((p) => cmd.includes(p));
  },
  enabled: true,
};
