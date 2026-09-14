import {
  DefinitionProvenanceSchema,
  FullAccessPolicySchema,
  MemoryPolicySchema,
  PersonalizationDefinitionSchema,
  type AgentDefinition,
  type PersonalizationDefinition,
  type PersonalizationMutationResult,
  type ScenarioDefinition,
} from '../../../engine/runtime/PersonalizationRuntimeContract.js';

/**
 * PersonalizationCenter 拆分后的共享类型、常量与纯工具：
 * 类型标签、编辑器草稿持久化、保存结果文案与可视化 schema 草稿。
 */

export type Kind = PersonalizationDefinition['kind'];

export const KIND_ORDER: Kind[] = ['scenario', 'skill', 'mcp', 'rules'];
export const KIND_LABELS = {
  zh: { scenario: '场景', agent: '智能体', skill: '技能', mcp: 'MCP', rules: 'Metis.md' },
  en: { scenario: 'Scenarios', agent: 'Agents', skill: 'Skills', mcp: 'MCP', rules: 'Metis.md' },
} as const;

export const LIBRARY_LABELS = {
  zh: { scenario: '场景库', agent: '智能体库', skill: '技能库', mcp: 'MCP 库', rules: 'Metis.md 库' },
  en: { scenario: 'Scenario library', agent: 'Agent library', skill: 'Skill library', mcp: 'MCP library', rules: 'Metis.md library' },
} as const;

const PERSONALIZATION_DRAFT_PREFIX = 'metis:personalization-draft:v1:';
export const PERSONALIZATION_DRAFT_DEBOUNCE_MS = 200;

interface StoredPersonalizationDraft {
  version: 1;
  baseRevision: number;
  draft: PersonalizationDefinition;
}

const volatilePersonalizationDrafts = new Map<string, StoredPersonalizationDraft>();
const volatileOnlyPersonalizationDraftIds = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDraftOutput(value: unknown): value is AgentDefinition['output'] {
  if (!isRecord(value)
    || typeof value.format !== 'string'
    || !('schema' in value)
    || (value.schema !== null && !isRecord(value.schema))
    || typeof value.requireEvidenceEnvelope !== 'boolean'
    || typeof value.includeIntegrityReport !== 'boolean') return false;
  if (value.plan === undefined || value.plan === null) return true;
  return isRecord(value.plan)
    && typeof value.plan.primaryDeliverable === 'string'
    && isStringArray(value.plan.supportingArtifacts)
    && isStringArray(value.plan.qualityCriteria);
}

function isDraftWorkflow(value: unknown): value is ScenarioDefinition['workflow'] {
  return Array.isArray(value) && value.every((step) => isRecord(step)
    && typeof step.id === 'string'
    && typeof step.name === 'string'
    && typeof step.description === 'string'
    && typeof step.agentId === 'string'
    && isStringArray(step.skillIds)
    && isStringArray(step.toolIds)
    && isStringArray(step.mcpIds)
    && isStringArray(step.dependsOn)
    && typeof step.maxTurns === 'number');
}

/**
 * Editor drafts deliberately accept temporarily incomplete business values (for example an empty
 * required name while it is being replaced). Stable structure is still checked so malformed
 * storage cannot reach the editor as an arbitrary object.
 */
function isPersonalizationEditorDraft(value: unknown): value is PersonalizationDefinition {
  if (!isRecord(value)
    || value.contractVersion !== 1
    || typeof value.id !== 'string'
    || !['scenario', 'agent', 'skill', 'mcp', 'rules'].includes(String(value.kind))
    || typeof value.name !== 'string'
    || typeof value.description !== 'string'
    || typeof value.enabled !== 'boolean'
    || !isStringArray(value.tags)
    || !Number.isSafeInteger(value.revision)
    || !DefinitionProvenanceSchema.safeParse(value.provenance).success) return false;

  if (value.kind === 'agent') {
    return typeof value.role === 'string'
      && typeof value.systemPrompt === 'string'
      && (value.modelPreference === null || typeof value.modelPreference === 'string')
      && isStringArray(value.skillIds)
      && isStringArray(value.toolIds)
      && isStringArray(value.mcpIds)
      && MemoryPolicySchema.safeParse(value.memory).success
      && isDraftOutput(value.output)
      && typeof value.maxTurns === 'number'
      && typeof value.retryLimit === 'number';
  }
  if (value.kind === 'skill') {
    return ['markdown', 'package', 'url'].includes(String(value.sourceMode))
      && typeof value.markdown === 'string'
      && typeof value.systemPrompt === 'string'
      && isStringArray(value.toolIds)
      && isStringArray(value.mcpIds)
      && typeof value.maxTurns === 'number'
      && (value.inputSchema === null || isRecord(value.inputSchema))
      && (value.outputSchema === null || isRecord(value.outputSchema))
      && (value.packageEntry === null || typeof value.packageEntry === 'string');
  }
  if (value.kind === 'scenario') {
    return isStringArray(value.agentIds)
      && isStringArray(value.skillIds)
      && isStringArray(value.mcpIds)
      && isStringArray(value.rulesIds)
      && isDraftWorkflow(value.workflow)
      && FullAccessPolicySchema.safeParse(value.fullAccess).success
      && MemoryPolicySchema.safeParse(value.memory).success
      && isDraftOutput(value.output)
      && isStringArray(value.triggerPhrases)
      && ['research', 'writing', 'analysis', 'funding', 'presentation_reserved', 'custom']
        .includes(String(value.capability));
  }
  if (value.kind === 'rules') {
    return ['global', 'scenario', 'project'].includes(String(value.scope))
      && (value.scopeId === null || typeof value.scopeId === 'string')
      && typeof value.markdown === 'string';
  }
  return PersonalizationDefinitionSchema.safeParse(value).success;
}

