import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import {
  ScenarioRunControlRequestSchema,
  ScenarioRunControlResponseSchema,
  decodeScenarioRunControlResponse,
} from '../../engine/runtime/ScenarioControlContract.js';
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
  return result.manifest;
}

function runTurn(options: {
  run: ReturnType<typeof vi.fn>;
  requestId: string;
  manifest: ReturnType<typeof resolveManifest>;
  pauseSignal?: AbortSignal;
  cancelSignal?: AbortSignal;
}) {
  const messages: ChatMessage[] = [{ role: 'user', content: `Turn ${options.requestId}` }];
  return runPersistedScenarioWorkflow({
    agentLoop: { run: options.run },
    store,
    repository,
    sessionId: 'session-1',
    messages,
    requestId: options.requestId,
    manifest: options.manifest,
    pauseSignal: options.pauseSignal,
    cancelSignal: options.cancelSignal,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-scenario-control-service-'));
  store = new PersistenceStore(path.join(root, 'service.db'));
  store.createSession('session-1');
  repository = new PersonalizationRepository(store.raw);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('public Scenario pause/cancel over the persisted workflow', () => {
  it('pauses before executing work and the next turn resumes the paused checkpoint to completion', async () => {
    const manifest = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockImplementation(() => Promise.resolve(completedResult('# Resumed final deliverable')));
    const pauseController = new AbortController();
    pauseController.abort();

    const pausedResponse = await runTurn({
      run,
      requestId: 'pause-turn',
      manifest,
      pauseSignal: pauseController.signal,
    });

    // Nothing executed, nothing answered: the pause is durable state instead.
    expect(pausedResponse.status).toBe('interrupted');
    expect(pausedResponse.diagnostics.some((item) => item.code === 'scenario_run_paused')).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(repository.getRecoverableScenarioRun(manifest.sessionId)?.status).toBe('paused');
    expect(store.getMessages('session-1')).toEqual([{ role: 'user', content: 'Turn pause-turn' }]);

    const resumedResponse = await runTurn({ run, requestId: 'resume-turn', manifest });

    expect(resumedResponse.status).toBe('completed');
    expect(resumedResponse.answer).toBe('# Resumed final deliverable');
    expect(run).toHaveBeenCalledTimes(1);
    const record = repository.listScenarioRunRecords('session-1')[0];
    expect(record?.status).toBe('completed');
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'Turn pause-turn' },
      { role: 'user', content: 'Turn resume-turn' },
      { role: 'assistant', content: '# Resumed final deliverable' },
    ]);
  });

  it('cancel persists a terminal cancelled run that later turns cannot revive', async () => {
    const manifest = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockImplementation(() => Promise.resolve(completedResult('late provider output')));
    const cancelController = new AbortController();
    cancelController.abort();

    const cancelledResponse = await runTurn({
      run,
      requestId: 'cancel-turn',
      manifest,
      cancelSignal: cancelController.signal,
    });

    expect(cancelledResponse.status).toBe('cancelled');
    expect(cancelledResponse.diagnostics.some((item) => item.code === 'scenario_run_cancelled')).toBe(true);
    expect(run).not.toHaveBeenCalled();
    const record = repository.listScenarioRunRecords('session-1').at(-1);
    expect(record?.status).toBe('cancelled');
    expect(record?.completedAt).not.toBeNull();
    // Cancelled runs are never offered as recoverable work.
    expect(repository.getRecoverableScenarioRun(manifest.sessionId)).toBeUndefined();
    expect(store.getMessages('session-1')).toEqual([{ role: 'user', content: 'Turn cancel-turn' }]);

    // The next turn cannot resume the cancelled run; it starts fresh work while
    // the cancelled record itself stays immutable under its own runId.
    const followup = await runTurn({ run, requestId: 'after-cancel-turn', manifest });
    expect(followup.status).toBe('completed');
    expect(repository.getScenarioRunRecord(record!.runId)?.status).toBe('cancelled');
    expect(repository.getRecoverableScenarioRun(manifest.sessionId)).toBeUndefined();
    const statuses = repository.listScenarioRunRecords('session-1').map((item) => item.status);
    expect(statuses).toContain('cancelled');
    expect(statuses).toContain('completed');
  });
});

describe('ScenarioRunControl contract schema', () => {
  it('accepts well-formed control requests and rejects malformed ones', () => {
    const validPause = ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'op-pause-1',
      sessionId: 'session-1',
      action: 'pause',
    });
    expect(validPause.success).toBe(true);
    const validCancel = ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'op-cancel-1',
      sessionId: 'session-1',
      action: 'cancel',
      reason: 'user requested stop',
    });
    expect(validCancel.success).toBe(true);
    expect(ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 2,
      operationId: 'op-2',
      sessionId: 'session-1',
      action: 'pause',
    }).success).toBe(false);
    expect(ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'op-3',
      sessionId: 'session-1',
      action: 'rewind',
    }).success).toBe(false);
  });

  it('decodes responses defensively so a malformed reply cannot crash the renderer', () => {
    const parsed = ScenarioRunControlResponseSchema.safeParse({
      ok: true,
      contractVersion: 1,
      operationId: 'op-1',
      action: 'pause',
      code: 'pause_requested',
    });
    expect(parsed.success).toBe(true);
    const fallback = decodeScenarioRunControlResponse(null, 'op-fallback');
    expect(fallback).toEqual({
      ok: false,
      contractVersion: 1,
      operationId: 'op-fallback',
      code: 'scenario_control_unavailable',
    });
  });
});
