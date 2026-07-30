import { z } from 'zod';

/**
 * Public contract for user-personalized Metis behavior.
 *
 * Truth and provenance states are deliberately absent from editable definitions. A scenario,
 * skill, agent, MCP server, or Metis.md layer may influence research behavior, but only the
 * main-process Truth Layer may assert that evidence is verified, clean, corrected, or safe to
 * publish.
 */

export const PERSONALIZATION_CONTRACT_VERSION = 1 as const;

export const PERSONALIZATION_LIMITS = Object.freeze({
  idChars: 160,
  nameChars: 200,
  descriptionChars: 4_000,
  markdownChars: 500_000,
  promptChars: 500_000,
  urlChars: 8_192,
  commandChars: 4_096,
  argumentChars: 4_096,
  environmentKeys: 128,
  environmentKeyChars: 128,
  references: 256,
  tags: 128,
  tagChars: 128,
  tools: 512,
  workflowSteps: 128,
  definitionList: 2_000,
  version: 1_000_000_000,
} as const);

// eslint-disable-next-line no-control-regex -- this boundary intentionally rejects C0/C1 input
const UNSAFE_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- tabs/newlines are allowed in authored instructions
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function singleLine(max: number) {
  return z.string().min(1).max(max).refine((value) => !UNSAFE_SINGLE_LINE.test(value), {
    message: 'Text contains unsafe control characters',
  });
}

function multiline(max: number) {
  return z.string().max(max).refine((value) => !UNSAFE_MULTILINE.test(value), {
    message: 'Text contains unsafe control characters',
  });
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function httpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

export const PersonalizationIdSchema = z.string()
  .min(3)
  .max(PERSONALIZATION_LIMITS.idChars)
  .regex(/^(?:builtin|user|url|generated):[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine((value) => !value.includes('..') && !value.includes('\\'), {
    message: 'Identifier contains an unsafe path segment',
  });

export const PersonalizationLocalIdSchema = z.string()
  .min(1)
  .max(PERSONALIZATION_LIMITS.idChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const PersonalizationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const PersonalizationSemverSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
export const PersonalizationTimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PersonalizationUrlSchema = z.string()
  .min(1)
  .max(PERSONALIZATION_LIMITS.urlChars)
  .refine(httpUrl, { message: 'Only credential-free HTTP(S) URLs are supported' });

const ReferenceListSchema = z.array(PersonalizationIdSchema)
  .max(PERSONALIZATION_LIMITS.references)
  .refine(uniqueStrings, { message: 'References must be unique' });
const ToolListSchema = z.array(PersonalizationLocalIdSchema)
  .max(PERSONALIZATION_LIMITS.tools)
  .refine(uniqueStrings, { message: 'Tools must be unique' })
  .refine((tools) => !tools.includes('execute_command'), {
    message: 'Full Access personalization cannot bind an unrestricted command interpreter',
  });
const TagListSchema = z.array(singleLine(PERSONALIZATION_LIMITS.tagChars))
  .max(PERSONALIZATION_LIMITS.tags)
  .refine(uniqueStrings, { message: 'Tags must be unique' });

export const DefinitionOriginSchema = z.enum(['builtin', 'user', 'url', 'generated']);
export const PersonalizationKindSchema = z.enum(['scenario', 'agent', 'skill', 'mcp', 'rules']);

export const DefinitionProvenanceSchema = z.strictObject({
  origin: DefinitionOriginSchema,
  author: singleLine(PERSONALIZATION_LIMITS.nameChars),
  version: PersonalizationSemverSchema,
  license: singleLine(PERSONALIZATION_LIMITS.nameChars).nullable(),
  sourceUrl: PersonalizationUrlSchema.nullable(),
  sourceRevision: singleLine(256).nullable(),
  installedDigest: PersonalizationDigestSchema.nullable(),
  parentId: PersonalizationIdSchema.nullable(),
  parentVersion: PersonalizationSemverSchema.nullable(),
  locallyModified: z.boolean(),
  createdAt: PersonalizationTimestampSchema,
  updatedAt: PersonalizationTimestampSchema,
}).superRefine((value, context) => {
  if (value.origin === 'url' && value.sourceUrl === null) {
    context.addIssue({ code: 'custom', message: 'URL definitions require sourceUrl', path: ['sourceUrl'] });
  }
  if (value.parentId === null && value.parentVersion !== null) {
    context.addIssue({ code: 'custom', message: 'parentVersion requires parentId', path: ['parentVersion'] });
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'updatedAt cannot predate createdAt', path: ['updatedAt'] });
  }
});

const DefinitionHeaderSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  description: multiline(PERSONALIZATION_LIMITS.descriptionChars),
  enabled: z.boolean(),
  tags: TagListSchema,
  revision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  provenance: DefinitionProvenanceSchema,
});

