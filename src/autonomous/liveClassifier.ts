/**
 * liveClassifier — AI LIVE 场景归类（重构 R2）。
 *
 * 把引擎真实事件流（step/reflection/progress/引擎完成）映射为
 * 「AI 此刻正在操作什么研究对象」的场景视图：
 *   writing / question / framework / literature / analysis / figure / table / idle
 * 全部确定性规则，输入来自真实运行事件，零静态示例。
 */

export type LiveSceneKind = 'writing' | 'question' | 'framework' | 'literature' | 'analysis' | 'figure' | 'table' | 'idle';

export interface LiveScene {
  kind: LiveSceneKind;
  /** 正在操作的对象名（来自真实 step/reflection 数据）。 */
  target: string;
  /** 最新输出片段（真实 output / reasoning）。 */
  detail: string;
  /** 检索漏斗（literature 场景，从 output 数字解析；无则 null）。 */
  funnel: { scanned: number; relevant: number; fullText: number; included: number } | null;
  /** 前后对比（question/framework 场景来自 reflection 的修正说明）。 */
  before: string;
  after: string;
  reason: string;
  at: number;
}

interface StepLike {
  type: string;
  phase: string;
  stepName: string;
  output?: string;
  at: number;
}

interface ReflectionLike {
  type: string;
  phase: string;
  decision: string;
  reasoning: string;
  revisionNote?: string;
  qualityScore?: number;
  at: number;
}

const PHASE_TO_KIND: Record<string, LiveSceneKind> = {
  question_formulation: 'question',
  literature_review: 'literature',
  source_discovery: 'literature',
  screening: 'literature',
  conceptual_analysis: 'framework',
  source_criticism: 'literature',
  research_design: 'framework',
  data_collection: 'table',
  coding: 'table',
  data_preparation: 'table',
  statistics: 'analysis',
  analysis: 'analysis',
  triangulation: 'analysis',
  argumentation: 'framework',
  synthesis: 'writing',
  quality_audit: 'writing',
  writing: 'writing',
  idea: 'question',
  experiment: 'analysis',
  paper: 'writing',
};

/** 从 output 文本解析检索漏斗数字（如 已扫描/相关/全文/纳入）。 */
export function parseFunnel(text: string): LiveScene['funnel'] {
  const pick = (pattern: RegExp): number | null => {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const scanned = pick(/(?:扫描|检索|已扫)[^\d]{0,6}(\d+)/u) ?? pick(/scanned[^\d]{0,6}(\d+)/iu);
  const relevant = pick(/(?:相关|初筛)[^\d]{0,6}(\d+)/u) ?? pick(/relevant[^\d]{0,6}(\d+)/iu);
  const fullText = pick(/(?:全文|精读)[^\d]{0,6}(\d+)/u) ?? pick(/full[- ]?text[^\d]{0,6}(\d+)/iu);
  const included = pick(/(?:纳入|入选)[^\d]{0,6}(\d+)/u) ?? pick(/included[^\d]{0,6}(\d+)/iu);
  if (scanned === null && relevant === null && fullText === null && included === null) return null;
  return { scanned: scanned ?? 0, relevant: relevant ?? 0, fullText: fullText ?? 0, included: included ?? 0 };
}

/** step 事件 → 场景。 */
export function classifyStep(step: StepLike): LiveScene {
  const kind = PHASE_TO_KIND[step.phase] ?? 'writing';
  const output = (step.output ?? '').slice(0, 1200);
  return {
    kind,
    target: step.stepName,
    detail: output,
    funnel: kind === 'literature' ? parseFunnel(output) : null,
    before: '',
    after: '',
    reason: '',
    at: step.at,
  };
}

/** reflection 事件 → 场景（含前后修正语义）。 */
export function classifyReflection(reflection: ReflectionLike): LiveScene {
  const kind = PHASE_TO_KIND[reflection.phase] ?? 'framework';
  const isQuestionPhase = reflection.phase === 'question_formulation' || reflection.phase === 'idea';
  return {
    kind: isQuestionPhase ? 'question' : kind,
    target: reflection.phase === 'writing' || reflection.phase === 'paper' ? '论文正文' : isQuestionPhase ? '研究问题' : '理论框架',
    detail: (reflection.reasoning ?? '').slice(0, 1200),
    funnel: null,
    before: '',
    after: reflection.decision === 'rollback' ? '回退到上一版本' : reflection.decision === 'redo' ? '重做本阶段' : '',
    reason: (reflection.revisionNote ?? '').slice(0, 400),
    at: reflection.at,
  };
}

/** 对文本成果做简单的前后差异（行级），供编辑直播展示。 */
export function diffText(before: string, after: string): { added: string[]; removed: string[] } {
  const beforeLines = new Set(before.split('\n').map((line) => line.trim()).filter(Boolean));
  const afterLines = new Set(after.split('\n').map((line) => line.trim()).filter(Boolean));
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of afterLines) {
    if (!beforeLines.has(line)) added.push(line);
    if (added.length >= 5) break;
  }
  for (const line of beforeLines) {
    if (!afterLines.has(line)) removed.push(line);
    if (removed.length >= 5) break;
  }
  return { added, removed };
}
