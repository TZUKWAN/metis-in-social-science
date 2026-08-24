/** Renderer-facing Outcomes workbench contract. */
import { z } from 'zod';

export const OUTCOME_RUNTIME_VERSION = 1 as const;
export const OUTCOME_LIMITS = Object.freeze({
  idChars: 128, titleChars: 512, textChars: 1_000_000, noteChars: 8_000,
  sourceCount: 64, categoryCount: 500, outcomes: 2_000, versions: 1_000,
  messages: 2_000, templateBytes: 1_000_000,
} as const);
// eslint-disable-next-line no-control-regex -- rejects non-printing control code points at the contract boundary.
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const text = (max: number) => z.string().max(max).refine((value) => !unsafeControls.test(value));
export const OutcomeIdSchema = z.string().min(1).max(OUTCOME_LIMITS.idChars).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().min(1).max(1_000_000_000);

export const OutcomeKindSchema = z.enum(['word', 'ppt', 'pdf', 'image', 'chart', 'other']);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;
export const OutcomeStatusSchema = z.enum(['draft', 'final', 'archived']);
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>;
export const OutcomeActorSchema = z.enum(['human', 'ai', 'import', 'restore']);
export type OutcomeActor = z.infer<typeof OutcomeActorSchema>;
export const OutcomeSourceSchema = z.strictObject({
  kind: z.enum(['selection', 'outcome_version', 'source', 'evidence', 'note_code', 'claim', 'artifact', 'project_metis', 'upload']),
  id: OutcomeIdSchema, version: version.optional(), label: text(OUTCOME_LIMITS.titleChars),
});
export type OutcomeSource = z.infer<typeof OutcomeSourceSchema>;

export const OutcomeDocxImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg']);
export type OutcomeDocxImageMediaType = z.infer<typeof OutcomeDocxImageMediaTypeSchema>;
export const WordDocumentSchema = z.strictObject({
  type: z.literal('word'),
  blocks: z.array(z.strictObject({
    id: OutcomeIdSchema,
    kind: z.enum(['paragraph', 'heading', 'table', 'image', 'figure_caption', 'table_caption']),
    text: text(OUTCOME_LIMITS.textChars).optional(), level: z.number().int().min(1).max(6).optional(),
    style: z.record(z.string(), z.unknown()).optional(), rows: z.array(z.array(text(100_000))).max(200).optional(),
    imageRef: OutcomeIdSchema.optional(), mediaType: OutcomeDocxImageMediaTypeSchema.optional(), displayName: text(OUTCOME_LIMITS.titleChars).optional(),
  })).max(20_000),
  page: z.record(z.string(), z.unknown()).default({}), header: text(20_000).default(''), footer: text(20_000).default(''),
});
export const PptElementSchema = z.strictObject({
  id: OutcomeIdSchema,
  type: z.enum(['text', 'rect', 'roundRect', 'ellipse', 'triangle', 'line', 'arrow', 'image', 'svg', 'table', 'chart', 'group']),
  x: z.number().int().min(0).max(32), y: z.number().int().min(0).max(18),
  width: z.number().int().min(1).max(32), height: z.number().int().min(1).max(18),
  locked: z.boolean().default(false), props: z.record(z.string(), z.unknown()).default({}),
});
export type PptElement = z.infer<typeof PptElementSchema>;
export const PptPageSchema = z.strictObject({
  id: OutcomeIdSchema, title: text(OUTCOME_LIMITS.titleChars), pageType: text(128).default('content'),
  humanModified: z.boolean().default(false), status: z.enum(['pending', 'draft', 'complete']).default('complete'),
  elements: z.array(PptElementSchema).max(500),
});
export type PptPage = z.infer<typeof PptPageSchema>;
export const PptDocumentSchema = z.strictObject({
  type: z.literal('ppt'), ratio: z.enum(['16:9', '4:3']).default('16:9'),
  theme: z.record(z.string(), z.unknown()).default({}), templateId: OutcomeIdSchema.nullable().default(null), generationSkillId: OutcomeIdSchema.nullable().default(null),
  pages: z.array(PptPageSchema).max(500),
});
export const OutcomeMediaTypeSchema = z.enum(['application/pdf','image/png','image/jpeg','image/svg+xml']);
export const OutcomeMediaSchema = z.strictObject({ id: OutcomeIdSchema, mediaType: OutcomeMediaTypeSchema, displayName: text(OUTCOME_LIMITS.titleChars), byteLength: z.number().int().positive().max(20 * 1024 * 1024) });
export type OutcomeMedia = z.infer<typeof OutcomeMediaSchema>;
export const OtherDocumentSchema = z.strictObject({ type: z.literal('other'), text: text(OUTCOME_LIMITS.textChars).default(''), media: OutcomeMediaSchema.nullable().default(null) });
export const OutcomeDocumentSchema = z.union([WordDocumentSchema, PptDocumentSchema, OtherDocumentSchema]);
export type OutcomeDocument = z.infer<typeof OutcomeDocumentSchema>;
export type WordDocument = z.infer<typeof WordDocumentSchema>;
export type PptDocument = z.infer<typeof PptDocumentSchema>;

