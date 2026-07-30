import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ResolvedRunManifestSchema,
  ResolvedWorkflowStepSchema,
  type ResolvedRunManifest,
} from '../runtime/PersonalizationRuntimeContract.js';

const RUN_RECORD_VERSION = 1 as const;
const MAX_STEP_OUTPUT_CHARS = 2_000_000;

const SafeRunIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
// eslint-disable-next-line no-control-regex -- runtime records intentionally reject C0/C1 text
const UNSAFE_RECORD_TEXT = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]', 'u');
const SafeRecordTextSchema = z.string().max(4_000).refine(
  (value) => !UNSAFE_RECORD_TEXT.test(value),
  'Record text contains control characters',
);

const ArtifactReferenceSchema = z.strictObject({
  id: z.string().min(1).max(256),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: DigestSchema,
});

const ScenarioStepExecutionSuccessSchema = z.strictObject({
  ok: z.literal(true),
  output: z.unknown(),
  outputDigest: DigestSchema,
  artifactRefs: z.array(ArtifactReferenceSchema).max(256),
});

const ScenarioStepExecutionFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/u),
  message: SafeRecordTextSchema,
});

export const ScenarioStepExecutionResultSchema = z.discriminatedUnion('ok', [
  ScenarioStepExecutionSuccessSchema,
  ScenarioStepExecutionFailureSchema,
]);

export type ScenarioStepExecutionResult = z.infer<typeof ScenarioStepExecutionResultSchema>;
export type ScenarioArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

const ScenarioStepRunRecordSchema = z.strictObject({
  stepId: z.string().min(1).max(160),
  executionKey: DigestSchema,
  stepSnapshot: ResolvedWorkflowStepSchema,
  stepSnapshotDigest: DigestSchema,
  status: z.enum(['pending', 'running', 'completed', 'failed', 'blocked']),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  completedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  output: z.unknown().nullable(),
  outputDigest: DigestSchema.nullable(),
  artifactRefs: z.array(ArtifactReferenceSchema).max(256),
  errorCode: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/u).nullable(),
  errorMessage: SafeRecordTextSchema.nullable(),
});

export const ScenarioRunRecordSchema = z.strictObject({
  recordVersion: z.literal(RUN_RECORD_VERSION),
  runId: SafeRunIdSchema,
  manifestSnapshot: ResolvedRunManifestSchema,
  manifestDigest: DigestSchema,
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  completedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  executionOrder: z.array(z.string().min(1).max(160)).max(128),
  steps: z.array(ScenarioStepRunRecordSchema).max(128),
  failureStepIds: z.array(z.string().min(1).max(160)).max(128),
});

export type ScenarioRunRecord = z.infer<typeof ScenarioRunRecordSchema>;
export type ScenarioStepRunRecord = z.infer<typeof ScenarioStepRunRecordSchema>;

