import { z } from 'zod';
import {
  OutputPlanSchema,
  type ResolvedRunManifest,
} from './PersonalizationRuntimeContract.js';

/** The authoritative output plan already validated on the resolved run manifest. */
export type ScenarioOutputPlan = NonNullable<ResolvedRunManifest['output']['plan']>;

export const SCENARIO_OUTPUT_BUNDLE_LIMITS = Object.freeze({
  rawTextChars: 1_250_000,
  primaryNameChars: 512,
  supportingNameChars: 512,
  criterionChars: 1_000,
  itemContentChars: 500_000,
  evidenceChars: 100_000,
  totalBodyChars: 1_000_000,
  supportingItems: 64,
  qualityItems: 64,
} as const);

// eslint-disable-next-line no-control-regex -- names and criteria are single-line contract fields
const UNSAFE_SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- body text permits tab/newline/CR but rejects other C0 and all C1 controls
const UNSAFE_MULTILINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const OUTPUT_TEMPLATE_PLACEHOLDER = /<(?:complete (?:primary deliverable|supporting artifact)|specific evidence from the generated deliverables)>/iu;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u;

function meaningfulSingleLine(maxLength: number) {
  return z.string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0, { message: 'Text cannot be blank' })
    .refine((value) => !UNSAFE_SINGLE_LINE_CONTROLS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function meaningfulBody(maxLength: number) {
  return z.string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0, { message: 'Body cannot be blank' })
    .refine((value) => !UNSAFE_MULTILINE_CONTROLS.test(value), {
      message: 'Body contains unsafe control characters',
    })
    .refine((value) => !OUTPUT_TEMPLATE_PLACEHOLDER.test(value), {
      message: 'Body still contains an output-template placeholder',
    });
}

export const ScenarioOutputQualityStatusSchema = z.enum([
  'met',
  'partially_met',
  'unmet',
]);

export const ScenarioOutputPrimarySchema = z.strictObject({
  name: meaningfulSingleLine(SCENARIO_OUTPUT_BUNDLE_LIMITS.primaryNameChars),
  content: meaningfulBody(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars),
});

export const ScenarioOutputSupportingItemSchema = z.strictObject({
  name: meaningfulSingleLine(SCENARIO_OUTPUT_BUNDLE_LIMITS.supportingNameChars),
  content: meaningfulBody(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars),
});

export const ScenarioOutputQualityItemSchema = z.strictObject({
  criterion: meaningfulSingleLine(SCENARIO_OUTPUT_BUNDLE_LIMITS.criterionChars),
  status: ScenarioOutputQualityStatusSchema,
  evidence: meaningfulBody(SCENARIO_OUTPUT_BUNDLE_LIMITS.evidenceChars),
});

export const ScenarioOutputBundleSchema = z.strictObject({
  primary: ScenarioOutputPrimarySchema,
  supporting: z.array(ScenarioOutputSupportingItemSchema)
    .max(SCENARIO_OUTPUT_BUNDLE_LIMITS.supportingItems)
    .refine(
      (items) => new Set(items.map((item) => item.name)).size === items.length,
      { message: 'Supporting artifact names must be unique' },
    ),
  quality: z.array(ScenarioOutputQualityItemSchema)
    .max(SCENARIO_OUTPUT_BUNDLE_LIMITS.qualityItems)
    .refine(
      (items) => new Set(items.map((item) => item.criterion)).size === items.length,
      { message: 'Quality criteria must be unique' },
    ),
});

export type ScenarioOutputBundle = z.infer<typeof ScenarioOutputBundleSchema>;

export type ScenarioOutputBundleDecodeResult =
  | { ok: true; bundle: ScenarioOutputBundle }
  | { ok: false; code: 'invalid_json' | 'invalid_shape' | 'plan_mismatch' };

type JsonInspection = 'valid' | 'invalid' | 'duplicate_key';

/**
 * Lexically validates JSON and detects duplicate object keys before JSON.parse
 * can silently overwrite them. It intentionally produces no decoded value.
 */