export const OutcomeSummarySchema = z.strictObject({
  id: OutcomeIdSchema, projectId: OutcomeIdSchema, categoryId: OutcomeIdSchema.nullable(), title: text(OUTCOME_LIMITS.titleChars),
  kind: OutcomeKindSchema, status: OutcomeStatusSchema, currentVersion: version, finalVersion: version.nullable(), createdAt: timestamp, updatedAt: timestamp,
});
export type OutcomeSummary = z.infer<typeof OutcomeSummarySchema>;
export const OutcomeVersionSchema = z.strictObject({
  outcomeId: OutcomeIdSchema, version, content: OutcomeDocumentSchema, note: text(OUTCOME_LIMITS.noteChars), createdBy: OutcomeActorSchema,
  parentVersion: version.nullable(), sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount), createdAt: timestamp,
});
export type OutcomeVersion = z.infer<typeof OutcomeVersionSchema>;
export const OutcomeDetailSchema = z.strictObject({ outcome: OutcomeSummarySchema, version: OutcomeVersionSchema });
export type OutcomeDetail = z.infer<typeof OutcomeDetailSchema>;
export const OutcomeCategorySchema = z.strictObject({ id: OutcomeIdSchema, name: text(OUTCOME_LIMITS.titleChars), sortOrder: z.number().int(), createdAt: timestamp, updatedAt: timestamp });
export type OutcomeCategory = z.infer<typeof OutcomeCategorySchema>;
/** 回收站条目：软删除的成果 + 删除时间与到期彻底删除时间（7 天保留期）。 */
export const OutcomeTrashEntrySchema = z.strictObject({ outcome: OutcomeSummarySchema, deletedAt: timestamp, expiresAt: timestamp });
export type OutcomeTrashEntry = z.infer<typeof OutcomeTrashEntrySchema>;

export const OutcomeListRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, query: text(OUTCOME_LIMITS.titleChars).default('') });
export const OutcomeTrashListRequestSchema = z.strictObject({ projectId: OutcomeIdSchema });
export const OutcomeTrashRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema });
export const OutcomeGetRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, version: version.optional() });
export const OutcomeVersionsRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema });
export const OutcomeMediaImportRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema });
export const OutcomeMediaReadRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, mediaId: OutcomeIdSchema });
export const OutcomeMediaSvgExportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), fileName: text(OUTCOME_LIMITS.titleChars) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'cancelled', 'outcomes_unavailable', 'outcome_not_found', 'svg_not_exportable', 'svg_write_failed']), message: text(OUTCOME_LIMITS.noteChars) }),
]);
export type OutcomeMediaSvgExportResult = z.infer<typeof OutcomeMediaSvgExportResultSchema>;
/** DOCX import deliberately returns an unsaved WordDocument. The renderer must
 * persist it with saveOutcome/createOutcome so imports remain immutable versions. */