export const FullAccessPolicySchema = z.strictObject({
  mode: z.literal('full_access'),
  perActionConfirmation: z.literal(false),
  liveSteering: z.literal(true),
  silentCheckpoints: z.boolean(),
  /** Generic external side effects are not falsely advertised as reversible. */
  rollbackOnFailure: z.literal(false),
  persistAcrossRestart: z.boolean(),
});

export const MemoryPolicySchema = z.strictObject({
  scope: z.enum(['none', 'session', 'project', 'scenario']),
  retainDecisions: z.boolean(),
  retainArtifacts: z.boolean(),
  maxSummaryChars: z.number().int().min(1_000).max(500_000),
});

export const OutputPlanSchema = z.strictObject({
  primaryDeliverable: singleLine(512),
  supportingArtifacts: z.array(singleLine(512)).max(64).refine(uniqueStrings, {
    message: 'Supporting artifacts must be unique',
  }),
  qualityCriteria: z.array(singleLine(1_000)).max(64).refine(uniqueStrings, {
    message: 'Quality criteria must be unique',
  }),
});

export const OutputContractSchema = z.strictObject({
  format: z.enum(['markdown', 'json', 'document', 'artifact_bundle', 'custom']),
  schema: z.record(z.string(), z.unknown()).nullable(),
  plan: OutputPlanSchema.nullable().optional(),
  requireEvidenceEnvelope: z.boolean(),
  includeIntegrityReport: z.boolean(),
});

export const WorkflowStepBindingSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  description: multiline(PERSONALIZATION_LIMITS.descriptionChars),
  agentId: PersonalizationIdSchema,
  skillIds: ReferenceListSchema,
  toolIds: ToolListSchema,
  mcpIds: ReferenceListSchema,
  dependsOn: z.array(PersonalizationLocalIdSchema)
    .max(PERSONALIZATION_LIMITS.workflowSteps)
    .refine(uniqueStrings, { message: 'Workflow dependencies must be unique' }),
  maxTurns: z.number().int().min(1).max(100),
});

/** Runtime-only fields resolved from the executing Agent and its bound Skills. */
export const ResolvedWorkflowStepSchema = WorkflowStepBindingSchema.extend({
  agentModelPreference: singleLine(512).nullable().optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
  memory: MemoryPolicySchema.optional(),
  output: OutputContractSchema.optional(),
}).strict();

export const AgentDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('agent'),
  role: singleLine(PERSONALIZATION_LIMITS.nameChars),
  systemPrompt: multiline(PERSONALIZATION_LIMITS.promptChars),
  modelPreference: singleLine(512).nullable(),
  skillIds: ReferenceListSchema,
  toolIds: ToolListSchema,
  mcpIds: ReferenceListSchema,
  memory: MemoryPolicySchema,
  output: OutputContractSchema,
  maxTurns: z.number().int().min(1).max(100),
  retryLimit: z.number().int().min(0).max(10),
}).strict();

export const SkillDefinitionV2Schema = DefinitionHeaderSchema.extend({
  kind: z.literal('skill'),
  sourceMode: z.enum(['markdown', 'package', 'url']),
  markdown: multiline(PERSONALIZATION_LIMITS.markdownChars),
  systemPrompt: multiline(PERSONALIZATION_LIMITS.promptChars),
  toolIds: ToolListSchema,
  mcpIds: ReferenceListSchema,
  maxTurns: z.number().int().min(1).max(100),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  packageEntry: singleLine(512).nullable(),
}).strict();

const EnvironmentSchema = z.record(
  z.string().min(1).max(PERSONALIZATION_LIMITS.environmentKeyChars).regex(/^[A-Z_][A-Z0-9_]*$/u),
  z.strictObject({
    secret: z.boolean(),
    value: singleLine(PERSONALIZATION_LIMITS.argumentChars).nullable(),
  }),
).refine((value) => Object.keys(value).length <= PERSONALIZATION_LIMITS.environmentKeys, {
  message: 'Too many environment entries',
});

