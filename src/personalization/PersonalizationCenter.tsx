import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DefinitionProvenanceSchema,
  FullAccessPolicySchema,
  MemoryPolicySchema,
  PersonalizationDefinitionSchema,
  type AgentDefinition,
  type McpDefinition,
  type MetisRulesDefinition,
  type PersonalizationDefinition,
  type PersonalizationMutationResult,
  type PersonalizationVersionView,
  type ScenarioDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import McpActivationPanel, {
  type McpActivationPanelDependencies,
} from './McpActivationPanel';
import ProjectMetisRulesEditor from './ProjectMetisRulesEditor';
import { BuiltinSkillBrowserPanel } from './BuiltinSkillBrowserPanel';
import SplitHandle from '../components/SplitHandle';
import { availableUserId, createDefinition, localId } from './personalizationLib.js';
import ScenarioWorkbench, { type WorkbenchTab } from './ScenarioWorkbench.js';
import ScenarioAiCreateDialog from './ScenarioAiCreateDialog.js';
import './PersonalizationCenter.css';

type Kind = PersonalizationDefinition['kind'];

export interface PersonalizationCenterProps {
  onActivateScenario?: (scenarioId: string) => void | Promise<void>;
}

function isDirectlyEditable(definition: PersonalizationDefinition): boolean {
  if (definition.provenance.origin !== 'user' || !definition.id.startsWith('user:')) return false;
  if (definition.provenance.sourceUrl !== null
    || definition.provenance.sourceRevision !== null
    || definition.provenance.installedDigest !== null) return false;
  if (definition.kind === 'mcp') return false;
  return definition.kind !== 'skill'
    || (definition.sourceMode === 'markdown' && definition.packageEntry === null);
}

const KIND_ORDER: Kind[] = ['scenario', 'agent', 'skill', 'mcp', 'rules'];
const KIND_LABELS = {
  zh: { scenario: '场景', agent: '智能体', skill: '技能', mcp: 'MCP', rules: 'Metis.md' },
  en: { scenario: 'Scenarios', agent: 'Agents', skill: 'Skills', mcp: 'MCP', rules: 'Metis.md' },
} as const;

const LIBRARY_LABELS = {
  zh: { scenario: '场景库', agent: '智能体库', skill: '技能库', mcp: 'MCP 库', rules: 'Metis.md 库' },
  en: { scenario: 'Scenario library', agent: 'Agent library', skill: 'Skill library', mcp: 'MCP library', rules: 'Metis.md library' },
} as const;

const MEMORY_SCOPE_OPTIONS: ReadonlyArray<{
  value: AgentDefinition['memory']['scope'];
  zh: string;
  en: string;
}> = [
  { value: 'none', zh: '不保留', en: 'None' },
  { value: 'session', zh: '当前会话', en: 'Session' },
  { value: 'project', zh: '当前项目', en: 'Project' },
  { value: 'scenario', zh: '当前场景', en: 'Scenario' },
];

const OUTPUT_FORMAT_OPTIONS: ReadonlyArray<{
  value: AgentDefinition['output']['format'];
  zh: string;
  en: string;
}> = [
  { value: 'markdown', zh: 'Markdown', en: 'Markdown' },
  { value: 'json', zh: 'JSON', en: 'JSON' },
  { value: 'document', zh: '文档', en: 'Document' },
  { value: 'artifact_bundle', zh: '产物包', en: 'Artifact bundle' },
  { value: 'custom', zh: '自定义', en: 'Custom' },
];


const RULE_SCOPE_OPTIONS: ReadonlyArray<{
  value: Exclude<MetisRulesDefinition['scope'], 'project'>;
  zh: string;
  en: string;
}> = [
  { value: 'global', zh: '全局', en: 'Global' },
  { value: 'scenario', zh: '场景', en: 'Scenario' },
];

const PERSONALIZATION_DRAFT_PREFIX = 'metis:personalization-draft:v1:';
const PERSONALIZATION_DRAFT_DEBOUNCE_MS = 200;

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

function personalizationDefinitionSignature(definition: PersonalizationDefinition): string {
  const parsed = PersonalizationDefinitionSchema.safeParse(definition);
  return JSON.stringify(parsed.success ? parsed.data : definition);
}

function readPersonalizationDraft(definition: PersonalizationDefinition): PersonalizationDefinition | null {
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

function writePersonalizationDraft(
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

function clearPersonalizationDraft(definitionId: string): void {
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

function retainedPersonalizationDraftIds(): Set<string> {
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



function editableCopy(definition: PersonalizationDefinition): PersonalizationDefinition {
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

function rebasePersonalizationDraft(
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

function resultMessage(result: PersonalizationMutationResult, zh: boolean): string {
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

function csv(values: readonly string[]): string { return values.join(', '); }
function parseCsv(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))];
}
function parseLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))];
}

function boundedInteger(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function DefinitionReferencePicker({
  label,
  help,
  kind,
  definitions,
  selectedIds,
  onChange,
  filter,
  emptyLabel,
  compact = false,
  onCreate,
  createLabel,
}: {
  label: string;
  help: string;
  kind: Kind;
  definitions: readonly PersonalizationDefinition[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  filter?: (definition: PersonalizationDefinition) => boolean;
  emptyLabel: string;
  compact?: boolean;
  onCreate?: () => void;
  createLabel?: string;
}) {
  const candidates = definitions.filter((definition) => (
    definition.kind === kind
    && (definition.enabled || selectedIds.includes(definition.id))
    && (!filter || filter(definition) || selectedIds.includes(definition.id))
  ));
  const selected = new Set(selectedIds);
  return <fieldset className={`personalization-reference-picker${compact ? ' is-compact' : ''}`}>
    <legend>{label}</legend>
    <p>{help}</p>
    {candidates.length === 0
      ? <div className="personalization-reference-picker__empty">
          <span>{emptyLabel}</span>
          {onCreate && <button type="button" className="btn-sm btn-secondary" onClick={onCreate} data-testid={`quick-create-${kind}`}>{createLabel ?? (kind === 'agent' ? '新建智能体' : kind === 'skill' ? '新建技能' : kind === 'mcp' ? '新建 MCP' : '新建 Metis.md')}</button>}
        </div>
      : <div className="personalization-reference-picker__options">
          {candidates.map((definition) => <label key={definition.id} data-definition-id={definition.id}>
            <input
              type="checkbox"
              checked={selected.has(definition.id)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selectedIds, definition.id]
                  : selectedIds.filter((id) => id !== definition.id);
                onChange([...new Set(next)]);
              }}
            />
            <span>
              <strong>{definition.name}</strong>
              <small>{definition.provenance.origin === 'builtin' ? 'Metis' : (definition.description || definition.id)}</small>
            </span>
          </label>)}
        </div>}
  </fieldset>;
}

function OutputPlanEditor({
  output,
  onChange,
  zh,
}: {
  output: AgentDefinition['output'];
  onChange: (output: AgentDefinition['output']) => void;
  zh: boolean;
}) {
  const { t } = useTranslation();
  const plan = output.plan ?? null;
  const editablePlan = plan ?? {
    primaryDeliverable: '',
    supportingArtifacts: [],
    qualityCriteria: [],
  };
  const updatePlan = (nextPlan: NonNullable<AgentDefinition['output']['plan']>) => {
    const isCompletelyEmpty = !nextPlan.primaryDeliverable.trim()
      && nextPlan.supportingArtifacts.length === 0
      && nextPlan.qualityCriteria.length === 0;
    onChange({ ...output, plan: isCompletelyEmpty ? null : nextPlan });
  };
  const setPrimary = (primaryDeliverable: string) => {
    const supportingArtifacts = editablePlan.supportingArtifacts;
    const qualityCriteria = editablePlan.qualityCriteria;
    updatePlan({
      primaryDeliverable,
      supportingArtifacts,
      qualityCriteria,
    });
  };
  return <fieldset className="personalization-output-plan">
    <legend>{zh ? '输出计划' : 'Output plan'}</legend>
    <p>{zh ? '用普通文字说明要交付什么，不需要编写 JSON。' : 'Describe the expected deliverables in plain language; no JSON is required.'}</p>
    <label><span>{zh ? '主交付物' : 'Primary deliverable'}</span><input aria-required="true" value={editablePlan.primaryDeliverable} maxLength={512} onChange={(event) => setPrimary(event.target.value)} placeholder={zh ? '例如：完整的学术论文草稿' : 'For example: a complete academic article draft'} /></label>
    {!editablePlan.primaryDeliverable.trim() && (editablePlan.supportingArtifacts.length > 0 || editablePlan.qualityCriteria.length > 0) && <p className="personalization-output-plan__required" role="note">{t('personalization.outputPrimaryRequired')}</p>}
    <div className="personalization-grid personalization-grid--2">
      <label><span>{zh ? '配套产物（每行一项）' : 'Supporting artifacts (one per line)'}</span><textarea rows={4} value={editablePlan.supportingArtifacts.join('\n')} onChange={(event) => updatePlan({ ...editablePlan, supportingArtifacts: parseLines(event.target.value).slice(0, 64) })} /></label>
      <label><span>{zh ? '质量标准（每行一项）' : 'Quality criteria (one per line)'}</span><textarea rows={4} value={editablePlan.qualityCriteria.join('\n')} onChange={(event) => updatePlan({ ...editablePlan, qualityCriteria: parseLines(event.target.value).slice(0, 64) })} /></label>
    </div>
  </fieldset>;
}

type SimpleSchemaFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