export const OutcomeWordDocxImportRequestSchema = z.strictObject({ projectId: OutcomeIdSchema });
export const OutcomeWordDocxImagePreviewSchema = z.strictObject({
  blockId: OutcomeIdSchema,
  mediaType: OutcomeDocxImageMediaTypeSchema,
  displayName: text(OUTCOME_LIMITS.titleChars),
  byteLength: z.number().int().positive().max(20 * 1024 * 1024),
});
export type OutcomeWordDocxImagePreview = z.infer<typeof OutcomeWordDocxImagePreviewSchema>;
export const OutcomeWordDocxImportPreviewSchema = z.strictObject({
  images: z.array(OutcomeWordDocxImagePreviewSchema).max(64),
});
export type OutcomeWordDocxImportPreview = z.infer<typeof OutcomeWordDocxImportPreviewSchema>;
export const OutcomeWordDocxImportCommitRequestSchema = z.strictObject({
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema.optional(),
  importToken: OutcomeIdSchema,
  document: WordDocumentSchema,
});
export const OutcomeWordDocxImportCommitResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), document: WordDocumentSchema, outcomeId: OutcomeIdSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'outcomes_unavailable', 'project_not_found', 'outcome_not_found', 'docx_media_commit_failed']), message: text(OUTCOME_LIMITS.noteChars) }),
]);
export type OutcomeWordDocxImportCommitResult = z.infer<typeof OutcomeWordDocxImportCommitResultSchema>;
export const OutcomeWordDocxExportRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, version: version.optional() });
export const OutcomeWordDocxWarningSchema = z.strictObject({
  code: z.enum([
    'unsupported_drawing',
    'unsupported_field',
    'unsupported_revision',
    'unsupported_hyperlink',
    'unsupported_inline_style',
    'unsupported_table_layout',
    'unsupported_section',
  ]),
  message: text(OUTCOME_LIMITS.noteChars),
});
export type OutcomeWordDocxWarning = z.infer<typeof OutcomeWordDocxWarningSchema>;
export const OutcomeWordDocxImportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), fileName: text(OUTCOME_LIMITS.titleChars), importToken: OutcomeIdSchema, document: WordDocumentSchema, preview: OutcomeWordDocxImportPreviewSchema, warnings: z.array(OutcomeWordDocxWarningSchema).max(64) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'cancelled', 'outcomes_unavailable', 'project_not_found', 'docx_read_failed']), message: text(OUTCOME_LIMITS.noteChars), warnings: z.array(OutcomeWordDocxWarningSchema).max(64) }),
]);
export type OutcomeWordDocxImportResult = z.infer<typeof OutcomeWordDocxImportResultSchema>;
export const OutcomeWordDocxExportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), fileName: text(OUTCOME_LIMITS.titleChars), warnings: z.array(OutcomeWordDocxWarningSchema).max(64) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'cancelled', 'outcomes_unavailable', 'project_not_found', 'outcome_not_found', 'outcome_not_word', 'docx_write_failed']), message: text(OUTCOME_LIMITS.noteChars), warnings: z.array(OutcomeWordDocxWarningSchema).max(64) }),
]);
export type OutcomeWordDocxExportResult = z.infer<typeof OutcomeWordDocxExportResultSchema>;
/** PPTX import follows the same immutable-version rule as DOCX: it never writes the repository. */
export const OutcomePptxImportRequestSchema = z.strictObject({ projectId: OutcomeIdSchema });
export const OutcomePptxImportCommitRequestSchema = z.strictObject({
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema.optional(),
  importToken: OutcomeIdSchema,
  document: PptDocumentSchema,
});
export const OutcomePptxImportCommitResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), document: PptDocumentSchema, outcomeId: OutcomeIdSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'outcomes_unavailable', 'project_not_found', 'outcome_not_found', 'pptx_media_commit_failed']), message: text(OUTCOME_LIMITS.noteChars) }),
]);
export type OutcomePptxImportCommitResult = z.infer<typeof OutcomePptxImportCommitResultSchema>;
export const OutcomePptxExportRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, version: version.optional() });
export const OutcomePptxWarningSchema = z.strictObject({
  code: z.enum(['unsupported_master', 'unsupported_animation', 'unsupported_chart', 'unsupported_image', 'unsupported_media', 'unsupported_shape', 'unsupported_notes', 'unsupported_theme']),
  message: text(OUTCOME_LIMITS.noteChars),
});
export type OutcomePptxWarning = z.infer<typeof OutcomePptxWarningSchema>;
export const OutcomePptxImportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), fileName: text(OUTCOME_LIMITS.titleChars), importToken: OutcomeIdSchema, document: PptDocumentSchema, warnings: z.array(OutcomePptxWarningSchema).max(64) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'cancelled', 'outcomes_unavailable', 'project_not_found', 'pptx_read_failed']), message: text(OUTCOME_LIMITS.noteChars), warnings: z.array(OutcomePptxWarningSchema).max(64) }),
]);
export type OutcomePptxImportResult = z.infer<typeof OutcomePptxImportResultSchema>;
export const OutcomePptxExportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), fileName: text(OUTCOME_LIMITS.titleChars), warnings: z.array(OutcomePptxWarningSchema).max(64) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'cancelled', 'outcomes_unavailable', 'project_not_found', 'outcome_not_found', 'outcome_not_ppt', 'pptx_write_failed']), message: text(OUTCOME_LIMITS.noteChars), warnings: z.array(OutcomePptxWarningSchema).max(64) }),
]);
export type OutcomePptxExportResult = z.infer<typeof OutcomePptxExportResultSchema>;
export const OutcomeCreateRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema.optional(), categoryId: OutcomeIdSchema.nullable().default(null), title: text(OUTCOME_LIMITS.titleChars).min(1), kind: OutcomeKindSchema, content: OutcomeDocumentSchema, note: text(OUTCOME_LIMITS.noteChars).default(''), actor: OutcomeActorSchema.default('human'), importToken: OutcomeIdSchema.optional() });
export const OutcomeSaveRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, baseVersion: version, content: OutcomeDocumentSchema, note: text(OUTCOME_LIMITS.noteChars).default(''), actor: OutcomeActorSchema, sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount).default([]), importToken: OutcomeIdSchema.optional() });
export const OutcomeRestoreRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, version, note: text(OUTCOME_LIMITS.noteChars).default('') });
export const OutcomeMoveRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, categoryId: OutcomeIdSchema.nullable() });
export const OutcomeRenameRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, title: text(OUTCOME_LIMITS.titleChars).min(1) });
export const OutcomeFinalRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, version });
export const OutcomeCategoryCreateSchema = z.strictObject({ name: text(OUTCOME_LIMITS.titleChars).min(1) });
export const OutcomeCategoryRenameSchema = z.strictObject({ categoryId: OutcomeIdSchema, name: text(OUTCOME_LIMITS.titleChars).min(1) });
export const OutcomeCategoryDeleteSchema = z.strictObject({ categoryId: OutcomeIdSchema });
export const ScopedConversationScopeSchema = z.enum(['outcome', 'scenario']);
export const ScopedConversationRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, scope: ScopedConversationScopeSchema, outcomeId: OutcomeIdSchema.nullable().default(null), scenarioId: OutcomeIdSchema.nullable().default(null) });
export const ScopedConversationMessageRequestSchema = ScopedConversationRequestSchema.extend({ role: z.enum(['user', 'assistant', 'system']), content: text(OUTCOME_LIMITS.textChars), sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount).default([]) });
export const ScopedConversationMessageSchema = z.strictObject({ id: OutcomeIdSchema, role: z.enum(['user', 'assistant', 'system']), content: text(OUTCOME_LIMITS.textChars), sources: z.array(OutcomeSourceSchema), createdAt: timestamp });
export type ScopedConversationMessage = z.infer<typeof ScopedConversationMessageSchema>;
/** 会话单元管理（新建/删除/列表）：对话成为可管理的独立单元。 */
export const ScopedConversationCreateSchema = ScopedConversationRequestSchema.extend({ title: text(200).optional() });
/** 场景作用域会话：scenarioId 是个性化定义 ID（如 user:scenarios/xxx，含斜杠），
 *  不能复用 OutcomeIdSchema（其正则禁止 "/"），否则创建/列表全部静默失败。 */
