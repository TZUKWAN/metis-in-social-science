/**
 * 场景成果结构契约测试（场景重构 P0）。
 * 校验 DeliverableSpec/Adaptivity/ReferenceMaterial 的结构约束与场景级 superRefine。
 */
import { describe, expect, it } from 'vitest';
import {
  AdaptivityPolicySchema,
  DeliverableSpecSchema,
  ReferenceMaterialSchema,
  ScenarioDefinitionSchema,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

const validDeliverable = {
  type: 'empirical_paper',
  typeLabel: '实证论文',
  sections: [
    { id: 'title', title: '题目', kind: 'title', status: 'locked' },
    { id: 'c1', title: '1 引言', kind: 'chapter', status: 'required', requirements: ['研究缺口'] },
    { id: 'r1', title: '稳健性检验', kind: 'section', status: 'conditional', condition: '基准结果成立时' },
  ],
  structurePolicy: { defaultSections: 5, suggestedMin: 4, suggestedMax: 7 },
  globalLength: '10000-12000 字',
  language: 'zh',
  journalTier: 'core',
} as const;

describe('DeliverableSpecSchema', () => {
  it('合法成果结构通过', () => {
    expect(DeliverableSpecSchema.safeParse(validDeliverable).success).toBe(true);
  });
  it('条件部分缺少 condition 被拒', () => {
    const broken = { ...validDeliverable, sections: [{ id: 'r1', title: 'x', kind: 'section', status: 'conditional' }] };
    expect(DeliverableSpecSchema.safeParse(broken).success).toBe(false);
  });
  it('suggestedMin > suggestedMax 被拒', () => {
    const broken = { ...validDeliverable, structurePolicy: { defaultSections: 5, suggestedMin: 8, suggestedMax: 4 } };
    expect(DeliverableSpecSchema.safeParse(broken).success).toBe(false);
  });
  it('嵌套深度超过 4 层被拒', () => {
    const deep = (depth: number): unknown => (depth >= 5
      ? { id: 'x' + depth, title: 'L' + depth, kind: 'section', status: 'optional' }
      : { id: 'x' + depth, title: 'L' + depth, kind: 'chapter', status: 'required', children: [deep(depth + 1)] });
    const broken = { ...validDeliverable, sections: [deep(0)] };
    expect(DeliverableSpecSchema.safeParse(broken).success).toBe(false);
  });
});

describe('AdaptivityPolicySchema', () => {
  it('完整自适应策略通过；回溯边去重', () => {
    const valid = {
      structure: { addSections: true, deleteUnlockedSections: true, splitSections: true, mergeSections: true, reorderSections: true, adjustLength: true },
      content: { reviseQuestion: true, addQuestion: true, reviseHypothesis: true, dropUnsupportedHypothesis: true, adjustFramework: true },
      method: { addMethod: true, replaceUnsuitableMethod: true, addRobustness: true, addHeterogeneity: true, addMechanism: true },
      allowedBacktracks: ['analysis->literature'],
      majorAdjustmentTriggers: ['新证据推翻原假设'],
    };
    expect(AdaptivityPolicySchema.safeParse(valid).success).toBe(true);
    expect(AdaptivityPolicySchema.safeParse({ ...valid, allowedBacktracks: ['a', 'a'] }).success).toBe(false);
  });
});

describe('ReferenceMaterialSchema', () => {
  it('材料与洞察分类通过；id 必须是本地 id', () => {
    const valid = {
      id: 'mat-1',
      name: '投稿指南.pdf',
      kind: 'guide',
      analyzedAt: 1,
      insights: { structureRules: ['五章'], writingPrinciples: [], methodSuggestions: [], hardRequirements: ['引用可查'] },
    };
    expect(ReferenceMaterialSchema.safeParse(valid).success).toBe(true);
    expect(ReferenceMaterialSchema.safeParse({ ...valid, id: 'bad id!' }).success).toBe(false);
  });
});

describe('ScenarioDefinitionSchema 扩展字段兼容', () => {
  it('无扩展字段的最小场景仍通过（存量兼容）', () => {
    const minimal = {
      contractVersion: 1,
      id: 'user:scenario/min',
      kind: 'scenario',
      name: '最小场景',
      description: '',
      enabled: true,
      tags: [],
      revision: 1,
      provenance: {
        origin: 'user', author: 't', version: '1.0.0', license: null, sourceUrl: null,
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
    };
    const result = ScenarioDefinitionSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});