function personalizationDraftKey(definitionId: string): string {
  return `${PERSONALIZATION_DRAFT_PREFIX}${definitionId}`;
}

function parseStoredPersonalizationDraft(raw: string): StoredPersonalizationDraft | null {
  try {
    const candidate = JSON.parse(raw) as Partial<StoredPersonalizationDraft>;
    if (candidate.version !== 1 || !Number.isInteger(candidate.baseRevision)) return null;
    if (!isPersonalizationEditorDraft(candidate.draft)) return null;
    return { version: 1, baseRevision: candidate.baseRevision!, draft: candidate.draft };
  } catch {
    return null;
  }
}

export function personalizationDefinitionSignature(definition: PersonalizationDefinition): string {
  const parsed = PersonalizationDefinitionSchema.safeParse(definition);
  return JSON.stringify(parsed.success ? parsed.data : definition);
}

export function readPersonalizationDraft(definition: PersonalizationDefinition): PersonalizationDefinition | null {
  const key = personalizationDraftKey(definition.id);
  let stored = volatilePersonalizationDrafts.get(definition.id) ?? null;
  let durableStorageReadable = false;
  try {
    let raw = window.localStorage.getItem(key);
    durableStorageReadable = true;
    if (!raw) {
      raw = window.sessionStorage.getItem(key);
      if (raw) {
        window.localStorage.setItem(key, raw);
      }
    }
    if (raw) {
      stored = parseStoredPersonalizationDraft(raw);
      if (!stored) {
        clearPersonalizationDraft(definition.id);
        return null;
      }
      volatilePersonalizationDrafts.set(definition.id, stored);
    } else if (!volatileOnlyPersonalizationDraftIds.has(definition.id)) {
      volatilePersonalizationDrafts.delete(definition.id);
      stored = null;
    }
  } catch {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw) stored = parseStoredPersonalizationDraft(raw);
    } catch {
      // The in-memory mirror remains available when browser storage is restricted.
    }
  }
  if (durableStorageReadable && stored) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(stored));
    } catch {
      // localStorage remains the durable copy when session storage is restricted.
    }
  }
  if (!stored
    || stored.baseRevision !== definition.revision
    || stored.draft.id !== definition.id
    || stored.draft.kind !== definition.kind) {
    if (stored) clearPersonalizationDraft(definition.id);
    return null;
  }
  return stored.draft;
}

export function writePersonalizationDraft(
  definition: PersonalizationDefinition,
  draft: PersonalizationDefinition,
): void {
  const stored: StoredPersonalizationDraft = {
    version: 1,
    baseRevision: definition.revision,
    draft,
  };
  volatilePersonalizationDrafts.set(definition.id, stored);
  let persisted = false;
  try {
    const serialized = JSON.stringify(stored);
    window.localStorage.setItem(personalizationDraftKey(definition.id), serialized);
    persisted = true;
    window.sessionStorage.setItem(personalizationDraftKey(definition.id), serialized);
    volatileOnlyPersonalizationDraftIds.delete(definition.id);
  } catch {
    try {
      window.sessionStorage.setItem(personalizationDraftKey(definition.id), JSON.stringify(stored));
      persisted = true;
    } catch {
      // The in-memory mirror still protects navigation within this renderer session.
    }
    if (persisted) volatileOnlyPersonalizationDraftIds.delete(definition.id);
    else volatileOnlyPersonalizationDraftIds.add(definition.id);
  }
}