export const ScenarioConversationIdSchema = z.string().min(1).max(OUTCOME_LIMITS.idChars);
export const ScenarioScopedConversationRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, scope: z.literal('scenario'), outcomeId: z.null().default(null), scenarioId: ScenarioConversationIdSchema.nullable().default(null) });
export const ScenarioScopedConversationCreateSchema = ScenarioScopedConversationRequestSchema.extend({ title: text(200).optional() });
export const ScopedConversationRefSchema = z.strictObject({ projectId: OutcomeIdSchema, conversationId: OutcomeIdSchema });
export const ScopedConversationAppendToSchema = ScopedConversationRefSchema.extend({ role: z.enum(['user', 'assistant', 'system']), content: text(OUTCOME_LIMITS.textChars), sources: z.array(OutcomeSourceSchema).default([]) });
export const ScopedConversationUnitSchema = z.strictObject({ id: OutcomeIdSchema, title: text(200), messageCount: z.number().int().min(0), createdAt: timestamp, updatedAt: timestamp });
export type ScopedConversationUnit = z.infer<typeof ScopedConversationUnitSchema>;
export const PptTemplateSchema = z.strictObject({ id: OutcomeIdSchema, name: text(OUTCOME_LIMITS.titleChars), definition: z.record(z.string(), z.unknown()), createdAt: timestamp, updatedAt: timestamp });
export type PptTemplate = z.infer<typeof PptTemplateSchema>;
export const PptTemplateSaveRequestSchema = z.strictObject({ name: text(OUTCOME_LIMITS.titleChars).min(1), definition: z.record(z.string(), z.unknown()) });
/** Design policy is deliberately independent from a visual PPT template. */
export const PptGenerationSkillSchema = z.strictObject({ id: OutcomeIdSchema, name: text(OUTCOME_LIMITS.titleChars), narrative: z.enum(['problem_solution','argument_evidence','timeline','comparison','minimal_report']), contentDensity: z.enum(['sparse','balanced','dense']), audience: text(OUTCOME_LIMITS.titleChars).default(''), instructions: text(OUTCOME_LIMITS.noteChars).default('') });
export type PptGenerationSkill = z.infer<typeof PptGenerationSkillSchema>;
export const PptGenerationSkillSaveRequestSchema = PptGenerationSkillSchema.omit({ id: true });

