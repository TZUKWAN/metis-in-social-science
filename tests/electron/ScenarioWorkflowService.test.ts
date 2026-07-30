import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import { digestResolvedManifestSnapshot } from '../../engine/personalization/ScenarioRunCoordinator.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { AgentRunResult, ChatMessage } from '../../engine/core/types.js';
import {
  hasExecutableScenarioWorkflow,
  runPersistedScenarioWorkflow,
} from '../../electron/ScenarioWorkflowService.js';

let root: string;
let store: PersistenceStore;
let repository: PersonalizationRepository;

function completedResult(text: string): AgentRunResult {
  return {
    status: 'completed',
    finalText: text,
    finalVerified: true,
    messages: [],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    errors: [],
    traceEvents: [],
  };
}

function resolveManifest(scenarioId: string) {
  const result = new PersonalizationResolver(repository).resolve({
    sessionId: 'session-1',
    projectId: 'project-1',
    scenarioId,
    createdAt: 100,
  });
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result;
}

const TEST_OUTPUT_PLAN = {
  primaryDeliverable: 'Complete evidence-grounded manuscript',
  supportingArtifacts: ['Evidence table', 'Source ledger'],
  qualityCriteria: ['Every claim is traceable', 'Methods are reproducible'],
};

function withOutputPlan(resolved: ReturnType<typeof resolveManifest>) {
  const candidate = {
    ...resolved.manifest,
    output: {
      ...resolved.manifest.output,
      format: 'artifact_bundle' as const,
      plan: TEST_OUTPUT_PLAN,
    },
    manifestDigest: '0'.repeat(64),
  };
  return {
    ...candidate,
    manifestDigest: digestResolvedManifestSnapshot(candidate),
  };
}

