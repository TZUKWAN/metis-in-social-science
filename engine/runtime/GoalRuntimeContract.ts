import { z } from 'zod';
import {
  CHAT_RUNTIME_LIMITS,
  RuntimeIdSchema,
} from './ChatRuntimeContract.js';

export const GOAL_RUNTIME_LIMITS = Object.freeze({
  goals: CHAT_RUNTIME_LIMITS.historyItems,
  steps: CHAT_RUNTIME_LIMITS.goalSteps,
  labelChars: CHAT_RUNTIME_LIMITS.shortTextChars,
} as const);

// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const PresentationLabelSchema = z.string()
  .min(1)
  .max(GOAL_RUNTIME_LIMITS.labelChars)
  .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
    message: 'Presentation label contains unsafe control characters',
  });

const GoalDescriptionSchema = z.string()
  .min(1)
  .max(10_000)
  .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
    message: 'Goal description contains unsafe control characters',
  });

export const GoalCreateRequestSchema = z.strictObject({
  description: GoalDescriptionSchema,
  context: z.string().max(20_000).refine(
    (value) => !UNSAFE_CONTROL_CHARACTERS.test(value),
    { message: 'Goal context contains unsafe control characters' },
  ).optional(),
});

export const GoalIdRequestSchema = z.strictObject({
  goalId: RuntimeIdSchema,
});

export const GoalRefineRequestSchema = z.strictObject({
  goalId: RuntimeIdSchema,
  feedback: GoalDescriptionSchema,
});

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const KNOWN_GOAL_STATUSES = [
  'draft',
  'planning',
  'ready',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
const GOAL_STATUSES = [...KNOWN_GOAL_STATUSES, 'unknown'] as const;

export const GoalStatusSchema = z.enum(GOAL_STATUSES);

const GoalStatusInputSchema = z.unknown().transform((value) => (
  typeof value === 'string' && (KNOWN_GOAL_STATUSES as readonly string[]).includes(value)
    ? value as (typeof KNOWN_GOAL_STATUSES)[number]
    : 'unknown'
));

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

const GoalCreateSuccessSchema = z.strictObject({
  success: z.literal(true),
  goalId: RuntimeIdSchema,
  status: GoalStatusInputSchema,
});

const GoalCreateFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('goal_create_unavailable'),
});

export const GoalCreateResponseSchema = z.discriminatedUnion('success', [
  GoalCreateSuccessSchema,
  GoalCreateFailureSchema,
]);

export type GoalCreateResponse = z.infer<typeof GoalCreateResponseSchema>;

export function createGoalCreateRecovery(): GoalCreateResponse {
  return { success: false, code: 'goal_create_unavailable' };
}

export function decodeGoalCreateResponse(input: unknown): GoalCreateResponse {
  return parseWithoutThrow(GoalCreateResponseSchema, input) ?? createGoalCreateRecovery();
}

export const GoalSummarySchema = z.strictObject({
  goalId: RuntimeIdSchema,
  label: PresentationLabelSchema,
  status: GoalStatusInputSchema,
  createdAt: TimestampSchema,
});

export type GoalSummary = z.infer<typeof GoalSummarySchema>;

const GoalSummarySuccessSchema = z.strictObject({
  success: z.literal(true),
  goal: GoalSummarySchema,
});

const GoalSummaryFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('goal_summary_unavailable'),
});

export const GoalSummaryResponseSchema = z.discriminatedUnion('success', [
  GoalSummarySuccessSchema,
  GoalSummaryFailureSchema,
]);

export type GoalSummaryResponse = z.infer<typeof GoalSummaryResponseSchema>;

export function createGoalSummaryRecovery(): GoalSummaryResponse {
  return { success: false, code: 'goal_summary_unavailable' };
}

export function decodeGoalSummaryResponse(input: unknown): GoalSummaryResponse {
  return parseWithoutThrow(GoalSummaryResponseSchema, input) ?? createGoalSummaryRecovery();
}

const GoalListSuccessSchema = z.strictObject({
  success: z.literal(true),
  goals: z.array(GoalSummarySchema).max(GOAL_RUNTIME_LIMITS.goals),
});

const GoalListFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('goal_list_unavailable'),
  goals: z.tuple([]),
});

export const GoalListResponseSchema = z.discriminatedUnion('success', [
  GoalListSuccessSchema,
  GoalListFailureSchema,
]);

export type GoalListResponse = z.infer<typeof GoalListResponseSchema>;

export function createGoalListRecovery(): GoalListResponse {
  return { success: false, code: 'goal_list_unavailable', goals: [] };
}

export function decodeGoalListResponse(input: unknown): GoalListResponse {
  return parseWithoutThrow(GoalListResponseSchema, input) ?? createGoalListRecovery();
}

export const GOAL_PLAN_LABEL = 'Research plan' as const;
export const GOAL_PLAN_STEP_LABEL = 'Research step' as const;

export const GoalPlanStepSchema = z.strictObject({
  stepId: RuntimeIdSchema,
  label: z.literal(GOAL_PLAN_STEP_LABEL),
  ordinal: z.number().int().min(1).max(GOAL_RUNTIME_LIMITS.steps),
});

const GoalPlanSuccessSchema = z.strictObject({
  success: z.literal(true),
  goalId: RuntimeIdSchema,
  label: z.literal(GOAL_PLAN_LABEL),
  steps: z.array(GoalPlanStepSchema).max(GOAL_RUNTIME_LIMITS.steps),
}).superRefine((value, context) => {
  const stepIds = new Set<string>();
  for (let index = 0; index < value.steps.length; index += 1) {
    const step = value.steps[index];
    if (!step) continue;
    if (step.ordinal !== index + 1) {
      context.addIssue({
        code: 'custom',
        message: 'Goal plan step ordinals must be contiguous and ordered',
        path: ['steps', index, 'ordinal'],
      });
    }
    if (stepIds.has(step.stepId)) {
      context.addIssue({
        code: 'custom',
        message: 'Goal plan step IDs must be unique',
        path: ['steps', index, 'stepId'],
      });
    }
    stepIds.add(step.stepId);
  }
});

const GoalPlanFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('goal_plan_unavailable'),
  label: z.literal(GOAL_PLAN_LABEL),
  steps: z.tuple([]),
});

export const GoalPlanResponseSchema = z.discriminatedUnion('success', [
  GoalPlanSuccessSchema,
  GoalPlanFailureSchema,
]);

export type GoalPlanResponse = z.infer<typeof GoalPlanResponseSchema>;

export function createGoalPlanRecovery(): GoalPlanResponse {
  return {
    success: false,
    code: 'goal_plan_unavailable',
    label: GOAL_PLAN_LABEL,
    steps: [],
  };
}

export function decodeGoalPlanResponse(input: unknown): GoalPlanResponse {
  return parseWithoutThrow(GoalPlanResponseSchema, input) ?? createGoalPlanRecovery();
}

export const GoalExecutionCodeSchema = z.enum([
  'completed',
  'paused',
  'cancelled',
  'failed',
  'goal_not_found',
  'goal_not_ready',
  'goal_execution_unavailable',
]);

export const GoalExecutionResultSchema = z.strictObject({
  success: z.boolean(),
  code: GoalExecutionCodeSchema.optional(),
}).superRefine((value, context) => {
  if (value.success && value.code !== undefined && value.code !== 'completed') {
    context.addIssue({
      code: 'custom',
      message: 'Successful execution may only use the completed code',
      path: ['code'],
    });
  }
  if (!value.success && value.code === 'completed') {
    context.addIssue({
      code: 'custom',
      message: 'Failed execution cannot use the completed code',
      path: ['code'],
    });
  }
});

export type GoalExecutionResult = z.infer<typeof GoalExecutionResultSchema>;

export function createGoalExecutionRecovery(): GoalExecutionResult {
  return { success: false, code: 'goal_execution_unavailable' };
}

export function decodeGoalExecutionResult(input: unknown): GoalExecutionResult {
  return parseWithoutThrow(GoalExecutionResultSchema, input) ?? createGoalExecutionRecovery();
}
