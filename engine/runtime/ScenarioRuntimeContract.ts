import { z } from 'zod';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';

/**
 * Renderer-safe contracts for research scenario discovery and plan drafting.
 *
 * A scenario plan is a prospective, editable workflow. It cannot represent
 * completed research, generated findings, or approved publication output.
 * Execution and release remain separate operations behind explicit human gates.
 */

export const SCENARIO_RUNTIME_CONTRACT_VERSION = 1 as const;

export const SCENARIO_RUNTIME_LIMITS = Object.freeze({
  titleChars: 240,
  labelChars: 320,
  shortTextChars: 2_000,
  longTextChars: 24_000,
  fieldKeyChars: 64,
  routeKeyChars: 96,
  templates: 16,
  requirementFields: 20,
  requirementOptions: 24,
  requirementResponses: 20,
  responseSelections: 24,
  stages: 12,
  stageActions: 24,
  stageOutputs: 16,
  approvalCriteria: 16,
  boundaryNotes: 24,
  capabilityRoutes: 16,
  recordKinds: 24,
  issueCount: 32,
  planVersion: 1_000_000_000,
} as const);

// eslint-disable-next-line no-control-regex
const UNSAFE_SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function boundedSingleLineText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_SINGLE_LINE_CONTROLS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function boundedMultilineText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_MULTILINE_CONTROLS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const parsed = schema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PlanVersionSchema = z.number().int().min(1).max(SCENARIO_RUNTIME_LIMITS.planVersion);

export const ScenarioLocaleSchema = z.enum(['zh', 'en']);

export const HumanitiesScenarioIdSchema = z.enum([
  'literature_review',
  'historical_source_criticism',
  'qualitative_interview_coding',
  'theoretical_text_comparison',
]);

export const ResearchCapabilityIdSchema = z.enum([
  'retrieval',
  'close_reading',
  'evidence_anchoring',
  'qualitative_coding',
  'quantitative_analysis',
  'writing_citations',
  'review_reproducibility',
]);

export const ResearchCapabilityRouteKeySchema = z.enum([
  'research.retrieve',
  'research.read',
  'research.evidence',
  'research.code.qualitative',
  'research.analyze.quantitative',
  'research.write.citations',
  'research.review.reproduce',
]);

export const ScenarioStageKindSchema = z.enum([
  'question_clarification',
  'source_import',
  'evidence_anchoring',
  'coding_and_claims',
  'counterevidence_and_limitations',
  'artifact_and_review',
]);

export const SCENARIO_STAGE_ORDER = [
  'question_clarification',
  'source_import',
  'evidence_anchoring',
  'coding_and_claims',
  'counterevidence_and_limitations',
  'artifact_and_review',
] as const;

export const ScenarioApprovalGateSchema = z.enum([
  'question_scope',
  'source_corpus',
  'evidence_sample',
  'codebook_or_claims',
  'limitations',
  'artifact_release',
]);

export const SCENARIO_APPROVAL_GATE_ORDER = [
  'question_scope',
  'source_corpus',
  'evidence_sample',
  'codebook_or_claims',
  'limitations',
  'artifact_release',
] as const;

export const ScenarioRecordKindSchema = z.enum([
  'research_question',
  'search_protocol',
  'source_query',
  'source_record',
  'document_text',
  'reading_note',
  'evidence_anchor',
  'codebook',
  'coded_excerpt',
  'dataset',
  'analysis_diagnostic',
  'claim',
  'counterevidence',
  'limitation',
  'draft_artifact',
  'citation_audit',
  'reproduction_record',
  'review_decision',
]);

export const ScenarioFieldKeySchema = boundedSingleLineText(
  SCENARIO_RUNTIME_LIMITS.fieldKeyChars,
).min(1).regex(/^[a-z][a-z0-9_]*$/u);

export const ScenarioRouteLabelSchema = boundedSingleLineText(
  SCENARIO_RUNTIME_LIMITS.routeKeyChars,
).min(1);

