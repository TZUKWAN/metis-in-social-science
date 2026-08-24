import { describe, expect, it } from 'vitest';
import {
  PersonalizationDefinitionSchema,
  ScenarioDefinitionSchema,
  type ScenarioDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  assessScenarioHarness,
  autoFixScenarioHarness,
  normalizeScenarioHarness,
  renderScenarioMetisMarkdown,
} from '../../engine/personalization/ScenarioHarness.js';

function legacyScenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenarios/harness-test',
    kind: 'scenario',
    name: 'Harness test',
    description: 'Run a reproducible research workflow.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'user',
      author: 'test',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
      createdAt: 1,
      updatedAt: 1,
    },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [{
      id: 'search',
      name: 'Search',
      description: 'Find the relevant literature.',
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 12,
    }],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory: {
      scope: 'project',
      retainDecisions: true,
      retainArtifacts: true,
      maxSummaryChars: 100_000,
    },
    output: {
      format: 'artifact_bundle',
      schema: null,
      plan: null,
      requireEvidenceEnvelope: true,
      includeIntegrityReport: true,
    },
    triggerPhrases: [],
    capability: 'research',
    ...overrides,
  };
}

describe('Scenario Research Harness compatibility and quality', () => {
  it('keeps a legacy scenario valid while allowing an unassigned workflow Agent', () => {
    const parsed = ScenarioDefinitionSchema.safeParse(legacyScenario());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.workflow[0]?.agentId).toBeUndefined();
  });

  it('normalizes deterministic Harness policies without changing identity or revision', () => {
    const normalized = normalizeScenarioHarness(legacyScenario({ writingRules: ['Use verifiable citations.'] }));
    expect(normalized.id).toBe('user:scenarios/harness-test');
    expect(normalized.revision).toBe(1);
    expect(normalized.workflow[0]).toMatchObject({
      goal: 'Find the relevant literature.',
      prompt: 'Find the relevant literature.',
      failurePolicy: { action: 'retry', retryLimit: 2 },
      loop: { enabled: false, maxIterations: 1 },
    });
    expect(normalized.scenarioMetis?.writingRules).toContain('verifiable citations');
    expect(normalized.checkpointPolicy).toMatchObject({ enabled: true, afterEveryStep: true });
    expect(PersonalizationDefinitionSchema.safeParse(normalized).success).toBe(true);
  });

  it('reports actionable blocking gaps and auto-fixes only deterministic step structure', () => {
    const scenario = legacyScenario();
    const before = assessScenarioHarness(scenario);
    expect(before.status).toBe('blocked');
    expect(before.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'deliverable_blueprint_missing',
      'step_criteria_missing',
    ]));

    const fixed = autoFixScenarioHarness(scenario);
    expect(fixed.workflow[0]?.outputs).toHaveLength(1);
    expect(fixed.workflow[0]?.completionCriteria).toHaveLength(1);
    expect(assessScenarioHarness(fixed).issues.map((item) => item.code)).not.toContain('step_criteria_missing');
    expect(assessScenarioHarness(fixed).issues.map((item) => item.code)).toContain('deliverable_blueprint_missing');
    expect(ScenarioDefinitionSchema.safeParse(fixed).success).toBe(true);
  });

  it('renders every required Scenario Metis.md section in inheritance order', () => {
    const normalized = normalizeScenarioHarness(legacyScenario());
    const markdown = renderScenarioMetisMarkdown({
      ...normalized.scenarioMetis!,
      markdown: '',
      purpose: 'P',
      roleBoundaries: 'R',
      researchRules: 'Research',
      writingRules: 'Writing',
      toolRules: 'Tools',
      qualityGates: 'Quality',
      failureRecovery: 'Recovery',
    });
    expect(markdown).toContain('## Purpose\nP');
    expect(markdown).toContain('## Role boundaries\nR');
    expect(markdown).toContain('## Failure recovery\nRecovery');
    expect(normalized.scenarioMetis?.inheritanceOrder).toEqual(['global', 'scenario', 'project']);
  });

  it('heals top-level sections mislabeled as "section" back to "chapter" on normalize', () => {
    const scenario = legacyScenario({
      deliverable: {
        type: 'grant_postdoc',
        globalLength: '7500字',
        sections: [
          { id: 'ch-1', title: '一、立项依据', kind: 'section', status: 'required', children: [
            { id: 'ch-1-1', title: '1.1 研究问题', kind: 'section', status: 'required' },
          ] },
        ],
      } as ScenarioDefinition['deliverable'],
    });
    const normalized = normalizeScenarioHarness(scenario);
    expect(normalized.deliverable?.sections?.[0]?.kind).toBe('chapter');
    // 二级条目保持 "section"
    expect(normalized.deliverable?.sections?.[0]?.children?.[0]?.kind).toBe('section');
  });
});
