import { z } from 'zod';

/**
 * 内容规范（Content Charter，2026-09-01 刘总定名与架构）：
 * 与场景正交的表达规范层——场景管"做什么"（步骤/流程/工具），
 * 内容规范管"产出长什么样、什么质量"（写作/PPT/绘图风格与质量阈值），
 * 适用于所有场景：执行时步骤按场景走，内容表达按本章程走。
 *
 * 作用域与继承：全局默认章程 → 项目章程（覆盖未指定字段）→ 内置缺省。
 */

export const CHARTER_TARGETS = [
  'journal', 'thesis', 'conference', 'grant', 'report', 'presentation', 'figure',
] as const;
export type CharterTarget = typeof CHARTER_TARGETS[number];

/** scientific-schematics 的分级阈值表（期刊最高、演示最低）作为内置缺省。 */
export const DEFAULT_QUALITY_THRESHOLDS: ReadonlyArray<{ target: CharterTarget; score: number }> = [
  { target: 'journal', score: 8.5 },
  { target: 'thesis', score: 8.0 },
  { target: 'conference', score: 8.0 },
  { target: 'grant', score: 8.0 },
  { target: 'report', score: 7.5 },
  { target: 'presentation', score: 6.5 },
  { target: 'figure', score: 7.5 },
];

const line = (max: number) => z.string().min(0).max(max);

export const CharterWritingSchema = z.strictObject({
  tone: line(400).default(''),
  person: line(200).default(''),
  sentenceStyle: line(600).default(''),
  bannedPhrases: z.array(z.strictObject({
    phrase: line(120),
    replacement: line(200).default(''),
  })).max(64).default([]),
  terminology: z.array(z.strictObject({
    term: line(120),
    standardForm: line(200),
  })).max(256).default([]),
  citationStyle: line(120).default(''),
  structurePreference: line(1_000).default(''),
  extra: line(2_000).default(''),
});
export type CharterWriting = z.infer<typeof CharterWritingSchema>;

export const CharterPresentationSchema = z.strictObject({
  themeProfileId: z.string().max(64).default('academic-blue'),
  density: z.enum(['sparse', 'balanced', 'dense']).default('balanced'),
  bodyFontMinPt: z.number().min(10).max(20).nullable().default(null),
  narrativePreference: line(200).default(''),
  extra: line(1_000).default(''),
});
export type CharterPresentation = z.infer<typeof CharterPresentationSchema>;

export const CharterFigureSchema = z.strictObject({
  colorPrimary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().default(null),
  colorAccent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().default(null),
  colorEmphasis: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().default(null),
  style: z.enum(['clean', 'dense', 'schematic']).default('clean'),
  labelMinFont: z.number().min(8).max(24).default(12),
  outputFormat: z.enum(['png', 'svg']).default('png'),
  dpi: z.number().int().min(72).max(600).default(300),
  aiDisclosure: z.boolean().default(true),
  extra: line(1_000).default(''),
});
export type CharterFigure = z.infer<typeof CharterFigureSchema>;

export const CharterQualitySchema = z.strictObject({
  thresholds: z.array(z.strictObject({
    target: z.enum(CHARTER_TARGETS),
    score: z.number().min(0).max(10),
  })).max(16).default(DEFAULT_QUALITY_THRESHOLDS.map((entry) => ({ ...entry }))),
  maxIterations: z.number().int().min(1).max(5).default(3),
});
export type CharterQuality = z.infer<typeof CharterQualitySchema>;