export const ScenarioTitleSchema = boundedSingleLineText(
  SCENARIO_RUNTIME_LIMITS.titleChars,
).min(1);

export const ScenarioLabelSchema = boundedSingleLineText(
  SCENARIO_RUNTIME_LIMITS.labelChars,
).min(1);

export const ScenarioShortTextSchema = boundedMultilineText(
  SCENARIO_RUNTIME_LIMITS.shortTextChars,
);

export const ScenarioLongTextSchema = boundedMultilineText(
  SCENARIO_RUNTIME_LIMITS.longTextChars,
);

export const ScenarioLocalizedTextSchema = z.strictObject({
  zh: ScenarioShortTextSchema.min(1),
  en: ScenarioShortTextSchema.min(1),
});

export type ScenarioLocale = z.infer<typeof ScenarioLocaleSchema>;
export type HumanitiesScenarioId = z.infer<typeof HumanitiesScenarioIdSchema>;
export type ResearchCapabilityId = z.infer<typeof ResearchCapabilityIdSchema>;
export type ResearchCapabilityRouteKey = z.infer<typeof ResearchCapabilityRouteKeySchema>;
export type ScenarioStageKind = z.infer<typeof ScenarioStageKindSchema>;
export type ScenarioApprovalGate = z.infer<typeof ScenarioApprovalGateSchema>;
export type ScenarioRecordKind = z.infer<typeof ScenarioRecordKindSchema>;
export type ScenarioLocalizedText = z.infer<typeof ScenarioLocalizedTextSchema>;

export const ResearchCapabilityRouteDtoSchema = z.strictObject({
  capabilityId: ResearchCapabilityIdSchema,
  routeKey: ResearchCapabilityRouteKeySchema,
  title: ScenarioLocalizedTextSchema,
  summary: ScenarioLocalizedTextSchema,
  acceptedInputs: z.array(ScenarioRecordKindSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.recordKinds),
  producedRecords: z.array(ScenarioRecordKindSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.recordKinds),
  supportedStages: z.array(ScenarioStageKindSchema)
    .min(1)
    .max(SCENARIO_STAGE_ORDER.length),
  humanReviewRequired: z.boolean(),
});

export type ResearchCapabilityRouteDto = z.infer<typeof ResearchCapabilityRouteDtoSchema>;

const RequirementFieldBaseSchema = {
  key: ScenarioFieldKeySchema,
  label: ScenarioLocalizedTextSchema,
  helpText: ScenarioLocalizedTextSchema,
  required: z.boolean(),
};

const ScenarioShortTextFieldSchema = z.strictObject({
  ...RequirementFieldBaseSchema,
  kind: z.literal('short_text'),
  placeholder: ScenarioLocalizedTextSchema,
});

const ScenarioLongTextFieldSchema = z.strictObject({
  ...RequirementFieldBaseSchema,
  kind: z.literal('long_text'),
  placeholder: ScenarioLocalizedTextSchema,
});

export const ScenarioRequirementOptionDtoSchema = z.strictObject({
  value: ScenarioFieldKeySchema,
  label: ScenarioLocalizedTextSchema,
});

const ScenarioSingleSelectFieldSchema = z.strictObject({
  ...RequirementFieldBaseSchema,
  kind: z.literal('single_select'),
  options: z.array(ScenarioRequirementOptionDtoSchema)
    .min(2)
    .max(SCENARIO_RUNTIME_LIMITS.requirementOptions),
});

const ScenarioMultiSelectFieldSchema = z.strictObject({
  ...RequirementFieldBaseSchema,
  kind: z.literal('multi_select'),
  options: z.array(ScenarioRequirementOptionDtoSchema)
    .min(2)
    .max(SCENARIO_RUNTIME_LIMITS.requirementOptions),
});

