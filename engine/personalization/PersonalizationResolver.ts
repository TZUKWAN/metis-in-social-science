import { createHash } from 'node:crypto';
import {
  PersonalizationDigestSchema,
  ResolvedRunManifestSchema,
  type AgentDefinition,
  type McpDefinition,
  type MetisRulesDefinition,
  type PersonalizationDefinition,
  type ResolvedPromptLayer,
  type ResolvedRunManifest,
  type ScenarioDefinition,
  type SkillDefinitionV2,
} from '../runtime/PersonalizationRuntimeContract.js';
import { renderScenarioMetisMarkdown } from './ScenarioHarness.js';

export interface PersonalizationDefinitionReader {
  get(id: string, includeArchived?: boolean): PersonalizationDefinition | undefined;
  list(kind?: PersonalizationDefinition['kind'], includeDisabled?: boolean): PersonalizationDefinition[];
}

export interface ResolvePersonalizationRequest {
  sessionId: string;
  projectId: string;
  scenarioId: string;
  projectRulesId?: string;
  createdAt?: number;
}

export type ResolvePersonalizationResult =
  | {
      ok: true;
      manifest: ResolvedRunManifest;
      scenario: ScenarioDefinition;
      agents: AgentDefinition[];
      skills: SkillDefinitionV2[];
      mcps: McpDefinition[];
      rules: MetisRulesDefinition[];
      systemPrompt: string;
    }
  | {
      ok: false;
      code: 'scenario_not_found' | 'scenario_disabled' | 'dependency_invalid' | 'definition_corrupt';
      issues: string[];
    };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function resolveKind<TKind extends PersonalizationDefinition['kind']>(
  reader: PersonalizationDefinitionReader,
  ids: readonly string[],
  kind: TKind,
): { values: Extract<PersonalizationDefinition, { kind: TKind }>[]; issues: string[] } {
  const values: Extract<PersonalizationDefinition, { kind: TKind }>[] = [];
  const issues: string[] = [];
  for (const id of unique(ids)) {
    const definition = reader.get(id);
    if (!definition) {
      issues.push(`Missing ${kind} definition: ${id}`);
      continue;
    }
    if (definition.kind !== kind) {
      issues.push(`Definition ${id} is ${definition.kind}, expected ${kind}`);
      continue;
    }
    if (!definition.enabled) {
      issues.push(`Definition is disabled: ${id}`);
      continue;
    }
    values.push(definition as Extract<PersonalizationDefinition, { kind: TKind }>);
  }
  return { values, issues };
}

function promptLayer(
  sourceId: string,
  sourceKind: ResolvedPromptLayer['sourceKind'],
  precedence: number,
  content: string,
): ResolvedPromptLayer {
  return {
    sourceId,
    sourceKind,
    precedence,
    contentDigest: PersonalizationDigestSchema.parse(sha256(content)),
    content,
  };
}

function composeSystemPrompt(layers: readonly ResolvedPromptLayer[]): string {
  return [...layers]
    .sort((left, right) => left.precedence - right.precedence || left.sourceId.localeCompare(right.sourceId))
    .map((layer) => `<!-- metis-source:${layer.sourceId} digest:${layer.contentDigest} -->\n${layer.content}`)
    .join('\n\n');
}

function formatOutputContract(
  output: ResolvedRunManifest['output'],
  heading: string,
): string {
  const lines = [
    `# ${heading}`,
    `Required format: ${output.format}.`,
  ];
  if (output.plan) {
    lines.push(`Primary deliverable: ${output.plan.primaryDeliverable}.`);
    if (output.plan.supportingArtifacts.length > 0) {
      lines.push('Supporting artifacts:');
      lines.push(...output.plan.supportingArtifacts.map((artifact) => `- ${artifact}`));
    }
    if (output.plan.qualityCriteria.length > 0) {
      lines.push('Quality criteria:');
      lines.push(...output.plan.qualityCriteria.map((criterion) => `- ${criterion}`));
    }
  }
  if (output.schema) {
    lines.push(`Output schema: ${canonicalJson(output.schema)}`);
  }
  if (output.requireEvidenceEnvelope) {
    lines.push('Keep evidence and source references attached to the claims they support.');
  }
  if (output.includeIntegrityReport) {
    lines.push('Include an integrity report covering unresolved gaps and incomplete deliverables.');
  }
  return lines.join('\n');
}

