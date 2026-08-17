/**
 * ScenarioExecutionContext — 场景执行上下文格式化测试（场景重构 P3）。
 * 验证成果结构/自适应/写作规范/方法策略被格式化为可执行的研究约束文本。
 */
import { describe, expect, it } from 'vitest';
import { formatScenarioExecutionContext } from '../../engine/personalization/ScenarioExecutionContext.js';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

function makeScenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenario/test',
    kind: 'scenario',
    name: '测试场景',
    description: '',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'user', author: 't', version: '1', license: null, sourceUrl: null,
      sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null,
      locallyModified: false, createdAt: 0, updatedAt: 0,
    },
    agentIds: [], skillIds: [], mcpIds: [], rulesIds: [],
    workflow: [],
    fullAccess: {
      mode: 'full_access', perActionConfirmation: false, liveSteering: true,
      silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true,
    },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 1000 },
    output: { format: 'markdown', schema: null, plan: null, requireEvidenceEnvelope: false, includeIntegrityReport: false },
    triggerPhrases: [],
    capability: 'research',
    ...overrides,
  } as ScenarioDefinition;
}

describe('formatScenarioExecutionContext', () => {
  it('无扩展字段时输出为空（零影响兼容）', () => {
    expect(formatScenarioExecutionContext(makeScenario())).toBe('');
  });

  it('成果结构：类型/篇幅/章节策略/树与逐部分要求全部进入文本', () => {
    const scenario = makeScenario({
      deliverable: {
        type: 'empirical_paper',
        typeLabel: '实证论文',
        globalLength: '10000-12000 字',
        language: 'zh',
        journalTier: 'core',
        structurePolicy: { defaultSections: 5, suggestedMin: 4, suggestedMax: 7 },
        sections: [
          { id: 't', title: '题目', kind: 'title', status: 'locked' },
          {
            id: 'c3', title: '3 研究设计', kind: 'chapter', status: 'required',
            purpose: '交代识别策略', requirements: ['数据来源', '变量定义'], forbidden: ['堆砌不相关检验'],
            lengthTarget: '1800-2500 字', method: '双重差分', evidence: '报告数据来源',
            children: [{ id: 'c3-1', title: '3.1 数据', kind: 'section', status: 'optional' }],
          },
        ],
      },
    });
    const text = formatScenarioExecutionContext(scenario);
    expect(text).toContain('成果类型：实证论文');
    expect(text).toContain('总篇幅：10000-12000 字');
    expect(text).toContain('默认 5，建议 4-7 章');
    expect(text).toContain('[锁定] 题目（锁定）');
    expect(text).toContain('[必选] 3 研究设计（必选）');
    expect(text).toContain('必须包含：数据来源；变量定义');
    expect(text).toContain('禁止：堆砌不相关检验');
    expect(text).toContain('方法：双重差分');
    expect(text).toContain('3.1 数据');
  });

  it('自适应：允许/不允许分组、回溯路径与重大调整触发条件', () => {
    const scenario = makeScenario({
      adaptivity: {
        structure: { addSections: true, deleteUnlockedSections: false, splitSections: true, mergeSections: false, reorderSections: true, adjustLength: true },
        content: { reviseQuestion: true, addQuestion: false, reviseHypothesis: true, dropUnsupportedHypothesis: true, adjustFramework: false },
        method: { addMethod: true, replaceUnsuitableMethod: true, addRobustness: true, addHeterogeneity: false, addMechanism: false },
        allowedBacktracks: ['analysis->literature'],
        majorAdjustmentTriggers: ['新证据推翻原假设'],
      },
    });
    const text = formatScenarioExecutionContext(scenario);
    expect(text).toContain('允许：增加章节；拆分章节；调整章节顺序；调整篇幅');
    expect(text).toContain('不允许：删除非锁定章节；合并章节');
    expect(text).toContain('analysis->literature');
    expect(text).toContain('新证据推翻原假设');
    expect(text).toContain('无需用户逐次审批');
    expect(text).toContain('锁定部分与硬约束任何情况下不可修改');
  });

  it('写作规范与方法策略分别成块', () => {
    const scenario = makeScenario({
      writingRules: ['摘要禁止出现"本文"'],
      methodPolicy: { recommended: ['历史分析'], allowed: [], conditional: [], forbidden: ['问卷调查'] },
    });
    const text = formatScenarioExecutionContext(scenario);
    expect(text).toContain('# 场景写作规范');
    expect(text).toContain('摘要禁止出现');
    expect(text).toContain('推荐方法：历史分析');
    expect(text).toContain('禁止方法：问卷调查');
  });
});