export const ScenarioRequirementFieldDtoSchema = z.discriminatedUnion('kind', [
  ScenarioShortTextFieldSchema,
  ScenarioLongTextFieldSchema,
  ScenarioSingleSelectFieldSchema,
  ScenarioMultiSelectFieldSchema,
]);

export type ScenarioRequirementOptionDto = z.infer<typeof ScenarioRequirementOptionDtoSchema>;
export type ScenarioRequirementFieldDto = z.infer<typeof ScenarioRequirementFieldDtoSchema>;

export const ScenarioHumanApprovalDtoSchema = z.strictObject({
  gate: ScenarioApprovalGateSchema,
  title: ScenarioLocalizedTextSchema,
  instruction: ScenarioLocalizedTextSchema,
  criteria: z.array(ScenarioLocalizedTextSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.approvalCriteria),
});

export const ScenarioStageTemplateDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  kind: ScenarioStageKindSchema,
  title: ScenarioLocalizedTextSchema,
  objective: ScenarioLocalizedTextSchema,
  actions: z.array(ScenarioLocalizedTextSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.stageActions),
  expectedOutputs: z.array(ScenarioLocalizedTextSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.stageOutputs),
  capabilityIds: z.array(ResearchCapabilityIdSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.capabilityRoutes),
  humanApproval: ScenarioHumanApprovalDtoSchema,
});

export type ScenarioHumanApprovalDto = z.infer<typeof ScenarioHumanApprovalDtoSchema>;
export type ScenarioStageTemplateDto = z.infer<typeof ScenarioStageTemplateDtoSchema>;

export const ScenarioTemplateDtoSchema = z.strictObject({
  id: HumanitiesScenarioIdSchema,
  version: PlanVersionSchema,
  title: ScenarioLocalizedTextSchema,
  summary: ScenarioLocalizedTextSchema,
  suitableFor: z.array(ScenarioLocalizedTextSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.boundaryNotes),
  boundaryNotes: z.array(ScenarioLocalizedTextSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.boundaryNotes),
  requirementFields: z.array(ScenarioRequirementFieldDtoSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.requirementFields),
  stages: z.array(ScenarioStageTemplateDtoSchema)
    .length(SCENARIO_STAGE_ORDER.length),
}).superRefine((template, context) => {
  const fieldKeys = new Set<string>();
  for (const field of template.requirementFields) {
    if (fieldKeys.has(field.key)) {
      context.addIssue({
        code: 'custom',
        path: ['requirementFields'],
        message: 'Requirement field keys must be unique',
      });
    }
    fieldKeys.add(field.key);
  }

  const stageIds = new Set<string>();
  template.stages.forEach((stage, index) => {
    if (stage.kind !== SCENARIO_STAGE_ORDER[index]) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index, 'kind'],
        message: 'Scenario stages must follow the fixed research workflow order',
      });
    }
    if (stage.humanApproval.gate !== SCENARIO_APPROVAL_GATE_ORDER[index]) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index, 'humanApproval', 'gate'],
        message: 'Human approval gates must follow the fixed workflow order',
      });
    }
    if (stageIds.has(stage.id)) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index, 'id'],
        message: 'Scenario stage identifiers must be unique',
      });
    }
    stageIds.add(stage.id);
  });
});

export type ScenarioTemplateDto = z.infer<typeof ScenarioTemplateDtoSchema>;

export const ScenarioRequirementResponseValueSchema = z.union([
  ScenarioLongTextSchema,
  z.array(ScenarioFieldKeySchema).max(SCENARIO_RUNTIME_LIMITS.responseSelections),
]);

export const ScenarioRequirementResponseDtoSchema = z.strictObject({
  fieldKey: ScenarioFieldKeySchema,
  value: ScenarioRequirementResponseValueSchema,
});

export type ScenarioRequirementResponseValue = z.infer<typeof ScenarioRequirementResponseValueSchema>;
export type ScenarioRequirementResponseDto = z.infer<typeof ScenarioRequirementResponseDtoSchema>;