export function clearPersonalizationDraft(definitionId: string): void {
  volatilePersonalizationDrafts.delete(definitionId);
  volatileOnlyPersonalizationDraftIds.delete(definitionId);
  try {
    window.localStorage.removeItem(personalizationDraftKey(definitionId));
    window.sessionStorage.removeItem(personalizationDraftKey(definitionId));
  } catch {
    try {
      window.sessionStorage.removeItem(personalizationDraftKey(definitionId));
    } catch {
      // A restricted storage implementation does not affect the in-memory cleanup.
    }
  }
}

export function retainedPersonalizationDraftIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(PERSONALIZATION_DRAFT_PREFIX)) {
          ids.add(key.slice(PERSONALIZATION_DRAFT_PREFIX.length));
        }
      }
    }
    volatileOnlyPersonalizationDraftIds.forEach((id) => ids.add(id));
    volatilePersonalizationDrafts.forEach((_draft, id) => {
      if (!ids.has(id)) volatilePersonalizationDrafts.delete(id);
    });
  } catch {
    // The in-memory mirror is authoritative when browser storage is restricted.
    volatilePersonalizationDrafts.forEach((_draft, id) => ids.add(id));
  }
  return ids;
}

export function editableCopy(definition: PersonalizationDefinition): PersonalizationDefinition {
  const now = Date.now();
  return {
    ...definition,
    revision: definition.revision + 1,
    provenance: {
      ...definition.provenance,
      locallyModified: true,
      updatedAt: now,
    },
  };
}

export function rebasePersonalizationDraft(
  savedDefinition: PersonalizationDefinition,
  retainedDraft: PersonalizationDefinition,
): PersonalizationDefinition {
  const baseline = editableCopy(savedDefinition);
  if (retainedDraft.id !== savedDefinition.id || retainedDraft.kind !== savedDefinition.kind) {
    return baseline;
  }
  return {
    ...baseline,
    ...retainedDraft,
    contractVersion: savedDefinition.contractVersion,
    id: savedDefinition.id,
    kind: savedDefinition.kind,
    revision: baseline.revision,
    provenance: {
      ...baseline.provenance,
      ...retainedDraft.provenance,
      locallyModified: true,
      updatedAt: Math.max(retainedDraft.provenance.updatedAt, baseline.provenance.updatedAt),
    },
  } as PersonalizationDefinition;
}

export function resultMessage(result: PersonalizationMutationResult, zh: boolean): string {
  if (result.ok) return zh ? '已保存' : 'Saved';
  const labels: Record<string, [string, string]> = {
    invalid_request: ['内容不符合严格合同', 'Content does not match the strict contract'],
    not_found: ['未找到定义', 'Definition not found'],
    factory_protected: ['内置原版受保护，请先创建可编辑副本', 'Built-in factory version is protected; create an editable copy'],
    revision_conflict: ['版本已变更，请刷新后重试', 'The definition changed; reload and try again'],
    dependency_invalid: ['引用的智能体、技能或 MCP 不可用', 'A referenced agent, skill, or MCP is unavailable'],
    io_error: ['持久化失败', 'Persistence failed'],
  };
  return (labels[result.code] ?? ['操作失败', 'Operation failed'])[zh ? 0 : 1];
}

export type SimpleSchemaFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export const SIMPLE_SCHEMA_TYPE_OPTIONS: ReadonlyArray<{
  value: SimpleSchemaFieldType;
  zh: string;
  en: string;
}> = [
  { value: 'string', zh: '文本', en: 'Text' },
  { value: 'number', zh: '数值', en: 'Number' },
  { value: 'integer', zh: '整数', en: 'Integer' },
  { value: 'boolean', zh: '是 / 否', en: 'Yes / No' },
  { value: 'array', zh: '列表', en: 'List' },
  { value: 'object', zh: '对象', en: 'Object' },
];

export interface SimpleSchemaField {
  name: string;
  type: SimpleSchemaFieldType;
  description: string;
  required: boolean;
}

const SIMPLE_SCHEMA_DRAFT_ROWS_KEY = 'x-metis-visual-schema-draft-rows';
const SIMPLE_SCHEMA_REPLACEMENT_DRAFT_KEY = 'x-metis-visual-schema-replacement';

interface SimpleSchemaDraftState {
  rows: SimpleSchemaField[];
  preserveEmptyObject: boolean;
}