export interface ScenarioStepExecutionInput {
  runId: string;
  executionKey: string;
  sessionId: string;
  projectId: string;
  scenarioId: string;
  manifestDigest: string;
  step: ScenarioStepRunRecord['stepSnapshot'];
  dependencyOutputs: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export type ScenarioStepExecutor = (
  input: ScenarioStepExecutionInput,
) => Promise<unknown>;

export interface StartScenarioRunRequest {
  runId: string;
  manifest: ResolvedRunManifest;
  signal?: AbortSignal;
}

export interface ScenarioRunCoordinatorOptions {
  executor: ScenarioStepExecutor;
  now?: () => number;
  /** Durable, synchronous checkpoint sink invoked before and after every side-effecting step. */
  onCheckpoint?: (record: ScenarioRunRecord) => void;
}

export type ScenarioRunStartResult =
  | { ok: true; record: ScenarioRunRecord }
  | {
      ok: false;
      code: 'invalid_manifest' | 'invalid_dag' | 'invalid_snapshot' | 'invalid_record';
      issues: string[];
    };

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers are not serializable');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('Step output is not JSON serializable');
  if (seen.has(value)) throw new Error('Step output contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Step output must contain plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`,
    ).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestScenarioStepOutput(output: unknown): string {
  const canonical = canonicalJson(output);
  if (canonical.length > MAX_STEP_OUTPUT_CHARS) throw new Error('Step output exceeds the run-record limit');
  return sha256(canonical);
}

export function digestResolvedManifestSnapshot(manifest: ResolvedRunManifest): string {
  const { manifestDigest: _manifestDigest, ...withoutDigest } = manifest;
  void _manifestDigest;
  return sha256(canonicalJson(withoutDigest));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function topologicalOrder(manifest: ResolvedRunManifest): { order?: string[]; issues: string[] } {
  const steps = manifest.workflow;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const issues: string[] = [];

  if (manifest.truthPolicy !== 'automatic_required') {
    issues.push('Scenario run requires the automatic truth policy');
  }
  if (manifest.definitionRevisions[manifest.scenarioId] !== manifest.scenarioRevision) {
    issues.push('Scenario revision is not bound to the manifest snapshot');
  }
  if (steps.length === 0) issues.push('Executable scenario workflow cannot be empty');
  for (const definitionId of [...manifest.agentIds, ...manifest.skillIds, ...manifest.mcpIds]) {
    if (manifest.definitionRevisions[definitionId] === undefined) {
      issues.push(`Definition revision is missing: ${definitionId}`);
    }
  }

  for (const step of steps) {
    if (!manifest.agentIds.includes(step.agentId)) {
      issues.push(`Step ${step.id} references an agent outside the manifest`);
    }
    if (manifest.definitionRevisions[step.agentId] === undefined) {
      issues.push(`Step ${step.id} agent revision is missing`);
    }
    for (const skillId of step.skillIds) {
      if (!manifest.skillIds.includes(skillId) || manifest.definitionRevisions[skillId] === undefined) {
        issues.push(`Step ${step.id} references an unbound skill: ${skillId}`);
      }
    }
    for (const mcpId of step.mcpIds) {
      if (!manifest.mcpIds.includes(mcpId) || manifest.definitionRevisions[mcpId] === undefined) {
        issues.push(`Step ${step.id} references an unbound MCP server: ${mcpId}`);
      }
    }
    for (const toolId of step.toolIds) {
      if (!manifest.allowedTools.includes(toolId)) {
        issues.push(`Step ${step.id} references a tool outside the manifest: ${toolId}`);
      }
    }
    if (step.maxTurns > manifest.maxTurns) {
      issues.push(`Step ${step.id} exceeds the manifest turn budget`);
    }
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) issues.push(`Step ${step.id} dependency is missing: ${dependency}`);
    }
  }
  if (issues.length > 0) return { issues };

  const indegree = new Map<string, number>();
  const dependants = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, step.dependsOn.length);
    for (const dependency of step.dependsOn) {
      const children = dependants.get(dependency) ?? [];
      children.push(step.id);
      dependants.set(dependency, children);
    }
  }
  const originalIndex = new Map(steps.map((step, index) => [step.id, index]));
  const ready = steps.filter((step) => step.dependsOn.length === 0).map((step) => step.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0));
    const stepId = ready.shift();
    if (!stepId) break;
    order.push(stepId);
    for (const child of dependants.get(stepId) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  if (order.length !== steps.length) return { issues: ['Workflow contains a dependency cycle'] };
  return { order, issues: [] };
}

function dependencyClosure(manifest: ResolvedRunManifest, failedIds: Set<string>): Set<string> {
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of manifest.workflow) {
      if (blocked.has(step.id) || failedIds.has(step.id)) continue;
      if (step.dependsOn.some((dependency) => failedIds.has(dependency) || blocked.has(dependency))) {
        blocked.add(step.id);
        changed = true;
      }
    }
  }
  return blocked;
}

function validateManifest(raw: unknown): { manifest?: ResolvedRunManifest; order?: string[]; issues: string[] } {
  const parsed = ResolvedRunManifestSchema.safeParse(raw);
  if (!parsed.success) return { issues: ['Manifest failed strict schema validation'] };
  let digest: string;
  try {
    digest = digestResolvedManifestSnapshot(parsed.data);
  } catch {
    return { issues: ['Manifest is not canonically serializable'] };
  }
  if (digest !== parsed.data.manifestDigest) return { issues: ['Manifest digest mismatch'] };
  const topology = topologicalOrder(parsed.data);
  return topology.order
    ? { manifest: parsed.data, order: topology.order, issues: [] }
    : { issues: topology.issues };
}

