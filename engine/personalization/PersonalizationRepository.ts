import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  McpDefinitionSchema,
  PersonalizationDefinitionSchema,
  ResolvedRunManifestSchema,
  type PersonalizationDefinition,
  type McpDefinition,
  type PersonalizationMutationResult,
  type PersonalizationSaveRequest,
  type ResolvedRunManifest,
} from '../runtime/PersonalizationRuntimeContract.js';
import {
  ScenarioRunRecordSchema,
  type ScenarioRunRecord,
} from './ScenarioRunCoordinator.js';
import {
  PersonalizationBundleAssetBindingSchema,
  type PersonalizationBundleAssetBinding,
} from '../runtime/PersonalizationBundleContract.js';
import {
  EvidenceEnvelopeSchema,
  type EvidenceEnvelope,
} from '../runtime/EvidenceEnvelopeContract.js';
import {
  McpActivationEvidencePayloadSchema,
  McpActivationPersistenceInputSchema,
  type McpActivationPersistenceInput,
} from '../runtime/McpActivationContract.js';

interface DefinitionRow {
  id: string;
  kind: PersonalizationDefinition['kind'];
  origin: PersonalizationDefinition['provenance']['origin'];
  current_revision: number;
  factory_json: string | null;
  current_json: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface PersonalizationVersionView {
  id: string;
  revision: number;
  contentDigest: string;
  definition: PersonalizationDefinition;
  createdAt: number;
}

const PERSONALIZATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS personalization_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  factory_json TEXT,
  current_json TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_kind
  ON personalization_definitions(kind, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS personalization_versions (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision),
  FOREIGN KEY (id) REFERENCES personalization_definitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS personalization_run_manifests (
  manifest_digest TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  integrity_tag TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_run_session
  ON personalization_run_manifests(session_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS personalization_scenario_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_tag TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_scenario_run_session
  ON personalization_scenario_runs(session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS personalization_asset_bindings (
  owner_id TEXT PRIMARY KEY,
  directory_token TEXT NOT NULL,
  relative_root TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES personalization_definitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS personalization_evidence_envelopes (
  envelope_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  source_definition_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_evidence_session
  ON personalization_evidence_envelopes(session_id, observed_at DESC);
`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function digestDefinition(definition: PersonalizationDefinition): string {
  return createHash('sha256').update(canonicalJson(definition), 'utf8').digest('hex');
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function stableEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validMcpActivationTransition(input: McpActivationPersistenceInput): boolean {
  const { previousDefinition: previous, activatedDefinition: activated, installation, envelope, owner } = input;
  const sourceMatches = (previous.sourceMode === 'url'
      && activated.sourceMode === 'url'
      && previous.id.startsWith('url:mcp/')
      && previous.provenance.origin === 'url'
      && activated.provenance.origin === 'url'
      && previous.sourceUrl !== null)
    || (previous.sourceMode === 'generated'
      && activated.sourceMode === 'generated'
      && previous.id.startsWith('generated:mcp/')
      && previous.provenance.origin === 'generated'
      && activated.provenance.origin === 'generated'
      && previous.sourceUrl === null);
  if (previous.id !== activated.id || !sourceMatches
    || previous.enabled || !activated.enabled || previous.revision + 1 !== activated.revision
    || previous.args.length !== 1 || previous.args[0] !== installation.installationId
    || previous.workingDirectoryToken !== installation.installationId
    || previous.provenance.sourceRevision !== installation.installationId
    || previous.provenance.installedDigest !== installation.packageSha256
    || previous.name !== installation.packageId || previous.provenance.version !== installation.packageVersion
    || installation.state !== 'enabled' || !installation.enabled || installation.probedAt === null
    || installation.failureCode !== null || installation.exposedTools.length === 0
    || !sameStringArray(activated.exposedTools, installation.exposedTools)
    || previous.exposedTools.length !== 0
    || !previous.tags.includes('pending-probe') || previous.tags.includes('probe-verified')
    || activated.tags.includes('pending-probe') || !activated.tags.includes('probe-verified')
    || Object.keys(previous.environment).length !== 0
    || Object.values(activated.environment).some((entry) => entry.secret !== true || entry.value !== null)) return false;
  const previousPreservedTags = previous.tags.filter((tag) => tag !== 'pending-probe' && tag !== 'probe-verified');
  const activatedPreservedTags = activated.tags.filter((tag) => tag !== 'pending-probe' && tag !== 'probe-verified');
  if (!sameStringArray(previousPreservedTags, activatedPreservedTags)) return false;

  const {
    enabled: _previousEnabled,
    tags: _previousTags,
    revision: _previousRevision,
    provenance: previousProvenance,
    environment: _previousEnvironment,
    exposedTools: _previousTools,
    ...previousIdentity
  } = previous;
  const {
    enabled: _activatedEnabled,
    tags: _activatedTags,
    revision: _activatedRevision,
    provenance: activatedProvenance,
    environment: _activatedEnvironment,
    exposedTools: _activatedTools,
    ...activatedIdentity
  } = activated;
  void _previousEnabled;
  void _previousTags;
  void _previousRevision;
  void _previousEnvironment;
  void _previousTools;
  void _activatedEnabled;
  void _activatedTags;
  void _activatedRevision;
  void _activatedEnvironment;
  void _activatedTools;
  const { updatedAt: _previousUpdatedAt, ...previousProvenanceIdentity } = previousProvenance;
  const { updatedAt: _activatedUpdatedAt, ...activatedProvenanceIdentity } = activatedProvenance;
  void _previousUpdatedAt;
  if (!stableEqual(previousIdentity, activatedIdentity)
    || !stableEqual(previousProvenanceIdentity, activatedProvenanceIdentity)
    || _activatedUpdatedAt < previous.provenance.updatedAt) return false;

  if (envelope.sourceDefinitionId !== activated.id
    || envelope.sourceDefinitionRevision !== activated.revision
    || envelope.sourceKind !== 'mcp' || envelope.sourceUrl !== activated.sourceUrl || envelope.locator !== null
    || envelope.payload.kind !== 'json' || envelope.payloadDigest !== sha256Canonical(envelope.payload)
    || envelope.truth.state !== 'unverified' || envelope.truth.reviewStatus !== 'pending'
    || envelope.truth.correctionState !== 'unknown' || envelope.truth.claimEligible !== false
    || envelope.truth.publishEligible !== false) return false;
  let payloadRaw: unknown;
  try { payloadRaw = JSON.parse(envelope.payload.canonicalJson) as unknown; } catch { return false; }
  const payload = McpActivationEvidencePayloadSchema.safeParse(payloadRaw);
  if (!payload.success || envelope.payload.canonicalJson !== canonicalJson(payload.data)) return false;
  return payload.data.definitionId === activated.id
    && payload.data.installationId === installation.installationId
    && payload.data.packageId === installation.packageId
    && payload.data.packageVersion === installation.packageVersion
    && payload.data.packageDigest === installation.packageSha256
    && payload.data.manifestDigest === installation.manifestSha256
    && payload.data.priorRevision === previous.revision
    && payload.data.activatedRevision === activated.revision
    && sameStringArray(payload.data.exposedTools, installation.exposedTools)
    && stableEqual(payload.data.owner, owner);
}

function scenarioRunIntegrityTag(secret: Buffer, record: ScenarioRunRecord): string {
  return createHmac('sha256', secret)
    .update('metis:personalization-scenario-run:v1\0')
    .update(canonicalJson(record), 'utf8')
    .digest('hex');
}

function verifiesScenarioRun(secret: Buffer, record: ScenarioRunRecord, tag: string | null): boolean {
  if (!tag || !/^[a-f0-9]{64}$/u.test(tag)) return false;
  const expected = Buffer.from(scenarioRunIntegrityTag(secret, record), 'hex');
  const actual = Buffer.from(tag, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseDefinition(raw: string): PersonalizationDefinition {
  const parsedJson: unknown = JSON.parse(raw);
  return PersonalizationDefinitionSchema.parse(parsedJson);
}

function referencedDefinitionIds(definition: PersonalizationDefinition): string[] {
  switch (definition.kind) {
    case 'scenario':
      return [
        ...definition.agentIds,
        ...definition.skillIds,
        ...definition.mcpIds,
        ...definition.rulesIds,
        ...definition.workflow.flatMap((step) => [step.agentId, ...step.skillIds, ...step.mcpIds]),
      ];
    case 'agent':
      return [...definition.skillIds, ...definition.mcpIds];
    case 'skill':
      return [...definition.mcpIds];
    case 'mcp':
    case 'rules':
      return [];
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertRunProgression(previous: ScenarioRunRecord, next: ScenarioRunRecord): void {
  if (next.startedAt !== previous.startedAt || next.updatedAt < previous.updatedAt) {
    throw new Error('Scenario run timestamps cannot move backwards');
  }
  if (previous.status === 'completed' || previous.status === 'failed') {
    if (canonicalJson(previous) !== canonicalJson(next)) {
      throw new Error('Terminal scenario run records are immutable');
    }
    return;
  }
  const nextById = new Map(next.steps.map((step) => [step.stepId, step]));
  for (const previousStep of previous.steps) {
    const nextStep = nextById.get(previousStep.stepId);
    if (!nextStep) throw new Error('Scenario run steps cannot be removed');
    if (['completed', 'failed', 'blocked'].includes(previousStep.status)) {
      if (canonicalJson(previousStep) !== canonicalJson(nextStep)) {
        throw new Error('Terminal scenario step records are immutable');
      }
      continue;
    }
    const allowed = previousStep.status === 'pending'
      ? ['pending', 'running', 'completed', 'failed', 'blocked']
      : ['running', 'completed', 'failed'];
    const resumingUncertainStep = previous.status === 'interrupted'
      && previousStep.status === 'running'
      && next.status === 'running'
      && nextStep.status === 'pending'
      && nextStep.executionKey === previousStep.executionKey;
    if (!allowed.includes(nextStep.status) && !resumingUncertainStep) {
      throw new Error('Scenario step status cannot move backwards');
    }
  }
}

export class PersonalizationRepository {
  readonly #db: Database.Database;
  readonly #scenarioRunIntegritySecret: Buffer;

  constructor(db: Database.Database, scenarioRunIntegritySecret?: Buffer) {
    this.#db = db;
    this.#scenarioRunIntegritySecret = scenarioRunIntegritySecret && scenarioRunIntegritySecret.length >= 32
      ? Buffer.from(scenarioRunIntegritySecret)
      : randomBytes(32);
    this.#db.exec(PERSONALIZATION_SCHEMA_SQL);
    const manifestColumns = this.#db.prepare('PRAGMA table_info(personalization_run_manifests)').all() as Array<{ name: string }>;
    if (!manifestColumns.some((column) => column.name === 'integrity_tag')) {
      this.#db.exec('ALTER TABLE personalization_run_manifests ADD COLUMN integrity_tag TEXT');
    }
    const runColumns = this.#db.prepare('PRAGMA table_info(personalization_scenario_runs)').all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === 'integrity_tag')) {
      this.#db.exec('ALTER TABLE personalization_scenario_runs ADD COLUMN integrity_tag TEXT');
    }
  }

  seedBuiltins(definitions: readonly PersonalizationDefinition[]): void {
    const transaction = this.#db.transaction(() => {
      for (const candidate of definitions) {
        const definition = PersonalizationDefinitionSchema.parse(candidate);
        if (definition.provenance.origin !== 'builtin' || !definition.id.startsWith('builtin:')) {
          throw new Error(`Factory definition must use builtin origin and namespace: ${definition.id}`);
        }
        const current = this.#selectRow(definition.id);
        const raw = canonicalJson(definition);
        const digest = digestDefinition(definition);
        if (!current) {
          this.#db.prepare(`
            INSERT INTO personalization_definitions
              (id, kind, origin, current_revision, factory_json, current_json, archived, created_at, updated_at)
            VALUES (?, ?, 'builtin', ?, ?, ?, 0, ?, ?)
          `).run(
            definition.id,
            definition.kind,
            definition.revision,
            raw,
            raw,
            definition.provenance.createdAt,
            definition.provenance.updatedAt,
          );
          this.#insertVersion(definition, digest);
          continue;
        }
        if (current.origin !== 'builtin') {
          throw new Error(`Factory ID is occupied by a non-factory definition: ${definition.id}`);
        }
        const existingFactory = current.factory_json ? parseDefinition(current.factory_json) : undefined;
        if (existingFactory && digestDefinition(existingFactory) === digest) continue;
        const nextRevision = current.current_revision + 1;
        const next = PersonalizationDefinitionSchema.parse({
          ...definition,
          revision: nextRevision,
        });
        const nextRaw = canonicalJson(next);
        this.#db.prepare(`
          UPDATE personalization_definitions
          SET kind = ?, current_revision = ?, factory_json = ?, current_json = ?, archived = 0,
              updated_at = ?
          WHERE id = ? AND origin = 'builtin'
        `).run(next.kind, nextRevision, nextRaw, nextRaw, next.provenance.updatedAt, next.id);
        this.#insertVersion(next, digestDefinition(next));
      }
    });
    transaction();
  }

  list(kind?: PersonalizationDefinition['kind'], includeDisabled = false): PersonalizationDefinition[] {
    const rows = (kind
      ? this.#db.prepare(`
          SELECT * FROM personalization_definitions
          WHERE archived = 0 AND kind = ? ORDER BY updated_at DESC, id ASC
        `).all(kind)
      : this.#db.prepare(`
          SELECT * FROM personalization_definitions
          WHERE archived = 0 ORDER BY kind ASC, updated_at DESC, id ASC
        `).all()) as DefinitionRow[];
    return rows
      .flatMap((row) => {
        try { return [this.#parseVerifiedRow(row)]; } catch { return []; }
      })
      .filter((definition) => includeDisabled || definition.enabled);
  }

  get(id: string, includeArchived = false): PersonalizationDefinition | undefined {
    const row = this.#selectRow(id);
    if (!row || (!includeArchived && row.archived === 1)) return undefined;
    return this.#parseVerifiedRow(row);
  }

  getFactory(id: string): PersonalizationDefinition | undefined {
    const row = this.#selectRow(id);
    if (!row?.factory_json) return undefined;
    return parseDefinition(row.factory_json);
  }

  saveRunManifest(candidate: ResolvedRunManifest, integrityTag: string | null = null): ResolvedRunManifest {
    const manifest = ResolvedRunManifestSchema.parse(candidate);
    if (integrityTag !== null && !/^[a-f0-9]{64}$/u.test(integrityTag)) {
      throw new Error('Invalid run manifest integrity tag');
    }
    const raw = canonicalJson(manifest);
    this.#db.transaction(() => {
      this.#db.prepare(`
        UPDATE personalization_run_manifests SET active = 0
        WHERE session_id = ? AND active = 1
      `).run(manifest.sessionId);
      this.#db.prepare(`
        INSERT INTO personalization_run_manifests
          (manifest_digest, session_id, project_id, scenario_id, manifest_json, integrity_tag, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(manifest_digest) DO UPDATE SET active = 1, integrity_tag = excluded.integrity_tag
      `).run(
        manifest.manifestDigest,
        manifest.sessionId,
        manifest.projectId,
        manifest.scenarioId,
        raw,
        integrityTag,
        manifest.createdAt,
      );
    })();
    return manifest;
  }

  getActiveRunManifest(sessionId: string): ResolvedRunManifest | undefined {
    return this.getActiveRunManifestRecord(sessionId)?.manifest;
  }

  getActiveRunManifestRecord(sessionId: string): { manifest: ResolvedRunManifest; integrityTag: string | null } | undefined {
    const row = this.#db.prepare(`
      SELECT manifest_json, integrity_tag FROM personalization_run_manifests
      WHERE session_id = ? AND active = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as { manifest_json: string; integrity_tag: string | null } | undefined;
    if (!row) return undefined;
    try {
      const manifest = ResolvedRunManifestSchema.parse(JSON.parse(row.manifest_json) as unknown);
      if (row.integrity_tag !== null && !/^[a-f0-9]{64}$/u.test(row.integrity_tag)) return undefined;
      return { manifest, integrityTag: row.integrity_tag };
    } catch {
      return undefined;
    }
  }

  listRunManifests(sessionId: string): ResolvedRunManifest[] {
    const rows = this.#db.prepare(`
      SELECT manifest_json FROM personalization_run_manifests
      WHERE session_id = ? ORDER BY created_at DESC, manifest_digest DESC
    `).all(sessionId) as Array<{ manifest_json: string }>;
    return rows.flatMap((row) => {
      try {
        const parsed = ResolvedRunManifestSchema.safeParse(JSON.parse(row.manifest_json) as unknown);
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  saveScenarioRunRecord(candidate: ScenarioRunRecord): ScenarioRunRecord {
    const record = ScenarioRunRecordSchema.parse(candidate);
    const raw = canonicalJson(record);
    const integrityTag = scenarioRunIntegrityTag(this.#scenarioRunIntegritySecret, record);
    this.#db.transaction(() => {
      const existing = this.#db.prepare(`
        SELECT manifest_digest, record_json, integrity_tag FROM personalization_scenario_runs WHERE run_id = ?
      `).get(record.runId) as { manifest_digest: string; record_json: string; integrity_tag: string | null } | undefined;
      if (existing && existing.manifest_digest !== record.manifestDigest) {
        throw new Error('Scenario run manifest binding cannot change');
      }
      if (existing) {
        const previous = ScenarioRunRecordSchema.parse(JSON.parse(existing.record_json) as unknown);
        if (!verifiesScenarioRun(this.#scenarioRunIntegritySecret, previous, existing.integrity_tag)) {
          throw new Error('Scenario run integrity verification failed');
        }
        assertRunProgression(previous, record);
      }
      this.#db.prepare(`
        INSERT INTO personalization_scenario_runs
          (run_id, session_id, project_id, scenario_id, manifest_digest, status, record_json, integrity_tag, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          record_json = excluded.record_json,
          integrity_tag = excluded.integrity_tag,
          updated_at = excluded.updated_at
      `).run(
        record.runId,
        record.manifestSnapshot.sessionId,
        record.manifestSnapshot.projectId,
        record.manifestSnapshot.scenarioId,
        record.manifestDigest,
        record.status,
        raw,
        integrityTag,
        record.startedAt,
        record.updatedAt,
      );
    })();
    return record;
  }

  getScenarioRunRecord(runId: string): ScenarioRunRecord | undefined {
    const row = this.#db.prepare(`
      SELECT record_json, integrity_tag FROM personalization_scenario_runs WHERE run_id = ?
    `).get(runId) as { record_json: string; integrity_tag: string | null } | undefined;
    if (!row) return undefined;
    try {
      const record = ScenarioRunRecordSchema.parse(JSON.parse(row.record_json) as unknown);
      return verifiesScenarioRun(this.#scenarioRunIntegritySecret, record, row.integrity_tag) ? record : undefined;
    } catch {
      return undefined;
    }
  }

  getRecoverableScenarioRun(sessionId: string): ScenarioRunRecord | undefined {
    const row = this.#db.prepare(`
      SELECT record_json, integrity_tag FROM personalization_scenario_runs
      WHERE session_id = ? AND status IN ('running', 'interrupted')
      ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId) as { record_json: string; integrity_tag: string | null } | undefined;
    if (!row) return undefined;
    try {
      const record = ScenarioRunRecordSchema.parse(JSON.parse(row.record_json) as unknown);
      return verifiesScenarioRun(this.#scenarioRunIntegritySecret, record, row.integrity_tag) ? record : undefined;
    } catch {
      return undefined;
    }
  }

  listScenarioRunRecords(sessionId: string): ScenarioRunRecord[] {
    const rows = this.#db.prepare(`
      SELECT record_json, integrity_tag FROM personalization_scenario_runs
      WHERE session_id = ? ORDER BY updated_at DESC
    `).all(sessionId) as Array<{ record_json: string; integrity_tag: string | null }>;
    return rows.flatMap((row) => {
      try {
        const parsed = ScenarioRunRecordSchema.safeParse(JSON.parse(row.record_json) as unknown);
        return parsed.success && verifiesScenarioRun(this.#scenarioRunIntegritySecret, parsed.data, row.integrity_tag)
          ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  listVersions(id: string): PersonalizationVersionView[] {
    const rows = this.#db.prepare(`
      SELECT id, revision, content_digest, definition_json, created_at
      FROM personalization_versions WHERE id = ? ORDER BY revision DESC
    `).all(id) as Array<{
      id: string;
      revision: number;
      content_digest: string;
      definition_json: string;
      created_at: number;
    }>;
    return rows.flatMap((row) => {
      try {
        const definition = parseDefinition(row.definition_json);
        if (definition.id !== row.id || definition.revision !== row.revision
          || digestDefinition(definition) !== row.content_digest) return [];
        return [{
          id: row.id,
          revision: row.revision,
          contentDigest: row.content_digest,
          definition,
          createdAt: row.created_at,
        }];
      } catch { return []; }
    });
  }

  importDefinitionsAtomically(entries: ReadonlyArray<{
    definition: PersonalizationDefinition;
    assetBinding?: PersonalizationBundleAssetBinding;
  }>): void {
    if (entries.length === 0) throw new Error('Personalization import cannot be empty');
    const parsedEntries = entries.map((entry) => ({
      definition: PersonalizationDefinitionSchema.parse(entry.definition),
      assetBinding: entry.assetBinding === undefined
        ? undefined
        : PersonalizationBundleAssetBindingSchema.parse(entry.assetBinding),
    }));
    const ids = parsedEntries.map((entry) => entry.definition.id);
    if (new Set(ids).size !== ids.length) throw new Error('Personalization import contains duplicate IDs');
    if (parsedEntries.some((entry) => (
      entry.definition.id.startsWith('builtin:')
      || entry.definition.provenance.origin === 'builtin'
      || (entry.assetBinding && entry.assetBinding.ownerId !== entry.definition.id)
    ))) {
      throw new Error('Personalization import cannot overwrite factory definitions');
    }
    const incoming = new Set(ids);
    const dependencyLookup = this.#db.prepare(`
      SELECT archived FROM personalization_definitions WHERE id = ?
    `);

    this.#db.transaction(() => {
      for (const entry of parsedEntries) {
        if (this.#selectRow(entry.definition.id)) throw new Error('Personalization import target already exists');
        for (const dependencyId of dedupe(referencedDefinitionIds(entry.definition))) {
          if (incoming.has(dependencyId)) continue;
          const dependency = dependencyLookup.get(dependencyId) as { archived: number } | undefined;
          if (!dependency || dependency.archived === 1) {
            throw new Error(`Personalization import dependency is missing: ${dependencyId}`);
          }
        }
      }
      for (const entry of parsedEntries) {
        const definition = entry.definition;
        const raw = canonicalJson(definition);
        const digest = digestDefinition(definition);
        this.#db.prepare(`
          INSERT INTO personalization_definitions
            (id, kind, origin, current_revision, factory_json, current_json, archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)
        `).run(
          definition.id,
          definition.kind,
          definition.provenance.origin,
          definition.revision,
          raw,
          definition.provenance.createdAt,
          definition.provenance.updatedAt,
        );
        this.#insertVersion(definition, digest);
        if (entry.assetBinding) {
          this.#db.prepare(`
            INSERT INTO personalization_asset_bindings
              (owner_id, directory_token, relative_root, created_at)
            VALUES (?, ?, ?, ?)
          `).run(
            definition.id,
            entry.assetBinding.directoryToken,
            entry.assetBinding.relativeRoot,
            Date.now(),
          );
        }
      }
    })();
  }

  getAssetBinding(ownerId: string): PersonalizationBundleAssetBinding | undefined {
    const row = this.#db.prepare(`
      SELECT owner_id, directory_token, relative_root
      FROM personalization_asset_bindings WHERE owner_id = ?
    `).get(ownerId) as { owner_id: string; directory_token: string; relative_root: string } | undefined;
    if (!row) return undefined;
    const parsed = PersonalizationBundleAssetBindingSchema.safeParse({
      ownerId: row.owner_id,
      directoryToken: row.directory_token,
      relativeRoot: row.relative_root,
    });
    return parsed.success ? parsed.data : undefined;
  }

  recordEvidenceEnvelope(candidate: EvidenceEnvelope): boolean {
    const envelope = EvidenceEnvelopeSchema.parse(candidate);
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO personalization_evidence_envelopes
        (envelope_id, session_id, project_id, manifest_digest, source_definition_id, envelope_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.envelopeId,
      envelope.sessionId,
      envelope.projectId,
      envelope.runManifestDigest,
      envelope.sourceDefinitionId,
      canonicalJson(envelope),
      envelope.observedAt,
    );
    return result.changes === 1;
  }

  /** Activation-only CAS: definition revision and signed evidence are one SQLite transaction. */
  commitMcpActivation(raw: unknown): boolean {
    const parsed = McpActivationPersistenceInputSchema.safeParse(raw);
    if (!parsed.success || !validMcpActivationTransition(parsed.data)) return false;
    const input = parsed.data;
    const previousRaw = canonicalJson(input.previousDefinition);
    const activatedRaw = canonicalJson(input.activatedDefinition);
    const envelopeRaw = canonicalJson(input.envelope);
    try {
      return this.#db.transaction(() => {
        const current = this.#selectRow(input.previousDefinition.id);
        if (!current || current.archived === 1 || current.origin !== input.previousDefinition.provenance.origin
          || current.current_revision !== input.previousDefinition.revision
          || current.current_json !== previousRaw
          || !stableEqual(this.#parseVerifiedRow(current), input.previousDefinition)) return false;
        const evidenceExists = this.#db.prepare(`
          SELECT 1 FROM personalization_evidence_envelopes WHERE envelope_id = ?
        `).get(input.envelope.envelopeId);
        if (evidenceExists) return false;
        const updated = this.#db.prepare(`
          UPDATE personalization_definitions
          SET current_revision = ?, current_json = ?, updated_at = ?
          WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = ? AND archived = 0
        `).run(
          input.activatedDefinition.revision,
          activatedRaw,
          input.activatedDefinition.provenance.updatedAt,
          input.previousDefinition.id,
          input.previousDefinition.revision,
          previousRaw,
          input.previousDefinition.provenance.origin,
        );
        if (updated.changes !== 1) throw new Error('activation_cas_failed');
        this.#insertVersion(input.activatedDefinition, digestDefinition(input.activatedDefinition));
        this.#db.prepare(`
          INSERT INTO personalization_evidence_envelopes
            (envelope_id, session_id, project_id, manifest_digest, source_definition_id, envelope_json, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.envelope.envelopeId,
          input.envelope.sessionId,
          input.envelope.projectId,
          input.envelope.runManifestDigest,
          input.envelope.sourceDefinitionId,
          envelopeRaw,
          input.envelope.observedAt,
        );
        return true;
      })();
    } catch {
      return false;
    }
  }

  isMcpActivationCommitted(raw: unknown): boolean {
    const parsed = McpActivationPersistenceInputSchema.safeParse(raw);
    if (!parsed.success || !validMcpActivationTransition(parsed.data)) return false;
    try {
      const current = this.#selectRow(parsed.data.activatedDefinition.id);
      if (!current || current.archived === 1
        || !stableEqual(this.#parseVerifiedRow(current), parsed.data.activatedDefinition)) return false;
      const evidence = this.#db.prepare(`
        SELECT envelope_json FROM personalization_evidence_envelopes WHERE envelope_id = ?
      `).get(parsed.data.envelope.envelopeId) as { envelope_json: string } | undefined;
      return evidence?.envelope_json === canonicalJson(parsed.data.envelope);
    } catch {
      return false;
    }
  }

  /** Exact inverse used only when crash recovery finds DB committed but the file activation unavailable. */
  rollbackMcpActivation(raw: unknown): boolean {
    const parsed = McpActivationPersistenceInputSchema.safeParse(raw);
    if (!parsed.success || !validMcpActivationTransition(parsed.data)) return false;
    const input = parsed.data;
    const previousRaw = canonicalJson(input.previousDefinition);
    const activatedRaw = canonicalJson(input.activatedDefinition);
    const envelopeRaw = canonicalJson(input.envelope);
    try {
      return this.#db.transaction(() => {
        const current = this.#selectRow(input.activatedDefinition.id);
        const evidence = this.#db.prepare(`
          SELECT envelope_json FROM personalization_evidence_envelopes WHERE envelope_id = ?
        `).get(input.envelope.envelopeId) as { envelope_json: string } | undefined;
        if (!current || current.archived === 1 || current.current_revision !== input.activatedDefinition.revision
          || current.current_json !== activatedRaw
          || !stableEqual(this.#parseVerifiedRow(current), input.activatedDefinition)
          || evidence?.envelope_json !== envelopeRaw) return false;
        const restored = this.#db.prepare(`
          UPDATE personalization_definitions
          SET current_revision = ?, current_json = ?, updated_at = ?
          WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = ? AND archived = 0
        `).run(
          input.previousDefinition.revision,
          previousRaw,
          input.previousDefinition.provenance.updatedAt,
          input.previousDefinition.id,
          input.activatedDefinition.revision,
          activatedRaw,
          input.previousDefinition.provenance.origin,
        );
        if (restored.changes !== 1) throw new Error('activation_rollback_cas_failed');
        const removedVersion = this.#db.prepare(`
          DELETE FROM personalization_versions WHERE id = ? AND revision = ? AND definition_json = ?
        `).run(input.activatedDefinition.id, input.activatedDefinition.revision, activatedRaw);
        const removedEvidence = this.#db.prepare(`
          DELETE FROM personalization_evidence_envelopes WHERE envelope_id = ? AND envelope_json = ?
        `).run(input.envelope.envelopeId, envelopeRaw);
        if (removedVersion.changes !== 1 || removedEvidence.changes !== 1) {
          throw new Error('activation_rollback_identity_mismatch');
        }
        return true;
      })();
    } catch {
      return false;
    }
  }

  listEvidenceEnvelopes(sessionId: string): EvidenceEnvelope[] {
    const rows = this.#db.prepare(`
      SELECT envelope_json FROM personalization_evidence_envelopes
      WHERE session_id = ? ORDER BY observed_at DESC, envelope_id ASC
    `).all(sessionId) as Array<{ envelope_json: string }>;
    return rows.flatMap((row) => {
      try {
        const parsed = EvidenceEnvelopeSchema.safeParse(JSON.parse(row.envelope_json) as unknown);
        return parsed.success ? [parsed.data] : [];
      } catch { return []; }
    });
  }

  save(request: PersonalizationSaveRequest): PersonalizationMutationResult {
    const parsed = PersonalizationDefinitionSchema.safeParse(request.definition);
    if (!parsed.success || request.contractVersion !== PERSONALIZATION_CONTRACT_VERSION) {
      return { ok: false, code: 'invalid_request' };
    }
    const definition = parsed.data;
    if (definition.provenance.origin === 'builtin' || definition.id.startsWith('builtin:')) {
      return { ok: false, code: 'factory_protected' };
    }

    const missing = this.#missingDependencies(definition);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'dependency_invalid',
        issues: missing.map((id) => `Missing personalization dependency: ${id}`),
      };
    }

    try {
      return this.#db.transaction((): PersonalizationMutationResult => {
        const current = this.#selectRow(definition.id);
        if (!current) {
          if (request.expectedRevision !== 0 || definition.revision !== 1) {
            return { ok: false, code: 'revision_conflict', currentRevision: 0 };
          }
          const raw = canonicalJson(definition);
          this.#db.prepare(`
            INSERT INTO personalization_definitions
              (id, kind, origin, current_revision, factory_json, current_json, archived, created_at, updated_at)
            VALUES (?, ?, ?, 1, NULL, ?, 0, ?, ?)
          `).run(
            definition.id,
            definition.kind,
            definition.provenance.origin,
            raw,
            definition.provenance.createdAt,
            definition.provenance.updatedAt,
          );
          this.#insertVersion(definition, digestDefinition(definition));
          return { ok: true, code: 'saved', definition };
        }
        if (current.origin === 'builtin') return { ok: false, code: 'factory_protected' };
        if (current.current_revision !== request.expectedRevision
          || definition.revision !== current.current_revision + 1) {
          return { ok: false, code: 'revision_conflict', currentRevision: current.current_revision };
        }
        const raw = canonicalJson(definition);
        const result = this.#db.prepare(`
          UPDATE personalization_definitions
          SET kind = ?, origin = ?, current_revision = ?, current_json = ?, archived = 0,
              updated_at = ?
          WHERE id = ? AND current_revision = ? AND origin <> 'builtin'
        `).run(
          definition.kind,
          definition.provenance.origin,
          definition.revision,
          raw,
          definition.provenance.updatedAt,
          definition.id,
          request.expectedRevision,
        );
        if (result.changes !== 1) {
          const reread = this.#selectRow(definition.id);
          return { ok: false, code: 'revision_conflict', currentRevision: reread?.current_revision ?? 0 };
        }
        this.#insertVersion(definition, digestDefinition(definition));
        return { ok: true, code: 'saved', definition };
      })();
    } catch {
      return { ok: false, code: 'io_error' };
    }
  }

  /** Fail-closed reference query used before removing a managed MCP installation. */
  isMcpInstallationReferenced(installationId: string): boolean {
    if (!/^mcp_[a-f0-9]{32}$/u.test(installationId)) return true;
    const rows = this.#db.prepare(`
      SELECT * FROM personalization_definitions
    `).all() as DefinitionRow[];
    for (const row of rows) {
      let definition: PersonalizationDefinition;
      try { definition = this.#parseVerifiedRow(row); } catch { return true; }
      if (definition.kind === 'mcp'
        && (definition.args[0] === installationId
          || definition.workingDirectoryToken === installationId
          || definition.provenance.sourceRevision === installationId)) return true;
    }
    return false;
  }

  /** Exact inverse of the pending generated-MCP definition save. */
  rollbackGeneratedMcpPending(previousRaw: McpDefinition | null, pendingRaw: McpDefinition): boolean {
    const pending = McpDefinitionSchema.safeParse(pendingRaw);
    const previous = previousRaw === null ? null : McpDefinitionSchema.safeParse(previousRaw);
    if (!pending.success || (previous !== null && !previous.success)) return false;
    if (pending.data.sourceMode !== 'generated' || pending.data.provenance.origin !== 'generated'
      || pending.data.enabled || !pending.data.tags.includes('pending-probe')
      || pending.data.revision !== (previous?.data.revision ?? 0) + 1
      || (previous !== null && previous.data.id !== pending.data.id)) return false;
    const pendingJson = canonicalJson(pending.data);
    try {
      return this.#db.transaction(() => {
        const current = this.#selectRow(pending.data.id);
        if (!current || current.archived === 1 || current.origin !== 'generated'
          || current.current_revision !== pending.data.revision
          || current.current_json !== pendingJson
          || !stableEqual(this.#parseVerifiedRow(current), pending.data)) return false;
        if (previous === null) {
          const deletedVersion = this.#db.prepare(`
            DELETE FROM personalization_versions
            WHERE id = ? AND revision = ? AND definition_json = ?
          `).run(pending.data.id, pending.data.revision, pendingJson);
          const deletedDefinition = this.#db.prepare(`
            DELETE FROM personalization_definitions
            WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = 'generated' AND archived = 0
          `).run(pending.data.id, pending.data.revision, pendingJson);
          if (deletedVersion.changes !== 1 || deletedDefinition.changes !== 1) {
            throw new Error('generated_pending_rollback_mismatch');
          }
          return true;
        }
        const previousJson = canonicalJson(previous.data);
        const restored = this.#db.prepare(`
          UPDATE personalization_definitions
          SET kind = ?, origin = ?, current_revision = ?, current_json = ?, updated_at = ?
          WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = 'generated' AND archived = 0
        `).run(
          previous.data.kind,
          previous.data.provenance.origin,
          previous.data.revision,
          previousJson,
          previous.data.provenance.updatedAt,
          pending.data.id,
          pending.data.revision,
          pendingJson,
        );
        const deletedVersion = this.#db.prepare(`
          DELETE FROM personalization_versions
          WHERE id = ? AND revision = ? AND definition_json = ?
        `).run(pending.data.id, pending.data.revision, pendingJson);
        if (restored.changes !== 1 || deletedVersion.changes !== 1) {
          throw new Error('generated_pending_rollback_mismatch');
        }
        return true;
      })();
    } catch {
      return false;
    }
  }

  forkBuiltin(sourceId: string, targetId: string, author: string, now = Date.now()): PersonalizationMutationResult {
    const factory = this.getFactory(sourceId);
    if (!factory) return { ok: false, code: 'not_found' };
    const candidate = PersonalizationDefinitionSchema.safeParse({
      ...factory,
      id: targetId,
      revision: 1,
      provenance: {
        ...factory.provenance,
        origin: 'user',
        author,
        sourceUrl: null,
        sourceRevision: null,
        installedDigest: null,
        parentId: factory.id,
        parentVersion: factory.provenance.version,
        locallyModified: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (!candidate.success) return { ok: false, code: 'invalid_request' };
    return this.save({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      definition: candidate.data,
      expectedRevision: 0,
    });
  }

  restoreVersion(id: string, sourceRevision: number, expectedRevision: number, now = Date.now()): PersonalizationMutationResult {
    const current = this.get(id, true);
    if (!current) return { ok: false, code: 'not_found' };
    if (current.provenance.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    const source = this.listVersions(id).find((version) => version.revision === sourceRevision);
    if (!source) return { ok: false, code: 'not_found' };
    const candidate = PersonalizationDefinitionSchema.parse({
      ...source.definition,
      revision: expectedRevision + 1,
      provenance: {
        ...source.definition.provenance,
        locallyModified: true,
        updatedAt: now,
      },
    });
    return this.save({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      definition: candidate,
      expectedRevision,
    });
  }

  archive(id: string, expectedRevision: number): PersonalizationMutationResult {
    const row = this.#selectRow(id);
    if (!row) return { ok: false, code: 'not_found' };
    if (row.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    if (row.current_revision !== expectedRevision) {
      return { ok: false, code: 'revision_conflict', currentRevision: row.current_revision };
    }
    const result = this.#db.prepare(`
      UPDATE personalization_definitions SET archived = 1, updated_at = ?
      WHERE id = ? AND current_revision = ? AND origin <> 'builtin'
    `).run(Date.now(), id, expectedRevision);
    return result.changes === 1
      ? { ok: true, code: 'deleted', id }
      : { ok: false, code: 'io_error' };
  }

  #missingDependencies(definition: PersonalizationDefinition): string[] {
    const references = dedupe(referencedDefinitionIds(definition)).filter((id) => id !== definition.id);
    if (references.length === 0) return [];
    const lookup = this.#db.prepare('SELECT archived FROM personalization_definitions WHERE id = ?');
    return references.filter((id) => {
      const row = lookup.get(id) as { archived: number } | undefined;
      return !row || row.archived === 1;
    });
  }

  #selectRow(id: string): DefinitionRow | undefined {
    return this.#db.prepare('SELECT * FROM personalization_definitions WHERE id = ?').get(id) as DefinitionRow | undefined;
  }

  #parseVerifiedRow(row: DefinitionRow): PersonalizationDefinition {
    const definition = parseDefinition(row.current_json);
    const version = this.#db.prepare(`
      SELECT content_digest FROM personalization_versions WHERE id = ? AND revision = ?
    `).get(row.id, row.current_revision) as { content_digest: string } | undefined;
    if (!version
      || definition.id !== row.id
      || definition.kind !== row.kind
      || definition.provenance.origin !== row.origin
      || definition.revision !== row.current_revision
      || digestDefinition(definition) !== version.content_digest) {
      throw new Error('Personalization definition integrity verification failed');
    }
    return definition;
  }

  #insertVersion(definition: PersonalizationDefinition, digest: string): void {
    this.#db.prepare(`
      INSERT INTO personalization_versions (id, revision, content_digest, definition_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      definition.id,
      definition.revision,
      digest,
      canonicalJson(definition),
      definition.provenance.updatedAt,
    );
  }
}