function skillPromptContent(skill: SkillDefinitionV2): string {
  const sections = [
    skill.markdown,
    skill.systemPrompt,
  ];
  if (skill.inputSchema) sections.push(`# Skill input schema\n${canonicalJson(skill.inputSchema)}`);
  if (skill.outputSchema) sections.push(`# Skill output schema\n${canonicalJson(skill.outputSchema)}`);
  return sections.filter(Boolean).join('\n\n');
}

function agentPromptContent(agent: AgentDefinition): string {
  return [
    agent.systemPrompt,
    formatOutputContract(agent.output, `Agent output contract: ${agent.name}`),
  ].filter(Boolean).join('\n\n');
}

function scenarioHarnessPromptContent(scenario: ScenarioDefinition): string {
  const sections: string[] = [];
  if (scenario.scenarioMetis) sections.push(renderScenarioMetisMarkdown(scenario.scenarioMetis));
  if (scenario.deliverable) sections.push(`# Deliverable blueprint\n${canonicalJson(scenario.deliverable)}`);
  if (scenario.workflowPrompt?.trim()) sections.push(`# Workflow operating rules\n${scenario.workflowPrompt.trim()}`);
  return sections.join('\n\n');
}

/**
 * Compose the frozen prompt for either the complete scenario or one workflow step.
 * A step receives only its executing Agent and effective Skills, while every scoped
 * Metis.md rule and the scenario output contract continue to apply.
 */
export function composeManifestSystemPrompt(
  manifest: ResolvedRunManifest,
  step?: ResolvedRunManifest['workflow'][number],
): string {
  const layers = step
    ? manifest.promptStack.filter((layer) => (
        layer.sourceKind === 'rules'
        || layer.sourceKind === 'scenario_metis'
        || (layer.sourceKind === 'agent' && step.agentId !== undefined && layer.sourceId === step.agentId)
        || (layer.sourceKind === 'skill' && step.skillIds.includes(layer.sourceId))
      ))
    : manifest.promptStack;
  return [
    composeSystemPrompt(layers),
    formatOutputContract(manifest.output, 'Scenario output contract'),
  ].filter(Boolean).join('\n\n');
}

export class PersonalizationResolver {
  readonly #reader: PersonalizationDefinitionReader;

  constructor(reader: PersonalizationDefinitionReader) {
    this.#reader = reader;
  }

