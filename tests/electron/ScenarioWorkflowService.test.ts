import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { AgentRunResult, ChatMessage } from '../../engine/core/types.js';
import { runPersistedScenarioWorkflow } from '../../electron/ScenarioWorkflowService.js';

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
  it('executes every real DAG step, checkpoints it, and persists only the final answer', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const run = vi.fn().mockImplementation((request: { requestId: string }) => Promise.resolve(
      completedResult(`result:${request.requestId}`),
    ));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write a systematic review.' }];

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages,
      requestId: 'workflow-1',
      manifest: resolved.manifest,
      systemPrompt: resolved.systemPrompt,
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
    }
    expect(repository.listScenarioRunRecords('session-1')).toHaveLength(1);
    expect(repository.listScenarioRunRecords('session-1')[0]?.status).toBe('completed');
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'Write a systematic review.' },
      { role: 'assistant', content: response.answer },
    ]);
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
      systemPrompt: resolved.systemPrompt,
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
      systemPrompt: resolved.systemPrompt,
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
      systemPrompt: resolved.systemPrompt,
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    expect(store.getMessages('session-1')).toEqual([{ role: 'user', content: 'Research this question.' }]);
    expect(repository.listScenarioRunRecords('session-1')[0]?.status).toBe('failed');
  });
});
