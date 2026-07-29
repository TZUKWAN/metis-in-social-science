/**
 * Tests for GoalEngine — Goal-Driven Plan+Workflow 一体化引擎。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoalEngine } from './GoalEngine.js';
// import type { Goal } from './GoalPlanner.js';
import type { AgentLoop } from '../core/AgentLoop.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';

// ─── Mock AgentLoop ───────────────────────────────────────────

function createMinimalWorkflowJson(name: string): string {
  return JSON.stringify({
    id: 'wf_agent',
    name,
    description: 'Agent-generated workflow',
    version: '1.0',
    steps: [
      { id: 's1', name: 'Step 1', description: 'D', prompt: 'P', inputFrom: [], tools: [], maxTurns: 3 },
    ],
    dependencies: { s1: [] },
  });
}

function createMockAgentLoop(): AgentLoop {
  return {
    run: vi.fn(async (req: AgentRunRequest): Promise<AgentRunResult> => {
      const isPlanning = req.sessionId.startsWith('plan-');
      const isRefinement = req.sessionId.startsWith('refine-');
      const finalText = isPlanning
        ? createMinimalWorkflowJson('Agent Plan')
        : isRefinement
          ? createMinimalWorkflowJson('Refined Agent Plan')
          : `Result for ${req.sessionId}`;
      return {
        status: 'completed',
        finalText,
        finalVerified: true,
        messages: [{ role: 'assistant', content: finalText }],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        errors: [],
        traceEvents: [],
      } as AgentRunResult;
    }),
  } as unknown as AgentLoop;
}

function createFailingMockAgentLoop(): AgentLoop {
  return {
    run: vi.fn(async (req: AgentRunRequest): Promise<AgentRunResult> => {
      return {
        status: 'completed',
        finalText: `Result for ${req.sessionId}`,
        finalVerified: true,
        messages: [{ role: 'assistant', content: `Result for ${req.sessionId}` }],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        errors: [],
        traceEvents: [],
      } as AgentRunResult;
    }),
  } as unknown as AgentLoop;
}

// ─── Tests ────────────────────────────────────────────────────

describe('GoalEngine', () => {
  let agent: AgentLoop;
  let engine: GoalEngine;

  beforeEach(() => {
    agent = createMockAgentLoop();
    engine = new GoalEngine(agent);
  });

  // ── Goal Lifecycle ─────────────────────────────────────────

  it('creates a goal with correct initial state', () => {
    const goal = engine.createGoal('Analyze paper methodology');
    expect(goal.description).toBe('Analyze paper methodology');
    expect(goal.status).toBe('draft');
    expect(goal.id).toMatch(/^goal_\d+/);
    expect(goal.createdAt).toBeGreaterThan(0);
  });

  it('retrieves a goal by id', () => {
    const goal = engine.createGoal('Test goal');
    const retrieved = engine.getGoal(goal.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(goal.id);
  });

  it('returns undefined for non-existent goal', () => {
    expect(engine.getGoal('non-existent')).toBeUndefined();
  });

  it('lists goals sorted by createdAt desc', async () => {
    const g1 = engine.createGoal('First');
    await new Promise((r) => setTimeout(r, 10));
    const g2 = engine.createGoal('Second');
    const list = engine.listGoals();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(g2.id);
    expect(list[1]!.id).toBe(g1.id);
  });

  // ── Plan Generation ────────────────────────────────────────

  it('generates a plan for a goal', async () => {
    const goal = engine.createGoal('Write a literature review about transformers');
    const result = await engine.generatePlan(goal.id);

    expect(result.goal.status).toBe('ready');
    expect(result.workflow.steps.length).toBeGreaterThan(0);
    expect(result.workflow.dependencies).toBeDefined();
    expect(result.reasoning).toContain('Generated');
  });

  it('throws when generating plan for non-existent goal', async () => {
    await expect(engine.generatePlan('non-existent')).rejects.toThrow("not found");
  });

  it('selects literature review template for review goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Literature review on neural networks');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('literature');
    expect(result.workflow.steps.length).toBeGreaterThanOrEqual(4);
  });

  it('selects analysis template for analysis goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Analyze the methodology of this paper');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('analysis');
  });

  it('selects writing template for writing goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Write a research paper draft');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('writing');
  });

  it('selects experiment template for experiment goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Design an experiment to test hypothesis');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('experiment');
  });

  it('selects generic template for unmatched goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Do some research');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.steps.length).toBeGreaterThan(0);
  });

  // ── Plan Refinement ────────────────────────────────────────

  it('refines a plan based on feedback', async () => {
    const goal = engine.createGoal('Write a paper');
    await engine.generatePlan(goal.id);

    const refined = await engine.refinePlan(goal.id, 'Add more detail to the methodology section');
    expect(refined.goal.status).toBe('ready');
    expect(refined.workflow.steps.length).toBeGreaterThan(0);
  });

  it('throws when refining non-existent goal', async () => {
    await expect(engine.refinePlan('non-existent', 'feedback')).rejects.toThrow("not found");
  });

  it('extracts JSON from markdown code block when generating plan', async () => {
    const fencedEngine = new GoalEngine({
      run: vi.fn(async (): Promise<AgentRunResult> => ({
        status: 'completed',
        finalText: `Here is the plan:\n\n\`\`\`json\n${createMinimalWorkflowJson('Fenced Plan')}\n\`\`\``,
        finalVerified: true,
        messages: [],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        errors: [],
        traceEvents: [],
      } as AgentRunResult)),
    } as unknown as AgentLoop);
    const goal = fencedEngine.createGoal('Any goal');
    const result = await fencedEngine.generatePlan(goal.id);
    expect(result.workflow.name).toBe('Fenced Plan');
    expect(result.reasoning).toContain('LLM agent');
  });

  it('falls back to step append when refinement returns non-JSON', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Write a paper');
    await fallbackEngine.generatePlan(goal.id);

    const refined = await fallbackEngine.refinePlan(goal.id, 'Add more detail');
    expect(refined.goal.status).toBe('ready');
    expect(refined.workflow.steps.some((s) => s.name.includes('Feedback'))).toBe(true);
  });

  // ── Plan Update ────────────────────────────────────────────

  it('updates a plan directly', () => {
    const goal = engine.createGoal('Test');
    const plan = {
      id: 'wf_test',
      name: 'Test Workflow',
      description: 'Test',
      version: '1.0',
      steps: [
        { id: 's1', name: 'Step 1', description: 'D', prompt: 'P', inputFrom: [], tools: [], maxTurns: 3 },
      ],
      dependencies: { s1: [] },
    };

    const validation = engine.updatePlan(goal.id, plan);
    expect(validation.valid).toBe(true);
    expect(goal.status).toBe('ready');
  });

  it('rejects invalid plan update', () => {
    const goal = engine.createGoal('Test');
    const plan = {
      id: 'wf_test',
      name: 'Test',
      description: 'Test',
      version: '1.0',
      steps: [],
      dependencies: {},
    };

    const validation = engine.updatePlan(goal.id, plan);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  // ── Goal Execution ─────────────────────────────────────────

  it('executes a goal and marks it completed', async () => {
    const goal = engine.createGoal('Analyze methodology');
    await engine.generatePlan(goal.id);

    const run = await engine.executeGoal(goal.id);
    expect(run.status).toBe('completed');
    expect(goal.status).toBe('completed');
  });

  it('tracks progress during execution', async () => {
    const goal = engine.createGoal('Write literature review');
    await engine.generatePlan(goal.id);
    await engine.executeGoal(goal.id);

    const progress = engine.getProgress(goal.id);
    expect(progress).toBeDefined();
    expect(progress!.status).toBe('completed');
    expect(progress!.totalSteps).toBeGreaterThan(0);
    expect(progress!.completedSteps).toBeGreaterThan(0);
  });

  it('archives a completed goal', async () => {
    const goal = engine.createGoal('Analyze paper');
    await engine.generatePlan(goal.id);
    await engine.executeGoal(goal.id);

    const archive = await engine.archiveGoal(goal.id);
    expect(archive.goal.id).toBe(goal.id);
    expect(archive.summary).toContain(goal.description);
    expect(archive.archivedAt).toBeGreaterThan(0);
  });

  it('lists archives', async () => {
    const goal = engine.createGoal('Test archive');
    await engine.generatePlan(goal.id);
    await engine.executeGoal(goal.id);
    // executeGoal auto-archives on completion; don't call archiveGoal again

    const archives = engine.getArchives();
    expect(archives.length).toBe(1);
    expect(archives[0]!.goal.description).toBe('Test archive');
  });

  it('calls hooks during execution', async () => {
    const goal = engine.createGoal('Test hooks');
    await engine.generatePlan(goal.id);

    const onStepStart = vi.fn();
    const onStepComplete = vi.fn();

    await engine.executeGoal(goal.id, {
      onStepStart,
      onStepComplete,
    });

    expect(onStepStart).toHaveBeenCalled();
    expect(onStepComplete).toHaveBeenCalled();
  });

  // ── Goal Cancellation ──────────────────────────────────────

  it('cancels a running goal', () => {
    const goal = engine.createGoal('Cancel me');
    engine.cancelGoal(goal.id);
    expect(goal.status).toBe('failed');
  });

  // ── Goal with Context ──────────────────────────────────────

  it('creates goal with context', () => {
    const goal = engine.createGoal('Analyze paper', 'This is about transformer architectures');
    expect(goal.context).toBe('This is about transformer architectures');
  });
});
