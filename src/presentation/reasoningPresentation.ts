import { presentDiagnosticText, type PresentationLocale } from './executionPresentation';

const MAX_DIAGNOSTIC_REASONING = 2_000;
const MAX_SUMMARY_CHARS = 72;

/**
 * Reasoning is an internal model channel. Normal mode deliberately maps it to
 * a bounded public phase label instead of echoing chain-of-thought text.
 */
export function presentReasoningSummary(
  reasoning: string,
  locale: PresentationLocale,
): string {
  const normalized = reasoning.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!normalized) return '';

  const labels: Array<{ match: RegExp; zh: string; en: string }> = [
    { match: /search|检索|搜索|查找|文献|literature|source|evidence/u, zh: '正在检索并整理研究证据', en: 'Searching and organizing research evidence' },
    { match: /read|阅读|解析|pdf|document|材料|资料/u, zh: '正在阅读并提取关键材料', en: 'Reading and extracting key material' },
    { match: /compar|比较|对照|评估|evaluate|contrast/u, zh: '正在比较证据并评估差异', en: 'Comparing evidence and evaluating differences' },
    { match: /plan|规划|设计|workflow|方案|步骤/u, zh: '正在组织研究方案和执行步骤', en: 'Structuring the research plan and steps' },
    { match: /write|写作|整理|draft|compose|润色/u, zh: '正在整理并撰写回答', en: 'Organizing and drafting the answer' },
    { match: /check|审查|核验|验证|verify|review|quality/u, zh: '正在核验结果并检查完整性', en: 'Verifying results and checking completeness' },
  ];
  const matched = labels.find((entry) => entry.match.test(normalized));
  const fallback = locale === 'zh' ? '正在分析问题并整理回答' : 'Analyzing the question and preparing an answer';
  const summary = matched ? (locale === 'zh' ? matched.zh : matched.en) : fallback;
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

/** Diagnostic-only view: useful for debugging, never shown in normal mode. */
export function presentReasoningDiagnostic(
  reasoning: string,
  locale: PresentationLocale,
): string {
  if (!reasoning.trim()) return '';
  const safe = presentDiagnosticText(reasoning).trim();
  const bounded = safe.length > MAX_DIAGNOSTIC_REASONING
    ? `${safe.slice(0, MAX_DIAGNOSTIC_REASONING - 1)}…`
    : safe;
  return bounded || (locale === 'zh' ? '（无可显示的技术思考信息）' : '(No technical reasoning available)');
}