/** A model may only replace explicitly addressed slides or append bounded new slides. */
export const PptGenerationReplacePageSchema = z.strictObject({
  pageId: OutcomeIdSchema,
  title: text(OUTCOME_LIMITS.titleChars).optional(),
  pageType: text(128).optional(),
  elements: z.array(PptElementSchema).max(500).optional(),
}).refine((page) => page.title !== undefined || page.pageType !== undefined || page.elements !== undefined, {
  message: 'replacePages entries must change title, pageType, or elements',
});
export const PptGenerationAppendPageSchema = PptPageSchema.omit({ humanModified: true, status: true });
export const PptGenerationPatchSchema = z.strictObject({
  replacePages: z.array(PptGenerationReplacePageSchema).max(100).default([]),
  appendPages: z.array(PptGenerationAppendPageSchema).max(100).default([]),
  theme: z.record(z.string(), z.unknown()).optional(),
  note: text(OUTCOME_LIMITS.noteChars).min(1),
}).refine((patch) => patch.replacePages.length > 0 || patch.appendPages.length > 0 || patch.theme !== undefined, {
  message: 'PPT generation patch must contain a presentation change',
});
export type PptGenerationPatch = z.infer<typeof PptGenerationPatchSchema>;
export const PptGenerationModelResponseSchema = z.strictObject({
  answer: text(OUTCOME_LIMITS.textChars).min(1),
  patch: PptGenerationPatchSchema,
});
export const PptGenerationExecuteRequestSchema = z.strictObject({
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema,
  baseVersion: version,
  generationSkillId: OutcomeIdSchema,
  templateId: OutcomeIdSchema.nullable(),
  instruction: text(OUTCOME_LIMITS.noteChars).min(1),
});
export type PptGenerationExecuteRequest = z.infer<typeof PptGenerationExecuteRequestSchema>;
export const PptGenerationDiagnosticSchema = z.strictObject({
  code: z.enum([
    'invalid_request', 'outcome_not_found', 'outcome_not_ppt', 'generation_skill_not_found', 'template_not_found',
    'generation_unavailable', 'application_shutting_down', 'generation_provider_unavailable', 'generation_runtime_reconfigured',
    'agent_error', 'agent_cancelled', 'model_response_empty', 'model_response_contract_error',
    'project_context_unavailable', 'project_context_truncated',
    'patch_target_not_found', 'patch_target_duplicate', 'patch_page_id_conflict', 'outcome_version_conflict',
  ]),
  message: text(OUTCOME_LIMITS.noteChars),
});
export type PptGenerationDiagnostic = z.infer<typeof PptGenerationDiagnosticSchema>;
export const PptGenerationAppliedSchema = z.strictObject({
  outcome: OutcomeSummarySchema,
  version: OutcomeVersionSchema,
  patch: PptGenerationPatchSchema,
  skill: PptGenerationSkillSchema,
  template: PptTemplateSchema.nullable(),
});
export type PptGenerationApplied = z.infer<typeof PptGenerationAppliedSchema>;
export const PptGenerationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'), model: text(512), answer: text(OUTCOME_LIMITS.textChars),
    userMessage: ScopedConversationMessageSchema, assistantMessage: ScopedConversationMessageSchema,
    sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount), diagnostics: z.array(PptGenerationDiagnosticSchema).max(16),
    applied: PptGenerationAppliedSchema,
  }),
  z.strictObject({
    status: z.literal('error'), code: PptGenerationDiagnosticSchema.shape.code, message: text(OUTCOME_LIMITS.noteChars), answer: z.literal(''),
    sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount), diagnostics: z.array(PptGenerationDiagnosticSchema).max(16), userMessage: ScopedConversationMessageSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('cancelled'), code: z.literal('agent_cancelled'), message: text(OUTCOME_LIMITS.noteChars), answer: z.literal(''),
    sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount), diagnostics: z.array(PptGenerationDiagnosticSchema).max(16), userMessage: ScopedConversationMessageSchema.optional(),
  }),
]);
export type PptGenerationResult = z.infer<typeof PptGenerationResultSchema>;
const ImageProviderTextSchema = text(512).trim();
// A regular provider endpoint is HTTPS.  Loopback HTTP is deliberately allowed
// for a locally hosted, user-controlled image provider (and the isolated
// Electron integration smoke); it is not a general HTTP escape hatch.
const ImageEndpointSchema = text(2_048).trim().refine((value) => value === '' || /^https:\/\//u.test(value) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?:\/|$)/u.test(value), { message: 'Image endpoint must use HTTPS or a loopback HTTP endpoint' });
export const OUTCOME_IMAGE_SECRET_NAME = 'OUTCOME_IMAGE_API_KEY' as const;
export const OUTCOME_IMAGE_SECRET_REF = '${secret:OUTCOME_IMAGE_API_KEY}' as const;
export const ImageGenerationSettingsSchema = z.strictObject({ provider: ImageProviderTextSchema, model: ImageProviderTextSchema, endpoint: ImageEndpointSchema, defaultQuality: z.enum(['standard', 'hd', 'low', 'medium', 'high']), hasApiKey: z.boolean() });
export type ImageGenerationSettings = z.infer<typeof ImageGenerationSettingsSchema>;
export const OutcomeImageSettingsGetResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), settings: ImageGenerationSettingsSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['storage_unavailable', 'settings_read_failed']) }),
]);
export type OutcomeImageSettingsGetResult = z.infer<typeof OutcomeImageSettingsGetResultSchema>;
// Credentials are saved by the existing PersonalizationSecretVault IPC surface
// under OUTCOME_IMAGE_API_KEY.  This request can store only its fixed reference,
// never plaintext API-key material.
export const ImageGenerationSettingsUpdateSchema = z.strictObject({ provider: ImageProviderTextSchema, model: ImageProviderTextSchema, endpoint: ImageEndpointSchema, defaultQuality: z.enum(['standard', 'hd', 'low', 'medium', 'high']), apiKeyRef: z.literal(OUTCOME_IMAGE_SECRET_REF).nullable() });
export const OutcomeImageSettingsSaveResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), settings: ImageGenerationSettingsSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'storage_unavailable', 'secret_not_found', 'settings_write_failed']) }),
]);
export type OutcomeImageSettingsSaveResult = z.infer<typeof OutcomeImageSettingsSaveResultSchema>;
export const OutcomeImageGenerateRequestSchema = z.strictObject({ projectId: OutcomeIdSchema, outcomeId: OutcomeIdSchema, prompt: text(8_000).min(1), visualContext: text(8_000).default(''), quality: z.enum(['standard', 'hd', 'low', 'medium', 'high']).optional() });
export const OutcomeImageGenerateResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), media: OutcomeMediaSchema, mimeType: z.enum(['image/png','image/jpeg']) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid_request', 'image_generation_unconfigured', 'image_generation_provider_failed', 'image_generation_provider_http_error', 'image_generation_provider_response_invalid', 'image_generation_media_persist_failed', 'outcome_not_found']) }),
]);
export type OutcomeImageGenerateResult = z.infer<typeof OutcomeImageGenerateResultSchema>;