export const ScenarioPlanStageApprovalDtoSchema = z.strictObject({
  gate: ScenarioApprovalGateSchema,
  title: ScenarioLabelSchema,
  instruction: ScenarioShortTextSchema.min(1),
  criteria: z.array(ScenarioShortTextSchema.min(1))
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.approvalCriteria),
  status: z.literal('pending_human_review'),
});

export const ScenarioPlanStageDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  kind: ScenarioStageKindSchema,
  order: z.number().int().min(1).max(SCENARIO_RUNTIME_LIMITS.stages),
  title: ScenarioTitleSchema,
  objective: ScenarioShortTextSchema.min(1),
  actions: z.array(ScenarioShortTextSchema.min(1))
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.stageActions),
  expectedOutputs: z.array(ScenarioShortTextSchema.min(1))
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.stageOutputs),
  capabilityIds: z.array(ResearchCapabilityIdSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.capabilityRoutes),
  status: z.literal('not_started'),
  humanApproval: ScenarioPlanStageApprovalDtoSchema,
});

export type ScenarioPlanStageApprovalDto = z.infer<typeof ScenarioPlanStageApprovalDtoSchema>;
export type ScenarioPlanStageDto = z.infer<typeof ScenarioPlanStageDtoSchema>;

export const ScenarioPlanDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  requestId: RuntimeIdSchema,
  scenarioId: HumanitiesScenarioIdSchema,
  scenarioVersion: PlanVersionSchema,
  planVersion: PlanVersionSchema,
  locale: ScenarioLocaleSchema,
  title: ScenarioTitleSchema,
  researchQuestion: ScenarioShortTextSchema.min(1),
  requirementResponses: z.array(ScenarioRequirementResponseDtoSchema)
    .max(SCENARIO_RUNTIME_LIMITS.requirementResponses),
  stages: z.array(ScenarioPlanStageDtoSchema)
    .length(SCENARIO_STAGE_ORDER.length),
  boundaryNotes: z.array(ScenarioShortTextSchema.min(1))
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.boundaryNotes),
  capabilityIds: z.array(ResearchCapabilityIdSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.capabilityRoutes),
  researchStatus: z.literal('not_started'),
  completionClaim: z.literal('none'),
  requiresHumanApprovalBeforeExecution: z.literal(true),
  requiresHumanApprovalBeforeRelease: z.literal(true),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).superRefine((plan, context) => {
  const capabilityIds = new Set(plan.capabilityIds);
  if (capabilityIds.size !== plan.capabilityIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['capabilityIds'],
      message: 'Plan capability identifiers must be unique',
    });
  }
  const stageIds = new Set<string>();
  const responseKeys = new Set<string>();
  plan.requirementResponses.forEach((response, index) => {
    if (responseKeys.has(response.fieldKey)) {
      context.addIssue({
        code: 'custom',
        path: ['requirementResponses', index, 'fieldKey'],
        message: 'Requirement responses must be unique by field key',
      });
    }
    responseKeys.add(response.fieldKey);
  });
  plan.stages.forEach((stage, index) => {
    if (stage.kind !== SCENARIO_STAGE_ORDER[index] || stage.order !== index + 1) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index],
        message: 'Plan stages must retain the fixed workflow order',
      });
    }
    if (stage.humanApproval.gate !== SCENARIO_APPROVAL_GATE_ORDER[index]) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index, 'humanApproval', 'gate'],
        message: 'Plan approval gates must follow the fixed workflow order',
      });
    }
    if (stageIds.has(stage.id)) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index, 'id'],
        message: 'Plan stage identifiers must be unique',
      });
    }
    stageIds.add(stage.id);
    for (const capabilityId of stage.capabilityIds) {
      if (!capabilityIds.has(capabilityId)) {
        context.addIssue({
          code: 'custom',
          path: ['stages', index, 'capabilityIds'],
          message: 'Stage capability must be declared by the plan',
        });
      }
    }
  });
});

