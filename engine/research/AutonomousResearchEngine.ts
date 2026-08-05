/**
 * AutonomousResearchEngine — the while-not-done scheduler that drives the
 * autonomous research loop.
 *
 * Responsibilities:
 *   - Walk the planner's plan one phase at a time.
 *   - Execute each phase through WorkflowEngine (which runs the phase's steps
 *     against the real AgentLoop + tools), forwarding step events to the bus.
 *   - Check the live-steering queue between phases for pause/interrupt.
 *   - Reflect after each phase; redo/rollback/advance/done per the planner.
 *   - Persist phase checkpoints so a crashed/resumed session can continue.
 *
 * The engine owns NO agent state itself — it composes WorkflowEngine (phase
 * executor) + AutonomousPlanner (online decisions) + ResearchEventBus (events)
 * + LiveSteeringSource (human override). This mirrors the GoalEngine thin-shell
 * pattern but adds the reflective loop GoalEngine lacks.
 */

import type { WorkflowEngine } from '../workflow/WorkflowEngine.js';
import type { WorkflowDefinition, WorkflowHooks, WorkflowRun } from '../workflow/types.js';
import type { LiveSteeringSource } from '../runtime/LiveSteeringContract.js';
import type { ResearchPhaseKind } from '../runtime/AutonomousRuntimeContract.js';
import type { PersistenceStore } from '../persistence/PersistenceStore.js';
import { ResearchEventBus } from './ResearchEventBus.js';
import {
  AutonomousPlanner,
  type PlannedPhase,
  type PhaseHistoryEntry,
  type Reflection,
} from './AutonomousPlanner.js';
import { PHASE_WORKFLOWS, buildPhaseInput } from './researchPhases.js';

// ─── Types ────────────────────────────────────────────────────

export interface ResearchOutcome {
  sessionId: string;
  goal: string;
  status: 'completed' | 'interrupted' | 'failed';
  summary: string;
  phaseOutputs: Partial<Record<ResearchPhaseKind, string>>;
  iterations: number;
  artifactIds: string[];
}

export interface AutonomousResearchEngineOptions {
  workflowEngine: WorkflowEngine;
  planner: AutonomousPlanner;
  eventBus: ResearchEventBus;
  liveSteering?: LiveSteeringSource;
  store?: PersistenceStore;
  /** Hard cap on total phase executions (incl. redos) to bound cost. */
  maxPhaseExecutions?: number;
}

const DEFAULT_MAX_PHASE_EXECUTIONS = 16;
const CHECKPOINT_PREFIX = 'autonomous:session:';

// ─── Engine ───────────────────────────────────────────────────

export class AutonomousResearchEngine {
  private readonly workflowEngine: WorkflowEngine;
  private readonly planner: AutonomousPlanner;
  private readonly eventBus: ResearchEventBus;
  private readonly liveSteering?: LiveSteeringSource;
  private readonly store?: PersistenceStore;
  private readonly maxPhaseExecutions: number;

  /** Active sessions keyed by sessionId, for control (pause/interrupt). */
  private readonly activeSessions = new Map<string, { interrupted: boolean }>();

  constructor(options: AutonomousResearchEngineOptions) {
    this.workflowEngine = options.workflowEngine;
    this.planner = options.planner;
    this.eventBus = options.eventBus;
    this.liveSteering = options.liveSteering;
    this.store = options.store;
    this.maxPhaseExecutions = options.maxPhaseExecutions ?? DEFAULT_MAX_PHASE_EXECUTIONS;
  }