const SIMPLE_SCHEMA_TYPE_OPTIONS: ReadonlyArray<{
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
interface SimpleSchemaField {
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

function isSimpleSchemaRowsValid(rows: readonly SimpleSchemaField[]): boolean {
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

function readInvalidSimpleSchemaDraft(schema: Record<string, unknown> | null): SimpleSchemaDraftState | null {
  if (schema === null || Object.keys(schema).length !== 1) return null;
  return readSimpleSchemaDraftState(schema[SIMPLE_SCHEMA_DRAFT_ROWS_KEY]);
}

function buildInvalidSimpleSchemaDraft(
  rows: readonly SimpleSchemaField[],
  preserveEmptyObject: boolean,
): Record<string, unknown> {
  return { [SIMPLE_SCHEMA_DRAFT_ROWS_KEY]: { rows, preserveEmptyObject } };
}

function readSimpleSchemaReplacementDraft(
  schema: Record<string, unknown> | null,
): SimpleSchemaReplacementDraft | null {
  if (schema === null || Object.keys(schema).length !== 1) return null;
  const replacement = recordValue(schema[SIMPLE_SCHEMA_REPLACEMENT_DRAFT_KEY]);
  const state = readSimpleSchemaDraftState(replacement);
  const original = recordValue(replacement?.original);
  return replacement && state && original ? { ...state, original } : null;
}

function buildSimpleSchemaReplacementDraft(
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

function readSimpleSchema(schema: Record<string, unknown> | null): SimpleSchemaField[] | null {
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

function isStrictEmptySimpleSchema(schema: Record<string, unknown> | null): boolean {
  if (!schema || readInvalidSimpleSchemaDraft(schema) || readSimpleSchemaReplacementDraft(schema)) return false;
  const parsed = readSimpleSchema(schema);
  return parsed !== null && parsed.length === 0 && schema !== null;
}

function buildSimpleSchema(
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

function SimpleSchemaEditor({
  label,
  value,
  onChange,
  onValidityChange,
  zh,
}: {
  label: string;
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null) => void;
  onValidityChange: (valid: boolean) => void;
  zh: boolean;
}) {
  const parsed = readSimpleSchema(value);
  const invalidDraft = readInvalidSimpleSchemaDraft(value);
  const restoredReplacement = readSimpleSchemaReplacementDraft(value);
  const [rows, setRows] = useState<SimpleSchemaField[]>(parsed ?? []);
  const [unsupported, setUnsupported] = useState(parsed === null);
  const [replacementOriginal, setReplacementOriginal] = useState<Record<string, unknown> | null>(
    restoredReplacement?.original ?? null,
  );
  const [replacementMode, setReplacementMode] = useState(restoredReplacement !== null);
  const [preserveEmptyObject, setPreserveEmptyObject] = useState(
    invalidDraft?.preserveEmptyObject
      ?? restoredReplacement?.preserveEmptyObject
      ?? isStrictEmptySimpleSchema(value),
  );
  const [error, setError] = useState(invalidDraft
    ? (zh ? '字段名必须唯一，以字母或下划线开头。' : 'Field names must be unique and start with a letter or underscore.')
    : '');

  const commit = (next: SimpleSchemaField[]) => {
    setRows(next);
    const names = next.map((row) => row.name.trim());
    const valid = isSimpleSchemaRowsValid(next);
    if (!valid) {
      setError(zh ? '字段名必须唯一，以字母或下划线开头。' : 'Field names must be unique and start with a letter or underscore.');
      onChange(replacementMode && replacementOriginal
        ? buildSimpleSchemaReplacementDraft(replacementOriginal, next, preserveEmptyObject)
        : buildInvalidSimpleSchemaDraft(next, preserveEmptyObject));
      onValidityChange(false);
      return;
    }
    setError('');
    const normalizedRows = next.map((row, index) => ({ ...row, name: names[index]! }));
    if (replacementMode && replacementOriginal) {
      onChange(buildSimpleSchemaReplacementDraft(replacementOriginal, normalizedRows, preserveEmptyObject));
      onValidityChange(false);
    } else {
      onChange(buildSimpleSchema(normalizedRows, preserveEmptyObject));
      onValidityChange(true);
    }
  };

  if (unsupported) return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    <div className="personalization-boundary"><strong>{zh ? '已保留现有复杂结构' : 'Existing advanced schema preserved'}</strong><span>{zh ? '此结构超出可视化字段编辑器范围。只有明确选择替换时才会清空。' : 'This schema is more complex than the visual field editor. It remains unchanged unless you explicitly replace it.'}</span></div>
    <button type="button" onClick={() => {
      if (!value) return;
      setUnsupported(false);
      setRows([]);
      setError('');
      setReplacementOriginal(value);
      setReplacementMode(true);
      setPreserveEmptyObject(true);
      onChange(buildSimpleSchemaReplacementDraft(value, [], true));
      onValidityChange(false);
    }}>{zh ? '替换为可视化字段' : 'Replace with visual fields'}</button>
  </fieldset>;

  return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    {replacementMode && replacementOriginal && <div className="personalization-boundary">
      <strong>{zh ? '可视化替换尚未应用' : 'Visual replacement not applied'}</strong>
      <span>{zh ? '原始高级结构仍可恢复。应用替换后才能保存定义。' : 'The original advanced schema remains recoverable. Apply the replacement before saving the definition.'}</span>
      <div className="personalization-actions">
        <button type="button" onClick={() => {
          setRows([]);
          setError('');
          setReplacementMode(false);
          setReplacementOriginal(null);
          setUnsupported(true);
          setPreserveEmptyObject(false);
          onChange(replacementOriginal);
          onValidityChange(true);
        }}>{zh ? '取消替换' : 'Cancel replacement'}</button>
        <button type="button" disabled={!isSimpleSchemaRowsValid(rows)} onClick={() => {
          const names = rows.map((row) => row.name.trim());
          const normalizedRows = rows.map((row, index) => ({ ...row, name: names[index]! }));
          setRows(normalizedRows);
          setReplacementMode(false);
          setReplacementOriginal(null);
          setError('');
          onChange(buildSimpleSchema(normalizedRows, preserveEmptyObject));
          onValidityChange(true);
        }}>{zh ? '应用可视化替换' : 'Apply visual replacement'}</button>
      </div>
    </div>}
    <p>{zh ? '逐项定义字段；Metis 会生成严格结构，不需要直接编写 JSON。' : 'Define fields one by one. Metis builds a strict schema without raw JSON editing.'}</p>
    <div className="personalization-schema-fields">
      {rows.map((row, index) => <div className="personalization-schema-field" key={`schema-field-${index}`}>
        <label><span>{zh ? '字段名' : 'Field name'}</span><input value={row.name} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /></label>
        <label><span>{zh ? '类型' : 'Type'}</span><select value={row.type} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as SimpleSchemaFieldType } : item))}>{SIMPLE_SCHEMA_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option[zh ? 'zh' : 'en']}</option>)}</select></label>
        <label className="personalization-schema-field__description"><span>{zh ? '说明' : 'Description'}</span><input value={row.description} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} /></label>
        <label className="personalization-schema-field__required"><input type="checkbox" checked={row.required} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />{zh ? '必填' : 'Required'}</label>
        <button type="button" onClick={() => commit(rows.filter((_item, itemIndex) => itemIndex !== index))}>{zh ? '删除' : 'Remove'}</button>
      </div>)}
    </div>
    {error && <p className="personalization-schema-error" role="alert">{error}</p>}
    <button type="button" onClick={() => {
      let ordinal = rows.length + 1;
      while (rows.some((row) => row.name === `field_${ordinal}`)) ordinal += 1;
      commit([...rows, { name: `field_${ordinal}`, type: 'string', description: '', required: false }]);
    }}>{zh ? '添加字段' : 'Add field'}</button>
  </fieldset>;
}