export type ScenarioPlanDto = z.infer<typeof ScenarioPlanDtoSchema>;

export const ScenarioListTemplatesRequestSchema = z.strictObject({
  operation: z.literal('list_templates'),
  locale: ScenarioLocaleSchema,
  includeCapabilityRoutes: z.boolean(),
});

export const ScenarioGetTemplateRequestSchema = z.strictObject({
  operation: z.literal('get_template'),
  scenarioId: HumanitiesScenarioIdSchema,
  locale: ScenarioLocaleSchema,
});

export const ScenarioGeneratePlanRequestSchema = z.strictObject({
  operation: z.literal('generate_plan'),
  requestId: RuntimeIdSchema,
  scenarioId: HumanitiesScenarioIdSchema,
  locale: ScenarioLocaleSchema,
  projectTitle: ScenarioTitleSchema,
  researchQuestion: ScenarioShortTextSchema.min(1),
  requirementResponses: z.array(ScenarioRequirementResponseDtoSchema)
    .max(SCENARIO_RUNTIME_LIMITS.requirementResponses),
  selectedCapabilityIds: z.array(ResearchCapabilityIdSchema)
    .min(1)
    .max(SCENARIO_RUNTIME_LIMITS.capabilityRoutes),
});

export const ScenarioSavePlanDraftRequestSchema = z.strictObject({
  operation: z.literal('save_plan_draft'),
  requestId: RuntimeIdSchema,
  expectedPlanVersion: PlanVersionSchema,
  plan: ScenarioPlanDtoSchema,
});

export const ScenarioRuntimeRequestSchema = z.discriminatedUnion('operation', [
  ScenarioListTemplatesRequestSchema,
  ScenarioGetTemplateRequestSchema,
  ScenarioGeneratePlanRequestSchema,
  ScenarioSavePlanDraftRequestSchema,
]);

export type ScenarioListTemplatesRequest = z.infer<typeof ScenarioListTemplatesRequestSchema>;
export type ScenarioGetTemplateRequest = z.infer<typeof ScenarioGetTemplateRequestSchema>;
export type ScenarioGeneratePlanRequest = z.infer<typeof ScenarioGeneratePlanRequestSchema>;
export type ScenarioSavePlanDraftRequest = z.infer<typeof ScenarioSavePlanDraftRequestSchema>;
export type ScenarioRuntimeRequest = z.infer<typeof ScenarioRuntimeRequestSchema>;

export const ScenarioRuntimeRecoverySchema = z.strictObject({
  kind: z.literal('recovery'),
  code: z.enum([
    'scenario_list_request_unavailable',
    'scenario_get_request_unavailable',
    'scenario_generate_request_unavailable',
    'scenario_save_request_unavailable',
    'scenario_request_unavailable',
    'scenario_result_unavailable',
  ]),
});

export type ScenarioRuntimeRecovery = z.infer<typeof ScenarioRuntimeRecoverySchema>;

export type ScenarioRequestDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; recovery: ScenarioRuntimeRecovery };

export type ScenarioResultDecodeResult<T> = ScenarioRequestDecodeResult<T>;

function decodeScenarioRequest<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: ScenarioRuntimeRecovery['code'],
): ScenarioRequestDecodeResult<T> {
  const value = parseWithoutThrow(schema, input);
  return value === undefined
    ? { ok: false, recovery: { kind: 'recovery', code } }
    : { ok: true, value };
}

export function decodeScenarioListTemplatesRequest(
  input: unknown,
): ScenarioRequestDecodeResult<ScenarioListTemplatesRequest> {
  return decodeScenarioRequest(
    ScenarioListTemplatesRequestSchema,
    input,
    'scenario_list_request_unavailable',
  );
}