/** Returns the exact stable order used by the coordinator, or undefined for an invalid manifest. */
export function resolveScenarioExecutionOrder(raw: unknown): string[] | undefined {
  return validateManifest(raw).order;
}

export class ScenarioRunCoordinator {
  readonly #executor: ScenarioStepExecutor;
  readonly #now: () => number;
  readonly #onCheckpoint?: (record: ScenarioRunRecord) => void;

  constructor(options: ScenarioRunCoordinatorOptions) {
    this.#executor = options.executor;
    this.#now = options.now ?? Date.now;
    this.#onCheckpoint = options.onCheckpoint;
  }

  async start(request: StartScenarioRunRequest): Promise<ScenarioRunStartResult> {
    const runIdResult = SafeRunIdSchema.safeParse(request.runId);
    if (!runIdResult.success) return { ok: false, code: 'invalid_snapshot', issues: ['Invalid run ID'] };
    const validation = validateManifest(request.manifest);
    if (!validation.manifest || !validation.order) {
      const code = validation.issues.some((issue) => issue.includes('cycle') || issue.includes('dependency'))
        ? 'invalid_dag'
        : 'invalid_manifest';
      return { ok: false, code, issues: validation.issues };
    }

    const startedAt = this.#now();
    const record: ScenarioRunRecord = ScenarioRunRecordSchema.parse({
      recordVersion: RUN_RECORD_VERSION,
      runId: runIdResult.data,
      manifestSnapshot: cloneJson(validation.manifest),
      manifestDigest: validation.manifest.manifestDigest,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      executionOrder: validation.order,
      steps: validation.manifest.workflow.map((step) => {
        const stepSnapshot = cloneJson(step);
        const stepSnapshotDigest = sha256(canonicalJson(stepSnapshot));
        return {
          stepId: step.id,
          executionKey: sha256(`${runIdResult.data}:${validation.manifest?.manifestDigest}:${stepSnapshotDigest}`),
          stepSnapshot,
          stepSnapshotDigest,
          status: 'pending' as const,
          startedAt: null,
          completedAt: null,
          output: null,
          outputDigest: null,
          artifactRefs: [],
          errorCode: null,
          errorMessage: null,
        };
      }),
      failureStepIds: [],
    });
    return this.#execute(record, request.signal);
  }

