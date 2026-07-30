import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentDefinition,
  McpDefinition,
  MetisRulesDefinition,
  PersonalizationDefinition,
  PersonalizationMutationResult,
  PersonalizationVersionView,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import McpActivationPanel, {
  type McpActivationPanelDependencies,
} from './McpActivationPanel';
import ProjectMetisRulesEditor from './ProjectMetisRulesEditor';
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
const KIND_NAMESPACE: Record<Kind, string> = {
  scenario: 'scenarios',
  agent: 'agents',
  skill: 'skills',
  mcp: 'mcp',
  rules: 'rules',
};
const KIND_LABELS = {
  zh: { scenario: '场景', agent: '智能体', skill: '技能', mcp: 'MCP', rules: 'Metis.md' },
  en: { scenario: 'Scenarios', agent: 'Agents', skill: 'Skills', mcp: 'MCP', rules: 'Metis.md' },
} as const;

function localId(name: string, fallback = 'custom'): string {
  const normalized = name.trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .slice(0, 80)
    .replace(/[^a-z0-9]+$/gu, '');
  return normalized || fallback;
}

function availableUserId(
  kind: Kind,
  name: string,
  definitions: readonly PersonalizationDefinition[],
): string {
  const prefix = `user:${KIND_NAMESPACE[kind]}/`;
  const base = localId(name, `custom-${kind}`);
  const occupied = new Set(definitions.map((definition) => definition.id));
  if (!occupied.has(`${prefix}${base}`)) return `${prefix}${base}`;
  let ordinal = 2;
  while (occupied.has(`${prefix}${base}-${ordinal}`)) ordinal += 1;
  return `${prefix}${base}-${ordinal}`;
}

function userProvenance(now: number) {
  return {
    origin: 'user' as const,
    author: 'Local user',
    version: '1.0.0',
    license: null,
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: true,
    createdAt: now,
    updatedAt: now,
  };
}

function createDefinition(kind: Kind, name: string, all: readonly PersonalizationDefinition[]): PersonalizationDefinition {
  const now = Date.now();
  const id = availableUserId(kind, name, all);
  const common = {
    contractVersion: 1 as const,
    id,
    kind,
    name,
    description: '',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: userProvenance(now),
  };
  const memory = {
    scope: 'project' as const,
    retainDecisions: true,
    retainArtifacts: true,
    maxSummaryChars: 100_000,
  };
  const output = {
    format: 'artifact_bundle' as const,
    schema: null,
    plan: null,
    requireEvidenceEnvelope: true,
    includeIntegrityReport: true,
  };
  if (kind === 'skill') {
    return {
      ...common,
      kind,
      sourceMode: 'markdown',
      markdown: `# ${name}\n\n## Instructions\n\n`,
      systemPrompt: '',
      toolIds: [],
      mcpIds: [],
      maxTurns: 12,
      inputSchema: null,
      outputSchema: null,
      packageEntry: null,
    } satisfies SkillDefinitionV2;
  }
  if (kind === 'agent') {
    return {
      ...common,
      kind,
      role: name,
      systemPrompt: '',
      modelPreference: null,
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      memory,
      output,
      maxTurns: 20,
      retryLimit: 2,
    } satisfies AgentDefinition;
  }
  if (kind === 'mcp') {
    return {
      ...common,
      kind,
      sourceMode: 'url',
      transport: 'stdio',
      command: 'node',
      args: [],
      environment: {},
      sourceUrl: null,
      exposedTools: [],
      workingDirectoryToken: null,
    } satisfies McpDefinition;
  }
  if (kind === 'rules') {
    return {
      ...common,
      kind,
      scope: 'global',
      scopeId: null,
      markdown: `# Metis.md\n\n## ${name}\n\n`,
    } satisfies MetisRulesDefinition;
  }
  return {
    ...common,
    kind,
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory,
    output,
    triggerPhrases: [],
    capability: 'custom',
  } satisfies ScenarioDefinition;
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
      ? <div className="personalization-reference-picker__empty">{emptyLabel}</div>
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
  const plan = output.plan ?? null;
  const setPrimary = (primaryDeliverable: string) => {
    if (!primaryDeliverable.trim()) {
      onChange({ ...output, plan: null });
      return;
    }
    onChange({
      ...output,
      plan: {
        primaryDeliverable,
        supportingArtifacts: plan?.supportingArtifacts ?? [],
        qualityCriteria: plan?.qualityCriteria ?? [],
      },
    });
  };
  return <fieldset className="personalization-output-plan">
    <legend>{zh ? '输出计划' : 'Output plan'}</legend>
    <p>{zh ? '用普通文字说明要交付什么，不需要编写 JSON。' : 'Describe the expected deliverables in plain language; no JSON is required.'}</p>
    <label><span>{zh ? '主交付物' : 'Primary deliverable'}</span><input value={plan?.primaryDeliverable ?? ''} maxLength={512} onChange={(event) => setPrimary(event.target.value)} placeholder={zh ? '例如：完整的学术论文草稿' : 'For example: a complete academic article draft'} /></label>
    <div className="personalization-grid personalization-grid--2">
      <label><span>{zh ? '配套产物（每行一项）' : 'Supporting artifacts (one per line)'}</span><textarea rows={4} disabled={!plan} value={plan ? plan.supportingArtifacts.join('\n') : ''} onChange={(event) => plan && onChange({ ...output, plan: { ...plan, supportingArtifacts: parseLines(event.target.value).slice(0, 64) } })} /></label>
      <label><span>{zh ? '质量标准（每行一项）' : 'Quality criteria (one per line)'}</span><textarea rows={4} disabled={!plan} value={plan ? plan.qualityCriteria.join('\n') : ''} onChange={(event) => plan && onChange({ ...output, plan: { ...plan, qualityCriteria: parseLines(event.target.value).slice(0, 64) } })} /></label>
    </div>
  </fieldset>;
}

type SimpleSchemaFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
interface SimpleSchemaField {
  name: string;
  type: SimpleSchemaFieldType;
  description: string;
  required: boolean;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readSimpleSchema(schema: Record<string, unknown> | null): SimpleSchemaField[] | null {
  if (schema === null) return [];
  if (schema.type !== 'object') return null;
  const properties = recordValue(schema.properties);
  if (!properties) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
  const supported = new Set<SimpleSchemaFieldType>(['string', 'number', 'integer', 'boolean', 'array', 'object']);
  const rows: SimpleSchemaField[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = recordValue(rawProperty);
    if (!property || typeof property.type !== 'string' || !supported.has(property.type as SimpleSchemaFieldType)) return null;
    rows.push({
      name,
      type: property.type as SimpleSchemaFieldType,
      description: typeof property.description === 'string' ? property.description : '',
      required: required.has(name),
    });
  }
  return rows;
}

function buildSimpleSchema(rows: readonly SimpleSchemaField[]): Record<string, unknown> | null {
  if (rows.length === 0) return null;
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
  zh,
}: {
  label: string;
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null) => void;
  zh: boolean;
}) {
  const parsed = readSimpleSchema(value);
  const [rows, setRows] = useState<SimpleSchemaField[]>(parsed ?? []);
  const [unsupported, setUnsupported] = useState(parsed === null);
  const [error, setError] = useState('');

  const commit = (next: SimpleSchemaField[]) => {
    setRows(next);
    const names = next.map((row) => row.name.trim());
    const valid = names.every((name) => /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(name))
      && new Set(names).size === names.length;
    if (!valid) {
      setError(zh ? '字段名必须唯一，以字母或下划线开头。' : 'Field names must be unique and start with a letter or underscore.');
      return;
    }
    setError('');
    onChange(buildSimpleSchema(next.map((row, index) => ({ ...row, name: names[index]! }))));
  };

  if (unsupported) return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    <div className="personalization-boundary"><strong>{zh ? '已保留现有复杂结构' : 'Existing advanced schema preserved'}</strong><span>{zh ? '此结构超出可视化字段编辑器范围。只有明确选择替换时才会清空。' : 'This schema is more complex than the visual field editor. It remains unchanged unless you explicitly replace it.'}</span></div>
    <button type="button" onClick={() => { setUnsupported(false); setRows([]); onChange(null); }}>{zh ? '替换为可视化字段' : 'Replace with visual fields'}</button>
  </fieldset>;

  return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    <p>{zh ? '逐项定义字段；Metis 会生成严格结构，不需要直接编写 JSON。' : 'Define fields one by one. Metis builds a strict schema without raw JSON editing.'}</p>
    <div className="personalization-schema-fields">
      {rows.map((row, index) => <div className="personalization-schema-field" key={`schema-field-${index}`}>
        <label><span>{zh ? '字段名' : 'Field name'}</span><input value={row.name} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /></label>
        <label><span>{zh ? '类型' : 'Type'}</span><select value={row.type} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as SimpleSchemaFieldType } : item))}><option value="string">text</option><option value="number">number</option><option value="integer">integer</option><option value="boolean">yes / no</option><option value="array">list</option><option value="object">object</option></select></label>
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
  onInstalled,
}: {
  kind: 'skill' | 'mcp';
  onInstalled: (definitionId: string) => Promise<void>;
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
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [sourceCapabilityId, setSourceCapabilityId] = useState<string | null>(null);
  const [sourceDisplayName, setSourceDisplayName] = useState('');
  const [sourceCapabilityKind, setSourceCapabilityKind] = useState<'file' | 'folder' | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const mcpLocalId = localId(mcpName, 'my-mcp');
  const definitionId = mode === 'mcp_url' ? `url:mcp/${mcpLocalId}` : `generated:mcp/${mcpLocalId}`;
  const packageId = mcpLocalId;

  const changeMode = (nextMode: typeof mode) => {
    setMode(nextMode);
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
      ? sourceCapabilityId ? { ...common, mode, sourceCapabilityId } as const : null
      : mode === 'skill_url'
        ? {
            ...common,
            mode,
            url: trimmedUrl,
            expectedArchiveSha256: expectedDigest || null,
            expectedId: null,
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
      <div><span className="personalization-eyebrow">{kind === 'skill' ? 'SKILL' : 'MCP'}</span><h2>{zh ? '安装与构建' : 'Install and build'}</h2></div>
      <span>{zh ? '所有来源先验证、再保存；安装结果不能伪造“已核验”状态。' : 'Sources are verified before persistence and can never forge a verified truth state.'}</span>
    </div>
    <label><span>{zh ? '模式' : 'Mode'}</span><select value={mode} onChange={(event) => changeMode(event.target.value as typeof mode)}>{modeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <p className="personalization-installer__mode-help">{mode === 'skill_package'
      ? (zh ? 'ZIP 适合完整技能包；文件夹适合本地开发中的文档、脚本与资源集合。' : 'ZIP is for portable packages; folders are for locally developed documents, scripts, and assets.')
      : mode === 'skill_url'
        ? (zh ? '粘贴 GitHub 或技能包直链，Metis 会下载、核验再安装。' : 'Paste a GitHub or package URL. Metis downloads, verifies, then installs it.')
        : mode === 'mcp_requirements'
          ? (zh ? '用自然语言说明工具需求，Metis Builder 会构建、验证并注册 MCP。' : 'Describe the tool in natural language. Metis Builder constructs, validates, and registers the MCP.')
          : (zh ? '粘贴 MCP manifest 的 HTTPS 地址，核验通过后才启用。' : 'Paste an HTTPS MCP manifest URL. It is enabled only after verification.')}</p>
    {mode === 'skill_package' && <div className="personalization-package-picker">
      <button type="button" onClick={() => void selectPackage('file')}>{zh ? '选择 ZIP 技能包' : 'Choose skill ZIP package'}</button>
      <button type="button" onClick={() => void selectPackage('folder')}>{zh ? '选择技能文件夹' : 'Choose skill folder'}</button>
      <span>{sourceDisplayName
        ? `${sourceCapabilityKind === 'folder' ? (zh ? '文件夹' : 'Folder') : 'ZIP'}: ${sourceDisplayName}`
        : (zh ? '尚未选择' : 'Nothing selected')}</span>
    </div>}
    {(mode === 'skill_url' || mode === 'mcp_url') && <label><span>{mode === 'skill_url' ? (zh ? '技能包 URL / GitHub 地址' : 'Skill package URL / GitHub address') : (zh ? 'MCP manifest HTTPS 地址' : 'MCP manifest HTTPS URL')}</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /></label>}
    {mode === 'skill_url' && <label><span>{zh ? '预期版本（可选）' : 'Expected version (optional)'}</span><input value={expectedVersion} onChange={(event) => setExpectedVersion(event.target.value)} placeholder="1.0.0" /></label>}
    {mode === 'mcp_requirements' && <><label><span>{zh ? 'MCP 名称' : 'MCP name'}</span><input value={mcpName} maxLength={100} onChange={(event) => setMcpName(event.target.value)} /></label><label><span>{zh ? '说明你需要 MCP 做什么' : 'Describe what the MCP must do'}</span><textarea rows={6} value={requirement} onChange={(event) => setRequirement(event.target.value)} /></label><p className="personalization-derived-id">{zh ? '安装后名称' : 'Installed as'}: <strong>{mcpName.trim() || (zh ? '未命名 MCP' : 'Unnamed MCP')}</strong></p></>}
    {mode === 'mcp_url' && <><label><span>{zh ? 'MCP 名称' : 'MCP name'}</span><input value={mcpName} maxLength={100} onChange={(event) => setMcpName(event.target.value)} /></label><p className="personalization-derived-id">{zh ? '安装后名称' : 'Installed as'}: <strong>{mcpName.trim() || (zh ? '未命名 MCP' : 'Unnamed MCP')}</strong></p></>}
    {(mode === 'skill_url' || mode === 'mcp_url') && <label><span>{zh ? '预期 SHA-256（可选）' : 'Expected SHA-256 (optional)'}</span><input value={expectedDigest} onChange={(event) => setExpectedDigest(event.target.value.trim().toLowerCase())} /></label>}
    <label><span>{zh ? '现有定义修订号（新安装填 0）' : 'Existing definition revision (0 for new)'}</span><input type="number" min={0} value={expectedRevision} onChange={(event) => setExpectedRevision(boundedInteger(event.target.value, 0, 1_000_000_000, 0))} /></label>
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
      <div><span className="personalization-eyebrow">SECRETS</span><h2>{zh ? 'MCP 凭据' : 'MCP credentials'}</h2></div>
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
}: {
  definition: PersonalizationDefinition;
  definitions: readonly PersonalizationDefinition[];
  onSaved: () => Promise<void>;
}) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [draft, setDraft] = useState<PersonalizationDefinition>(() => editableCopy(definition));
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

  const updateCommon = (patch: Partial<Pick<PersonalizationDefinition, 'name' | 'description' | 'enabled'>>) => {
    setDraft((current) => ({ ...current, ...patch } as PersonalizationDefinition));
  };

  const updateWorkflowStep = (index: number, patch: Partial<ScenarioDefinition['workflow'][number]>) => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      return {
        ...current,
        workflow: current.workflow.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step),
      };
    });
  };

  const addWorkflowStep = () => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      const stepNumber = current.workflow.length + 1;
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
    setDraft((current) => current.kind === 'scenario'
      ? { ...current, workflow: current.workflow.filter((_step, stepIndex) => stepIndex !== index) }
      : current);
  };

  const save = async () => {
    if (draft.kind === 'rules' && draft.scope === 'project') {
      setStatus(zh
        ? '普通 project 规则定义不是权威项目 Metis.md；请先转换为 global 或 scenario。'
        : 'A regular project-scoped definition is not authoritative; convert it to global or scenario first.');
      return;
    }
    if (!window.metis?.savePersonalization) {
      setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable');
      return;
    }
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
        if (result.ok) await onSaved();
        return;
      }
      const result = await window.metis.savePersonalization({
        contractVersion: 1,
        definition: draft,
        expectedRevision: definition.revision,
      });
      setStatus(resultMessage(result, zh));
      if (result.ok) await onSaved();
    } catch {
      setStatus(zh
        ? '保存未完成：无法连接个性化服务，你的本地编辑已保留。'
        : 'Save did not complete: the personalization service could not be reached. Your local edits are preserved.');
    } finally {
      setSaving(false);
    }
  };

  const restore = async (sourceRevision: number) => {
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
      if (result.ok) await onSaved();
    } catch {
      setStatus(zh ? '版本恢复未完成，当前内容未改变。' : 'Version restore did not complete; the current content is unchanged.');
    }
  };

  const presentationReserved = draft.kind === 'scenario'
    && draft.capability === 'presentation_reserved';
  const nonAuthoritativeProjectRule = draft.kind === 'rules' && draft.scope === 'project';

  return (
    <section className="personalization-editor" aria-label={zh ? '定义编辑器' : 'Definition editor'}>
      <div className="personalization-editor__header">
        <div>
          <span className="personalization-eyebrow">{KIND_LABELS[zh ? 'zh' : 'en'][draft.kind]}</span>
          <h2>{draft.name}</h2>
          <code>{draft.id}</code>
        </div>
        <div className="personalization-editor__header-actions">
          <span className="personalization-revision">r{definition.revision}</span>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || !draft.name.trim() || nonAuthoritativeProjectRule}
            onClick={() => void save()}
          >
            {saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}
          </button>
        </div>
      </div>
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
          <SimpleSchemaEditor key={`${definition.id}:${definition.revision}:input`} label={zh ? '输入字段' : 'Input fields'} value={draft.inputSchema} onChange={(inputSchema) => setDraft({ ...draft, inputSchema })} zh={zh} />
          <SimpleSchemaEditor key={`${definition.id}:${definition.revision}:output`} label={zh ? '输出字段' : 'Output fields'} value={draft.outputSchema} onChange={(outputSchema) => setDraft({ ...draft, outputSchema })} zh={zh} />
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
          <label><span>{zh ? '记忆范围' : 'Memory scope'}</span><select value={draft.memory.scope} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, scope: event.target.value as AgentDefinition['memory']['scope'] } })}><option value="none">none</option><option value="session">session</option><option value="project">project</option><option value="scenario">scenario</option></select></label>
          <label><span>{zh ? '输出格式' : 'Output format'}</span><select value={draft.output.format} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, format: event.target.value as AgentDefinition['output']['format'] } })}><option value="markdown">markdown</option><option value="json">json</option><option value="document">document</option><option value="artifact_bundle">artifact_bundle</option><option value="custom">custom</option></select></label>
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
          <strong>Full Access</strong>
          <span>{zh ? '运行时不做逐步权限确认，允许用户随时发消息引导或打断。' : 'No per-action permission prompts; the user may steer or interrupt at any time.'}</span>
        </div>
        <DefinitionReferencePicker label={zh ? '用于此场景的智能体' : 'Agents for this scenario'} help={zh ? '选择后才能创建工作流步骤。' : 'Select agents before adding workflow steps.'} kind="agent" definitions={definitions} selectedIds={draft.agentIds} onChange={(agentIds) => setDraft({ ...draft, agentIds, workflow: draft.workflow.filter((step) => agentIds.includes(step.agentId)) })} emptyLabel={zh ? '还没有可用智能体。' : 'No agents are available.'} />
        <DefinitionReferencePicker label={zh ? '场景可使用的技能' : 'Skills available to this scenario'} help={zh ? '工作流步骤只能从这些技能中选择。' : 'Workflow steps can choose from this scenario-level set.'} kind="skill" definitions={definitions} selectedIds={draft.skillIds} onChange={(skillIds) => setDraft({ ...draft, skillIds, workflow: draft.workflow.map((step) => ({ ...step, skillIds: step.skillIds.filter((id) => skillIds.includes(id)) })) })} emptyLabel={zh ? '还没有可用技能。' : 'No skills are available.'} />
        <DefinitionReferencePicker label={zh ? '场景可使用的 MCP' : 'MCP available to this scenario'} help={zh ? '工作流步骤只能从这些 MCP 中选择。' : 'Workflow steps can choose from this scenario-level set.'} kind="mcp" definitions={definitions} selectedIds={draft.mcpIds} onChange={(mcpIds) => setDraft({ ...draft, mcpIds, workflow: draft.workflow.map((step) => ({ ...step, mcpIds: step.mcpIds.filter((id) => mcpIds.includes(id)) })) })} emptyLabel={zh ? '还没有可用 MCP。' : 'No MCP definitions are available.'} />
        <DefinitionReferencePicker label={zh ? '场景专属 Metis.md' : 'Scenario-specific Metis.md'} help={zh ? '全局 Metis.md 会自动生效；这里只选择绑定到该场景的规则。项目 Metis.md 由“当前项目 Metis.md”独立管理。' : 'Global Metis.md applies automatically. Select only scenario-bound rules here; project Metis.md is managed separately.'} kind="rules" definitions={definitions} selectedIds={draft.rulesIds} onChange={(rulesIds) => setDraft({ ...draft, rulesIds })} filter={(candidate) => candidate.kind === 'rules' && candidate.scope === 'scenario' && candidate.scopeId === draft.id} emptyLabel={zh ? '还没有绑定到此场景的 Metis.md。' : 'No Metis.md definition is bound to this scenario yet.'} />
        <div className="personalization-grid personalization-grid--2">
          <label><span>{zh ? '场景能力' : 'Scenario capability'}</span><select value={draft.capability} onChange={(event) => setDraft({ ...draft, capability: event.target.value as ScenarioDefinition['capability'] })}><option value="research">research</option><option value="writing">writing</option><option value="analysis">analysis</option><option value="funding">funding</option><option value="custom">custom</option>{draft.capability === 'presentation_reserved' && <option value="presentation_reserved">presentation_reserved</option>}</select></label>
          <label><span>{zh ? '触发短语' : 'Trigger phrases'}</span><textarea rows={3} value={csv(draft.triggerPhrases)} onChange={(event) => setDraft({ ...draft, triggerPhrases: parseCsv(event.target.value) })} /></label>
          <label><span>{zh ? '记忆范围' : 'Memory scope'}</span><select value={draft.memory.scope} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, scope: event.target.value as ScenarioDefinition['memory']['scope'] } })}><option value="none">none</option><option value="session">session</option><option value="project">project</option><option value="scenario">scenario</option></select></label>
          <label><span>{zh ? '记忆摘要上限' : 'Memory summary limit'}</span><input type="number" min={1000} max={500000} value={draft.memory.maxSummaryChars} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, maxSummaryChars: boundedInteger(event.target.value, 1000, 500000, draft.memory.maxSummaryChars) } })} /></label>
          <label><span>{zh ? '产物格式' : 'Artifact format'}</span><select value={draft.output.format} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, format: event.target.value as ScenarioDefinition['output']['format'] } })}><option value="markdown">markdown</option><option value="json">json</option><option value="document">document</option><option value="artifact_bundle">artifact_bundle</option><option value="custom">custom</option></select></label>
        </div>
        <div className="personalization-inline-checks">
          <label><input type="checkbox" checked={draft.memory.retainDecisions} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainDecisions: event.target.checked } })} />{zh ? '保留场景决策摘要' : 'Retain scenario decisions'}</label>
          <label><input type="checkbox" checked={draft.memory.retainArtifacts} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainArtifacts: event.target.checked } })} />{zh ? '保留场景产物索引' : 'Retain scenario artifacts'}</label>
        </div>
        <OutputPlanEditor output={draft.output} onChange={(output) => setDraft({ ...draft, output })} zh={zh} />
        <div className="personalization-truth-lock" role="note"><strong>{zh ? '真实性底座自动生效' : 'Truth controls apply automatically'}</strong><span>{zh ? '证据封装、完整性报告、引用与来源状态不提供关闭开关。' : 'Evidence envelopes, integrity reports, citation checks, and source-state checks cannot be disabled here.'}</span></div>
        <div className="personalization-workflow">
          <div className="personalization-workflow__header"><div><strong>{zh ? '工作流步骤' : 'Workflow steps'}</strong><p>{zh ? '依赖关系决定真实执行顺序；失败步骤会阻断其下游。启用输出计划时，请把所有分支汇入唯一的最终步骤。' : 'Dependencies define execution order; failed steps block downstream work. When an output plan is enabled, connect all branches to one final step.'}</p></div><button type="button" onClick={addWorkflowStep}>{zh ? '添加步骤' : 'Add step'}</button></div>
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
          }}><option value="global">global</option><option value="scenario">scenario</option>{draft.scope === 'project' && <option value="project" disabled>{zh ? 'project（非权威旧定义）' : 'project (legacy, non-authoritative)'}</option>}</select></label>
          {draft.scope === 'scenario' && <label><span>{zh ? '绑定场景' : 'Bound scenario'}</span><select value={draft.scopeId ?? ''} onChange={(event) => setDraft({ ...draft, scopeId: event.target.value || null })}><option value="">{zh ? '请选择场景' : 'Choose a scenario'}</option>{definitions.filter((candidate) => candidate.kind === 'scenario').map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>}
        </div>
        {draft.scope === 'project' && <div className="personalization-boundary" role="note"><strong>{zh ? '这不是权威项目 Metis.md' : 'This is not the authoritative project Metis.md'}</strong><span>{zh ? '请使用本分类顶部的“当前项目 Metis.md”。可将此旧定义转换为 global 或 scenario 后再保存。' : 'Use Current project Metis.md at the top of this category. You may convert this legacy definition to global or scenario before saving.'}</span></div>}
        <label><span>Metis.md</span><textarea rows={20} value={draft.markdown} onChange={(event) => setDraft({ ...draft, markdown: event.target.value })} /></label>
      </>}

      {draft.kind === 'mcp' && <>
        <label><span>{zh ? 'MCP 来源模式' : 'MCP source mode'}</span><select value={draft.sourceMode} onChange={(event) => setDraft({ ...draft, sourceMode: event.target.value as McpDefinition['sourceMode'] })}><option value="generated">{zh ? '描述需求，由 Metis 构建' : 'Describe requirements; Metis builds it'}</option><option value="url">URL / GitHub</option></select></label>
        <div className="personalization-boundary"><strong>{zh ? '托管运行时' : 'Managed runtime'}</strong><span>{zh ? '启动程序、参数和工作目录由已验证安装记录决定，不能在界面中替换为任意命令。' : 'Executable, arguments, and working directory come from the verified installation record and cannot be replaced with arbitrary commands.'}</span></div>
        <label><span>{zh ? '安装来源（只读）' : 'Installation source (read-only)'}</span><input value={draft.sourceUrl ?? ''} readOnly /></label>
      </>}

      <div className="personalization-actions">
        <button className="btn-primary" disabled={saving || !draft.name.trim() || nonAuthoritativeProjectRule} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存新版本' : 'Save new revision')}</button>
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
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [definitions, setDefinitions] = useState<PersonalizationDefinition[]>([]);
  const [kind, setKind] = useState<Kind>('scenario');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
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

  const afterExtensionInstall = async (definitionId: string) => {
    await load();
    setSelectedId(definitionId);
  };

  const create = async () => {
    const defaultName = zh ? `我的${KIND_LABELS.zh[kind]}` : `My ${KIND_LABELS.en[kind]}`;
    const definition = createDefinition(kind, defaultName, definitions);
    try {
      const result = await window.metis?.savePersonalization({ contractVersion: 1, definition, expectedRevision: 0 });
      if (!result) { setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable'); return; }
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await load();
        setSelectedId(result.definition.id);
      }
    } catch {
      setStatus(zh ? '新建未完成，没有创建半成品。请重试。' : 'Creation did not complete and no partial definition was created. Try again.');
    }
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
      if (result.ok) await load();
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

  return (
    <div className="personalization-page">
      <header className="personalization-hero">
        <div>
          <span className="personalization-eyebrow">THE MOST FREE FOR METIS</span>
          <h1>{zh ? '个性化' : 'Personalization'}</h1>
          <p>{zh ? '从空白场景开始，将你创建的智能体、技能、MCP 与 Metis.md 组合成专属研究系统。' : 'Start from a blank scenario and compose the agents, skills, MCP servers, and Metis.md that belong to your research system.'}</p>
        </div>
        <div className="personalization-truth-card">
          <strong>{zh ? '自动真实性层始终强制执行' : 'Automatic truth controls always remain enforced'}</strong>
          <span>{zh ? '个性化可以改变行为，但不能伪造已核验、已更正或可发布状态。' : 'Personalization may change behavior, but cannot forge verified, corrected, or publishable states.'}</span>
        </div>
      </header>

      <nav className="personalization-tabs" aria-label={zh ? '个性化分类' : 'Personalization categories'}>
        {KIND_ORDER.map((item) => <button key={item} className={kind === item ? 'active' : ''} aria-pressed={kind === item} onClick={() => { setKind(item); setSelectedId(null); }}>{KIND_LABELS[zh ? 'zh' : 'en'][item]}<span>{userDefinitions.filter((definition) => definition.kind === item).length}</span></button>)}
      </nav>

      <div className="personalization-bundle-actions" aria-label={zh ? '配置包导入导出' : 'Bundle import and export'}>
        <button type="button" onClick={() => void importBundle()}>{zh ? '导入配置包' : 'Import bundle'}</button>
        <button type="button" disabled={!selected} onClick={() => void exportBundle()}>{zh ? '导出所选配置' : 'Export selected configuration'}</button>
        <span>{zh ? '配置包包含所选定义及其依赖；凭据不会导出。' : 'Bundles include the selected definition graph; credentials are never exported.'}</span>
      </div>

      <div className="personalization-layout">
        <aside className="personalization-library">
          <div className="personalization-library__header">
            <div><h2>{KIND_LABELS[zh ? 'zh' : 'en'][kind]}</h2><p>{zh ? '由你创建和安装' : 'Created and installed by you'}</p></div>
            {kind !== 'mcp' && <button className="btn-primary" onClick={() => void create()}>{zh ? '新建' : 'New'}</button>}
          </div>
          {loading && <p>{zh ? '正在加载…' : 'Loading…'}</p>}
          {!loading && loadError && <div className="personalization-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></div>}
          {!loading && !loadError && filtered.length === 0 && <p className="personalization-empty">{kind === 'scenario' ? (zh ? '还没有场景。从新建场景开始。' : 'No scenarios yet. Start by creating one.') : (zh ? '还没有自定义内容。' : 'No custom definitions yet.')}</p>}
          <div className="personalization-cards">
            {filtered.map((definition) => {
              return <article key={definition.id} className={`personalization-card ${selectedId === definition.id ? 'selected' : ''}`}>
                <button className="personalization-card__select" data-definition-id={definition.id} onClick={() => setSelectedId(definition.id)}>
                  <span className="personalization-card__meta"><b>{definition.provenance.origin === 'builtin' ? (zh ? '内置' : 'Built-in') : (zh ? '自定义' : 'Custom')}</b><span>r{definition.revision}</span></span>
                  <strong>{definition.name}</strong>
                  <span>{definition.description || (zh ? '暂无说明' : 'No description')}</span>
                </button>
                <div className="personalization-card__actions">
                  {definition.kind === 'scenario'
                    && definition.enabled
                    && definition.capability !== 'presentation_reserved'
                    && (
                      <button
                        type="button"
                        disabled={!onActivateScenario}
                        onClick={() => void activateScenario(definition)}
                      >
                        {zh ? '在对话中使用' : 'Use in conversation'}
                      </button>
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

        <section
          className="personalization-detail"
          aria-label={zh ? '个性化详情' : 'Personalization details'}
        >
          {kind === 'rules' && (
            <ProjectMetisRulesEditor projectId={activeProjectId} />
          )}
          {(kind === 'skill' || kind === 'mcp') && <ExtensionInstaller kind={kind} onInstalled={afterExtensionInstall} />}
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
          {!selected && <div className="personalization-welcome"><h2>{kind === 'scenario' ? (zh ? '创建你的第一个场景' : 'Create your first scenario') : (zh ? '选择或新建配置' : 'Choose or create a configuration')}</h2><p>{kind === 'scenario' ? (zh ? '从空白场景开始，再按名称组合你自己的智能体、技能、MCP 和 Metis.md。' : 'Start from a blank scenario, then compose your own agents, skills, MCP, and Metis.md by name.') : (zh ? '这里只展示你创建或安装的内容。' : 'Only content you create or install is shown here.')}</p>{kind === 'scenario' && <button className="btn-primary" type="button" onClick={() => void create()}>{zh ? '新建场景' : 'Create scenario'}</button>}</div>}
          {selected && isDirectlyEditable(selected) && <DefinitionEditor key={`${selected.id}:${selected.revision}`} definition={selected} definitions={userDefinitions} onSaved={load} />}
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
    </div>
  );
}
