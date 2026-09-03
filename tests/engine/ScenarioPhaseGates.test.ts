import { describe, expect, it } from 'vitest';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  SCENARIO_PHASE_ORDER,
  checkPhaseGate,
  formatAuditIssues,
  runAllPhaseGates,
} from '../../engine/personalization/ScenarioPhaseGates.js';

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenario/test',
    kind: 'scenario',
    name: '测试场景',
    description: '这是一个用于单元测试的完整场景描述，超过二十个字以满足验收门。',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: { origin: 'user', author: 'test', version: '1.0.0', license: null, sourceUrl: null, sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null, locallyModified: true, createdAt: 1, updatedAt: 1 },
    agentIds: [], skillIds: [], mcpIds: [], rulesIds: [],
    workflow: [{
      id: 'step-1', name: '第一步', description: '', goal: '', prompt: '做第一步的工作。', inputs: [], outputs: [],
      completionCriteria: ['产出物完成并通过检查。'], condition: null, skillIds: [], mcpIds: [], toolIds: [], dependsOn: [], maxTurns: 12,
    }],
    fullAccess: { mode: 'full_access', perActionConfirmation: false, liveSteering: true, silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 4_000 },
    output: { format: 'markdown', schema: null, plan: { primaryDeliverable: '测试交付物', supportingArtifacts: [], qualityCriteria: ['内容覆盖全部章节。'] }, requireEvidenceEnvelope: false, includeIntegrityReport: false },
    triggerPhrases: [],
    capability: 'research',
    deliverable: {
      type: 'empirical_paper', language: 'zh', globalLength: '7500字', secondarySections: { min: 2, max: 4 },
      structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
      sections: [{ id: 'sec-1', title: '引言', kind: 'chapter', status: 'required', children: [
        { id: 'sec-1-1', title: '研究背景', kind: 'section', status: 'required', children: [] },
        { id: 'sec-1-2', title: '研究问题', kind: 'section', status: 'required', children: [] },
      ] }],
    },
    workflowPrompt: '先完成第一步，再把产出交给下一步；全程保证引用真实来源。',
    scenarioMetis: { purpose: '测试目的', roleBoundaries: '', researchRules: '', writingRules: '', toolRules: '', qualityGates: '', failureRecovery: '', markdown: '# 测试规则\n\n这是一段真实的规则文档内容，用于验证 rules 阶段的验收门可以通过。规则必须覆盖研究、写作、质量与失败恢复等关键方面，因此这段文字需要足够长才能通过验收门的长度检查。' },
    ...overrides,
  } as ScenarioDefinition;
}

describe('ScenarioPhaseGates', () => {
  it('passes every gate on a complete scenario', () => {
    const results = runAllPhaseGates(scenario());
    for (const entry of results) {
      expect(entry.result.ok, `${entry.phase} should pass`).toBe(true);
    }
  });

  it('basics gate rejects missing name/description/capability', () => {
    const gate = checkPhaseGate('basics', scenario({ name: '', description: '太短', capability: '' }));
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((issue) => issue.includes('name'))).toBe(true);
    expect(gate.issues.some((issue) => issue.includes('description'))).toBe(true);
    expect(gate.issues.some((issue) => issue.includes('capability'))).toBe(true);
  });

  it('deliverable gate rejects numeric globalLength and empty sections', () => {
    const base = scenario();
    base.deliverable!.globalLength = '';
    base.deliverable!.sections = [];
    const gate = checkPhaseGate('deliverable', base);
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((issue) => issue.includes('globalLength'))).toBe(true);
    expect(gate.issues.some((issue) => issue.includes('sections'))).toBe(true);
  });

  it('deliverable gate rejects chapters without enough second-level children (2026-08-28 刘总要求)', () => {
    const base = scenario();
    base.deliverable!.sections = [{ id: 'sec-1', title: '引言', kind: 'chapter', status: 'required', children: [] }];
    const gate = checkPhaseGate('deliverable', base);
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((issue) => issue.includes('二级章节不足'))).toBe(true);
  });

  it('workflow gate rejects steps without prompt or criteria', () => {
    const base = scenario();
    base.workflow[0]!.prompt = '';
    const gate = checkPhaseGate('workflow', base);
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((issue) => issue.includes('prompt'))).toBe(true);
  });

  it('workflow gate rejects an empty workflow', () => {
    const gate = checkPhaseGate('workflow', scenario({ workflow: [] }));
    expect(gate.ok).toBe(false);
    expect(gate.issues[0]).toContain('workflow');
  });

  it('rules gate rejects template-only Metis markdown and empty workflowPrompt', () => {
    const base = scenario({ workflowPrompt: '' });
    // 清空全部结构化字段：normalize 后 markdown 退化为空白模板，必须被判不合格。
    base.scenarioMetis = { purpose: '', roleBoundaries: '', researchRules: '', writingRules: '', toolRules: '', qualityGates: '', failureRecovery: '', markdown: '' };
    const gate = checkPhaseGate('rules', base);
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((issue) => issue.includes('scenarioMetis.markdown'))).toBe(true);
    expect(gate.issues.some((issue) => issue.includes('workflowPrompt'))).toBe(true);
  });

  it('output_plan gate rejects empty quality criteria', () => {
    const base = scenario();
    base.output.plan!.qualityCriteria = [];
    const gate = checkPhaseGate('output_plan', base);
    expect(gate.ok).toBe(false);
    expect(gate.issues.some((issue) => issue.includes('qualityCriteria'))).toBe(true);
  });

  it('formatAuditIssues merges phase issues and extra issues in order', () => {
    const base = scenario({ name: '' });
    base.output.plan!.qualityCriteria = [];
    const entries = runAllPhaseGates(base);
    const lines = formatAuditIssues(entries, ['schema 违规示例']);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain('[基本信息]');
    expect(lines.at(-1)).toContain('schema 违规示例');
  });

  it('exposes the five phases in order', () => {
    expect([...SCENARIO_PHASE_ORDER]).toEqual(['basics', 'deliverable', 'workflow', 'rules', 'output_plan']);
  });
});