// ── Outcome AI assistant ────────────────────────────────────────────────
// The renderer supplies only its instruction and a stable selection reference.
// The main process always reloads the current artifact and its project-scoped
// conversation, so stale or renderer-crafted documents/history cannot become
// an AI-editing source of truth.
const nonNegativeInteger = z.number().int().min(0).max(OUTCOME_LIMITS.textChars);
const tableCellCoordinate = z.number().int().min(0).max(199);
export const OutcomeAssistantSelectionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('word_block'),
    blockId: OutcomeIdSchema,
    start: nonNegativeInteger.optional(),
    end: nonNegativeInteger.optional(),
  }),
  z.strictObject({
    type: z.literal('word_table_cell'),
    blockId: OutcomeIdSchema,
    row: tableCellCoordinate,
    column: tableCellCoordinate,
    start: nonNegativeInteger.optional(),
    end: nonNegativeInteger.optional(),
  }),
  z.strictObject({ type: z.literal('ppt_page'), pageId: OutcomeIdSchema }),
  z.strictObject({
    type: z.literal('ppt_element'),
    pageId: OutcomeIdSchema,
    elementId: OutcomeIdSchema,
  }),
]);
export type OutcomeAssistantSelection = z.infer<typeof OutcomeAssistantSelectionSchema>;

