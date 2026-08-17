/**
 * personalizationLib — 场景/定义创建与 ID 工具（场景重构 P2 抽取，供
 * PersonalizationCenter 与场景工作台/AI 创建对话框共用）。
 */
import type {
  AgentDefinition,
  McpDefinition,
  MetisRulesDefinition,
  PersonalizationDefinition,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

export type Kind = 'scenario' | 'agent' | 'skill' | 'mcp' | 'rules';

const KIND_NAMESPACE: Record<Kind, string> = {
  scenario: 'scenarios',
  agent: 'agents',
  skill: 'skills',
  mcp: 'mcp',
  rules: 'rules',
};

export function localId(name: string, fallback = 'custom'): string {
  const normalized = name.trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .slice(0, 80)
    .replace(/[^a-z0-9]+$/gu, '');
  return normalized || fallback;
}

export function availableUserId(
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

export function userProvenance(now: number) {
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

export function createDefinition(kind: Kind, name: string, all: readonly PersonalizationDefinition[]): PersonalizationDefinition {
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

/** 深拷贝（解耦持久化对象与编辑态）。 */
export function cloneDefinition<T extends PersonalizationDefinition>(definition: T): T {
  return JSON.parse(JSON.stringify(definition)) as T;
}