function outputBundleText(
  plan: NonNullable<ReturnType<typeof resolveManifest>['manifest']['output']['plan']>,
  primaryContent = '# Complete primary deliverable\n\nEvidence-aware final content.',
): string {
  return JSON.stringify({
    primary: {
      name: plan.primaryDeliverable,
      content: primaryContent,
    },
    supporting: plan.supportingArtifacts.map((name, index) => ({
      name,
      content: `# ${name}\n\nSupporting artifact ${index + 1}.`,
    })),
    quality: plan.qualityCriteria.map((criterion) => ({
      criterion,
      status: 'met',
      evidence: `Verified against the generated deliverables: ${criterion}`,
    })),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-scenario-workflow-'));
  store = new PersistenceStore(path.join(root, 'workflow.db'));
  store.createSession('session-1');
  repository = new PersonalizationRepository(store.raw);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runPersistedScenarioWorkflow', () => {
  it('routes a single-step scenario through the persisted workflow engine', () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    expect(resolved.manifest.workflow).toHaveLength(1);
    expect(hasExecutableScenarioWorkflow(resolved.manifest)).toBe(true);
    expect(hasExecutableScenarioWorkflow({ ...resolved.manifest, workflow: [] })).toBe(false);
  });

  it('executes every real DAG step and persists its configured output bundle as reusable artifacts', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const manifest = withOutputPlan(resolved);
    const plan = manifest.output.plan!;
    const run = vi.fn().mockImplementation((request: { requestId: string; messages: ChatMessage[] }) => Promise.resolve(
      completedResult(request.messages.at(-1)?.content.includes('# Required output bundle')
        ? outputBundleText(plan)
        : `result:${request.requestId}`),
    ));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write a systematic review.' }];

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages,
      requestId: 'workflow-1',
      manifest,
    });

    expect(response.status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(resolved.manifest.workflow.length);
    for (const [index, call] of run.mock.calls.entries()) {
      const step = resolved.manifest.workflow[index];
      expect(call[0]).toMatchObject({
        allowedTools: step?.toolIds,
        maxTurns: step?.maxTurns,
        fullAccess: resolved.manifest.fullAccess,
      });
      expect(call[0].skillPrompt).toContain(`metis-source:${step?.agentId}`);
      for (const otherAgentId of resolved.manifest.agentIds.filter((id) => id !== step?.agentId)) {
        expect(call[0].skillPrompt).not.toContain(`metis-source:${otherAgentId}`);
      }
    }
    expect(repository.listScenarioRunRecords('session-1')).toHaveLength(1);
    const runRecord = repository.listScenarioRunRecords('session-1')[0];
    const finalStepId = runRecord?.executionOrder.at(-1);
    expect(runRecord?.status).toBe('completed');
    const persistedArtifacts = store.listArtifacts('session-1');
    expect(persistedArtifacts).toHaveLength(1 + plan.supportingArtifacts.length + 1);
    expect(persistedArtifacts.every((artifact) => artifact.contentAvailable)).toBe(true);
    expect(runRecord?.steps.find((step) => step.stepId === finalStepId)?.artifactRefs)
      .toHaveLength(persistedArtifacts.length);
    const primary = persistedArtifacts.find((artifact) => artifact.metadata.role === 'primary');
    expect(primary?.name).toContain(plan.primaryDeliverable.slice(0, 24));
    expect(store.getArtifactContent(primary!.id, 'session-1')?.content)
      .toBe('# Complete primary deliverable\n\nEvidence-aware final content.');
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'Write a systematic review.' },
      { role: 'assistant', content: response.answer },
    ]);
    expect(response.answer).toBe('# Complete primary deliverable\n\nEvidence-aware final content.');
  });

  it('fails without an assistant message or artifacts when the final output bundle is malformed', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const manifest = withOutputPlan(resolved);
    expect(manifest.output.plan).toEqual(TEST_OUTPUT_PLAN);
    const run = vi.fn().mockResolvedValue(completedResult('{"primary":{"name":"wrong"}}'));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write a systematic review.' }],
      requestId: 'workflow-invalid-bundle',
      manifest,
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    expect(store.listArtifacts('session-1')).toEqual([]);
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'Write a systematic review.' },
    ]);
    expect(repository.listScenarioRunRecords('session-1')[0]?.status).toBe('failed');
  });

  it('uses the configured retry limit to repair a malformed output bundle before persisting it', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const baseManifest = withOutputPlan(resolved);
    const workflow = baseManifest.workflow.map((step) => ({ ...step, retryLimit: 1 }));
    const candidate = { ...baseManifest, workflow, manifestDigest: '0'.repeat(64) };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const run = vi.fn()
      .mockResolvedValueOnce(completedResult('{"primary":{"name":"wrong"}}'))
      .mockResolvedValueOnce(completedResult(outputBundleText(TEST_OUTPUT_PLAN, '# Repaired result')));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Generate the configured bundle.' }],
      requestId: 'workflow-repair-bundle',
      manifest,
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('# Repaired result');
    expect(run).toHaveBeenCalledTimes(2);
    const repairMessages = run.mock.calls[1]?.[0].messages as ChatMessage[];
    expect(repairMessages.at(-1)?.content).toContain('previous response failed');
    expect(store.listArtifacts('session-1')).toHaveLength(
      1 + TEST_OUTPUT_PLAN.supportingArtifacts.length + 1,
    );
  });

  it('rejects an output plan with multiple terminal workflow steps instead of choosing one arbitrarily', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const baseManifest = withOutputPlan(resolved);
    const baseStep = baseManifest.workflow[0]!;
    const workflow = [
      { ...baseStep, id: 'step-a', name: 'A', dependsOn: [] },
      { ...baseStep, id: 'step-c', name: 'C', dependsOn: ['step-a'] },
      { ...baseStep, id: 'step-b', name: 'B', dependsOn: [] },
    ];
    const candidate = { ...baseManifest, workflow, manifestDigest: '0'.repeat(64) };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const run = vi.fn();

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Run the interleaved DAG.' }],
      requestId: 'workflow-interleaved',
      manifest,
    });

    expect(response.status).toBe('error');
    expect(response.diagnostics[0]?.code).toBe('scenario_output_step_ambiguous');
    expect(run).not.toHaveBeenCalled();
    expect(store.getMessages('session-1')).toEqual([]);
    expect(store.listArtifacts('session-1')).toEqual([]);
  });

  it('uses the Agent model preference and retries only within the frozen step limit', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const workflow = resolved.manifest.workflow.map((step) => ({
      ...step,
      agentModelPreference: 'preferred-research-model',
      retryLimit: 1,
    }));
    const candidate = { ...resolved.manifest, workflow, manifestDigest: '0'.repeat(64) };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const defaultRun = vi.fn();
    const preferredRun = vi.fn()
      .mockResolvedValueOnce({
        ...completedResult(''),
        status: 'error' as const,
        finalText: '',
        finalVerified: false,
      })
      .mockResolvedValueOnce(completedResult('preferred model result'));
    const agentLoopForModel = vi.fn().mockReturnValue({ run: preferredRun });

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run: defaultRun },
      agentLoopForModel,
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Use the preferred model.' }],
      requestId: 'workflow-model',
      manifest,
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('preferred model result');
    expect(agentLoopForModel).toHaveBeenCalledWith('preferred-research-model');
    expect(preferredRun).toHaveBeenCalledTimes(2);
    expect(defaultRun).not.toHaveBeenCalled();
    expect(preferredRun.mock.calls.map((call) => call[0].requestId)).toEqual([
      'workflow-model-research-try-1',
      'workflow-model-research-try-2',
    ]);
  });

  it('applies the configured memory scope to later workflow runs', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn()
      .mockResolvedValueOnce(completedResult('durable prior decision'))
      .mockResolvedValueOnce(completedResult('new decision'));

    const first = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Establish the first decision.' }],
      requestId: 'workflow-memory-one',
      manifest: resolved.manifest,
    });
    expect(first.status).toBe('completed');

    const second = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Continue from prior work.' }],
      requestId: 'workflow-memory-two',
      manifest: resolved.manifest,
    });
    expect(second.status).toBe('completed');
    const secondStepMessages = run.mock.calls[1]?.[0].messages as ChatMessage[];
    expect(secondStepMessages.at(-1)?.content).toContain('# Prior scenario memory');
    expect(secondStepMessages.at(-1)?.content).toContain('durable prior decision');
  });

  it('persists an interrupted record and resumes it with stable execution keys', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn().mockResolvedValue(completedResult('resumed output'));

    const interrupted = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-interrupt',
      manifest: resolved.manifest,
      signal: controller.signal,
    });
    expect(interrupted.status).toBe('interrupted');
    expect(repository.getRecoverableScenarioRun('session-1')?.status).toBe('interrupted');
    expect(run).not.toHaveBeenCalled();

    const resumed = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-resume',
      manifest: resolved.manifest,
      mode: 'regenerate',
    });
    expect(resumed.status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(repository.getRecoverableScenarioRun('session-1')).toBeUndefined();
  });

  it('fails closed without an assistant message when a step is not verified', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockResolvedValue({ ...completedResult('unsafe partial'), finalVerified: false });

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-failure',
      manifest: resolved.manifest,
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    expect(store.getMessages('session-1')).toEqual([{ role: 'user', content: 'Research this question.' }]);
    expect(repository.listScenarioRunRecords('session-1')[0]?.status).toBe('failed');
  });
});
