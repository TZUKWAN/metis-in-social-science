/**
 * AutonomousResearchEngine — integration tests for the while-not-done loop.
 *
 * Uses a stubbed WorkflowEngine (so no real AgentLoop/tools needed) and a
 * deterministic planner to verify: linear completion, reflection-driven redo,
 * live-steering interrupt, checkpoint persistence, and event emission.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutonomousResearchEngine } from '../../engine/research/AutonomousResearchEngine.js';
import { AutonomousPlanner } from '../../engine/research/AutonomousPlanner.js';
import { ResearchEventBus, type ResearchEvent } from '../../engine/research/ResearchEventBus.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import type { WorkflowDefinition, WorkflowRun, WorkflowHooks } from '../../engine/workflow/types.js';

// ─── Stub WorkflowEngine ──────────────────────────────────────

class StubWorkflowEngine {
  /** Configurable per-phase output. */
  public outputs: Partial<Record<string, string>> = {};
  /** Throw on the Nth run call (simulates phase failure). */
  public failOnRun: number | null = null;
  private runCount = 0;
  public hooksSnapshot: WorkflowHooks | null = null;

  async run(
    definition: WorkflowDefinition,
    _input: Record<string, unknown>,
    hooks?: WorkflowHooks,
  ): Promise<WorkflowRun> {
    this.runCount += 1;
    this.hooksSnapshot = hooks ?? null;
    if (this.failOnRun === this.runCount) {
      throw new Error(`stub failure on run ${this.runCount}`);
    }
    // Drive hooks so event coverage is exercised.
    for (const step of definition.steps) {
      await hooks?.onStepStart?.(step, {} as WorkflowRun);
      await hooks?.onStepComplete?.(step, { stepId: step.id, status: 'completed', output: 'step output', agentResult: null, startedAt: 0, completedAt: 1, retryCount: 0 }, {} as WorkflowRun);
    }
    const lastStep = definition.steps[definition.steps.length - 1];
    const output = this.outputs[definition.id] ?? `${definition.id}-output`;
    const run: WorkflowRun = {
      id: `run-${this.runCount}`,
      workflowId: definition.id,
      status: 'completed',
      currentStepId: lastStep?.id ?? null,
      stepResults: { [lastStep!.id]: { stepId: lastStep!.id, status: 'completed', output, agentResult: null, startedAt: 0, completedAt: 1, retryCount: 0 } },
      startedAt: 0,
      completedAt: 1,
      input: _input,
      errors: [],
    };
    return run;
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-auto-test-'));
}

describe('AutonomousResearchEngine', () => {
  let dataDir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    store = new PersistenceStore(path.join(dataDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runs all 4 phases linearly and completes (deterministic planner)', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner(); // no provider → deterministic advance
    const bus = new ResearchEventBus();
    const events: ResearchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub matches the run() contract sufficiently
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    const outcome = await engine.run('study X', 'sess-1');

    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(4); // 4 phases
    expect(Object.keys(outcome.phaseOutputs).sort()).toEqual(['analysis', 'experiment', 'idea', 'paper']);
    // Events: 1 engine-started + 4 phase-started + 4 reflection + 1 engine-completed (at least)
    const types = events.map((e) => e.type);
    expect(types).toContain('engine-started');
    expect(types.filter((t) => t === 'phase-started')).toHaveLength(4);
    expect(types.filter((t) => t === 'reflection')).toHaveLength(4);
    expect(types).toContain('engine-completed');
  });

  it('persists checkpoints to the store', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    await engine.run('goal', 'sess-cp');

    const checkpoint = engine.loadCheckpoint('sess-cp');
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.goal).toBe('goal');
    expect(checkpoint?.executions).toBe(4);
    expect(checkpoint?.history).toHaveLength(4);
  });

  it('handles phase execution failure by redoing then completing', async () => {
    const stub = new StubWorkflowEngine();
    stub.failOnRun = 1; // first phase (idea) throws once
    // Use a planner that advances so the redo doesn't loop forever.
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    const outcome = await engine.run('goal', 'sess-fail');

    // idea phase failed once (redo), then succeeded → total executions = 5 (1 failed + 4 success)
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(5);
  });

  it('stops when interrupted via the engine API', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    // Interrupt before the first phase can complete.
    const runPromise = engine.run('goal', 'sess-int');
    engine.interrupt('sess-int', 'test');
    const outcome = await runPromise;

    expect(outcome.status).toBe('interrupted');
    expect(outcome.iterations).toBeLessThan(4);
  });

  it('stops when live-steering queue yields an event between phases', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    let drainCalls = 0;
    const liveSteering = {
      drain: async () => {
        drainCalls += 1;
        // After the first drain (before phase 1), return an interrupt event.
        return drainCalls === 2 ? [{ type: 'interrupt', sessionId: 'sess-ls', sequence: 1 }] : [];
      },
    };
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      // @ts-expect-error minimal live-steering stub
      liveSteering,
      store,
    });

    const outcome = await engine.run('goal', 'sess-ls');

    expect(outcome.status).toBe('interrupted');
  });

  it('respects maxPhaseExecutions cap', async () => {
    const stub = new StubWorkflowEngine();
    // Planner that always redos idea → would loop forever without the cap.
    const alwaysRedoProvider = {
      complete: async () => ({ content: JSON.stringify({ decision: 'redo', qualityScore: 0.2, reasoning: 'never good enough', revisionNote: 'again' }) }),
      capabilities: () => ({ providerType: 'stub', model: 'm', nativeToolCalling: false, jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 1000, maxOutputTokens: 100, retryableStatusCodes: [] }),
    };
    const planner = new AutonomousPlanner({ provider: alwaysRedoProvider as never, maxRedosPerPhase: 100 });
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
      maxPhaseExecutions: 5,
    });

    const outcome = await engine.run('goal', 'sess-cap');
    expect(outcome.iterations).toBeLessThanOrEqual(5);
  });
});
