/**
 * liveClassifier — AI LIVE 场景归类规则测试（重构 R2）。
 * 全部输入来自真实事件形状，验证确定性映射与漏斗解析。
 */

import { describe, expect, it } from 'vitest';
import { classifyReflection, classifyStep, diffText, parseFunnel } from '../../src/autonomous/liveClassifier';

describe('parseFunnel', () => {
  it('解析中文漏斗数字', () => {
    const funnel = parseFunnel('已扫描 120 篇，相关 34 篇，全文精读 12 篇，最终纳入 8 篇');
    expect(funnel).toEqual({ scanned: 120, relevant: 34, fullText: 12, included: 8 });
  });

  it('解析英文漏斗数字', () => {
    const funnel = parseFunnel('scanned 200, relevant 40, full text 15, included 9');
    expect(funnel).toEqual({ scanned: 200, relevant: 40, fullText: 15, included: 9 });
  });

  it('无漏斗数字时返回 null', () => {
    expect(parseFunnel('正在整理检索结果')).toBeNull();
  });

  it('缺失项补 0', () => {
    const funnel = parseFunnel('已扫描 50 篇');
    expect(funnel).toEqual({ scanned: 50, relevant: 0, fullText: 0, included: 0 });
  });
});

describe('classifyStep', () => {
  it('文献阶段 → literature 场景并带漏斗', () => {
    const scene = classifyStep({
      type: 'step', phase: 'screening', stepName: '标题/摘要筛选',
      output: '扫描 98 篇 → 相关 21 篇', at: 1000,
    });
    expect(scene.kind).toBe('literature');
    expect(scene.target).toBe('标题/摘要筛选');
    expect(scene.funnel?.scanned).toBe(98);
  });

  it('统计阶段 → analysis 场景', () => {
    const scene = classifyStep({ type: 'step', phase: 'statistics', stepName: '双通道 OLS', output: '系数 -0.42（p<0.01）', at: 2000 });
    expect(scene.kind).toBe('analysis');
    expect(scene.funnel).toBeNull();
  });

  it('未知阶段回退 writing', () => {
    const scene = classifyStep({ type: 'step', phase: 'unknown_phase', stepName: 'x', output: '', at: 3000 });
    expect(scene.kind).toBe('writing');
  });
});

describe('classifyReflection', () => {
  it('问题阶段 → question 场景且 after 反映修正语义', () => {
    const scene = classifyReflection({
      type: 'reflection', phase: 'question_formulation', decision: 'redo',
      reasoning: '原问题过窄', revisionNote: '已收窄到组织控制视角', at: 4000,
    });
    expect(scene.kind).toBe('question');
    expect(scene.target).toBe('研究问题');
    expect(scene.after).toContain('重做');
    expect(scene.reason).toContain('收窄');
  });

  it('写作阶段 → writing 场景且回退语义正确', () => {
    const scene = classifyReflection({
      type: 'reflection', phase: 'writing', decision: 'rollback',
      reasoning: '结论与证据不一致', at: 5000,
    });
    expect(scene.kind).toBe('writing');
    expect(scene.target).toBe('论文正文');
    expect(scene.after).toContain('回退');
  });
});

describe('diffText', () => {
  it('行级差异：新增与删除分离', () => {
    const { added, removed } = diffText('第一行\n共同行\n旧行', '第一行\n共同行\n新行');
    expect(added).toContain('新行');
    expect(removed).toContain('旧行');
  });

  it('无差异时为空', () => {
    const { added, removed } = diffText('相同', '相同');
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it('差异行超过 5 条时截断', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `行${i}`);
    const { added } = diffText('', lines.join('\n'));
    expect(added.length).toBeLessThanOrEqual(5);
  });
});