  /** Run a full autonomous research loop. Resolves when done or interrupted. */
  async run(userGoal: string, sessionId: string, projectId?: string): Promise<ResearchOutcome> {
    const session = { interrupted: false };
    this.activeSessions.set(sessionId, session);

    const plan = this.planner.proposeInitialGoal(userGoal);
    const history: PhaseHistoryEntry[] = [];
    const phaseOutputs: Partial<Record<ResearchPhaseKind, string>> = {};
    let executions = 0;

    this.eventBus.emit({
      type: 'engine-started',
      sessionId,
      goal: userGoal,
      plan: plan.phases.map((p) => ({ phase: p.phase, name: p.name })),
    });

    let lastReflection: Reflection | null = null;
    try {
      while (executions < this.maxPhaseExecutions) {
        // 1. Check for human interrupt before picking the next phase.
        if (await this.checkInterrupt(sessionId)) break;

        // 2. Pick the next phase (plan may have been revised by reflection).
        const planned = this.planner.pickNextPhase(plan, history);
        if (!planned) {
          // Plan exhausted and last reflection didn't say done — finish anyway.
          break;
        }

        // 3. Execute the phase via WorkflowEngine.
        executions += 1;
        const workflow = PHASE_WORKFLOWS[planned.phase];
        const priorOutputs = collectPriorOutputs(history);
        const revisionNote = plan.revisionNotes[planned.phase];
        const input = buildPhaseInput(userGoal, priorOutputs, revisionNote);

        this.eventBus.emit({
          type: 'phase-started',
          sessionId,
          phase: planned.phase,
          phaseIteration: planned.iteration,
          phaseName: planned.name,
        });

        const hooks = this.buildPhaseHooks(sessionId, planned, plan.phases.length, history.length);
        let run: WorkflowRun;
        try {
          run = await this.workflowEngine.run(workflow, input, hooks, this.liveSteering);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.eventBus.emit({
            type: 'reflection',
            sessionId,
            phase: planned.phase,
            decision: 'redo',
            qualityScore: 0,
            reasoning: `阶段执行异常：${message}`,
            revisionNote: '上次执行抛出异常，请简化方案重试。',
          });
          this.planner.reviseForRedo(plan, planned.phase, `异常：${message}`);
          continue;
        }

        const output = extractOutput(run, workflow);
        history.push({ phase: planned.phase, iteration: planned.iteration, output });
        phaseOutputs[planned.phase] = output;
        this.persistCheckpoint(sessionId, { goal: userGoal, history, phaseOutputs, executions, projectId });

        // 4. Reflect on the phase output.
        const reflection = await this.planner.reflect(planned.phase, output, history, userGoal);
        lastReflection = reflection;
        this.eventBus.emit({
          type: 'reflection',
          sessionId,
          phase: planned.phase,
          decision: reflection.decision,
          nextPhase: reflection.nextPhase,
          qualityScore: reflection.qualityScore,
          reasoning: reflection.reasoning,
          revisionNote: reflection.revisionNote,
        });

        if (reflection.decision === 'done') break;
        if (reflection.decision === 'redo') {
          if (reflection.revisionNote) this.planner.reviseForRedo(plan, planned.phase, reflection.revisionNote);
          continue;
        }
        if (reflection.decision === 'rollback' && reflection.nextPhase) {
          if (reflection.revisionNote) {
            this.planner.reviseForRollback(plan, history, reflection.nextPhase, reflection.revisionNote);
          }
          continue;
        }
        // advance: the plan's next entry is picked on the next iteration.
      }

      const status: ResearchOutcome['status'] = session.interrupted ? 'interrupted' : 'completed';
      const summary = composeSummary(userGoal, phaseOutputs, lastReflection);
      const artifactIds = extractArtifactIds(phaseOutputs);

      this.eventBus.emit({
        type: 'engine-completed' as const,
        sessionId,
        summary,
        artifactIds,
      });

      return { sessionId, goal: userGoal, status, summary, phaseOutputs, iterations: executions, artifactIds };
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  /** Request an interrupt for a running session (cooperative, between phases). */
  interrupt(sessionId: string, reason = 'user_requested'): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    session.interrupted = true;
    this.eventBus.emit({ type: 'engine-interrupted', sessionId, reason });
    return true;
  }

  /** Whether a session is currently running. */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  // ─── Internals ──────────────────────────────────────────────

  private async checkInterrupt(sessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.interrupted) return true;
    if (!this.liveSteering) return false;
    try {
      const events = await this.liveSteering.drain({ sessionId, afterSequence: 0 });
      // Any drained event between phases is treated as an interrupt request.
      if (events.length > 0) {
        session.interrupted = true;
        this.eventBus.emit({
          type: 'engine-interrupted',
          sessionId,
          reason: 'live_steering_between_phases',
        });
        return true;
      }
    } catch { /* ignore drain errors */ }
    return false;
  }