  async resume(rawRecord: unknown, signal?: AbortSignal): Promise<ScenarioRunStartResult> {
    const parsed = ScenarioRunRecordSchema.safeParse(rawRecord);
    if (!parsed.success) return { ok: false, code: 'invalid_record', issues: ['Run record failed strict validation'] };
    const record = cloneJson(parsed.data);
    const validation = validateManifest(record.manifestSnapshot);
    if (!validation.manifest || !validation.order || record.manifestDigest !== validation.manifest.manifestDigest) {
      return { ok: false, code: 'invalid_record', issues: validation.issues.length > 0 ? validation.issues : ['Run manifest binding mismatch'] };
    }
    if (!['interrupted', 'running'].includes(record.status)) {
      return { ok: false, code: 'invalid_record', issues: ['Only interrupted or running records can resume'] };
    }
    if (record.executionOrder.join('\u0000') !== validation.order.join('\u0000')) {
      return { ok: false, code: 'invalid_record', issues: ['Run execution order mismatch'] };
    }
    const manifestSteps = new Map(record.manifestSnapshot.workflow.map((step) => [step.id, step]));
    if (record.steps.length !== manifestSteps.size) {
      return { ok: false, code: 'invalid_record', issues: ['Run step set does not match the manifest'] };
    }
    const actualFailureIds = record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId).sort();
    if (actualFailureIds.join('\u0000') !== [...record.failureStepIds].sort().join('\u0000')) {
      return { ok: false, code: 'invalid_record', issues: ['Run failure index does not match step records'] };
    }
    const expectedBlockedIds = dependencyClosure(record.manifestSnapshot, new Set(actualFailureIds));
    for (const blockedStep of record.steps.filter((step) => step.status === 'blocked')) {
      if (!expectedBlockedIds.has(blockedStep.stepId)) {
        return { ok: false, code: 'invalid_record', issues: [`Blocked step has no failed dependency: ${blockedStep.stepId}`] };
      }
    }
    for (const stepRecord of record.steps) {
      const manifestStep = manifestSteps.get(stepRecord.stepId);
      if (!manifestStep || canonicalJson(manifestStep) !== canonicalJson(stepRecord.stepSnapshot)) {
        return { ok: false, code: 'invalid_record', issues: [`Step is not bound to the manifest: ${stepRecord.stepId}`] };
      }
      const actualStepDigest = sha256(canonicalJson(stepRecord.stepSnapshot));
      if (actualStepDigest !== stepRecord.stepSnapshotDigest) {
        return { ok: false, code: 'invalid_record', issues: [`Step snapshot mismatch: ${stepRecord.stepId}`] };
      }
      const expectedExecutionKey = sha256(`${record.runId}:${record.manifestDigest}:${actualStepDigest}`);
      if (stepRecord.executionKey !== expectedExecutionKey) {
        return { ok: false, code: 'invalid_record', issues: [`Step execution key mismatch: ${stepRecord.stepId}`] };
      }
      if (stepRecord.status === 'completed') {
        let completedDigest: string;
        try {
          completedDigest = digestScenarioStepOutput(stepRecord.output);
        } catch {
          return { ok: false, code: 'invalid_record', issues: [`Completed step output mismatch: ${stepRecord.stepId}`] };
        }
        if (stepRecord.outputDigest === null || completedDigest !== stepRecord.outputDigest) {
          return { ok: false, code: 'invalid_record', issues: [`Completed step output mismatch: ${stepRecord.stepId}`] };
        }
      }
      if (stepRecord.status === 'running') {
        // executionKey is stable across retries; real executors must use it as their
        // idempotency key before repeating an uncertain, crash-interrupted operation.
        stepRecord.status = 'pending';
        stepRecord.startedAt = null;
      }
    }
    record.status = 'running';
    record.completedAt = null;
    return this.#execute(record, signal);
  }

  async #execute(record: ScenarioRunRecord, signal?: AbortSignal): Promise<ScenarioRunStartResult> {
    const stepById = new Map(record.steps.map((step) => [step.stepId, step]));
    const manifest = record.manifestSnapshot;
    const initialCheckpoint = this.#checkpoint(record);
    if (initialCheckpoint) return initialCheckpoint;

    for (const stepId of record.executionOrder) {
      const stepRecord = stepById.get(stepId);
      if (!stepRecord || stepRecord.status === 'completed' || stepRecord.status === 'failed' || stepRecord.status === 'blocked') {
        continue;
      }
      if (signal?.aborted) {
        record.status = 'interrupted';
        record.updatedAt = this.#now();
        const checkpointFailure = this.#checkpoint(record);
        if (checkpointFailure) return checkpointFailure;
        return { ok: true, record: ScenarioRunRecordSchema.parse(record) };
      }

      const failedIds = new Set(record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId));
      const blockedIds = dependencyClosure(manifest, failedIds);
      if (blockedIds.has(stepId)) {
        stepRecord.status = 'blocked';
        stepRecord.completedAt = this.#now();
        stepRecord.errorCode = 'dependency_failed';
        stepRecord.errorMessage = 'A required upstream step failed';
        continue;
      }

      const dependencies = Object.fromEntries(stepRecord.stepSnapshot.dependsOn.map((dependencyId) => {
        const dependency = stepById.get(dependencyId);
        return [dependencyId, dependency?.output ?? null];
      }));
      stepRecord.status = 'running';
      stepRecord.startedAt = this.#now();
      record.updatedAt = stepRecord.startedAt;
      const runningCheckpointFailure = this.#checkpoint(record);
      if (runningCheckpointFailure) return runningCheckpointFailure;

      let rawResult: unknown;
      try {
        rawResult = await this.#executor({
          runId: record.runId,
          executionKey: stepRecord.executionKey,
          sessionId: manifest.sessionId,
          projectId: manifest.projectId,
          scenarioId: manifest.scenarioId,
          manifestDigest: manifest.manifestDigest,
          step: cloneJson(stepRecord.stepSnapshot),
          dependencyOutputs: cloneJson(dependencies),
          signal,
        });
      } catch (error) {
        rawResult = {
          ok: false,
          code: 'executor_error',
          message: error instanceof Error ? error.message.slice(0, 4_000) : 'Step executor failed',
        };
      }

      if (signal?.aborted) {
        record.status = 'interrupted';
        record.updatedAt = this.#now();
        // Keep the step as running. On resume the same stable executionKey is supplied again,
        // allowing an idempotent real executor to recover an uncertain completion safely.
        const checkpointFailure = this.#checkpoint(record);
        if (checkpointFailure) return checkpointFailure;
        return { ok: true, record: ScenarioRunRecordSchema.parse(record) };
      }

      const result = ScenarioStepExecutionResultSchema.safeParse(rawResult);
      if (!result.success) {
        stepRecord.status = 'failed';
        stepRecord.errorCode = 'invalid_executor_result';
        stepRecord.errorMessage = 'Step executor returned an invalid result';
        stepRecord.completedAt = this.#now();
        record.failureStepIds.push(stepId);
        const checkpointFailure = this.#checkpoint(record);
        if (checkpointFailure) return checkpointFailure;
        continue;
      }
      if (!result.data.ok) {
        stepRecord.status = 'failed';
        stepRecord.errorCode = result.data.code;
        stepRecord.errorMessage = result.data.message;
        stepRecord.completedAt = this.#now();
        record.failureStepIds.push(stepId);
        const checkpointFailure = this.#checkpoint(record);
        if (checkpointFailure) return checkpointFailure;
        continue;
      }

      let actualDigest: string;
      try {
        actualDigest = digestScenarioStepOutput(result.data.output);
      } catch {
        stepRecord.status = 'failed';
        stepRecord.errorCode = 'invalid_step_output';
        stepRecord.errorMessage = 'Step output is not bounded canonical JSON';
        stepRecord.completedAt = this.#now();
        record.failureStepIds.push(stepId);
        const checkpointFailure = this.#checkpoint(record);
        if (checkpointFailure) return checkpointFailure;
        continue;
      }
      if (actualDigest !== result.data.outputDigest) {
        stepRecord.status = 'failed';
        stepRecord.errorCode = 'output_digest_mismatch';
        stepRecord.errorMessage = 'Step output digest did not match the returned output';
        stepRecord.completedAt = this.#now();
        record.failureStepIds.push(stepId);
        const checkpointFailure = this.#checkpoint(record);
        if (checkpointFailure) return checkpointFailure;
        continue;
      }

      stepRecord.status = 'completed';
      stepRecord.output = cloneJson(result.data.output);
      stepRecord.outputDigest = actualDigest;
      stepRecord.artifactRefs = cloneJson(result.data.artifactRefs);
      stepRecord.completedAt = this.#now();
      record.updatedAt = stepRecord.completedAt;
      const completedCheckpointFailure = this.#checkpoint(record);
      if (completedCheckpointFailure) return completedCheckpointFailure;
    }

    const failedIds = new Set(record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId));
    const blockedIds = dependencyClosure(manifest, failedIds);
    for (const blockedId of blockedIds) {
      const step = stepById.get(blockedId);
      if (step && step.status === 'pending') {
        step.status = 'blocked';
        step.completedAt = this.#now();
        step.errorCode = 'dependency_failed';
        step.errorMessage = 'A required upstream step failed';
      }
    }
    record.failureStepIds = record.steps
      .filter((step) => step.status === 'failed')
      .map((step) => step.stepId);
    record.status = record.failureStepIds.length > 0 ? 'failed' : 'completed';
    record.completedAt = this.#now();
    record.updatedAt = record.completedAt;
    const finalCheckpointFailure = this.#checkpoint(record);
    if (finalCheckpointFailure) return finalCheckpointFailure;
    return { ok: true, record: ScenarioRunRecordSchema.parse(record) };
  }

  #checkpoint(record: ScenarioRunRecord): ScenarioRunStartResult | undefined {
    if (!this.#onCheckpoint) return undefined;
    try {
      this.#onCheckpoint(cloneJson(ScenarioRunRecordSchema.parse(record)));
      return undefined;
    } catch {
      return {
        ok: false,
        code: 'invalid_record',
        issues: ['Run checkpoint persistence failed'],
      };
    }
  }
}