function ExtensionInstaller({
  kind,
  definitions,
  onInstalled,
  onRefresh,
}: {
  kind: 'skill' | 'mcp';
  definitions: readonly PersonalizationDefinition[];
  onInstalled: (definitionId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [mode, setMode] = useState<'skill_package' | 'skill_url' | 'mcp_requirements' | 'mcp_url'>(
    kind === 'skill' ? 'skill_package' : 'mcp_requirements',
  );
  const [url, setUrl] = useState('');
  const [mcpName, setMcpName] = useState(zh ? '我的 MCP' : 'My MCP');
  const [requirement, setRequirement] = useState('');
  const [expectedVersion, setExpectedVersion] = useState('');
  const [expectedDigest, setExpectedDigest] = useState('');
  const [targetDefinitionId, setTargetDefinitionId] = useState('');
  const [sourceCapabilityId, setSourceCapabilityId] = useState<string | null>(null);
  const [sourceDisplayName, setSourceDisplayName] = useState('');
  const [sourceCapabilityKind, setSourceCapabilityKind] = useState<'file' | 'folder' | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const mcpLocalId = localId(mcpName, 'my-mcp');
  const derivedMcpDefinitionId = mode === 'mcp_url' ? `url:mcp/${mcpLocalId}` : `generated:mcp/${mcpLocalId}`;
  const targetCandidates = definitions.filter((definition) => {
    if (definition.kind !== kind) return false;
    if (kind === 'skill') {
      return mode === 'skill_url'
        ? definition.id.startsWith('url:skills/')
        : definition.id.startsWith('user:skills/');
    }
    return mode === 'mcp_url'
      ? definition.id.startsWith('url:mcp/')
      : definition.id.startsWith('generated:mcp/');
  });
  const automaticTarget = targetDefinitionId
    ? null
    : mode === 'skill_url'
      ? targetCandidates.find((definition) => definition.provenance.sourceUrl === url.trim()) ?? null
      : kind === 'mcp'
        ? targetCandidates.find((definition) => definition.id === derivedMcpDefinitionId) ?? null
        : null;
  const targetDefinition = targetCandidates.find((definition) => definition.id === targetDefinitionId)
    ?? automaticTarget;
  const expectedRevision = targetDefinition?.revision ?? 0;
  const definitionId = kind === 'mcp' && targetDefinition ? targetDefinition.id : derivedMcpDefinitionId;
  const packageId = mcpLocalId;

  const changeMode = (nextMode: typeof mode) => {
    setMode(nextMode);
    setTargetDefinitionId('');
    setStatus('');
  };

  const selectPackage = async (kind: 'file' | 'folder') => {
    setSourceCapabilityId(null);
    setSourceDisplayName('');
    setSourceCapabilityKind(null);
    const purpose = kind === 'folder'
      ? 'personalization-skill-directory' as const
      : 'personalization-skill-package' as const;
    try {
      const selected = await window.metis?.selectFileCapability?.(purpose);
      const expectedOperation = kind === 'folder' ? 'folder' : 'file';
      if (!selected?.success
        || selected.capability.kind !== kind
        || !selected.capability.operations.includes(expectedOperation)) {
        setStatus(kind === 'folder'
          ? (zh ? '未选择有效的技能文件夹' : 'No valid skill folder was selected')
          : (zh ? '未选择有效的技能 ZIP 包' : 'No valid skill ZIP package was selected'));
        return;
      }
      setSourceCapabilityId(selected.capability.capabilityId);
      setSourceDisplayName(selected.capability.displayName);
      setSourceCapabilityKind(kind);
      setStatus('');
    } catch {
      setStatus(zh
        ? '无法打开文件选择器，请重试。'
        : 'The file picker could not be opened. Try again.');
    }
  };

  const install = async () => {
    const apply = window.metis?.applyPersonalizationExtension;
    if (!apply) {
      setStatus(zh ? '扩展安装服务不可用' : 'Extension installation service is unavailable');
      return;
    }
    const trimmedUrl = url.trim();
    const digestIsValid = expectedDigest.length === 0 || /^[a-f0-9]{64}$/u.test(expectedDigest);
    if ((mode === 'skill_url' || mode === 'mcp_url')) {
      try {
        const parsed = new URL(trimmedUrl);
        const allowedProtocol = mode === 'mcp_url' ? parsed.protocol === 'https:' : ['https:', 'http:'].includes(parsed.protocol);
        if (!allowedProtocol || parsed.username || parsed.password) throw new Error('unsupported URL');
      } catch {
        setStatus(zh ? '请输入不含凭据的有效 HTTP(S) 地址；MCP 地址必须使用 HTTPS。' : 'Enter a valid credential-free HTTP(S) URL; MCP URLs must use HTTPS.');
        return;
      }
    }
    if (!digestIsValid) {
      setStatus(zh ? 'SHA-256 必须是 64 位小写十六进制字符。' : 'SHA-256 must contain exactly 64 lowercase hexadecimal characters.');
      return;
    }
    if (mode === 'mcp_requirements' && !requirement.trim()) {
      setStatus(zh ? '请先说明你需要 MCP 完成的任务。' : 'Describe what the MCP should do first.');
      return;
    }
    if ((mode === 'mcp_requirements' || mode === 'mcp_url') && !mcpName.trim()) {
      setStatus(zh ? '请先为 MCP 填写一个名称。' : 'Give the MCP a name first.');
      return;
    }
    setBusy(true);
    setStatus('');
    const operationId = crypto.randomUUID();
    const common = { contractVersion: 1 as const, operationId, expectedRevision };
    const request = mode === 'skill_package'
      ? sourceCapabilityId ? {
          ...common,
          mode,
          sourceCapabilityId,
          expectedId: targetDefinition?.id ?? null,
        } as const : null
      : mode === 'skill_url'
        ? {
            ...common,
            mode,
            url: trimmedUrl,
            expectedArchiveSha256: expectedDigest || null,
            expectedId: targetDefinition?.id ?? null,
            expectedVersion: expectedVersion || null,
          } as const
        : mode === 'mcp_requirements'
          ? {
              ...common,
              mode,
              definitionId,
              requirement: requirement.trim(),
              requestedPackageId: packageId,
              runProbe: true,
            } as const
          : {
              ...common,
              mode,
              definitionId,
              manifestUrl: trimmedUrl,
              expectedManifestSha256: expectedDigest || null,
            } as const;
    if (!request) {
      setBusy(false);
      setStatus(zh ? '请先选择技能 ZIP 包或技能文件夹' : 'Choose a skill ZIP package or folder first');
      return;
    }
    try {
      const result = await apply(request);
      if (!result.ok) {
        if (result.code === 'definition_rejected' && result.detailCode === 'definition_cas_failed') {
          if (mode === 'skill_package') {
            setSourceCapabilityId(null);
            setSourceDisplayName('');
            setSourceCapabilityKind(null);
            setTargetDefinitionId('');
          }
          await onRefresh();
          setStatus(mode === 'skill_package'
            ? (zh
                ? '该技能已在其他位置更新。Metis 已载入最新版本；请重新选择安装目标和技能包后重试。'
                : 'This Skill changed elsewhere. Metis loaded the latest version; select the target and skill package again to retry.')
            : (zh
                ? '配置已在其他位置更新。Metis 已载入最新版本，请检查后重试。'
                : 'This configuration changed elsewhere. Metis loaded the latest version; review it and try again.'));
          return;
        }
        setStatus(`${zh ? '安装失败' : 'Installation failed'}: ${result.code}${result.detailCode ? ` / ${result.detailCode}` : ''}`);
        return;
      }
      setStatus(zh ? '已安装并写入不可伪造的来源记录' : 'Installed with a signed, non-authoritative source record');
      await onInstalled(result.definition.id);
    } catch {
      setStatus(zh
        ? '安装未完成：无法连接主进程安装服务，可修改后重试。'
        : 'Installation did not complete: the main-process installer could not be reached. You can revise the input and retry.');
    } finally {
      setBusy(false);
    }
  };

  const modeOptions = kind === 'skill'
    ? [['skill_package', zh ? '上传技能包' : 'Upload skill package'], ['skill_url', zh ? '从 URL / GitHub 安装' : 'Install from URL / GitHub']] as const
    : [['mcp_requirements', zh ? '描述需求，由 Metis 构建' : 'Describe requirements for Metis Builder'], ['mcp_url', zh ? '从 MCP 地址安装' : 'Install from MCP URL']] as const;

  return <section className="personalization-installer" aria-label={zh ? '安全扩展安装器' : 'Secure extension installer'}>
    <div className="personalization-installer__header">
      <div><span className="personalization-eyebrow">{kind === 'skill' ? (zh ? '技能' : 'SKILL') : 'MCP'}</span><h2>{zh ? '安装与构建' : 'Install and build'}</h2></div>
      <span>{zh ? '所有来源先验证、再保存；安装结果不能伪造“已核验”状态。' : 'Sources are verified before persistence and can never forge a verified truth state.'}</span>
    </div>
    <label><span>{zh ? '模式' : 'Mode'}</span><select value={mode} onChange={(event) => changeMode(event.target.value as typeof mode)}>{modeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label><span>{zh ? '安装目标' : 'Installation target'}</span><select value={targetDefinition?.id ?? ''} onChange={(event) => setTargetDefinitionId(event.target.value)}><option value="">{zh ? '安装为新定义' : 'Install as a new definition'}</option>{targetCandidates.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}</select></label>
    <p className="personalization-installer__mode-help">{targetDefinition
      ? (zh ? `将更新“${targetDefinition.name}”；Metis 会自动绑定当前保存版本。` : `Updating “${targetDefinition.name}”. Metis binds the current saved version automatically.`)
      : (zh ? '将创建新定义；无需填写内部修订号。' : 'A new definition will be created; no internal revision number is required.')}</p>
    <p className="personalization-installer__mode-help">{mode === 'skill_package'
      ? (zh ? 'ZIP 适合完整技能包；文件夹适合本地开发中的文档、脚本与资源集合。' : 'ZIP is for portable packages; folders are for locally developed documents, scripts, and assets.')
      : mode === 'skill_url'
        ? (zh ? '粘贴 GitHub 或技能包直链，Metis 会下载、核验再安装。' : 'Paste a GitHub or package URL. Metis downloads, verifies, then installs it.')
        : mode === 'mcp_requirements'
          ? (zh ? '用自然语言说明工具需求，Metis Builder 会构建、验证并注册 MCP。' : 'Describe the tool in natural language. Metis Builder constructs, validates, and registers the MCP.')
          : (zh ? '粘贴 MCP 清单的 HTTPS 地址，核验通过后才启用。' : 'Paste an HTTPS MCP manifest URL. It is enabled only after verification.')}</p>
    {mode === 'skill_package' && <div className="personalization-package-picker">
      <button type="button" onClick={() => void selectPackage('file')}>{zh ? '选择 ZIP 技能包' : 'Choose skill ZIP package'}</button>
      <button type="button" onClick={() => void selectPackage('folder')}>{zh ? '选择技能文件夹' : 'Choose skill folder'}</button>
      <span>{sourceDisplayName
        ? `${sourceCapabilityKind === 'folder' ? (zh ? '文件夹' : 'Folder') : 'ZIP'}: ${sourceDisplayName}`
        : (zh ? '尚未选择' : 'Nothing selected')}</span>
    </div>}
    {(mode === 'skill_url' || mode === 'mcp_url') && <label><span>{mode === 'skill_url' ? (zh ? '技能包 URL / GitHub 地址' : 'Skill package URL / GitHub address') : (zh ? 'MCP 清单 HTTPS 地址' : 'MCP manifest HTTPS URL')}</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /></label>}
    {mode === 'skill_url' && <label><span>{zh ? '预期版本（可选）' : 'Expected version (optional)'}</span><input value={expectedVersion} onChange={(event) => setExpectedVersion(event.target.value)} placeholder="1.0.0" /></label>}
    {mode === 'mcp_requirements' && <><label><span>{zh ? 'MCP 名称' : 'MCP name'}</span><input value={mcpName} maxLength={100} onChange={(event) => setMcpName(event.target.value)} /></label><label><span>{zh ? '说明你需要 MCP 做什么' : 'Describe what the MCP must do'}</span><textarea rows={6} value={requirement} onChange={(event) => setRequirement(event.target.value)} /></label><p className="personalization-derived-id">{zh ? '安装后名称' : 'Installed as'}: <strong>{mcpName.trim() || (zh ? '未命名 MCP' : 'Unnamed MCP')}</strong></p></>}
    {mode === 'mcp_url' && <><label><span>{zh ? 'MCP 名称' : 'MCP name'}</span><input value={mcpName} maxLength={100} onChange={(event) => setMcpName(event.target.value)} /></label><p className="personalization-derived-id">{zh ? '安装后名称' : 'Installed as'}: <strong>{mcpName.trim() || (zh ? '未命名 MCP' : 'Unnamed MCP')}</strong></p></>}
    {(mode === 'skill_url' || mode === 'mcp_url') && <label><span>{zh ? '预期 SHA-256（可选）' : 'Expected SHA-256 (optional)'}</span><input value={expectedDigest} onChange={(event) => setExpectedDigest(event.target.value.trim().toLowerCase())} /></label>}
    <div className="personalization-actions"><button className="btn-primary" type="button" disabled={busy} onClick={() => void install()}>{busy ? (zh ? '处理中…' : 'Working…') : (zh ? '验证并安装' : 'Verify and install')}</button><span role="status" aria-live="polite">{status}</span></div>
  </section>;
}

function SecretVaultPanel() {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [revision, setRevision] = useState(0);
  const [secrets, setSecrets] = useState<Array<{ name: string; createdAt: number; updatedAt: number }>>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = window.metis?.listPersonalizationSecrets;
    if (!list) {
      setStatus(zh ? '加密凭据库不可用' : 'Encrypted credential vault is unavailable');
      return;
    }
    try {
      const response = await list({ contractVersion: 1, operationId: crypto.randomUUID() });
      if (!response.ok) {
        setStatus(`${zh ? '无法读取凭据元数据' : 'Credential metadata unavailable'}: ${response.code}`);
        return;
      }
      setRevision(response.revision);
      setSecrets(response.secrets);
      setStatus('');
    } catch {
      setStatus(zh ? '无法连接加密凭据库，请重试。' : 'The encrypted credential vault could not be reached. Try again.');
    }
  }, [zh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; };
  }, [load]);

  const save = async () => {
    const setSecret = window.metis?.setPersonalizationSecret;
    if (!setSecret) return;
    setBusy(true);
    try {
      const response = await setSecret({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        name: name.trim(),
        value,
      });
      if (!response.ok) {
        setStatus(`${zh ? '保存失败' : 'Save failed'}: ${response.code}`);
        if (response.code === 'revision_conflict') await load();
        return;
      }
      setValue('');
      setName('');
      setRevision(response.revision);
      setStatus(zh ? '凭据已由操作系统加密保存；值不会回显' : 'Credential encrypted by the operating system; values are never displayed');
      await load();
    } catch {
      setStatus(zh ? '保存未完成，凭据值仍保留在输入框中，可直接重试。' : 'Save did not complete. The credential value remains in the field so you can retry.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secretName: string) => {
    const removeSecret = window.metis?.removePersonalizationSecret;
    if (!removeSecret) return;
    setBusy(true);
    try {
      const response = await removeSecret({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        name: secretName,
      });
      if (!response.ok) {
        setStatus(`${zh ? '删除失败' : 'Remove failed'}: ${response.code}`);
        if (response.code === 'revision_conflict') await load();
        return;
      }
      setRevision(response.revision);
      setStatus(zh ? '凭据已删除' : 'Credential removed');
      await load();
    } catch {
      setStatus(zh ? '删除未完成，请重试。' : 'Remove did not complete. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return <section className="personalization-installer" aria-label={zh ? '加密凭据库' : 'Encrypted credential vault'}>
    <div className="personalization-installer__header">
      <div><span className="personalization-eyebrow">{zh ? '凭据' : 'SECRETS'}</span><h2>{zh ? 'MCP 凭据' : 'MCP credentials'}</h2></div>
      <span>{zh ? '值仅在主进程通过系统安全存储加密；界面和配置包只使用 ${secret:NAME} 引用。' : 'Values are encrypted through OS secure storage in the main process; UI and bundles use only ${secret:NAME} references.'}</span>
    </div>
    <div className="personalization-grid personalization-grid--2">
      <label><span>{zh ? '环境变量名称' : 'Environment name'}</span><input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="ZOTERO_API_KEY" autoComplete="off" spellCheck={false} /></label>
      <label><span>{zh ? '凭据值' : 'Credential value'}</span><input type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" /></label>
    </div>
    <div className="personalization-actions"><button className="btn-primary" type="button" disabled={busy || !name.trim() || !value} onClick={() => void save()}>{zh ? '加密保存' : 'Save encrypted'}</button><span role="status" aria-live="polite">{status}</span></div>
    <div className="personalization-cards">
      {secrets.map((secret) => <article className="personalization-card" key={secret.name}>
        <div className="personalization-card__select"><strong>{secret.name}</strong><span>{zh ? '值已隐藏' : 'Value hidden'} · {new Date(secret.updatedAt).toLocaleString()}</span></div>
        <div className="personalization-card__actions"><button type="button" disabled={busy} onClick={() => void remove(secret.name)}>{zh ? '删除' : 'Remove'}</button></div>
      </article>)}
      {secrets.length === 0 && <p className="personalization-empty">{zh ? '还没有保存凭据。' : 'No credentials saved.'}</p>}
    </div>
  </section>;
}

function DefinitionEditor({
  definition,
  definitions,
  onSaved,
  onDraftStateChange,
  onQuickCreate,
}: {
  definition: PersonalizationDefinition;
  definitions: readonly PersonalizationDefinition[];
  onSaved: (saved?: PersonalizationDefinition) => Promise<void>;
  onDraftStateChange: (definitionId: string, retained: boolean) => void;
  /** 场景编辑器空状态里的「新建 X」跳转（创建后返回场景并重新选中）。 */
  onQuickCreate?: (kind: Kind) => void;
}) {
  const { locale, t } = useTranslation();
  const zh = locale === 'zh';
  const [initialDraftState] = useState(() => {
    const fresh = editableCopy(definition);
    const retained = readPersonalizationDraft(definition);
    return { fresh, draft: retained ?? fresh, restored: retained !== null };
  });
  const [draft, setDraft] = useState<PersonalizationDefinition>(initialDraftState.draft);
  const [inputSchemaValid, setInputSchemaValid] = useState(
    initialDraftState.draft.kind !== 'skill'
      || (readInvalidSimpleSchemaDraft(initialDraftState.draft.inputSchema) === null
        && readSimpleSchemaReplacementDraft(initialDraftState.draft.inputSchema) === null),
  );
  const [outputSchemaValid, setOutputSchemaValid] = useState(
    initialDraftState.draft.kind !== 'skill'
      || (readInvalidSimpleSchemaDraft(initialDraftState.draft.outputSchema) === null
        && readSimpleSchemaReplacementDraft(initialDraftState.draft.outputSchema) === null),
  );
  const baselineSignatureRef = useRef(JSON.stringify(initialDraftState.fresh));
  const baseDefinitionRef = useRef(definition);
  const latestDraftRef = useRef(initialDraftState.draft);
  const observedDraftRef = useRef(initialDraftState.draft);
  const draftPersistenceTimerRef = useRef<number | null>(null);
  const draftPersistencePendingRef = useRef(false);
  const savedRevisionReloadPendingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draftRetention, setDraftRetention] = useState<'preserved' | 'restored' | null>(
    initialDraftState.restored ? 'restored' : null,
  );
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<PersonalizationVersionView[]>([]);

  const definitionName = (id: string): string => definitions.find((item) => item.id === id)?.name ?? id;

  const loadVersions = useCallback(async () => {
    try {
      const response = await window.metis?.listPersonalizationVersions?.({ contractVersion: 1, id: definition.id });
      setVersions(response?.versions ?? []);
    } catch {
      setVersions([]);
      setStatus(zh ? '无法读取版本历史，但当前草稿仍可编辑。' : 'Version history could not be loaded, but the current draft remains editable.');
    }
  }, [definition.id, zh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void loadVersions(); });
    return () => { cancelled = true; };
  }, [loadVersions]);

  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    const stackedLayout = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1120px)').matches
      : window.innerWidth <= 1120;
    if (stackedLayout && typeof heading.scrollIntoView === 'function') {
      heading.scrollIntoView({ block: 'start', inline: 'nearest' });
    }
  }, [definition.id, definition.revision]);

  const flushPendingDraft = useCallback((updateEditorState = true) => {
    if (draftPersistenceTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceTimerRef.current);
      draftPersistenceTimerRef.current = null;
    }
    if (!draftPersistencePendingRef.current) return;
    draftPersistencePendingRef.current = false;

    const baseDefinition = baseDefinitionRef.current;
    const latestDraft = latestDraftRef.current;
    const draftSignature = personalizationDefinitionSignature(latestDraft);
    if (draftSignature === baselineSignatureRef.current) {
      clearPersonalizationDraft(baseDefinition.id);
      onDraftStateChange(baseDefinition.id, false);
      if (updateEditorState) setDraftRetention(null);
      return;
    }
    writePersonalizationDraft(baseDefinition, latestDraft);
    onDraftStateChange(baseDefinition.id, true);
    if (updateEditorState) setDraftRetention('preserved');
  }, [onDraftStateChange]);

  useEffect(() => {
    latestDraftRef.current = draft;
    if (observedDraftRef.current === draft) return;
    observedDraftRef.current = draft;
    draftPersistencePendingRef.current = true;
    if (draftPersistenceTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceTimerRef.current);
    }
    onDraftStateChange(definition.id, true);
    setDraftRetention('preserved');
    if (savedRevisionReloadPendingRef.current) {
      flushPendingDraft(true);
      return;
    }
    draftPersistenceTimerRef.current = window.setTimeout(() => {
      flushPendingDraft(true);
    }, PERSONALIZATION_DRAFT_DEBOUNCE_MS);
  }, [definition.id, draft, flushPendingDraft, onDraftStateChange]);

  useEffect(() => () => {
    flushPendingDraft(false);
  }, [flushPendingDraft]);

  const finishSuccessfulMutation = async (
    submittedSignature: string,
    savedDefinition: PersonalizationDefinition,
  ) => {
    flushPendingDraft(false);
    const parsedSavedDefinition = PersonalizationDefinitionSchema.safeParse(savedDefinition);
    if (!parsedSavedDefinition.success) {
      await onSaved();
      return;
    }
    const persistedDefinition = parsedSavedDefinition.data;
    const retained = latestDraftRef.current;
    const hasNewerEdits = personalizationDefinitionSignature(retained) !== submittedSignature;
    const nextDraft = hasNewerEdits
      ? rebasePersonalizationDraft(persistedDefinition, retained)
      : editableCopy(persistedDefinition);

    baseDefinitionRef.current = persistedDefinition;
    baselineSignatureRef.current = personalizationDefinitionSignature(editableCopy(persistedDefinition));
    latestDraftRef.current = nextDraft;
    observedDraftRef.current = nextDraft;
    setDraft(nextDraft);
    if (hasNewerEdits) {
      writePersonalizationDraft(persistedDefinition, nextDraft);
      onDraftStateChange(persistedDefinition.id, true);
      setDraftRetention('preserved');
    } else {
      clearPersonalizationDraft(persistedDefinition.id);
      onDraftStateChange(persistedDefinition.id, false);
      setDraftRetention(null);
    }
    savedRevisionReloadPendingRef.current = true;
    try {
      await onSaved(persistedDefinition);
    } finally {
      savedRevisionReloadPendingRef.current = false;
    }
  };

  const updateCommon = (patch: Partial<Pick<PersonalizationDefinition, 'name' | 'description' | 'enabled'>>) => {
    setDraft((current) => ({ ...current, ...patch } as PersonalizationDefinition));
  };

  const updateWorkflowStep = (index: number, patch: Partial<ScenarioDefinition['workflow'][number]>) => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      const previousId = current.workflow[index]?.id;
      const nextId = patch.id;
      return {
        ...current,
        workflow: current.workflow.map((step, stepIndex) => {
          const updatedStep = stepIndex === index ? { ...step, ...patch } : step;
          if (!previousId || nextId === undefined || nextId === previousId) return updatedStep;
          return {
            ...updatedStep,
            dependsOn: updatedStep.dependsOn.map((dependencyId) => dependencyId === previousId ? nextId : dependencyId),
          };
        }),
      };
    });
  };

  const addWorkflowStep = () => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      const stepNumber = current.workflow.reduce((maximum, step) => {
        const match = /^step-(\d+)$/u.exec(step.id);
        if (!match) return maximum;
        const suffix = Number(match[1]);
        return Number.isSafeInteger(suffix) ? Math.max(maximum, suffix) : maximum;
      }, current.workflow.length) + 1;
      const firstAgentId = current.agentIds[0] ?? '';
      if (!firstAgentId) {
        setStatus(zh ? '请先从“用于此场景的智能体”中选择至少一个智能体' : 'Choose at least one agent for this scenario first');
        return current;
      }
      return {
        ...current,
        workflow: [...current.workflow, {
          id: `step-${stepNumber}`,
          name: zh ? `步骤 ${stepNumber}` : `Step ${stepNumber}`,
          description: '',
          agentId: firstAgentId,
          skillIds: [],
          toolIds: [],
          mcpIds: [],
          dependsOn: current.workflow.length ? [current.workflow[current.workflow.length - 1]?.id ?? ''] : [],
          maxTurns: 12,
        }],
      };
    });
  };

  const removeWorkflowStep = (index: number) => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      const removedId = current.workflow[index]?.id;
      if (!removedId) return current;
      return {
        ...current,
        workflow: current.workflow
          .filter((_step, stepIndex) => stepIndex !== index)
          .map((step) => ({
            ...step,
            dependsOn: step.dependsOn.filter((dependencyId) => dependencyId !== removedId),
          })),
      };
    });
  };

  const save = async () => {
    if (draft.kind === 'skill' && (!inputSchemaValid || !outputSchemaValid)) {
      setStatus(zh
        ? '请先修正字段名称；当前编辑已保留，但不会提交旧结构。'
        : 'Correct the field names first. Your edits are preserved and the previous schema will not be submitted.');
      return;
    }
    if (draft.kind === 'rules' && draft.scope === 'project') {
      setStatus(zh
        ? '普通项目规则定义不是权威项目 Metis.md；请先转换为全局或场景规则。'
        : 'A regular project-scoped definition is not authoritative; convert it to global or scenario first.');
      return;
    }
    if ((draft.kind === 'agent' || draft.kind === 'scenario')
      && draft.output.plan != null
      && !draft.output.plan.primaryDeliverable.trim()) {
      setStatus(t('personalization.outputPrimaryRequiredSave'));
      return;
    }
    if (!window.metis?.savePersonalization) {
      setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable');
      return;
    }
    flushPendingDraft(false);
    const submittedSignature = personalizationDefinitionSignature(draft);
    setSaving(true);
    try {
      if (draft.kind === 'skill' && draft.sourceMode === 'markdown' && window.metis.applyPersonalizationExtension) {
        const result = await window.metis.applyPersonalizationExtension({
        contractVersion: 1,
        mode: 'skill_markdown',
        operationId: crypto.randomUUID(),
        expectedRevision: definition.revision,
        id: draft.id,
        name: draft.name,
        description: draft.description,
        author: draft.provenance.author,
        version: draft.provenance.version,
        markdown: draft.markdown,
        toolIds: draft.toolIds,
        mcpIds: draft.mcpIds,
        tags: draft.tags,
        maxTurns: draft.maxTurns,
        inputSchema: draft.inputSchema,
        outputSchema: draft.outputSchema,
      });
        setStatus(result.ok
          ? (zh ? '已保存，并写入签名来源记录' : 'Saved with a signed source record')
          : `${zh ? '保存失败' : 'Save failed'}: ${result.code}`);
        if (result.ok) {
          await finishSuccessfulMutation(submittedSignature, result.definition);
        }
        return;
      }
      const result = await window.metis.savePersonalization({
        contractVersion: 1,
        definition: draft,
        expectedRevision: definition.revision,
      });
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await finishSuccessfulMutation(submittedSignature, result.definition);
      }
    } catch {
      setStatus(zh
        ? '保存未完成：无法连接个性化服务，你的本地编辑已保留。'
        : 'Save did not complete: the personalization service could not be reached. Your local edits are preserved.');
    } finally {
      setSaving(false);
    }
  };

  const restore = async (sourceRevision: number) => {
    flushPendingDraft(false);
    const submittedSignature = personalizationDefinitionSignature(draft);
    try {
      const result = await window.metis?.restorePersonalization?.({
        contractVersion: 1,
        id: definition.id,
        sourceRevision,
        expectedRevision: definition.revision,
      });
      if (!result) {
        setStatus(zh ? '版本恢复服务不可用。' : 'Version restore service is unavailable.');
        return;
      }
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await finishSuccessfulMutation(submittedSignature, result.definition);
      }
    } catch {
      setStatus(zh ? '版本恢复未完成，当前内容未改变。' : 'Version restore did not complete; the current content is unchanged.');
    }
  };

  const presentationReserved = draft.kind === 'scenario'
    && draft.capability === 'presentation_reserved';
  const nonAuthoritativeProjectRule = draft.kind === 'rules' && draft.scope === 'project';
  const schemaEditorsValid = draft.kind !== 'skill' || (inputSchemaValid && outputSchemaValid);
  // UX: 场景的「最终交付物」只保留一个普通文本字段，避免复杂的输出计划表单。
  const scenarioDeliverable = draft.kind === 'scenario'
    ? (draft.output.plan?.primaryDeliverable ?? '')
    : '';
  const updateScenarioDeliverable = (value: string) => {
    if (draft.kind !== 'scenario') return;
    const next = value.trim();
    const existing = draft.output.plan;
    setDraft({
      ...draft,
      output: {
        ...draft.output,
        plan: next
          ? {
              primaryDeliverable: next,
              supportingArtifacts: existing?.supportingArtifacts ?? [],
              qualityCriteria: existing?.qualityCriteria ?? [],
            }
          : null,
      },
    });
  };

  return (
    <section className="personalization-editor" aria-label={zh ? '定义编辑器' : 'Definition editor'}>
      <div className="personalization-editor__header">
        <div>
          <span className="personalization-eyebrow">{KIND_LABELS[zh ? 'zh' : 'en'][draft.kind]}</span>
          <h2 ref={headingRef} tabIndex={-1}>{draft.name}</h2>
          <code>{draft.id}</code>
        </div>
        <div className="personalization-editor__header-actions">
          <span className="personalization-revision">r{definition.revision}</span>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || !draft.name.trim() || nonAuthoritativeProjectRule || !schemaEditorsValid}
            onClick={() => void save()}
          >
            {saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}
          </button>
        </div>
      </div>
      <p className="personalization-draft-notice" role="status" aria-live="polite">
        {draftRetention === 'restored'
          ? (zh ? '已恢复保留的草稿' : 'Preserved draft restored')
          : draftRetention === 'preserved'
            ? (zh ? '草稿已自动保留' : 'Draft preserved automatically')
            : ''}
      </p>
      <label>
        <span>{zh ? '名称' : 'Name'}</span>
        <input value={draft.name} maxLength={200} onChange={(event) => updateCommon({ name: event.target.value })} />
      </label>
      <label>
        <span>{zh ? '说明' : 'Description'}</span>
        <textarea value={draft.description} rows={3} maxLength={4000} onChange={(event) => updateCommon({ description: event.target.value })} />
      </label>
      {!presentationReserved && <label className="personalization-switch">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => updateCommon({ enabled: event.target.checked })} />
        <span>{zh ? '启用此定义' : 'Enable this definition'}</span>
      </label>}

      {presentationReserved && <div className="personalization-boundary" role="note">
        <strong>{zh ? 'PPT 场景仅保留空间' : 'Presentation scenario is reserved only'}</strong>
        <span>{zh
          ? '在你确认 PPT 产品方案之前，这里只允许修改名称与说明，不会启用或挂载智能体、技能、MCP、触发词与工作流。'
          : 'Until its product specification is approved, only the name and description may be edited. Agents, Skills, MCPs, triggers, and workflows remain unavailable.'}</span>
      </div>}

      {draft.kind === 'skill' && <>
        <div className="personalization-boundary" role="note"><strong>{zh ? 'Markdown 技能直接编辑' : 'Direct Markdown skill editing'}</strong><span>{zh ? '这里适合编写或修改单文件技能。ZIP、文件夹和 GitHub / URL 技能请使用上方安装器，来源与脚本才能一起保存。' : 'Use this editor for a single-file skill. Install ZIP, folder, or GitHub / URL skills through the installer above so their source and scripts are preserved together.'}</span></div>
        <label><span>{zh ? '技能 Markdown' : 'Skill Markdown'}</span><textarea rows={16} value={draft.markdown} onChange={(event) => setDraft({ ...draft, markdown: event.target.value })} /></label>
        <label><span>{zh ? '系统指令' : 'System instructions'}</span><textarea rows={8} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} /></label>
        <label><span>{zh ? '允许的工具 ID（逗号或换行）' : 'Allowed tool IDs (comma or newline)'}</span><textarea rows={3} value={csv(draft.toolIds)} onChange={(event) => setDraft({ ...draft, toolIds: parseCsv(event.target.value) })} /></label>
        <DefinitionReferencePicker label={zh ? '允许此技能使用的 MCP' : 'MCP available to this skill'} help={zh ? '按名称选择；不需要手工复制 ID。' : 'Choose by name; no ID copying is required.'} kind="mcp" definitions={definitions} selectedIds={draft.mcpIds} onChange={(mcpIds) => setDraft({ ...draft, mcpIds })} emptyLabel={zh ? '还没有可用的 MCP。' : 'No MCP definitions are available.'} />
        <label><span>{zh ? '最大轮次' : 'Maximum turns'}</span><input type="number" min={1} max={100} value={draft.maxTurns} onChange={(event) => setDraft({ ...draft, maxTurns: boundedInteger(event.target.value, 1, 100, draft.maxTurns) })} /></label>
        <div className="personalization-grid personalization-grid--2">
          <SimpleSchemaEditor key={`${definition.id}:${definition.revision}:input`} label={zh ? '输入字段' : 'Input fields'} value={draft.inputSchema} onChange={(inputSchema) => setDraft({ ...draft, inputSchema })} onValidityChange={setInputSchemaValid} zh={zh} />
          <SimpleSchemaEditor key={`${definition.id}:${definition.revision}:output`} label={zh ? '输出字段' : 'Output fields'} value={draft.outputSchema} onChange={(outputSchema) => setDraft({ ...draft, outputSchema })} onValidityChange={setOutputSchemaValid} zh={zh} />
        </div>
      </>}

      {draft.kind === 'agent' && <>
        <label><span>{zh ? '角色' : 'Role'}</span><input value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
        <label><span>{zh ? '智能体系统指令' : 'Agent system instructions'}</span><textarea rows={14} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} /></label>
        <DefinitionReferencePicker label={zh ? '此智能体使用的技能' : 'Skills used by this agent'} help={zh ? '选择已启用的技能，保存后随智能体生效。' : 'Select enabled skills to bind to this agent.'} kind="skill" definitions={definitions} selectedIds={draft.skillIds} onChange={(skillIds) => setDraft({ ...draft, skillIds })} emptyLabel={zh ? '还没有可用技能。' : 'No skills are available.'} />
        <label><span>{zh ? '允许的工具 ID' : 'Allowed tool IDs'}</span><textarea rows={3} value={csv(draft.toolIds)} onChange={(event) => setDraft({ ...draft, toolIds: parseCsv(event.target.value) })} /></label>
        <DefinitionReferencePicker label={zh ? '此智能体使用的 MCP' : 'MCP used by this agent'} help={zh ? '只显示已启用或已经选中的 MCP。' : 'Only enabled or already-selected MCP definitions are shown.'} kind="mcp" definitions={definitions} selectedIds={draft.mcpIds} onChange={(mcpIds) => setDraft({ ...draft, mcpIds })} emptyLabel={zh ? '还没有可用 MCP。' : 'No MCP definitions are available.'} />
        <div className="personalization-grid personalization-grid--3">
          <label><span>{zh ? '模型偏好（可空）' : 'Model preference (optional)'}</span><input value={draft.modelPreference ?? ''} onChange={(event) => setDraft({ ...draft, modelPreference: event.target.value || null })} /></label>
          <label><span>{zh ? '最大轮次' : 'Maximum turns'}</span><input type="number" min={1} max={100} value={draft.maxTurns} onChange={(event) => setDraft({ ...draft, maxTurns: boundedInteger(event.target.value, 1, 100, draft.maxTurns) })} /></label>
          <label><span>{zh ? '重试次数' : 'Retry limit'}</span><input type="number" min={0} max={10} value={draft.retryLimit} onChange={(event) => setDraft({ ...draft, retryLimit: boundedInteger(event.target.value, 0, 10, draft.retryLimit) })} /></label>
        </div>
        <div className="personalization-grid personalization-grid--2">
          <label><span>{zh ? '记忆范围' : 'Memory scope'}</span><select value={draft.memory.scope} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, scope: event.target.value as AgentDefinition['memory']['scope'] } })}>{MEMORY_SCOPE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option[zh ? 'zh' : 'en']}</option>)}</select></label>
          <label><span>{zh ? '输出格式' : 'Output format'}</span><select value={draft.output.format} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, format: event.target.value as AgentDefinition['output']['format'] } })}>{OUTPUT_FORMAT_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option[zh ? 'zh' : 'en']}</option>)}</select></label>
          <label><span>{zh ? '记忆摘要上限' : 'Memory summary limit'}</span><input type="number" min={1000} max={500000} value={draft.memory.maxSummaryChars} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, maxSummaryChars: boundedInteger(event.target.value, 1000, 500000, draft.memory.maxSummaryChars) } })} /></label>
        </div>
        <div className="personalization-inline-checks">
          <label><input type="checkbox" checked={draft.memory.retainDecisions} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainDecisions: event.target.checked } })} />{zh ? '保留决策摘要' : 'Retain decision summaries'}</label>
          <label><input type="checkbox" checked={draft.memory.retainArtifacts} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainArtifacts: event.target.checked } })} />{zh ? '保留产物索引' : 'Retain artifact references'}</label>
        </div>
        <OutputPlanEditor output={draft.output} onChange={(output) => setDraft({ ...draft, output })} zh={zh} />
        <div className="personalization-truth-lock" role="note"><strong>{zh ? '真实性底座自动生效' : 'Truth controls apply automatically'}</strong><span>{zh ? '证据封装、完整性报告和状态校验不提供关闭开关。' : 'Evidence envelopes, integrity reports, and state validation cannot be disabled here.'}</span></div>
      </>}

      {draft.kind === 'scenario' && !presentationReserved && <>
        <div className="personalization-boundary">
          <strong>{zh ? '全权限运行' : 'Full Access'}</strong>
          <span>{zh ? '运行时不做逐步权限确认，允许用户随时发消息引导或打断。' : 'No per-action permission prompts; the user may steer or interrupt at any time.'}</span>
        </div>
        <DefinitionReferencePicker label={zh ? '用于此场景的智能体' : 'Agents for this scenario'} help={zh ? '选择后才能创建工作流步骤。' : 'Select agents before adding workflow steps.'} kind="agent" definitions={definitions} selectedIds={draft.agentIds} onChange={(agentIds) => setDraft({ ...draft, agentIds, workflow: draft.workflow.filter((step) => agentIds.includes(step.agentId)) })} emptyLabel={zh ? '还没有可用智能体。' : 'No agents are available.'} onCreate={onQuickCreate ? () => onQuickCreate('agent') : undefined} createLabel={zh ? '新建智能体' : 'Create an agent'} />
        <DefinitionReferencePicker label={zh ? '场景可使用的技能' : 'Skills available to this scenario'} help={zh ? '工作流步骤只能从这些技能中选择。' : 'Workflow steps can choose from this scenario-level set.'} kind="skill" definitions={definitions} selectedIds={draft.skillIds} onChange={(skillIds) => setDraft({ ...draft, skillIds, workflow: draft.workflow.map((step) => ({ ...step, skillIds: step.skillIds.filter((id) => skillIds.includes(id)) })) })} emptyLabel={zh ? '还没有可用技能。' : 'No skills are available.'} onCreate={onQuickCreate ? () => onQuickCreate('skill') : undefined} createLabel={zh ? '新建技能' : 'Create a skill'} />
        <DefinitionReferencePicker label={zh ? '场景可使用的 MCP' : 'MCP available to this scenario'} help={zh ? '工作流步骤只能从这些 MCP 中选择。' : 'Workflow steps can choose from this scenario-level set.'} kind="mcp" definitions={definitions} selectedIds={draft.mcpIds} onChange={(mcpIds) => setDraft({ ...draft, mcpIds, workflow: draft.workflow.map((step) => ({ ...step, mcpIds: step.mcpIds.filter((id) => mcpIds.includes(id)) })) })} emptyLabel={zh ? '还没有可用 MCP。' : 'No MCP definitions are available.'} onCreate={onQuickCreate ? () => onQuickCreate('mcp') : undefined} createLabel={zh ? '新建 MCP' : 'Create an MCP'} />
        <DefinitionReferencePicker label={zh ? '场景专属 Metis.md' : 'Scenario-specific Metis.md'} help={zh ? '全局 Metis.md 会自动生效；这里只选择绑定到该场景的规则。项目 Metis.md 由“当前项目 Metis.md”独立管理。' : 'Global Metis.md applies automatically. Select only scenario-bound rules here; project Metis.md is managed separately.'} kind="rules" definitions={definitions} selectedIds={draft.rulesIds} onChange={(rulesIds) => setDraft({ ...draft, rulesIds })} filter={(candidate) => candidate.kind === 'rules' && candidate.scope === 'scenario' && candidate.scopeId === draft.id} emptyLabel={zh ? '还没有绑定到此场景的 Metis.md。' : 'No Metis.md definition is bound to this scenario yet.'} onCreate={onQuickCreate ? () => onQuickCreate('rules') : undefined} createLabel={zh ? '新建 Metis.md' : 'Create a Metis.md'} />
        <div className="personalization-grid personalization-grid--2">
          <label><span>{zh ? '触发短语' : 'Trigger phrases'}</span><textarea rows={3} value={csv(draft.triggerPhrases)} onChange={(event) => setDraft({ ...draft, triggerPhrases: parseCsv(event.target.value) })} /></label>
          <label><span>{zh ? '记忆范围' : 'Memory scope'}</span><select value={draft.memory.scope} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, scope: event.target.value as ScenarioDefinition['memory']['scope'] } })}>{MEMORY_SCOPE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option[zh ? 'zh' : 'en']}</option>)}</select></label>
          <label><span>{zh ? '记忆摘要上限' : 'Memory summary limit'}</span><input type="number" min={1000} max={500000} value={draft.memory.maxSummaryChars} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, maxSummaryChars: boundedInteger(event.target.value, 1000, 500000, draft.memory.maxSummaryChars) } })} /></label>
        </div>
        <div className="personalization-inline-checks">
          <label><input type="checkbox" checked={draft.memory.retainDecisions} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainDecisions: event.target.checked } })} />{zh ? '保留场景决策摘要' : 'Retain scenario decisions'}</label>
          <label><input type="checkbox" checked={draft.memory.retainArtifacts} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainArtifacts: event.target.checked } })} />{zh ? '保留场景产物索引' : 'Retain scenario artifacts'}</label>
        </div>
        <details className="personalization-deliverable" open={Boolean(scenarioDeliverable)}>
          <summary>{zh ? '最终交付物（可选）' : 'Final deliverable (optional)'}</summary>
          <p className="personalization-deliverable__help">{zh ? '填写后，模型完成工作流后会按此汇总最终结果；不填则直接汇总最后一步的输出。' : 'If filled, the model summarizes the final result against this deliverable after the workflow finishes; otherwise the last step output is summarized.'}</p>
          <label><span>{zh ? '交付物描述' : 'Deliverable description'}</span><textarea rows={2} value={scenarioDeliverable} onChange={(event) => updateScenarioDeliverable(event.target.value)} placeholder={zh ? '例如：一份关于地方救济制度演变的综述报告' : 'e.g. A review report on the evolution of local relief systems'} /></label>
        </details>
        <div className="personalization-truth-lock" role="note"><strong>{zh ? '真实性底座自动生效' : 'Truth controls apply automatically'}</strong><span>{zh ? '证据封装、完整性报告、引用与来源状态不提供关闭开关。' : 'Evidence envelopes, integrity reports, citation checks, and source-state checks cannot be disabled here.'}</span></div>
        <div className="personalization-workflow">
          <div className="personalization-workflow__header"><div><strong>{zh ? '工作流步骤' : 'Workflow steps'}</strong><p>{draft.agentIds.length === 0 ? (zh ? '请先在「用于此场景的智能体」中选择至少一个智能体，然后才能添加步骤。' : 'Choose at least one agent for this scenario before adding steps.') : (zh ? '依赖关系决定真实执行顺序；失败步骤会阻断其下游。' : 'Dependencies define execution order; failed steps block downstream work.')}</p></div><button type="button" onClick={addWorkflowStep} disabled={draft.agentIds.length === 0} title={draft.agentIds.length === 0 ? (zh ? '请先选择智能体' : 'Choose an agent first') : undefined}>{zh ? '添加步骤' : 'Add step'}</button></div>
          {draft.workflow.map((step, index) => <article className="personalization-step" key={`${step.id}-${index}`}>
            <div className="personalization-step__title"><strong>{index + 1}. {step.name || step.id}</strong><button type="button" onClick={() => removeWorkflowStep(index)}>{zh ? '移除' : 'Remove'}</button></div>
            <div className="personalization-grid personalization-grid--2">
              <label><span>ID</span><input value={step.id} onChange={(event) => updateWorkflowStep(index, { id: event.target.value })} /></label>
              <label><span>{zh ? '名称' : 'Name'}</span><input value={step.name} onChange={(event) => updateWorkflowStep(index, { name: event.target.value })} /></label>
              <label><span>{zh ? '执行智能体' : 'Executing agent'}</span><select value={step.agentId} onChange={(event) => updateWorkflowStep(index, { agentId: event.target.value })}>{draft.agentIds.map((id) => <option value={id} key={id}>{definitionName(id)}</option>)}</select></label>
              <label><span>{zh ? '依赖步骤 ID' : 'Dependency step IDs'}</span><input value={csv(step.dependsOn)} onChange={(event) => updateWorkflowStep(index, { dependsOn: parseCsv(event.target.value) })} /></label>
            </div>
            <label><span>{zh ? '步骤说明' : 'Step description'}</span><textarea rows={2} value={step.description} onChange={(event) => updateWorkflowStep(index, { description: event.target.value })} /></label>
            <div className="personalization-grid personalization-grid--2">
              <DefinitionReferencePicker compact label={zh ? '步骤技能' : 'Step skills'} help={zh ? '从场景已允许的技能中选择。' : 'Choose from skills allowed by the scenario.'} kind="skill" definitions={definitions} selectedIds={step.skillIds} onChange={(skillIds) => updateWorkflowStep(index, { skillIds })} filter={(candidate) => draft.skillIds.includes(candidate.id)} emptyLabel={zh ? '请先为场景选择技能。' : 'Select scenario skills first.'} />
              <label><span>{zh ? '工具 ID' : 'Tool IDs'}</span><textarea rows={2} value={csv(step.toolIds)} onChange={(event) => updateWorkflowStep(index, { toolIds: parseCsv(event.target.value) })} /></label>
              <DefinitionReferencePicker compact label={zh ? '步骤 MCP' : 'Step MCP'} help={zh ? '从场景已允许的 MCP 中选择。' : 'Choose from MCP allowed by the scenario.'} kind="mcp" definitions={definitions} selectedIds={step.mcpIds} onChange={(mcpIds) => updateWorkflowStep(index, { mcpIds })} filter={(candidate) => draft.mcpIds.includes(candidate.id)} emptyLabel={zh ? '请先为场景选择 MCP。' : 'Select scenario MCP first.'} />
              <label><span>{zh ? '最大轮次' : 'Maximum turns'}</span><input type="number" min={1} max={100} value={step.maxTurns} onChange={(event) => updateWorkflowStep(index, { maxTurns: boundedInteger(event.target.value, 1, 100, step.maxTurns) })} /></label>
            </div>
          </article>)}
        </div>
      </>}

      {draft.kind === 'rules' && <>
        <div className="personalization-grid personalization-grid--2">
          <label><span>{zh ? '规则层级' : 'Rule scope'}</span><select value={draft.scope} onChange={(event) => {
            const scope = event.target.value as MetisRulesDefinition['scope'];
            setDraft({ ...draft, scope, scopeId: scope === 'global' ? null : draft.scopeId });
          }}>{RULE_SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option[zh ? 'zh' : 'en']}</option>)}{draft.scope === 'project' && <option value="project" disabled>{zh ? '项目（非权威旧定义）' : 'Project (legacy, non-authoritative)'}</option>}</select></label>
          {draft.scope === 'scenario' && <label><span>{zh ? '绑定场景' : 'Bound scenario'}</span><select value={draft.scopeId ?? ''} onChange={(event) => setDraft({ ...draft, scopeId: event.target.value || null })}><option value="">{zh ? '请选择场景' : 'Choose a scenario'}</option>{definitions.filter((candidate) => candidate.kind === 'scenario').map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>}
        </div>
        {draft.scope === 'project' && <div className="personalization-boundary" role="note"><strong>{zh ? '这不是权威项目 Metis.md' : 'This is not the authoritative project Metis.md'}</strong><span>{zh ? '请使用上方“打开当前项目 Metis.md”返回独立编辑器。也可将此旧定义转换为全局或场景规则后再保存。' : 'Use “Open current project Metis.md” above to return to its separate editor. You may also convert this legacy definition to global or scenario before saving.'}</span></div>}
        <label><span>Metis.md</span><textarea rows={20} value={draft.markdown} onChange={(event) => setDraft({ ...draft, markdown: event.target.value })} /></label>
      </>}

      {draft.kind === 'mcp' && <>
        <label><span>{zh ? 'MCP 来源模式' : 'MCP source mode'}</span><select value={draft.sourceMode} onChange={(event) => setDraft({ ...draft, sourceMode: event.target.value as McpDefinition['sourceMode'] })}><option value="generated">{zh ? '描述需求，由 Metis 构建' : 'Describe requirements; Metis builds it'}</option><option value="url">{zh ? 'URL / GitHub 地址' : 'URL / GitHub'}</option></select></label>
        <div className="personalization-boundary"><strong>{zh ? '托管运行时' : 'Managed runtime'}</strong><span>{zh ? '启动程序、参数和工作目录由已验证安装记录决定，不能在界面中替换为任意命令。' : 'Executable, arguments, and working directory come from the verified installation record and cannot be replaced with arbitrary commands.'}</span></div>
        <label><span>{zh ? '安装来源（只读）' : 'Installation source (read-only)'}</span><input value={draft.sourceUrl ?? ''} readOnly /></label>
      </>}

      <div className="personalization-actions">
        <button className="btn-primary" disabled={saving || !draft.name.trim() || nonAuthoritativeProjectRule || !schemaEditorsValid} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存新版本' : 'Save new revision')}</button>
        <span role="status" aria-live="polite">{status}</span>
      </div>
      <details className="personalization-history">
        <summary>{zh ? `版本历史（${versions.length}）` : `Version history (${versions.length})`}</summary>
        <div>
          {versions.map((version) => (
            <article key={version.revision}>
              <span><strong>r{version.revision}</strong><code>{version.contentDigest.slice(0, 12)}</code></span>
              <time>{new Date(version.createdAt).toLocaleString()}</time>
              {version.revision !== definition.revision && <button onClick={() => void restore(version.revision)}>{zh ? '恢复此版本' : 'Restore this version'}</button>}
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

export default function PersonalizationCenter({ onActivateScenario }: PersonalizationCenterProps = {}) {
  const { locale, t } = useTranslation();
  const zh = locale === 'zh';
  const [definitions, setDefinitions] = useState<PersonalizationDefinition[]>([]);
  const [kind, setKind] = useState<Kind>('scenario');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browseBuiltinOpen, setBrowseBuiltinOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [draftIds, setDraftIds] = useState<Set<string>>(() => retainedPersonalizationDraftIds());
  // AI 辅助创建（场景）：描述需求 → 生成场景 + 智能体 + 工作流 → 用户修改后保存。
  const [scenarioAiOpen, setScenarioAiOpen] = useState(false);
  const [scenarioWorkbenchTab, setScenarioWorkbenchTab] = useState<WorkbenchTab>('overview');
  // 模板识别（论文结构）：粘贴模板 → AI 解析为逐节写作指引 → 用户修改后保存。
  const [tplOpen, setTplOpen] = useState(false);
  // 库面板宽度：用户可拖拽调节，本地持久化。
  const [libraryWidth, setLibraryWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem('metis-personalization-library-width');
      const value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) ? Math.min(480, Math.max(220, value)) : 330;
    } catch {
      return 330;
    }
  });
  const layoutRef = useRef<HTMLDivElement>(null);
  const [narrowLayout, setNarrowLayout] = useState(() => (
    typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 1120px)').matches : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1120px)') as MediaQueryList & { addListener?: (listener: (event: MediaQueryListEvent) => void) => void; removeListener?: (listener: (event: MediaQueryListEvent) => void) => void };
    const listener = (event: MediaQueryListEvent) => setNarrowLayout(event.matches);
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    }
    // 旧实现/测试桩可能只提供 addListener。
    media.addListener?.(listener);
    return () => media.removeListener?.(listener);
  }, []);

  const handleLibraryDrag = useCallback((clientX: number) => {
    const rect = layoutRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLibraryWidth(Math.min(480, Math.max(220, clientX - rect.left)));
  }, []);

  const saveLibraryWidth = useCallback((value: number) => {
    try { window.localStorage.setItem('metis-personalization-library-width', String(Math.round(value))); } catch { /* best-effort */ }
  }, []);

  // 宽度持久化放 effect：拖动结束时读到的是最新值。
  useEffect(() => { saveLibraryWidth(libraryWidth); }, [libraryWidth, saveLibraryWidth]);
  const [tplText, setTplText] = useState('');
  const [tplBusy, setTplBusy] = useState(false);
  const [tplStatus, setTplStatus] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplSections, setTplSections] = useState<Array<{ title: string; instruction: string }>>([]);
  /** 场景编辑器空状态「新建 X」跳转后，保存成功时返回场景并重新选中。 */
  const pendingReturnRef = useRef<{ createdKind: Kind; createdId: string; returnSelectedId: string | null } | null>(null);
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const mcpActivationDependencies = useMemo<McpActivationPanelDependencies>(() => ({
    activateMcp: async (request) => (
      window.metis?.activatePersonalizationMcp?.(request) ?? null
    ),
  }), []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const list = window.metis?.listPersonalization;
      if (!list) throw new Error('personalization bridge unavailable');
      const response = await list({ contractVersion: 1, includeDisabled: true });
      const next = response.definitions;
      setDefinitions(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : null);
    } catch {
      setLoadError(zh
        ? '无法加载个性化配置。已保留当前页面，可直接重试。'
        : 'Personalization configurations could not be loaded. The current page is preserved and you can retry.');
    } finally {
      setLoading(false);
    }
  }, [zh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; };
  }, [load]);

  const userDefinitions = useMemo(
    () => definitions.filter((item) => item.provenance.origin !== 'builtin'),
    [definitions],
  );
  const filtered = useMemo(() => userDefinitions.filter((item) => item.kind === kind), [userDefinitions, kind]);
  const selected = userDefinitions.find((item) => item.id === selectedId) ?? null;

  const handleDraftStateChange = useCallback((definitionId: string, retained: boolean) => {
    setDraftIds((current) => {
      if (current.has(definitionId) === retained) return current;
      const next = new Set(current);
      if (retained) next.add(definitionId);
      else next.delete(definitionId);
      return next;
    });
  }, []);

  const afterExtensionInstall = async (definitionId: string) => {
    await load();
    setSelectedId(definitionId);
  };

  const saveNew = async (definition: PersonalizationDefinition) => {
    try {
      const result = await window.metis?.savePersonalization({ contractVersion: 1, definition, expectedRevision: 0 });
      if (!result) { setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable'); return null; }
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await load();
        setSelectedId(result.definition.id);
        return result.definition;
      }
      return null;
    } catch {
      setStatus(zh ? '新建未完成，没有创建半成品。请重试。' : 'Creation did not complete and no partial definition was created. Try again.');
      return null;
    }
  };

  const create = async () => {
    const defaultName = zh ? `我的${KIND_LABELS.zh[kind]}` : `My ${KIND_LABELS.en[kind]}`;
    await saveNew(createDefinition(kind, defaultName, definitions));
  };

  // 场景编辑器空状态「新建 X」：切换到对应类型创建，保存后自动回到场景。
  const quickCreate = async (targetKind: Kind) => {
    const returnSelectedId = selectedId;
    const created = createDefinition(
      targetKind,
      zh ? `我的${KIND_LABELS.zh[targetKind]}` : `My ${KIND_LABELS.en[targetKind]}`,
      definitions,
    );
    pendingReturnRef.current = { createdKind: targetKind, createdId: created.id, returnSelectedId };
    setKind(targetKind);
    await saveNew(created);
  };

  const handleEditorSaved = async (saved?: PersonalizationDefinition) => {
    await load();
    const pending = pendingReturnRef.current;
    if (pending && saved && saved.kind === pending.createdKind && saved.id === pending.createdId) {
      pendingReturnRef.current = null;
      setKind('scenario');
      setSelectedId(pending.returnSelectedId);
      setStatus(zh ? '已创建，回到场景继续配置。' : 'Created; back to the scenario to continue.');
    }
  };

  const updateTplSection = (index: number, field: 'title' | 'instruction', value: string) => {
    setTplSections((prev) => prev.map((section, i) => (i === index ? { ...section, [field]: value } : section)));
  };

  const removeTplSection = (index: number) => {
    setTplSections((prev) => prev.filter((_, i) => i !== index));
  };

  const parsePaperTemplate = async () => {
    const text = tplText.trim();
    if (text.length < 10) {
      setTplStatus(zh ? '请先粘贴论文结构模板文本。' : 'Paste a paper template first.');
      return;
    }
    if (!window.metis?.aiParsePaperTemplate) {
      setTplStatus(zh ? '模板解析服务不可用，请检查模型连接后重试。' : 'Template parsing is unavailable. Check the model connection and retry.');
      return;
    }
    setTplBusy(true);
    setTplStatus('');
    try {
      const result = await window.metis.aiParsePaperTemplate({ text });
      if (!result.ok || !result.sections || result.sections.length < 3) {
        setTplStatus(zh
          ? `模板解析失败（${result.code ?? 'parse_failed'}），请调整模板文本后重试。`
          : `Template parse failed (${result.code ?? 'parse_failed'}). Adjust the text and retry.`);
        return;
      }
      setTplSections(result.sections);
      setTplName(zh ? '解析的论文模板' : 'Parsed paper template');
      setTplStatus(zh
        ? `解析出 ${result.sections.length} 个章节，可逐节修改写作指引后保存。`
        : `Parsed ${result.sections.length} sections; edit each writing guide and save.`);
    } catch {
      setTplStatus(zh ? '模板解析未完成，请重试。' : 'Template parsing did not complete. Try again.');
    } finally {
      setTplBusy(false);
    }
  };

  const savePaperTemplate = async () => {
    const name = tplName.trim();
    if (!name || tplSections.length === 0) return;
    const result = await window.metis?.structureSave?.({
      id: `structure-${Date.now().toString(36)}`,
      name,
      sections: tplSections.map((section, index) => ({
        id: `sec-${index + 1}`,
        title: section.title,
        instruction: section.instruction,
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isDefault: false,
    });
    setTplStatus(result?.ok
      ? (zh ? `已保存论文结构「${name}」，可在自主科研中使用。` : `Paper structure "${name}" saved — usable in autonomous research.`)
      : (zh ? '保存失败，请重试。' : 'Save failed, please retry.'));
  };

  const fork = async (definition: PersonalizationDefinition) => {
    try {
      const result = await window.metis?.forkPersonalization({
        contractVersion: 1,
        sourceId: definition.id,
        targetId: availableUserId(definition.kind, `${definition.name} copy`, definitions),
        author: 'Local user',
      });
      if (!result) { setStatus(zh ? '副本服务不可用。' : 'Copy service is unavailable.'); return; }
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await load();
        setSelectedId(result.definition.id);
      }
    } catch {
      setStatus(zh ? '创建可编辑副本失败，内置原版未改变。' : 'The editable copy could not be created; the factory original is unchanged.');
    }
  };

  const archive = async (definition: PersonalizationDefinition) => {
    try {
      const result = await window.metis?.archivePersonalization({ contractVersion: 1, id: definition.id, expectedRevision: definition.revision });
      if (!result) { setStatus(zh ? '归档服务不可用。' : 'Archive service is unavailable.'); return; }
      setStatus(result.ok ? (zh ? '已移入归档；内置原版始终保留' : 'Archived; the factory original remains available') : resultMessage(result, zh));
      if (result.ok) {
        clearPersonalizationDraft(definition.id);
        handleDraftStateChange(definition.id, false);
        await load();
      }
    } catch {
      setStatus(zh ? '归档未完成，定义仍保留。' : 'Archive did not complete; the definition remains available.');
    }
  };

  const activateScenario = async (definition: ScenarioDefinition) => {
    if (!definition.enabled || definition.capability === 'presentation_reserved') {
      setStatus(zh
        ? '该场景当前不可运行；没有启动任何任务。'
        : 'This scenario is not executable; no task was started.');
      return;
    }
    if (definition.agentIds.length === 0) {
      setStatus(zh
        ? '请先为此场景绑定至少一个智能体；没有启动任何任务。'
        : 'Bind at least one Agent to this scenario first; no task was started.');
      return;
    }
    if (definition.output.plan != null
      && definition.workflow.length === 0
      && definition.agentIds.length !== 1) {
      setStatus(t('personalization.scenarioNeedsUniqueAgent'));
      return;
    }
    if (!onActivateScenario) {
      setStatus(zh
        ? '当前壳层尚未接入对话跳转；没有启动任何任务。'
        : 'Conversation navigation is unavailable; no task was started.');
      return;
    }
    try {
      await onActivateScenario(definition.id);
    } catch {
      setStatus(zh
        ? '场景未能交给对话工作区；没有启动任何任务。'
        : 'The scenario could not be handed to the conversation workspace; no task was started.');
    }
  };

  const exportBundle = async () => {
    if (!selected) {
      setStatus(zh ? '请先选择要导出的根定义' : 'Choose a root definition to export');
      return;
    }
    try {
      const result = await window.metis?.exportPersonalizationBundle?.({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        rootDefinitionIds: [selected.id],
      });
      if (!result) { setStatus(zh ? '配置包服务不可用' : 'Bundle service is unavailable'); return; }
      setStatus(result.ok
        ? (zh ? `已导出 ${result.definitionCount} 个相互依赖的定义` : `Exported ${result.definitionCount} linked definitions`)
        : result.code === 'cancelled' ? (zh ? '已取消导出' : 'Export cancelled') : `${zh ? '导出失败' : 'Export failed'}: ${result.code}`);
    } catch {
      setStatus(zh ? '导出未完成，未写出不完整配置包。' : 'Export did not complete; no partial bundle was written.');
    }
  };

  const importBundle = async () => {
    try {
      const result = await window.metis?.importPersonalizationBundle?.({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
      });
      if (!result) { setStatus(zh ? '配置包服务不可用' : 'Bundle service is unavailable'); return; }
      if (!result.ok) {
        setStatus(result.code === 'cancelled' ? (zh ? '已取消导入' : 'Import cancelled') : `${zh ? '导入失败' : 'Import failed'}: ${result.code}`);
        return;
      }
      setStatus(zh ? `已原子导入 ${result.definitionCount} 个定义` : `Atomically imported ${result.definitionCount} definitions`);
      await load();
    } catch {
      setStatus(zh ? '导入未完成，原有配置未改变。' : 'Import did not complete; existing configurations are unchanged.');
    }
  };

  const isScenarioKind = kind === 'scenario';
  const scenarioTemplatePanel = isScenarioKind ? (

            <div className="personalization-template">
              <button type="button" className="btn-secondary" data-testid="template-parse-toggle" onClick={() => setTplOpen((open) => !open)} aria-expanded={tplOpen}>
                {zh ? '模板识别（论文结构）' : 'Template recognition (paper structure)'}
              </button>
              {tplOpen && (
                <div className="personalization-template__panel" data-testid="template-parse-panel">
                  <p>{zh ? '粘贴论文写作模板（如国家社科基金申请书、论文结构规范），AI 会解析为逐节写作指引，你可修改后保存为论文结构，供自主科研使用。' : 'Paste a paper template (e.g. a grant application or thesis structure). AI parses it into per-section writing guides you can edit and save as a paper structure for autonomous research.'}</p>
                  <label>
                    <span>{zh ? '模板文本' : 'Template text'}</span>
                    <textarea rows={3} value={tplText} onChange={(event) => setTplText(event.target.value)} data-testid="template-parse-input" placeholder={zh ? '粘贴模板文本…' : 'Paste template text…'} />
                  </label>
                  <div className="personalization-ai-create__actions">
                    <button type="button" className="btn-primary btn-sm" disabled={tplBusy || tplText.trim().length < 10} onClick={() => void parsePaperTemplate()} data-testid="template-parse-submit">
                      {tplBusy ? (zh ? '解析中…' : 'Parsing…') : (zh ? '解析模板' : 'Parse template')}
                    </button>
                  </div>
                  {tplSections.length > 0 && (
                    <div className="personalization-template__sections" data-testid="template-parse-sections">
                      <label>
                        <span>{zh ? '结构名称' : 'Structure name'}</span>
                        <input className="settings-input" value={tplName} onChange={(event) => setTplName(event.target.value)} data-testid="template-name-input" />
                      </label>
                      {tplSections.map((section, index) => (
                        <div key={index} className="personalization-template__section" data-testid="template-section">
                          <input
                            className="settings-input"
                            value={section.title}
                            aria-label={zh ? `第 ${index + 1} 节标题` : `Section ${index + 1} title`}
                            onChange={(event) => updateTplSection(index, 'title', event.target.value)}
                          />
                          <textarea
                            rows={2}
                            value={section.instruction}
                            aria-label={zh ? `第 ${index + 1} 节写作指引` : `Section ${index + 1} writing guide`}
                            onChange={(event) => updateTplSection(index, 'instruction', event.target.value)}
                          />
                          <button type="button" className="btn-secondary btn-sm" onClick={() => removeTplSection(index)}>
                            {zh ? '删除' : 'Remove'}
                          </button>
                        </div>
                      ))}
                      <div className="personalization-ai-create__actions">
                        <button type="button" className="btn-primary btn-sm" disabled={!tplName.trim()} onClick={() => void savePaperTemplate()} data-testid="template-save">
                          {zh ? '保存为论文结构' : 'Save as paper structure'}
                        </button>
                      </div>
                    </div>
                  )}
                  {tplStatus && <p className="personalization-ai-create__status" role="status" aria-live="polite" data-testid="template-parse-status">{tplStatus}</p>}
                </div>
              )}
            </div>
          
  ) : null;

  return (
    <div className="personalization-page">
      <header className="personalization-hero">
        <div>
          <span className="personalization-eyebrow">{zh ? '研究场景工作台' : 'RESEARCH SCENARIO WORKBENCH'}</span>
          <h1>{zh ? '场景' : 'Scenarios'}</h1>
          <p>{zh ? '从空白场景开始，将你创建的智能体、技能、MCP 与 Metis.md 组合成专属研究系统。' : 'Start from a blank scenario and compose the agents, skills, MCP servers, and Metis.md that belong to your research system.'}</p>
        </div>
        <div className="personalization-truth-card">
          <strong>{zh ? '自动真实性层始终强制执行' : 'Automatic truth controls always remain enforced'}</strong>
          <span>{zh ? '个性化可以改变行为，但不能伪造已核验、已更正或可发布状态。' : 'Personalization may change behavior, but cannot forge verified, corrected, or publishable states.'}</span>
        </div>
      </header>

      <nav className="personalization-tabs" aria-label={zh ? '场景分类' : 'Scenario categories'}>
        {KIND_ORDER.map((item) => <button key={item} className={kind === item ? 'active' : ''} aria-pressed={kind === item} onClick={() => { setKind(item); setSelectedId(null); }}>{KIND_LABELS[zh ? 'zh' : 'en'][item]}<span>{userDefinitions.filter((definition) => definition.kind === item).length}</span></button>)}
      </nav>

      <div className="personalization-bundle-actions" aria-label={zh ? '配置包导入导出' : 'Bundle import and export'}>
        <button type="button" onClick={() => void importBundle()}>{zh ? '导入配置包' : 'Import bundle'}</button>
        <button type="button" disabled={!selected} onClick={() => void exportBundle()}>{zh ? '导出所选配置' : 'Export selected configuration'}</button>
        <span>{zh ? '配置包包含所选定义及其依赖；凭据不会导出。' : 'Bundles include the selected definition graph; credentials are never exported.'}</span>
      </div>

      {isScenarioKind && !loading && loadError && (
        <div className="personalization-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></div>
      )}
      {isScenarioKind ? (
        <ScenarioWorkbench
          zh={zh}
          definitions={userDefinitions}
          selectedId={selectedId}
          onSelect={setSelectedId}
          save={async (definition, expectedRevision) => {
            const result = await window.metis?.savePersonalization({ contractVersion: 1, definition, expectedRevision });
            return result ?? { ok: false, code: 'unavailable' as const };
          }}
          createScenario={() => void create()}
          onActivateScenario={(id) => onActivateScenario?.(id)}
          reload={load}
          onOpenAiCreate={() => setScenarioAiOpen(true)}
          initialTab={scenarioWorkbenchTab}
        >
          {scenarioTemplatePanel}
        </ScenarioWorkbench>
      ) : (
      <div
        className="personalization-layout"
        ref={layoutRef}
        style={narrowLayout ? undefined : { gridTemplateColumns: `${Math.round(libraryWidth)}px 7px minmax(480px, 1fr)` }}
      >
        <aside className="personalization-library">
          <div className="personalization-library__header">
            <div><h2>{LIBRARY_LABELS[zh ? 'zh' : 'en'][kind]}</h2><p>{zh ? '由你创建和安装' : 'Created and installed by you'}</p></div>
            <div className="personalization-library__actions">
              {kind !== 'mcp' && <button className="btn-primary" onClick={() => void create()}>{zh ? '新建' : 'New'}</button>}
            </div>
          </div>
          {loading && <p>{zh ? '正在加载…' : 'Loading…'}</p>}
          {!loading && loadError && <div className="personalization-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></div>}
          {!loading && !loadError && filtered.length === 0 && <p className="personalization-empty">{zh ? '还没有自定义内容。' : 'No custom definitions yet.'}</p>}
          <div className="personalization-cards">
            {filtered.map((definition, index) => {
              const missingScenarioAgent = definition.kind === 'scenario'
                && definition.enabled
                && definition.capability !== 'presentation_reserved'
                && definition.agentIds.length === 0;
              const ambiguousPlannedScenario = definition.kind === 'scenario'
                && definition.enabled
                && definition.capability !== 'presentation_reserved'
                && definition.output.plan != null
                && definition.workflow.length === 0
                && definition.agentIds.length > 1;
              const scenarioUseBlocked = missingScenarioAgent || ambiguousPlannedScenario;
              const readinessId = `personalization-scenario-readiness-${index}`;
              return <article key={definition.id} className={`personalization-card ${selectedId === definition.id ? 'selected' : ''}`}>
                <button className="personalization-card__select" data-definition-id={definition.id} onClick={() => setSelectedId(definition.id)}>
                  <span className="personalization-card__meta"><b>{definition.provenance.origin === 'builtin' ? (zh ? '内置' : 'Built-in') : (zh ? '自定义' : 'Custom')}</b><span>r{definition.revision}</span></span>
                  <strong>{definition.name}</strong>
                  <span>{definition.description || (zh ? '暂无说明' : 'No description')}</span>
                </button>
                <div className="personalization-card__actions">
                  {draftIds.has(definition.id) && <span className="personalization-card__draft">{zh ? '草稿已保留' : 'Draft preserved'}</span>}
                  {definition.kind === 'scenario'
                    && definition.enabled
                    && definition.capability !== 'presentation_reserved'
                    && (
                      <button
                        type="button"
                        disabled={!onActivateScenario || scenarioUseBlocked}
                        aria-describedby={scenarioUseBlocked ? readinessId : undefined}
                        title={missingScenarioAgent
                          ? (zh ? '请先绑定至少一个智能体' : 'Bind at least one Agent first')
                          : ambiguousPlannedScenario
                            ? t('personalization.scenarioNeedsUniqueAgentTitle')
                          : undefined}
                        onClick={() => void activateScenario(definition)}
                      >
                        {zh ? '在对话中使用' : 'Use in conversation'}
                      </button>
                    )}
                  {scenarioUseBlocked && (
                    <span id={readinessId} className="personalization-card__readiness">
                      {ambiguousPlannedScenario
                        ? t('personalization.scenarioNeedsUniqueAgent')
                        : zh
                        ? '请先绑定至少一个智能体，再在对话中使用此场景。'
                        : 'Bind at least one Agent before using this scenario in conversation.'}
                    </span>
                  )}
                  {definition.provenance.origin === 'builtin'
                    ? <button onClick={() => void fork(definition)}>{zh ? '创建可编辑副本' : 'Create editable copy'}</button>
                    : <button onClick={() => void archive(definition)}>{zh ? '归档' : 'Archive'}</button>}
                </div>
              </article>;
            })}
          </div>
          <div className="personalization-library__status" role="status" aria-live="polite">{status}</div>
        </aside>

        {!narrowLayout && (
          <SplitHandle
            label={zh ? '拖动调整库面板宽度' : 'Drag to resize the library panel'}
            testId="personalization-split-library"
            onDrag={handleLibraryDrag}
            onKeyDelta={(delta) => {
              setLibraryWidth((current) => Math.min(480, Math.max(220, current + delta)));
            }}
          />
        )}

        <section
          className="personalization-detail"
          aria-label={zh ? '场景详情' : 'Scenario details'}
        >
          {kind === 'rules' && !selected && (
            <ProjectMetisRulesEditor projectId={activeProjectId} />
          )}
          {selected?.kind === 'rules' && (
            <div className="personalization-boundary personalization-rules-context" role="note">
              <strong>{selected.scope === 'global'
                ? t('personalization.globalRulesContext')
                : selected.scope === 'scenario'
                  ? t('personalization.scenarioRulesContext')
                  : t('personalization.legacyProjectRulesContext')}</strong>
              <span>{t('personalization.rulesContextDescription')}</span>
              <button type="button" onClick={() => setSelectedId(null)}>{t('personalization.openProjectRules')}</button>
            </div>
          )}
          {kind === 'skill' && (
            <>
              <button type="button" className="btn-toggle" onClick={() => setBrowseBuiltinOpen((v) => !v)}>
                {browseBuiltinOpen ? t('personalization.browseBuiltinHide') : t('personalization.browseBuiltinShow')}
              </button>
              {browseBuiltinOpen && <BuiltinSkillBrowserPanel />}
            </>
          )}
          {(kind === 'skill' || kind === 'mcp') && <ExtensionInstaller key={kind} kind={kind} definitions={userDefinitions} onInstalled={afterExtensionInstall} onRefresh={load} />}
          {kind === 'mcp' && <SecretVaultPanel />}
          {selected?.kind === 'mcp' && (
            <McpActivationPanel
              definition={selected}
              dependencies={mcpActivationDependencies}
              onActivated={(definition) => {
                setDefinitions((current) => current.map((item) => item.id === definition.id ? definition : item));
                setSelectedId(definition.id);
                void load();
              }}
            />
          )}
          {!selected && kind !== 'rules' && <div className="personalization-welcome"><h2>{zh ? '选择或新建配置' : 'Choose or create a configuration'}</h2><p>{zh ? '这里只展示你创建或安装的内容。' : 'Only content you create or install is shown here.'}</p></div>}
          {selected && isDirectlyEditable(selected) && <DefinitionEditor key={`${selected.id}:${selected.revision}`} definition={selected} definitions={userDefinitions} onSaved={handleEditorSaved} onDraftStateChange={handleDraftStateChange} onQuickCreate={quickCreate} />}
          {selected && selected.provenance.origin !== 'builtin' && !isDirectlyEditable(selected) && (
            <div className="personalization-welcome">
              <h2>{selected.name}</h2>
              <p>{zh
                ? '这是由受控安装器或 MCP Builder 管理的定义。来源、安装摘要和启用状态不能手工伪造；请使用上方安装、验证或重新安装流程。'
                : 'This definition is managed by the controlled installer or MCP Builder. Source provenance, installation digests, and activation state cannot be edited by hand; use the install, verify, or reinstall flow above.'}</p>
            </div>
          )}
        </section>
      </div>
      )}
      {scenarioAiOpen && (
        <ScenarioAiCreateDialog
          zh={zh}
          definitions={userDefinitions}
          onClose={() => setScenarioAiOpen(false)}
          onGenerated={(scenarioId, openStructure) => {
            setScenarioAiOpen(false);
            setScenarioWorkbenchTab(openStructure ? 'structure' : 'overview');
            void load();
            setSelectedId(scenarioId);
          }}
        />
      )}
    </div>
  );
}