export const OutcomeAssistantChatRequestSchema = z.strictObject({
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema,
  instruction: text(OUTCOME_LIMITS.noteChars).min(1),
  selection: OutcomeAssistantSelectionSchema.optional(),
});
export type OutcomeAssistantChatRequest = z.infer<typeof OutcomeAssistantChatRequestSchema>;

const OutcomeAssistantWordReplacementSchema = z.strictObject({
  blockId: OutcomeIdSchema,
  text: text(OUTCOME_LIMITS.textChars),
  style: z.record(z.string(), z.unknown()).optional(),
  // 表格单元格定位：row/column 同时存在时替换目标为表格单元格而非整段文本。
  row: tableCellCoordinate.optional(),
  column: tableCellCoordinate.optional(),
});
export const OutcomeAssistantWordEditSchema = z.strictObject({
  kind: z.literal('word'),
  replacements: z.array(OutcomeAssistantWordReplacementSchema).min(1).max(100),
  note: text(OUTCOME_LIMITS.noteChars).default('AI 协同修改'),
});
export const OutcomeAssistantPptEditSchema = z.strictObject({
  kind: z.literal('ppt'),
  replacePage: z.strictObject({
    pageId: OutcomeIdSchema,
    title: text(OUTCOME_LIMITS.titleChars).optional(),
    elements: z.array(PptElementSchema).max(500).optional(),
  }).refine((page) => page.title !== undefined || page.elements !== undefined, {
    message: 'replacePage must change title or elements',
  }),
  note: text(OUTCOME_LIMITS.noteChars).default('AI 协同修改'),
});
export const OutcomeAssistantEditSchema = z.union([
  OutcomeAssistantWordEditSchema,
  OutcomeAssistantPptEditSchema,
]);
export type OutcomeAssistantEdit = z.infer<typeof OutcomeAssistantEditSchema>;