export function decodeScenarioGetTemplateRequest(
  input: unknown,
): ScenarioRequestDecodeResult<ScenarioGetTemplateRequest> {
  return decodeScenarioRequest(
    ScenarioGetTemplateRequestSchema,
    input,
    'scenario_get_request_unavailable',
  );
}

export function decodeScenarioGeneratePlanRequest(
  input: unknown,
): ScenarioRequestDecodeResult<ScenarioGeneratePlanRequest> {
  return decodeScenarioRequest(
    ScenarioGeneratePlanRequestSchema,
    input,
    'scenario_generate_request_unavailable',
  );
}

export function decodeScenarioSavePlanDraftRequest(
  input: unknown,
): ScenarioRequestDecodeResult<ScenarioSavePlanDraftRequest> {
  return decodeScenarioRequest(
    ScenarioSavePlanDraftRequestSchema,
    input,
    'scenario_save_request_unavailable',
  );
}

export function decodeScenarioRuntimeRequest(
  input: unknown,
): ScenarioRequestDecodeResult<ScenarioRuntimeRequest> {
  return decodeScenarioRequest(
    ScenarioRuntimeRequestSchema,
    input,
    'scenario_request_unavailable',
  );
}

export const ScenarioIssueCodeSchema = z.enum([
  'request_invalid',
  'template_unavailable',
  'required_response_missing',
  'response_type_invalid',
  'response_option_invalid',
  'duplicate_response',
  'capability_unavailable',
  'plan_conflict',
  'service_unavailable',
]);

export const ScenarioIssueDtoSchema = z.strictObject({
  code: ScenarioIssueCodeSchema,
  fieldKey: ScenarioFieldKeySchema.nullable(),
});

export type ScenarioIssueCode = z.infer<typeof ScenarioIssueCodeSchema>;
export type ScenarioIssueDto = z.infer<typeof ScenarioIssueDtoSchema>;

const ScenarioTemplateListSuccessSchema = z.strictObject({
  success: z.literal(true),
  resultKind: z.literal('template_list'),
  templates: z.array(ScenarioTemplateDtoSchema).max(SCENARIO_RUNTIME_LIMITS.templates),
  capabilityRoutes: z.array(ResearchCapabilityRouteDtoSchema)
    .max(SCENARIO_RUNTIME_LIMITS.capabilityRoutes),
});

const ScenarioTemplateListFailureSchema = z.strictObject({
  success: z.literal(false),
  resultKind: z.literal('template_list'),
  code: z.literal('scenario_templates_unavailable'),
  templates: z.tuple([]),
  capabilityRoutes: z.tuple([]),
});

export const ScenarioTemplateListResultSchema = z.discriminatedUnion('success', [
  ScenarioTemplateListSuccessSchema,
  ScenarioTemplateListFailureSchema,
]);

const ScenarioTemplateSuccessSchema = z.strictObject({
  success: z.literal(true),
  resultKind: z.literal('template'),
  template: ScenarioTemplateDtoSchema,
});

const ScenarioTemplateFailureSchema = z.strictObject({
  success: z.literal(false),
  resultKind: z.literal('template'),
  code: z.literal('scenario_template_unavailable'),
});

export const ScenarioTemplateResultSchema = z.discriminatedUnion('success', [
  ScenarioTemplateSuccessSchema,
  ScenarioTemplateFailureSchema,
]);

const ScenarioPlanSuccessSchema = z.strictObject({
  success: z.literal(true),
  resultKind: z.literal('plan_draft'),
  code: z.literal('scenario_plan_drafted'),
  plan: ScenarioPlanDtoSchema,
});

const ScenarioPlanFailureSchema = z.strictObject({
  success: z.literal(false),
  resultKind: z.literal('plan_draft'),
  code: z.enum([
    'scenario_request_invalid',
    'scenario_template_unavailable',
    'scenario_requirements_incomplete',
    'scenario_plan_unavailable',
    'scenario_service_unavailable',
  ]),
  issues: z.array(ScenarioIssueDtoSchema).max(SCENARIO_RUNTIME_LIMITS.issueCount),
});