function inspectJson(text: string): JsonInspection {
  let index = 0;
  let duplicateKey = false;

  const skipWhitespace = () => {
    // eslint-disable-next-line no-control-regex -- JSON permits exactly tab, LF, CR, and space as whitespace
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index]!)) index += 1;
  };

  const parseString = (): string | undefined => {
    if (text[index] !== '"') return undefined;
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '"') {
        index += 1;
        try {
          const parsed = JSON.parse(text.slice(start, index)) as unknown;
          return typeof parsed === 'string' ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length) return undefined;
        const escaped = text[index]!;
        if (escaped === 'u') {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) return undefined;
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped)) return undefined;
        index += 1;
        continue;
      }
      if (character.codePointAt(0)! <= 0x1f) return undefined;
      index += 1;
    }
    return undefined;
  };

  const parseLiteral = (literal: string): boolean => {
    if (!text.startsWith(literal, index)) return false;
    index += literal.length;
    return true;
  };

  const parseNumber = (): boolean => {
    const match = JSON_NUMBER.exec(text.slice(index));
    if (!match) return false;
    index += match[0].length;
    return true;
  };

  const parseArray = (): boolean => {
    if (text[index] !== '[') return false;
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return true;
    }
    while (index < text.length) {
      if (!parseValue()) return false;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return true;
      }
      if (text[index] !== ',') return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  };

  const parseObject = (): boolean => {
    if (text[index] !== '{') return false;
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return true;
    }
    const keys = new Set<string>();
    while (index < text.length) {
      const key = parseString();
      if (key === undefined) return false;
      if (keys.has(key)) duplicateKey = true;
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') return false;
      index += 1;
      skipWhitespace();
      if (!parseValue()) return false;
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return true;
      }
      if (text[index] !== ',') return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  };

  const parseValue = (): boolean => {
    skipWhitespace();
    const character = text[index];
    if (character === '{') return parseObject();
    if (character === '[') return parseArray();
    if (character === '"') return parseString() !== undefined;
    if (character === 't') return parseLiteral('true');
    if (character === 'f') return parseLiteral('false');
    if (character === 'n') return parseLiteral('null');
    return character === '-' || (character !== undefined && /\d/u.test(character))
      ? parseNumber()
      : false;
  };

  try {
    skipWhitespace();
    const valid = parseValue();
    skipWhitespace();
    if (!valid || index !== text.length) return 'invalid';
    return duplicateKey ? 'duplicate_key' : 'valid';
  } catch {
    return 'invalid';
  }
}

function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  return match?.[1];
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function meaningfulPlan(plan: ScenarioOutputPlan): boolean {
  return plan.primaryDeliverable.trim().length > 0
    && plan.supportingArtifacts.every((item) => item.trim().length > 0)
    && plan.qualityCriteria.every((item) => item.trim().length > 0);
}

function aggregateBodyChars(bundle: ScenarioOutputBundle): number {
  return bundle.primary.content.length
    + bundle.supporting.reduce((total, item) => total + item.content.length, 0)
    + bundle.quality.reduce((total, item) => total + item.evidence.length, 0);
}

/**
 * Decodes a final Agent response without throwing. Only raw JSON or a single
 * lowercase `json` fenced block is accepted; all prose wrappers are rejected.
 */
export function decodeScenarioOutputBundle(
  text: string,
  plan: ScenarioOutputPlan,
): ScenarioOutputBundleDecodeResult {
  if (typeof text !== 'string') return { ok: false, code: 'invalid_json' };

  let parsedPlan: ScenarioOutputPlan;
  try {
    const planResult = OutputPlanSchema.safeParse(plan);
    if (!planResult.success || !meaningfulPlan(planResult.data)) {
      return { ok: false, code: 'invalid_shape' };
    }
    parsedPlan = planResult.data;
  } catch {
    return { ok: false, code: 'invalid_shape' };
  }

  if (text.length > SCENARIO_OUTPUT_BUNDLE_LIMITS.rawTextChars) {
    return { ok: false, code: 'invalid_shape' };
  }
  const jsonText = extractJson(text);
  if (jsonText === undefined || jsonText.trim().length === 0) {
    return { ok: false, code: 'invalid_json' };
  }
  if (inspectJson(jsonText) !== 'valid') {
    return { ok: false, code: 'invalid_json' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch {
    return { ok: false, code: 'invalid_json' };
  }

  let bundle: ScenarioOutputBundle;
  try {
    const bundleResult = ScenarioOutputBundleSchema.safeParse(raw);
    if (!bundleResult.success) return { ok: false, code: 'invalid_shape' };
    bundle = bundleResult.data;
  } catch {
    return { ok: false, code: 'invalid_shape' };
  }

  if (bundle.primary.name !== parsedPlan.primaryDeliverable
    || !arraysEqual(bundle.supporting.map((item) => item.name), parsedPlan.supportingArtifacts)
    || !arraysEqual(bundle.quality.map((item) => item.criterion), parsedPlan.qualityCriteria)) {
    return { ok: false, code: 'plan_mismatch' };
  }

  if (aggregateBodyChars(bundle) > SCENARIO_OUTPUT_BUNDLE_LIMITS.totalBodyChars) {
    return { ok: false, code: 'invalid_shape' };
  }
  return { ok: true, bundle };
}