  private buildPhaseHooks(
    sessionId: string,
    planned: PlannedPhase,
    totalPhases: number,
    completedBefore: number,
  ): WorkflowHooks {
    return {
      onStepStart: (step) => {
        this.eventBus.emit({
          type: 'step-start',
          sessionId,
          phase: planned.phase,
          stepId: step.id,
          stepName: step.name,
        });
      },
      onStepComplete: (step, result) => {
        this.eventBus.emit({
          type: 'step-complete',
          sessionId,
          phase: planned.phase,
          stepId: step.id,
          stepName: step.name,
          output: result.output.slice(0, 100_000),
        });
        this.eventBus.emit({
          type: 'progress',
          sessionId,
          completedPhases: completedBefore,
          totalPhases,
          currentPhase: planned.phase,
        });
      },
      onStepFailed: (step, result) => {
        this.eventBus.emit({
          type: 'step-failed',
          sessionId,
          phase: planned.phase,
          stepId: step.id,
          stepName: step.name,
          error: (result.output || 'step failed').slice(0, 20_000),
        });
      },
    };
  }

  private persistCheckpoint(sessionId: string, data: { goal: string; history: PhaseHistoryEntry[]; phaseOutputs: Partial<Record<ResearchPhaseKind, string>>; executions: number; projectId?: string }): void {
    if (!this.store) return;
    try {
      this.store.setMemory(
        `${CHECKPOINT_PREFIX}${sessionId}`,
        JSON.stringify({ ...data, savedAt: Date.now() }),
        'autonomous_checkpoint',
      );
    } catch { /* checkpoint failures must never break the loop */ }
  }

  /** Load a saved checkpoint for crash recovery. */
  loadCheckpoint(sessionId: string): { goal: string; history: PhaseHistoryEntry[]; phaseOutputs: Partial<Record<ResearchPhaseKind, string>>; executions: number; projectId?: string } | null {
    if (!this.store) return null;
    try {
      const entry = this.store.getMemory(`${CHECKPOINT_PREFIX}${sessionId}`);
      if (!entry?.value) return null;
      return JSON.parse(entry.value);
    } catch { return null; }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function collectPriorOutputs(history: PhaseHistoryEntry[]): Record<string, string> {
  // Map each phase's latest output to its phase key, plus cross-phase references
  // that the phase prompts rely on (hypothesis/record/interpret/compare).
  const out: Record<string, string> = {};
  for (const entry of history) {
    out[entry.phase] = entry.output;
  }
  // Convenience aliases used by downstream phase prompts.
  if (out.idea) out.hypothesis = out.idea;
  if (out.experiment) out.record = out.experiment;
  if (out.analysis) {
    out.interpret = out.analysis;
    out.compare = out.analysis;
  }
  if (out.paper) {
    out.outline = out.paper;
    out.draft_sections = out.paper;
    out.compile_latex = out.paper;
  }
  return out;
}

function extractOutput(run: WorkflowRun, workflow: WorkflowDefinition): string {
  // Use the last step's output as the phase's representative output.
  const lastStepId = workflow.steps[workflow.steps.length - 1]?.id;
  if (lastStepId && run.stepResults[lastStepId]?.output) {
    return run.stepResults[lastStepId]!.output;
  }
  // Fallback: concatenate all step outputs.
  return workflow.steps
    .map((s) => run.stepResults[s.id]?.output ?? '')
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function composeSummary(
  goal: string,
  phaseOutputs: Partial<Record<ResearchPhaseKind, string>>,
  reflection: Reflection | null,
): string {
  const parts: string[] = [`研究目标：${goal}`];
  if (phaseOutputs.paper) {
    parts.push(`论文摘要：\n${phaseOutputs.paper.slice(0, 4000)}`);
  } else if (phaseOutputs.analysis) {
    parts.push(`分析结论：\n${phaseOutputs.analysis.slice(0, 4000)}`);
  } else if (phaseOutputs.experiment) {
    parts.push(`实验结果：\n${phaseOutputs.experiment.slice(0, 4000)}`);
  } else if (phaseOutputs.idea) {
    parts.push(`选题与假设：\n${phaseOutputs.idea.slice(0, 4000)}`);
  }
  if (reflection) {
    parts.push(`最终反思：${reflection.reasoning.slice(0, 1000)}`);
  }
  return parts.join('\n\n');
}

function extractArtifactIds(phaseOutputs: Partial<Record<ResearchPhaseKind, string>>): string[] {
  // Scan paper output for artifact id markers; real artifact persistence is
  // handled by the tool layer (findings/artifacts). This is a best-effort pull.
  const ids: string[] = [];
  const text = phaseOutputs.paper ?? '';
  const matches = text.match(/artifact[_-]?id[:\s]+([A-Za-z0-9_-]{4,64})/giu);
  if (matches) {
    for (const m of matches) {
      const id = m.split(/[:\s]+/u).pop();
      if (id) ids.push(id);
    }
  }
  return ids;
}
