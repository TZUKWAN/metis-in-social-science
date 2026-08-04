import { z } from 'zod';

export const ThemeModeSchema = z.enum(['light', 'dark', 'system']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

const SafeProviderLabelSchema = z.string()
  .trim()
  .min(1)
  .max(2_048)
// eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'Provider label contains unsafe control characters',
  });

export const SettingsViewSchema = z.strictObject({
  configured: z.boolean(),
  baseUrl: SafeProviderLabelSchema.optional(),
  model: SafeProviderLabelSchema.optional(),
  hasApiKey: z.boolean(),
  needsReauth: z.boolean(),
  theme: ThemeModeSchema,
  weeklyReadingGoal: z.number().int().min(1).max(100).default(5),
  providerVision: z.boolean().default(false),
  providerMaxContextTokens: z.number().int().min(0).default(0),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const SettingsUpdateRequestSchema = z.strictObject({
  theme: ThemeModeSchema,
  weeklyReadingGoal: z.number().int().min(1).max(100).optional(),
  /** METIS-WX-2: whether the configured model accepts inline images. */
  providerVision: z.boolean().optional(),
  /** User-declared max context tokens (0 = auto-detect from model name). */
  providerMaxContextTokens: z.number().int().min(0).max(2_000_000).optional(),
});
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

export const SettingsMutationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), code: z.literal('settings_saved') }),
  z.strictObject({
    success: z.literal(false),
    code: z.enum(['settings_update_unavailable', 'secure_setup_required']),
  }),
]);
export type SettingsMutationResult = z.infer<typeof SettingsMutationResultSchema>;

export function createSettingsViewRecovery(): SettingsView {
  return {
    configured: false,
    hasApiKey: false,
    needsReauth: false,
    theme: 'light',
    weeklyReadingGoal: 5,
    providerVision: false,
    providerMaxContextTokens: 0,
  };
}

export function decodeSettingsView(input: unknown): SettingsView {
  const parsed = SettingsViewSchema.safeParse(input);
  return parsed.success ? parsed.data : createSettingsViewRecovery();
}

export function decodeSettingsUpdateRequest(input: unknown): SettingsUpdateRequest | undefined {
  const parsed = SettingsUpdateRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function createSettingsMutationFailure(
  code: 'settings_update_unavailable' | 'secure_setup_required' = 'settings_update_unavailable',
): SettingsMutationResult {
  return { success: false, code };
}

export function decodeSettingsMutationResult(input: unknown): SettingsMutationResult {
  const parsed = SettingsMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createSettingsMutationFailure();
}