interface SimpleSchemaReplacementDraft extends SimpleSchemaDraftState {
  original: Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSimpleSchemaField(value: unknown): value is SimpleSchemaField {
  const record = recordValue(value);
  return record !== null
    && typeof record.name === 'string'
    && ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(String(record.type))
    && typeof record.description === 'string'
    && typeof record.required === 'boolean';
}

export function isSimpleSchemaRowsValid(rows: readonly SimpleSchemaField[]): boolean {
  const names = rows.map((row) => row.name.trim());
  return names.every((name) => /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(name))
    && new Set(names).size === names.length;
}

function readSimpleSchemaDraftState(value: unknown): SimpleSchemaDraftState | null {
  if (Array.isArray(value)) {
    return value.every(isSimpleSchemaField) ? { rows: value, preserveEmptyObject: false } : null;
  }
  const record = recordValue(value);
  if (!record
    || !Array.isArray(record.rows)
    || !record.rows.every(isSimpleSchemaField)
    || typeof record.preserveEmptyObject !== 'boolean') return null;
  return { rows: record.rows, preserveEmptyObject: record.preserveEmptyObject };
}

export function readInvalidSimpleSchemaDraft(schema: Record<string, unknown> | null): SimpleSchemaDraftState | null {
  if (schema === null || Object.keys(schema).length !== 1) return null;
  return readSimpleSchemaDraftState(schema[SIMPLE_SCHEMA_DRAFT_ROWS_KEY]);
}

export function buildInvalidSimpleSchemaDraft(
  rows: readonly SimpleSchemaField[],
  preserveEmptyObject: boolean,
): Record<string, unknown> {
  return { [SIMPLE_SCHEMA_DRAFT_ROWS_KEY]: { rows, preserveEmptyObject } };
}

export function readSimpleSchemaReplacementDraft(
  schema: Record<string, unknown> | null,
): SimpleSchemaReplacementDraft | null {
  if (schema === null || Object.keys(schema).length !== 1) return null;
  const replacement = recordValue(schema[SIMPLE_SCHEMA_REPLACEMENT_DRAFT_KEY]);
  const state = readSimpleSchemaDraftState(replacement);
  const original = recordValue(replacement?.original);
  return replacement && state && original ? { ...state, original } : null;
}

export function buildSimpleSchemaReplacementDraft(
  original: Record<string, unknown>,
  rows: readonly SimpleSchemaField[],
  preserveEmptyObject: boolean,
): Record<string, unknown> {
  return {
    [SIMPLE_SCHEMA_REPLACEMENT_DRAFT_KEY]: {
      original,
      rows,
      preserveEmptyObject,
    },
  };
}

export function readSimpleSchema(schema: Record<string, unknown> | null): SimpleSchemaField[] | null {
  if (schema === null) return [];
  const invalidDraft = readInvalidSimpleSchemaDraft(schema);
  if (invalidDraft) return invalidDraft.rows;
  const replacementDraft = readSimpleSchemaReplacementDraft(schema);
  if (replacementDraft) return replacementDraft.rows;
  if (schema.type !== 'object') return null;
  const topLevelKeys = Object.keys(schema);
  if (topLevelKeys.length !== 4
    || !['type', 'additionalProperties', 'properties', 'required']
      .every((key) => Object.hasOwn(schema, key))
    || schema.additionalProperties !== false
    || !Array.isArray(schema.required)
    || !schema.required.every((item) => typeof item === 'string')
    || new Set(schema.required).size !== schema.required.length) return null;
  const properties = recordValue(schema.properties);
  if (!properties) return null;
  const required = new Set(schema.required);
  if ([...required].some((name) => !Object.hasOwn(properties, name))) return null;
  const supported = new Set<SimpleSchemaFieldType>(['string', 'number', 'integer', 'boolean', 'array', 'object']);
  const rows: SimpleSchemaField[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = recordValue(rawProperty);
    if (!property
      || typeof property.type !== 'string'
      || !supported.has(property.type as SimpleSchemaFieldType)
      || Object.keys(property).some((key) => key !== 'type' && key !== 'description')
      || (property.description !== undefined
        && (typeof property.description !== 'string'
          || property.description.length === 0
          || property.description.trim() !== property.description))) return null;
    rows.push({
      name,
      type: property.type as SimpleSchemaFieldType,
      description: typeof property.description === 'string' ? property.description : '',
      required: required.has(name),
    });
  }
  return rows;
}

export function isStrictEmptySimpleSchema(schema: Record<string, unknown> | null): boolean {
  if (!schema || readInvalidSimpleSchemaDraft(schema) || readSimpleSchemaReplacementDraft(schema)) return false;
  const parsed = readSimpleSchema(schema);
  return parsed !== null && parsed.length === 0 && schema !== null;
}

export function buildSimpleSchema(
  rows: readonly SimpleSchemaField[],
  preserveEmptyObject = false,
): Record<string, unknown> | null {
  if (rows.length === 0 && !preserveEmptyObject) return null;
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(rows.map((row) => [row.name, {
      type: row.type,
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
    }])),
    required: rows.filter((row) => row.required).map((row) => row.name),
  };
}