export const McpDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('mcp'),
  sourceMode: z.enum(['generated', 'url']),
  transport: z.literal('stdio'),
  command: singleLine(PERSONALIZATION_LIMITS.commandChars),
  args: z.array(singleLine(PERSONALIZATION_LIMITS.argumentChars)).max(128),
  environment: EnvironmentSchema,
  sourceUrl: PersonalizationUrlSchema.nullable(),
  exposedTools: ToolListSchema,
  workingDirectoryToken: PersonalizationLocalIdSchema.nullable(),
}).strict();

export const MetisRulesDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('rules'),
  scope: z.enum(['global', 'scenario', 'project']),
  scopeId: PersonalizationIdSchema.nullable(),
  markdown: multiline(PERSONALIZATION_LIMITS.markdownChars),
}).strict().superRefine((value, context) => {
  if (value.scope === 'global' && value.scopeId !== null) {
    context.addIssue({ code: 'custom', message: 'Global rules cannot have scopeId', path: ['scopeId'] });
  }
  if (value.scope !== 'global' && value.scopeId === null) {
    context.addIssue({ code: 'custom', message: 'Scoped rules require scopeId', path: ['scopeId'] });
  }
});

export const ScenarioDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('scenario'),
  agentIds: ReferenceListSchema,
  skillIds: ReferenceListSchema,
  mcpIds: ReferenceListSchema,
  rulesIds: ReferenceListSchema,
  workflow: z.array(WorkflowStepBindingSchema)
    .max(PERSONALIZATION_LIMITS.workflowSteps)
    .refine((steps) => uniqueStrings(steps.map((step) => step.id)), {
      message: 'Workflow step IDs must be unique',
    }),
  fullAccess: FullAccessPolicySchema,
  memory: MemoryPolicySchema,
  output: OutputContractSchema,
  triggerPhrases: z.array(singleLine(512)).max(128).refine(uniqueStrings, {
    message: 'Trigger phrases must be unique',
  }),
  capability: z.enum(['research', 'writing', 'analysis', 'funding', 'presentation_reserved', 'custom']),
}).strict().superRefine((value, context) => {
  const stepIds = new Set(value.workflow.map((step) => step.id));
  const selectedAgentIds = new Set(value.agentIds);
  const selectedSkillIds = new Set(value.skillIds);
  const selectedMcpIds = new Set(value.mcpIds);
  for (let index = 0; index < value.workflow.length; index += 1) {
    const step = value.workflow[index];
    if (!step) continue;
    if (!selectedAgentIds.has(step.agentId)) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow Agent must be declared by scenario',
        path: ['workflow', index, 'agentId'],
      });
    }
    for (const skillId of step.skillIds) {
      if (selectedSkillIds.has(skillId)) continue;
      context.addIssue({
        code: 'custom',
        message: 'Workflow Skill must be declared by scenario',
        path: ['workflow', index, 'skillIds'],
      });
    }
    for (const mcpId of step.mcpIds) {
      if (selectedMcpIds.has(mcpId)) continue;
      context.addIssue({
        code: 'custom',
        message: 'Workflow MCP must be declared by scenario',
        path: ['workflow', index, 'mcpIds'],
      });
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        context.addIssue({
          code: 'custom',
          message: 'Workflow dependency does not exist',
          path: ['workflow', index, 'dependsOn'],
        });
      }
      if (dependency === step.id) {
        context.addIssue({
          code: 'custom',
          message: 'Workflow step cannot depend on itself',
          path: ['workflow', index, 'dependsOn'],
        });
      }
    }
  }
  const indegree = new Map(value.workflow.map((step) => [step.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const step of value.workflow) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency) || dependency === step.id) continue;
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      const children = dependents.get(dependency) ?? [];
      children.push(step.id);
      dependents.set(dependency, children);
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    visited += 1;
    for (const child of dependents.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  if (visited !== value.workflow.length) {
    context.addIssue({
      code: 'custom',
      message: 'Workflow dependencies must form an acyclic DAG',
      path: ['workflow'],
    });
  }
  if (value.output.plan && value.workflow.length > 0) {
    const dependencyIds = new Set(value.workflow.flatMap((step) => step.dependsOn));
    const terminalSteps = value.workflow.filter((step) => !dependencyIds.has(step.id));
    if (terminalSteps.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'A scenario with an output plan must have exactly one final workflow step',
        path: ['workflow'],
      });
    }
  }
  if (value.capability === 'presentation_reserved') {
    const reservedBehaviorFields: Array<[boolean, keyof typeof value]> = [
      [value.enabled, 'enabled'],
      [value.agentIds.length > 0, 'agentIds'],
      [value.skillIds.length > 0, 'skillIds'],
      [value.mcpIds.length > 0, 'mcpIds'],
      [value.workflow.length > 0, 'workflow'],
      [value.triggerPhrases.length > 0, 'triggerPhrases'],
    ];
    for (const [hasBehavior, field] of reservedBehaviorFields) {
      if (!hasBehavior) continue;
      context.addIssue({
        code: 'custom',
        message: 'Presentation behavior is reserved until its product specification is approved',
        path: [field],
      });
    }
  }
});

