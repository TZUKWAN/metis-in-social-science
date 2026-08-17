/**
 * ScenarioExecutionContext — 把场景的成果结构/自适应边界/写作规范/方法策略
 * 格式化为运行时可执行的研究约束文本（场景重构 P3）。
 *
 * 协同对话与自主科研共用：这保证场景配置真正驱动执行，而不是只存在于 UI。
 */
import type { ScenarioDefinition } from '../runtime/PersonalizationRuntimeContract.js';

type Section = NonNullable<ScenarioDefinition['deliverable']>['sections'] extends (infer T)[] | undefined ? T : never;

const STATUS_LABEL: Record<string, string> = {
  locked: '锁定',
  required: '必选',
  optional: '可选',
  conditional: '条件',
};

function sectionLine(section: Section, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const marker = section.status === 'locked' ? '🔒' : section.status === 'conditional' ? '◇' : '●';
  const lines = [`${indent}${marker} ${section.title}（${STATUS_LABEL[section.status] ?? section.status}）`];
  if (section.status === 'conditional' && section.condition) lines.push(`${indent}  条件：${section.condition}`);
  if (section.purpose) lines.push(`${indent}  作用：${section.purpose}`);
  if (section.requirements && section.requirements.length > 0) {
    lines.push(`${indent}  必须包含：${section.requirements.join('；')}`);
  }
  if (section.optionalContent && section.optionalContent.length > 0) {
    lines.push(`${indent}  可选内容：${section.optionalContent.join('；')}`);
  }
  if (section.forbidden && section.forbidden.length > 0) {
    lines.push(`${indent}  禁止：${section.forbidden.join('；')}`);
  }
  if (section.lengthTarget) lines.push(`${indent}  建议篇幅：${section.lengthTarget}`);
  if (section.method) lines.push(`${indent}  方法：${section.method}`);
  if (section.evidence) lines.push(`${indent}  证据要求：${section.evidence}`);
  for (const child of section.children ?? []) lines.push(...sectionLine(child, depth + 1));
  return lines;
}

function booleanBlock(title: string, entries: ReadonlyArray<[string, boolean, string]>): string {
  const allowed = entries.filter(([, enabled]) => enabled).map(([, , label]) => label);
  const blocked = entries.filter(([, enabled]) => !enabled).map(([, , label]) => label);
  const lines = [`## ${title}`];
  if (allowed.length > 0) lines.push(`允许：${allowed.join('；')}`);
  if (blocked.length > 0) lines.push(`不允许：${blocked.join('；')}`);
  return lines.join('\n');
}

/** 把场景定义中的成果结构、自适应策略、写作规范与方法策略格式化为执行约束文本。 */
export function formatScenarioExecutionContext(scenario: ScenarioDefinition): string {
  const blocks: string[] = [];
  const deliverable = scenario.deliverable;
  if (deliverable) {
    const head = ['# 场景成果结构', `成果类型：${deliverable.typeLabel ?? deliverable.type}`];
    if (deliverable.globalLength) head.push(`总篇幅：${deliverable.globalLength}`);
    if (deliverable.language) head.push(`语言：${deliverable.language === 'zh' ? '中文' : '英文'}`);
    if (deliverable.journalTier) {
      head.push(`期刊层次：${deliverable.journalTier === 'core' ? '核心期刊' : deliverable.journalTier === 'general' ? '一般刊物' : '不限'}`);
    }
    if (deliverable.structurePolicy) {
      const { defaultSections, suggestedMin, suggestedMax } = deliverable.structurePolicy;
      head.push(`章节数：默认 ${defaultSections}，建议 ${suggestedMin}-${suggestedMax} 章`);
    }
    for (const section of deliverable.sections ?? []) head.push(...sectionLine(section, 0));
    blocks.push(head.join('\n'));
  }
  const adaptivity = scenario.adaptivity;
  if (adaptivity) {
    const lines = ['# AI 自适应边界（研究过程中的自主调整范围）'];
    lines.push(booleanBlock('成果结构调整', [
      ['addSections', adaptivity.structure.addSections, '增加章节'],
      ['deleteUnlockedSections', adaptivity.structure.deleteUnlockedSections, '删除非锁定章节'],
      ['splitSections', adaptivity.structure.splitSections, '拆分章节'],
      ['mergeSections', adaptivity.structure.mergeSections, '合并章节'],
      ['reorderSections', adaptivity.structure.reorderSections, '调整章节顺序'],
      ['adjustLength', adaptivity.structure.adjustLength, '调整篇幅'],
    ]));
    lines.push(booleanBlock('研究内容调整', [
      ['reviseQuestion', adaptivity.content.reviseQuestion, '修改非锁定研究问题'],
      ['addQuestion', adaptivity.content.addQuestion, '新增研究问题'],
      ['reviseHypothesis', adaptivity.content.reviseHypothesis, '修改研究假设'],
      ['dropUnsupportedHypothesis', adaptivity.content.dropUnsupportedHypothesis, '删除证据不足的假设'],
      ['adjustFramework', adaptivity.content.adjustFramework, '调整理论框架'],
    ]));
    lines.push(booleanBlock('方法与分析调整', [
      ['addMethod', adaptivity.method.addMethod, '增加分析方法'],
      ['replaceUnsuitableMethod', adaptivity.method.replaceUnsuitableMethod, '更换不适用的方法'],
      ['addRobustness', adaptivity.method.addRobustness, '增加稳健性检验'],
      ['addHeterogeneity', adaptivity.method.addHeterogeneity, '增加异质性分析'],
      ['addMechanism', adaptivity.method.addMechanism, '增加机制分析'],
    ]));
    const backtracks = adaptivity.allowedBacktracks ?? [];
    if (backtracks.length > 0) {
      lines.push(`允许的回溯路径：${backtracks.join('；')}（研究过程可循环回补，不必严格线性执行）`);
    } else {
      lines.push('未开放回溯路径：按工作流顺序推进。');
    }
    const triggers = adaptivity.majorAdjustmentTriggers ?? [];
    if (triggers.length > 0) {
      lines.push(`重大调整触发条件（满足其一即可自主调整，无需用户逐次审批）：\n${triggers.map((trigger) => `- ${trigger}`).join('\n')}`);
    }
    lines.push('重大调整必须记录：调整前内容、调整后内容、原因与依据；锁定部分与硬约束任何情况下不可修改。');
    blocks.push(lines.join('\n'));
  }
  if (scenario.writingRules && scenario.writingRules.length > 0) {
    blocks.push(['# 场景写作规范', ...scenario.writingRules.map((rule) => `- ${rule}`)].join('\n'));
  }
  const methodPolicy = scenario.methodPolicy;
  if (methodPolicy) {
    const lines = ['# 场景研究方法策略'];
    if (methodPolicy.recommended.length > 0) lines.push(`推荐方法：${methodPolicy.recommended.join('；')}`);
    if (methodPolicy.allowed.length > 0) lines.push(`允许方法：${methodPolicy.allowed.join('；')}`);
    if (methodPolicy.conditional.length > 0) lines.push(`条件方法（说明使用条件）：${methodPolicy.conditional.join('；')}`);
    if (methodPolicy.forbidden.length > 0) lines.push(`禁止方法：${methodPolicy.forbidden.join('；')}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