export const ScenarioPlanResultSchema = z.discriminatedUnion('success', [
  ScenarioPlanSuccessSchema,
  ScenarioPlanFailureSchema,
]);

const ScenarioSavePlanSuccessSchema = z.strictObject({
  success: z.literal(true),
  resultKind: z.literal('plan_saved'),
  code: z.literal('scenario_plan_saved'),
  plan: ScenarioPlanDtoSchema,
});

const ScenarioSavePlanFailureSchema = z.strictObject({
  success: z.literal(false),
  resultKind: z.literal('plan_saved'),
  code: z.enum([
    'scenario_request_invalid',
    'scenario_plan_conflict',
    'scenario_plan_unavailable',
    'scenario_service_unavailable',
  ]),
  issues: z.array(ScenarioIssueDtoSchema).max(SCENARIO_RUNTIME_LIMITS.issueCount),
});

export const ScenarioSavePlanResultSchema = z.discriminatedUnion('success', [
  ScenarioSavePlanSuccessSchema,
  ScenarioSavePlanFailureSchema,
]);

export const ScenarioRuntimeResultSchema = z.union([
  ScenarioTemplateListResultSchema,
  ScenarioTemplateResultSchema,
  ScenarioPlanResultSchema,
  ScenarioSavePlanResultSchema,
]);

export type ScenarioTemplateListResult = z.infer<typeof ScenarioTemplateListResultSchema>;
export type ScenarioTemplateResult = z.infer<typeof ScenarioTemplateResultSchema>;
export type ScenarioPlanResult = z.infer<typeof ScenarioPlanResultSchema>;
export type ScenarioSavePlanResult = z.infer<typeof ScenarioSavePlanResultSchema>;
export type ScenarioRuntimeResult = z.infer<typeof ScenarioRuntimeResultSchema>;

export function createScenarioTemplateListRecovery(): ScenarioTemplateListResult {
  return {
    success: false,
    resultKind: 'template_list',
    code: 'scenario_templates_unavailable',
    templates: [],
    capabilityRoutes: [],
  };
}

export function createScenarioTemplateRecovery(): ScenarioTemplateResult {
  return {
    success: false,
    resultKind: 'template',
    code: 'scenario_template_unavailable',
  };
}

export function createScenarioPlanRecovery(): ScenarioPlanResult {
  return {
    success: false,
    resultKind: 'plan_draft',
    code: 'scenario_plan_unavailable',
    issues: [],
  };
}

export function createScenarioSavePlanRecovery(): ScenarioSavePlanResult {
  return {
    success: false,
    resultKind: 'plan_saved',
    code: 'scenario_plan_unavailable',
    issues: [],
  };
}

export function decodeScenarioTemplateListResult(input: unknown): ScenarioTemplateListResult {
  return parseWithoutThrow(ScenarioTemplateListResultSchema, input)
    ?? createScenarioTemplateListRecovery();
}

export function decodeScenarioTemplateResult(input: unknown): ScenarioTemplateResult {
  return parseWithoutThrow(ScenarioTemplateResultSchema, input)
    ?? createScenarioTemplateRecovery();
}

export function decodeScenarioPlanResult(input: unknown): ScenarioPlanResult {
  return parseWithoutThrow(ScenarioPlanResultSchema, input)
    ?? createScenarioPlanRecovery();
}

export function decodeScenarioSavePlanResult(input: unknown): ScenarioSavePlanResult {
  return parseWithoutThrow(ScenarioSavePlanResultSchema, input)
    ?? createScenarioSavePlanRecovery();
}

export function decodeScenarioRuntimeResult(
  input: unknown,
): ScenarioResultDecodeResult<ScenarioRuntimeResult> {
  return decodeScenarioRequest(
    ScenarioRuntimeResultSchema,
    input,
    'scenario_result_unavailable',
  );
}