  resolve(request: ResolvePersonalizationRequest): ResolvePersonalizationResult {
    let candidate: PersonalizationDefinition | undefined;
    try {
      candidate = this.#reader.get(request.scenarioId);
    } catch {
      return { ok: false, code: 'definition_corrupt', issues: ['Scenario definition could not be decoded'] };
    }
    if (!candidate || candidate.kind !== 'scenario') {
      return { ok: false, code: 'scenario_not_found', issues: [`Scenario not found: ${request.scenarioId}`] };
    }
    if (!candidate.enabled) {
      return { ok: false, code: 'scenario_disabled', issues: [`Scenario is disabled: ${request.scenarioId}`] };
    }
    const scenario = candidate;

    try {
      const workflowAgentIds = scenario.workflow
        .map((step) => step.agentId)
        .filter((id): id is string => typeof id === 'string');
      const workflowSkillIds = scenario.workflow.flatMap((step) => step.skillIds);
      const workflowMcpIds = scenario.workflow.flatMap((step) => step.mcpIds);
      const agentResult = resolveKind(this.#reader, [...scenario.agentIds, ...workflowAgentIds], 'agent');
      const directSkillResult = resolveKind(this.#reader, [...scenario.skillIds, ...workflowSkillIds], 'skill');
      const agentSkillIds = agentResult.values.flatMap((agent) => agent.skillIds);
      const skillResult = resolveKind(this.#reader, [...directSkillResult.values.map((skill) => skill.id), ...agentSkillIds], 'skill');
      const skillMcpIds = skillResult.values.flatMap((skill) => skill.mcpIds);
      const agentMcpIds = agentResult.values.flatMap((agent) => agent.mcpIds);
      const mcpResult = resolveKind(
        this.#reader,
        [...scenario.mcpIds, ...workflowMcpIds, ...agentMcpIds, ...skillMcpIds],
        'mcp',
      );
      const globalRuleIds = this.#reader.list('rules', false)
        .filter((definition): definition is MetisRulesDefinition => definition.kind === 'rules' && definition.scope === 'global')
        .map((definition) => definition.id);
      const ruleResult = resolveKind(
        this.#reader,
        [
          ...globalRuleIds,
          ...scenario.rulesIds,
          ...(request.projectRulesId ? [request.projectRulesId] : []),
        ],
        'rules',
      );

      const selectedAgentIds = new Set(scenario.agentIds);
      const selectedSkillIds = new Set(scenario.skillIds);
      const selectedMcpIds = new Set(scenario.mcpIds);
      const workflowBindingIssues = scenario.workflow.flatMap((step) => [
        ...(step.agentId && !selectedAgentIds.has(step.agentId)
          ? [`Workflow Agent ${step.agentId} is not declared by scenario ${scenario.id}`]
          : []),
        ...step.skillIds
          .filter((skillId) => !selectedSkillIds.has(skillId))
          .map((skillId) => `Workflow Skill ${skillId} is not declared by scenario ${scenario.id}`),
        ...step.mcpIds
          .filter((mcpId) => !selectedMcpIds.has(mcpId))
          .map((mcpId) => `Workflow MCP ${mcpId} is not declared by scenario ${scenario.id}`),
      ]);
      const expectedProjectScopeId = `user:projects/${request.projectId}`;
      const scopeIssues = ruleResult.values.flatMap((rule) => {
        if (rule.scope === 'global') return [];
        if (rule.scope === 'scenario') {
          return rule.scopeId === scenario.id && scenario.rulesIds.includes(rule.id)
            ? []
            : [`Scenario rule ${rule.id} is not bound to ${scenario.id}`];
        }
        return rule.scopeId === expectedProjectScopeId && request.projectRulesId === rule.id
          ? []
          : [`Project rule ${rule.id} is not bound to ${expectedProjectScopeId}`];
      });

      const issues = unique([
        ...agentResult.issues,
        ...directSkillResult.issues,
        ...skillResult.issues,
        ...mcpResult.issues,
        ...ruleResult.issues,
        ...workflowBindingIssues,
        ...scopeIssues,
      ]);
      if (issues.length > 0) return { ok: false, code: 'dependency_invalid', issues };

      const agents = agentResult.values;
      const skills = skillResult.values;
      const mcps = mcpResult.values;
      const rules = ruleResult.values;
      const agentById = new Map(agents.map((agent) => [agent.id, agent]));
      const skillById = new Map(skills.map((skill) => [skill.id, skill]));
      const mcpById = new Map(mcps.map((mcp) => [mcp.id, mcp]));
      const resolveEffectiveStep = (step: ScenarioDefinition['workflow'][number]) => {
        const agent = step.agentId ? agentById.get(step.agentId) : undefined;
        const skillIds = unique([
          ...step.skillIds,
          ...(agent?.skillIds ?? []),
        ]);
        const stepSkills = skillIds
          .map((skillId) => skillById.get(skillId))
          .filter((skill): skill is SkillDefinitionV2 => skill !== undefined);
        const mcpIds = unique([
          ...step.mcpIds,
          ...(agent?.mcpIds ?? []),
          ...stepSkills.flatMap((skill) => skill.mcpIds),
        ]);
        const stepMcps = mcpIds
          .map((mcpId) => mcpById.get(mcpId))
          .filter((mcp): mcp is McpDefinition => mcp !== undefined);
        return {
          ...step,
          agentModelPreference: agent?.modelPreference ?? null,
          retryLimit: agent?.retryLimit ?? 0,
          memory: agent?.memory ?? scenario.memory,
          output: agent?.output ?? scenario.output,
          skillIds,
          mcpIds,
          toolIds: unique([
            ...step.toolIds,
            ...(agent?.toolIds ?? []),
            ...stepSkills.flatMap((skill) => skill.toolIds),
            ...stepMcps.flatMap((mcp) => mcp.exposedTools),
          ]).sort(),
          maxTurns: Math.max(1, Math.min(
            step.maxTurns,
            agent?.maxTurns ?? step.maxTurns,
            ...stepSkills.map((skill) => skill.maxTurns),
          )),
        };
      };
      const effectiveWorkflow = scenario.workflow.map(resolveEffectiveStep);
      const implicitOutputStep = scenario.workflow.length === 0
        && scenario.output.plan
        && agents.length === 1
        ? resolveEffectiveStep({
            id: 'runtime-output-plan',
            name: 'Generate configured deliverables',
            description: 'Generate the user-configured output plan with the selected Agent and bound capabilities.',
            agentId: agents[0]!.id,
            skillIds: [...scenario.skillIds],
            toolIds: [],
            mcpIds: [...scenario.mcpIds],
            dependsOn: [],
            maxTurns: agents[0]!.maxTurns,
          })
        : undefined;
      const promptStack: ResolvedPromptLayer[] = [
        ...skills.map((skill) => promptLayer(skill.id, 'skill', 100, skillPromptContent(skill))),
        ...agents.map((agent) => promptLayer(agent.id, 'agent', 200, agentPromptContent(agent))),
        ...rules.filter((rule) => rule.scope === 'global')
          .map((rule) => promptLayer(rule.id, 'rules', 300, rule.markdown)),
        ...rules.filter((rule) => rule.scope === 'scenario')
          .map((rule) => promptLayer(rule.id, 'rules', 400, rule.markdown)),
        ...(scenarioHarnessPromptContent(scenario)
          ? [promptLayer(scenario.id, 'scenario_metis', 450, scenarioHarnessPromptContent(scenario))]
          : []),
        ...rules.filter((rule) => rule.scope === 'project')
          .map((rule) => promptLayer(rule.id, 'rules', 500, rule.markdown)),
      ];
      const definitions: PersonalizationDefinition[] = [scenario, ...agents, ...skills, ...mcps, ...rules];
      const definitionRevisions = Object.fromEntries(
        definitions.map((definition) => [definition.id, definition.revision]),
      );
      const allowedTools = unique(effectiveWorkflow.length > 0
        ? effectiveWorkflow.flatMap((step) => step.toolIds)
        : [
            ...agents.flatMap((agent) => agent.toolIds),
            ...skills.flatMap((skill) => skill.toolIds),
            ...mcps.flatMap((mcp) => mcp.exposedTools),
          ]).sort();
      const maxTurns = Math.max(
        1,
        ...effectiveWorkflow.map((step) => step.maxTurns),
        ...agents.map((agent) => agent.maxTurns),
        ...skills.map((skill) => skill.maxTurns),
      );
      const manifestWithoutDigest = {
        contractVersion: 1 as const,
        sessionId: request.sessionId,
        projectId: request.projectId,
        scenarioId: scenario.id,
        scenarioRevision: scenario.revision,
        definitionRevisions,
        agentIds: agents.map((agent) => agent.id),
        skillIds: skills.map((skill) => skill.id),
        mcpIds: mcps.map((mcp) => mcp.id),
        allowedTools,
        workflow: effectiveWorkflow,
        ...(scenario.workflowPrompt?.trim() ? { workflowPrompt: scenario.workflowPrompt.trim() } : {}),
        ...(implicitOutputStep ? { implicitOutputStep } : {}),
        maxTurns,
        promptStack,
        ...(scenario.hooks && scenario.hooks.length > 0 ? { hooks: scenario.hooks } : {}),
        harnessVersion: scenario.revision,
        ...(scenario.deliverable ? { deliverable: scenario.deliverable } : {}),
        ...(scenario.writingStyle ? { writingStyle: scenario.writingStyle } : {}),
        ...(scenario.adaptivity ? { adaptivity: scenario.adaptivity } : {}),
        ...(scenario.scenarioMetis ? { scenarioMetis: scenario.scenarioMetis } : {}),
        ...(scenario.workflowGovernance ? { workflowGovernance: scenario.workflowGovernance } : {}),
        ...(scenario.workflowLoop ? { workflowLoop: scenario.workflowLoop } : {}),
        ...(scenario.checkpointPolicy ? { checkpointPolicy: scenario.checkpointPolicy } : {}),
        ...(scenario.qualityGates ? { qualityGates: scenario.qualityGates } : {}),
        fullAccess: scenario.fullAccess,
        memory: scenario.memory,
        output: scenario.output,
        truthPolicy: 'automatic_required' as const,
        createdAt: request.createdAt ?? Date.now(),
      };
      const manifest = ResolvedRunManifestSchema.parse({
        ...manifestWithoutDigest,
        manifestDigest: sha256(canonicalJson(manifestWithoutDigest)),
      });
      return {
        ok: true,
        manifest,
        scenario,
        agents,
        skills,
        mcps,
        rules,
        systemPrompt: composeManifestSystemPrompt(manifest),
      };
    } catch {
      return { ok: false, code: 'definition_corrupt', issues: ['Personalization graph could not be resolved'] };
    }
  }
}