export const PersonalizationDefinitionSchema = z.discriminatedUnion('kind', [
  ScenarioDefinitionSchema,
  AgentDefinitionSchema,
  SkillDefinitionV2Schema,
  McpDefinitionSchema,
  MetisRulesDefinitionSchema,
]);

export type DefinitionProvenance = z.infer<typeof DefinitionProvenanceSchema>;
export type FullAccessPolicy = z.infer<typeof FullAccessPolicySchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type SkillDefinitionV2 = z.infer<typeof SkillDefinitionV2Schema>;
export type McpDefinition = z.infer<typeof McpDefinitionSchema>;
export type MetisRulesDefinition = z.infer<typeof MetisRulesDefinitionSchema>;
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
export type PersonalizationDefinition = z.infer<typeof PersonalizationDefinitionSchema>;

export const PersonalizationListRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  kind: PersonalizationKindSchema.optional(),
  includeDisabled: z.boolean(),
});

export const PersonalizationGetRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
});

export const PersonalizationSaveRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  definition: PersonalizationDefinitionSchema,
  expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationDeleteRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  expectedRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationForkRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  sourceId: PersonalizationIdSchema,
  targetId: PersonalizationIdSchema.refine((value) => value.startsWith('user:'), {
    message: 'Fork target must use the user namespace',
  }),
  author: singleLine(PERSONALIZATION_LIMITS.nameChars),
});

export const PersonalizationRestoreRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  sourceRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  expectedRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationVersionsRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
});

export const PersonalizationResolveRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  scenarioId: PersonalizationIdSchema,
  projectRulesId: PersonalizationIdSchema.optional(),
});

export const PersonalizationListResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    definitions: z.array(PersonalizationDefinitionSchema).max(PERSONALIZATION_LIMITS.definitionList),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['invalid_request', 'unavailable', 'invalid_response']),
  }),
]);

export const PersonalizationGetResponseSchema = z.strictObject({
  ok: z.literal(true),
  definition: PersonalizationDefinitionSchema.nullable(),
});

export const PersonalizationVersionViewSchema = z.strictObject({
  id: PersonalizationIdSchema,
  revision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  contentDigest: PersonalizationDigestSchema,
  definition: PersonalizationDefinitionSchema,
  createdAt: PersonalizationTimestampSchema,
});