export const ContentCharterSchema = z.strictObject({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  scope: z.enum(['global', 'project']),
  projectId: z.string().max(80).nullable().default(null),
  writing: CharterWritingSchema.default({
    tone: '', person: '', sentenceStyle: '', bannedPhrases: [], terminology: [],
    citationStyle: '', structurePreference: '', extra: '',
  }),
  presentation: CharterPresentationSchema.default({
    themeProfileId: 'academic-blue', density: 'balanced', bodyFontMinPt: null,
    narrativePreference: '', extra: '',
  }),
  figure: CharterFigureSchema.default({
    colorPrimary: null, colorAccent: null, colorEmphasis: null,
    style: 'clean', labelMinFont: 12, outputFormat: 'png', dpi: 300,
    aiDisclosure: true, extra: '',
  }),
  quality: CharterQualitySchema.default({
    thresholds: DEFAULT_QUALITY_THRESHOLDS.map((entry) => ({ ...entry })),
    maxIterations: 3,
  }),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ContentCharter = z.infer<typeof ContentCharterSchema>;

/** 内置默认章程（首次启动播种并激活的全局章程）。 */
export function buildDefaultContentCharter(now: number): ContentCharter {
  return ContentCharterSchema.parse({
    id: 'charter-default',
    name: '默认内容规范',
    scope: 'global',
    projectId: null,
    createdAt: now,
    updatedAt: now,
  });
}

// ─── Prompt 段组装（注入各产出型动作） ─────────────────────────

function nonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 写作规范段：注入场景步骤执行与协同对话的 prompt。 */
export function writingCharterPrompt(writing: CharterWriting): string | null {
  const blocks: string[] = [];
  const tone = nonEmpty(writing.tone);
  if (tone) blocks.push(`- 语气与立场：${tone}`);
  const person = nonEmpty(writing.person);
  if (person) blocks.push(`- 人称与自称：${person}`);
  const sentence = nonEmpty(writing.sentenceStyle);
  if (sentence) blocks.push(`- 句式与用词：${sentence}`);
  if (writing.bannedPhrases.length > 0) {
    blocks.push(`- 禁用表述（必须遵守，出现即改写）：${writing.bannedPhrases.map((entry) => `「${entry.phrase}」→${entry.replacement ? `「${entry.replacement}」` : '直接删除'}`).join('；')}`);
  }
  if (writing.terminology.length > 0) {
    blocks.push(`- 术语统一（必须按标准写法）：${writing.terminology.map((entry) => `「${entry.term}」写作「${entry.standardForm}」`).join('；')}`);
  }
  const citation = nonEmpty(writing.citationStyle);
  if (citation) blocks.push(`- 引用格式：${citation}`);
  const structure = nonEmpty(writing.structurePreference);
  if (structure) blocks.push(`- 结构偏好：${structure}`);
  const extra = nonEmpty(writing.extra);
  if (extra) blocks.push(`- 其他要求：${extra}`);
  if (blocks.length === 0) return null;
  return ['【内容规范·写作（必须遵守）】', ...blocks].join('\n');
}

/** 演示规范段：注入 PPT 生成（zone 协议）prompt。 */
export function presentationCharterPrompt(presentation: CharterPresentation): string | null {
  const blocks: string[] = [];
  blocks.push(`- 主题风格引用：${presentation.themeProfileId}`);
  blocks.push(`- 信息密度：${presentation.density === 'sparse' ? '精简' : presentation.density === 'dense' ? '详实' : '均衡'}`);
  if (presentation.bodyFontMinPt !== null) blocks.push(`- 正文字号下限：${presentation.bodyFontMinPt}pt`);
  const narrative = nonEmpty(presentation.narrativePreference);
  if (narrative) blocks.push(`- 叙事偏好：${narrative}`);
  const extra = nonEmpty(presentation.extra);
  if (extra) blocks.push(`- 其他要求：${extra}`);
  return ['【内容规范·演示（必须遵守）】', ...blocks].join('\n');
}

/** 绘图规范段：注入图片生成 prompt（含 AI 披露诚信要求）。 */
export function figureCharterPrompt(figure: CharterFigure): string | null {
  const blocks: string[] = [];
  const palette = [
    figure.colorPrimary && `主色 ${figure.colorPrimary}`,
    figure.colorAccent && `点缀 ${figure.colorAccent}`,
    figure.colorEmphasis && `强调 ${figure.colorEmphasis}`,
  ].filter(Boolean);
  if (palette.length > 0) blocks.push(`- 配色纪律：${palette.join(' / ')}；其余使用黑白灰中性色`);
  blocks.push(`- 风格：${figure.style === 'clean' ? '简洁矢量风' : figure.style === 'dense' ? '高密度逻辑图风' : '示意图风'}；标注字号不低于 ${figure.labelMinFont}pt`);
  blocks.push(`- 输出规格：${figure.outputFormat.toUpperCase()}，${figure.dpi} DPI`);
  if (figure.aiDisclosure) blocks.push('- 本图为 AI 示意草稿：不得声称其为数据图或实验结果，不得虚构实验数值、机构标志');
  const extra = nonEmpty(figure.extra);
  if (extra) blocks.push(`- 其他要求：${extra}`);
  return ['【内容规范·科研绘图（必须遵守）】', ...blocks].join('\n');
}

/** 质量阈值查询：按产出目标取阈值（章程未配置的目标用内置缺省）。 */
export function qualityThresholdFor(quality: CharterQuality, target: CharterTarget): number {
  const configured = quality.thresholds.find((entry) => entry.target === target);
  if (configured) return configured.score;
  return DEFAULT_QUALITY_THRESHOLDS.find((entry) => entry.target === target)?.score ?? 7.5;
}