/** The only JSON shape an AI assistant turn may use to request a direct edit. */
export const OutcomeAssistantModelResponseSchema = z.strictObject({
  answer: text(OUTCOME_LIMITS.textChars),
  edit: OutcomeAssistantEditSchema.nullable().default(null),
});

export const OutcomeAssistantDiagnosticSchema = z.strictObject({
  code: z.enum([
    'invalid_request',
    'outcome_not_found',
    'assistant_unavailable',
    'application_shutting_down',
    'assistant_provider_unavailable',
    'assistant_runtime_reconfigured',
    'invalid_selection',
    'agent_error',
    'agent_cancelled',
    'model_response_empty',
    'model_response_not_structured',
    'model_response_contract_error',
    'edit_document_kind_mismatch',
    'edit_target_not_found',
    'edit_target_unsupported',
    'outcome_version_conflict',
    'project_context_unavailable',
    'project_context_truncated',
  ]),
  message: text(OUTCOME_LIMITS.noteChars),
});
export type OutcomeAssistantDiagnostic = z.infer<typeof OutcomeAssistantDiagnosticSchema>;
export const OutcomeAssistantAppliedEditSchema = z.strictObject({
  outcome: OutcomeSummarySchema,
  version: OutcomeVersionSchema,
  edit: OutcomeAssistantEditSchema,
});
export type OutcomeAssistantAppliedEdit = z.infer<typeof OutcomeAssistantAppliedEditSchema>;
export const OutcomeAssistantChatResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    model: text(512),
    answer: text(OUTCOME_LIMITS.textChars),
    userMessage: ScopedConversationMessageSchema,
    assistantMessage: ScopedConversationMessageSchema,
    sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount),
    diagnostics: z.array(OutcomeAssistantDiagnosticSchema).max(16),
    applied: OutcomeAssistantAppliedEditSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('error'),
    code: OutcomeAssistantDiagnosticSchema.shape.code,
    message: text(OUTCOME_LIMITS.noteChars),
    answer: z.literal(''),
    sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount),
    diagnostics: z.array(OutcomeAssistantDiagnosticSchema).max(16),
    userMessage: ScopedConversationMessageSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    code: z.literal('agent_cancelled'),
    message: text(OUTCOME_LIMITS.noteChars),
    answer: z.literal(''),
    sources: z.array(OutcomeSourceSchema).max(OUTCOME_LIMITS.sourceCount),
    diagnostics: z.array(OutcomeAssistantDiagnosticSchema).max(16),
    userMessage: ScopedConversationMessageSchema.optional(),
  }),
]);
export type OutcomeAssistantChatResult = z.infer<typeof OutcomeAssistantChatResultSchema>;
export function decodeOutcomeDocument(input: unknown): OutcomeDocument | undefined { const parsed = OutcomeDocumentSchema.safeParse(input); return parsed.success ? parsed.data : undefined; }

// ─── OUT-11: source → location resolver ─────────────────────────────
/**
 * A source proof only when a real, project-owned backend can be reached.  Only
 * kinds with a durable, owned content surface (artifact, project_metis,
 * outcome_version) resolve to a target; upload/source/evidence/claim/note_code
 * renderer-only labels return source_not_locatable instead of a fake action.
 */
export const OutcomeSourceLocateRequestSchema = z.strictObject({
  projectId: OutcomeIdSchema,
  outcomeId: OutcomeIdSchema,
  source: OutcomeSourceSchema,
});
export type OutcomeSourceLocateRequest = z.infer<typeof OutcomeSourceLocateRequestSchema>;

export const OutcomeSourceLocateResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    kind: z.enum(['artifact', 'project_metis', 'outcome_version']),
    targetId: OutcomeIdSchema,
    version: version.optional(),
    label: text(OUTCOME_LIMITS.titleChars),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['source_not_locatable', 'source_not_found', 'invalid_request']),
  }),
]);
export type OutcomeSourceLocateResult = z.infer<typeof OutcomeSourceLocateResultSchema>;