export const PersonalizationVersionsResponseSchema = z.strictObject({
  ok: z.literal(true),
  versions: z.array(PersonalizationVersionViewSchema).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationMutationResultSchema = z.discriminatedUnion('code', [
  z.strictObject({ ok: z.literal(true), code: z.literal('saved'), definition: PersonalizationDefinitionSchema }),
  z.strictObject({ ok: z.literal(true), code: z.literal('deleted'), id: PersonalizationIdSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal('invalid_request') }),
  z.strictObject({ ok: z.literal(false), code: z.literal('not_found') }),
  z.strictObject({ ok: z.literal(false), code: z.literal('factory_protected') }),
  z.strictObject({ ok: z.literal(false), code: z.literal('revision_conflict'), currentRevision: z.number().int().min(1) }),
  z.strictObject({ ok: z.literal(false), code: z.literal('dependency_invalid'), issues: z.array(multiline(4_000)).max(128) }),
  z.strictObject({ ok: z.literal(false), code: z.literal('io_error') }),
]);

export const ResolvedPromptLayerSchema = z.strictObject({
  sourceId: PersonalizationIdSchema,
  sourceKind: z.enum(['rules', 'agent', 'skill']),
  precedence: z.number().int().min(0).max(10_000),
  contentDigest: PersonalizationDigestSchema,
  content: multiline(PERSONALIZATION_LIMITS.promptChars),
});

export const ResolvedRunManifestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  scenarioId: PersonalizationIdSchema,
  scenarioRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  definitionRevisions: z.record(
    PersonalizationIdSchema,
    z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  ),
  agentIds: ReferenceListSchema,
  skillIds: ReferenceListSchema,
  mcpIds: ReferenceListSchema,
  allowedTools: ToolListSchema,
  workflow: z.array(ResolvedWorkflowStepSchema).max(PERSONALIZATION_LIMITS.workflowSteps),
  /** Frozen runtime policy for a one-Agent output plan whose authored workflow is intentionally empty. */
  implicitOutputStep: ResolvedWorkflowStepSchema.nullable().optional(),
  maxTurns: z.number().int().min(1).max(100),
  promptStack: z.array(ResolvedPromptLayerSchema).max(PERSONALIZATION_LIMITS.references),
  fullAccess: FullAccessPolicySchema,
  memory: MemoryPolicySchema,
  output: OutputContractSchema,
  truthPolicy: z.literal('automatic_required'),
  createdAt: PersonalizationTimestampSchema,
  manifestDigest: PersonalizationDigestSchema,
});

export const PersonalizationResolveResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), manifest: ResolvedRunManifestSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['scenario_not_found', 'scenario_disabled', 'dependency_invalid', 'definition_corrupt']),
    issues: z.array(multiline(4_000)).max(128),
  }),
]);

export type PersonalizationListRequest = z.infer<typeof PersonalizationListRequestSchema>;
export type PersonalizationGetRequest = z.infer<typeof PersonalizationGetRequestSchema>;
export type PersonalizationSaveRequest = z.infer<typeof PersonalizationSaveRequestSchema>;
export type PersonalizationDeleteRequest = z.infer<typeof PersonalizationDeleteRequestSchema>;
export type PersonalizationForkRequest = z.infer<typeof PersonalizationForkRequestSchema>;
export type PersonalizationRestoreRequest = z.infer<typeof PersonalizationRestoreRequestSchema>;
export type PersonalizationVersionsRequest = z.infer<typeof PersonalizationVersionsRequestSchema>;
export type PersonalizationResolveRequest = z.infer<typeof PersonalizationResolveRequestSchema>;
export type PersonalizationListResponse = z.infer<typeof PersonalizationListResponseSchema>;
export type PersonalizationGetResponse = z.infer<typeof PersonalizationGetResponseSchema>;
export type PersonalizationVersionView = z.infer<typeof PersonalizationVersionViewSchema>;
export type PersonalizationVersionsResponse = z.infer<typeof PersonalizationVersionsResponseSchema>;
export type PersonalizationMutationResult = z.infer<typeof PersonalizationMutationResultSchema>;
export type ResolvedPromptLayer = z.infer<typeof ResolvedPromptLayerSchema>;
export type ResolvedRunManifest = z.infer<typeof ResolvedRunManifestSchema>;
export type PersonalizationResolveResponse = z.infer<typeof PersonalizationResolveResponseSchema>;

export function decodePersonalizationDefinition(input: unknown): PersonalizationDefinition | undefined {
  const parsed = PersonalizationDefinitionSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function decodePersonalizationListResponse(input: unknown): PersonalizationListResponse {
  const parsed = PersonalizationListResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: false, code: 'invalid_response' };
}

export function decodePersonalizationGetResponse(input: unknown): PersonalizationGetResponse {
  const parsed = PersonalizationGetResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: true, definition: null };
}

export function decodePersonalizationVersionsResponse(input: unknown): PersonalizationVersionsResponse {
  const parsed = PersonalizationVersionsResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: true, versions: [] };
}

export function decodePersonalizationMutationResult(input: unknown): PersonalizationMutationResult {
  const parsed = PersonalizationMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: false, code: 'invalid_request' };
}

export function decodePersonalizationResolveResponse(input: unknown): PersonalizationResolveResponse {
  const parsed = PersonalizationResolveResponseSchema.safeParse(input);
  return parsed.success
    ? parsed.data
    : { ok: false, code: 'definition_corrupt', issues: ['Invalid personalization response'] };
}
