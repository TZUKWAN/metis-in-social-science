import type {
  PersonalizationDefinition,
  ScenarioDefinition,
  ScenarioMetisDocument,
  ScenarioQualityGate,
  ScenarioWritingStyle,
  WorkflowStepBinding,
} from '../runtime/PersonalizationRuntimeContract.js';

export type ScenarioHarnessIssueSeverity = 'blocking' | 'warning';

export interface ScenarioHarnessIssue {
  code: string;
  severity: ScenarioHarnessIssueSeverity;
  path: string;
  message: string;
  autoFixable: boolean;
}

export interface ScenarioHarnessAssessment {
  score: number;
  status: 'ready' | 'needs_attention' | 'blocked';
  issues: ScenarioHarnessIssue[];
  blockingCount: number;
  warningCount: number;
}

const DEFAULT_WRITING_STYLE: ScenarioWritingStyle = {
  voice: 'academic',
  person: 'impersonal',
  tone: 'formal',
  tense: '',
  terminology: [],
  paragraphPattern: '',
  citationStyle: '',
  formulaStyle: '',
  tableFigureStyle: '',
  prohibitedExpressions: [],
  customInstructions: '',
};

const DEFAULT_SCENARIO_METIS: ScenarioMetisDocument = {
  purpose: '',
  roleBoundaries: '',
  researchRules: '',
  writingRules: '',
  toolRules: '',
  qualityGates: '',
  failureRecovery: '',
  markdown: '',
  inheritanceOrder: ['global', 'scenario', 'project'],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safeLocalId(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 150);
  return cleaned || fallback;
}

function normalizeWorkflowStep(step: WorkflowStepBinding): WorkflowStepBinding {
  const description = step.description.trim();
  return {
    ...step,
    goal: step.goal ?? description,
    prompt: step.prompt ?? description,
    inputs: clone(step.inputs ?? []),
    outputs: clone(step.outputs ?? []),
    completionCriteria: [...(step.completionCriteria ?? [])],
    condition: step.condition ?? null,
    failurePolicy: clone(step.failurePolicy ?? {
      action: 'retry',
      retryLimit: 2,
      backtrackStepId: null,
      instruction: '',
    }),
    loop: clone(step.loop ?? {
      enabled: false,
      maxIterations: 1,
      stopCondition: '',
      evaluator: 'completion_criteria',
      onExhausted: 'fail',
      backtrackStepId: null,
    }),
  };
}

/** Render the structured Scenario Metis fields into the exact runtime Markdown layer. */
export function renderScenarioMetisMarkdown(document: ScenarioMetisDocument): string {
  if (document.markdown.trim()) return document.markdown.trim();
  return [
    '# Scenario Metis.md',
    '',
    '## Purpose',
    document.purpose,
    '',
    '## Role boundaries',
    document.roleBoundaries,
    '',
    '## Research rules',
    document.researchRules,
    '',
    '## Writing rules',
    document.writingRules,
    '',
    '## Tool rules',
    document.toolRules,
    '',
    '## Quality gates',
    document.qualityGates,
    '',
    '## Failure recovery',
    document.failureRecovery,
  ].join('\n').trim();
}

/**
 * Upgrade a valid legacy Scenario in memory without changing its identity or revision.
 * All additions are deterministic policy defaults; no research content is fabricated.
 */
export function normalizeScenarioHarness(input: ScenarioDefinition): ScenarioDefinition {
  const scenario = clone(input);
  const workflow = scenario.workflow.map(normalizeWorkflowStep);
  const writingStyle = clone(scenario.writingStyle ?? DEFAULT_WRITING_STYLE);
  const scenarioMetis = clone(scenario.scenarioMetis ?? {
    ...DEFAULT_SCENARIO_METIS,
    purpose: scenario.description,
    writingRules: (scenario.writingRules ?? []).join('\n'),
  });
  if (!scenarioMetis.markdown.trim()) {
    scenarioMetis.markdown = renderScenarioMetisMarkdown(scenarioMetis);
  }
  const rootStepIds = new Set(workflow.map((step) => step.id));
  const firstRootStep = workflow.find((step) => step.dependsOn.length === 0)?.id ?? workflow[0]?.id ?? null;
  const workflowGovernance = clone(scenario.workflowGovernance ?? {
    entryStepId: firstRootStep,
    completionCriteria: [],
    allowDynamicReorder: false,
    allowStepSplit: false,
    allowStepMerge: false,
    allowStepInsertion: false,
    requireChangeLog: true,
    // This is a runtime safety ceiling, not a user-facing workflow setting.
    // Criteria failures are repaired in-place and must not turn into a false
    // terminal result just because a short legacy default was reached.
    maxTotalStepExecutions: 10_000,
  });
  if (workflowGovernance.entryStepId && !rootStepIds.has(workflowGovernance.entryStepId)) {
    workflowGovernance.entryStepId = firstRootStep;
  }
  workflowGovernance.maxTotalStepExecutions = 10_000;
  // 章节层级语义自愈：模型/历史补丁可能把顶层章节写成 "section"，
  // 渲染层只把顶层 "chapter" 当一级章节展示；此处统一纠正，避免结构在重载后"消失"。
  if (scenario.deliverable?.sections?.some((section) => section.kind === 'section')) {
    scenario.deliverable = {
      ...scenario.deliverable,
      sections: scenario.deliverable.sections.map((section) => (
        section.kind === 'section' ? { ...section, kind: 'chapter' as const } : section
      )),
    };
  }
  return {
    ...scenario,
    workflow,
    workflowPrompt: scenario.workflowPrompt ?? '',
    agentIds: unique([
      ...scenario.agentIds,
      ...workflow.flatMap((step) => step.agentId ? [step.agentId] : []),
    ]),
    skillIds: unique([...scenario.skillIds, ...workflow.flatMap((step) => step.skillIds)]),
    mcpIds: unique([...scenario.mcpIds, ...workflow.flatMap((step) => step.mcpIds)]),
    writingStyle,
    scenarioMetis,
    workflowGovernance,
    workflowLoop: clone(scenario.workflowLoop ?? {
      enabled: false,
      maxIterations: 1,
      stopCondition: '',
      reentryStepId: firstRootStep,
      carryArtifacts: true,
      onExhausted: 'complete',
    }),
    checkpointPolicy: clone(scenario.checkpointPolicy ?? {
      enabled: true,
      afterEveryStep: true,
      afterEveryLoopIteration: true,
      includeToolCallSummary: true,
      resumeMode: 'continue',
    }),
    qualityGates: clone(scenario.qualityGates ?? []),
    adjustmentLog: clone(scenario.adjustmentLog ?? []),
  };
}

function hasText(value: string | undefined | null): boolean {
  return Boolean(value?.trim());
}

function issue(
  code: string,
  severity: ScenarioHarnessIssueSeverity,
  path: string,
  message: string,
  autoFixable: boolean,
): ScenarioHarnessIssue {
  return { code, severity, path, message, autoFixable };
}

/** Pure, deterministic quality audit used by both the renderer and compiler boundary. */
export function assessScenarioHarness(
  input: ScenarioDefinition,
  definitions: readonly PersonalizationDefinition[] = [],
): ScenarioHarnessAssessment {
  const scenario = normalizeScenarioHarness(input);
  const issues: ScenarioHarnessIssue[] = [];
  const known = new Map(definitions.map((definition) => [definition.id, definition]));
  if (!scenario.deliverable || (scenario.deliverable.sections?.length ?? 0) === 0) {
    issues.push(issue('deliverable_blueprint_missing', 'blocking', 'deliverable.sections', 'Define at least one deliverable section.', false));
  }
  if (!hasText(scenario.scenarioMetis?.markdown)) {
    issues.push(issue('scenario_metis_missing', 'warning', 'scenarioMetis.markdown', 'Add the Scenario Metis.md rules that apply throughout this workflow.', false));
  }
  if (scenario.workflow.length === 0) {
    issues.push(issue('workflow_missing', 'blocking', 'workflow', 'Add at least one executable workflow step.', false));
  }
  const stepIds = new Set(scenario.workflow.map((step) => step.id));
  for (let index = 0; index < scenario.workflow.length; index += 1) {
    const step = scenario.workflow[index]!;
    const base = `workflow.${index}`;
    if (!hasText(step.prompt)) issues.push(issue('step_prompt_missing', 'blocking', `${base}.prompt`, `Step “${step.name}” has no dedicated prompt.`, true));
    if ((step.completionCriteria?.length ?? 0) === 0) issues.push(issue('step_criteria_missing', 'blocking', `${base}.completionCriteria`, `Step “${step.name}” has no completion criterion.`, true));
    if (step.failurePolicy?.action === 'backtrack' && !step.failurePolicy.backtrackStepId) {
      issues.push(issue('failure_backtrack_target_missing', 'blocking', `${base}.failurePolicy.backtrackStepId`, `Step “${step.name}” backtracks without a target.`, false));
    }
    if (step.loop?.enabled && !hasText(step.loop.stopCondition)) {
      issues.push(issue('step_loop_stop_missing', 'blocking', `${base}.loop.stopCondition`, `Step “${step.name}” loop has no stop condition.`, false));
    }
    if (step.loop?.backtrackStepId && !stepIds.has(step.loop.backtrackStepId)) {
      issues.push(issue('step_loop_target_invalid', 'blocking', `${base}.loop.backtrackStepId`, `Step “${step.name}” loop target is invalid.`, false));
    }
    for (const skillId of step.skillIds) {
      if (known.size > 0 && known.get(skillId)?.kind !== 'skill') issues.push(issue('step_skill_unavailable', 'blocking', `${base}.skillIds`, `Step “${step.name}” references unavailable Skill ${skillId}.`, false));
    }
    for (const mcpId of step.mcpIds) {
      if (known.size > 0 && known.get(mcpId)?.kind !== 'mcp') issues.push(issue('step_mcp_unavailable', 'blocking', `${base}.mcpIds`, `Step “${step.name}” references unavailable MCP ${mcpId}.`, false));
    }
  }
  const blockingCount = issues.filter((item) => item.severity === 'blocking').length;
  const warningCount = issues.length - blockingCount;
  const score = Math.max(0, 100 - blockingCount * 12 - warningCount * 3);
  return {
    score,
    status: blockingCount > 0 ? 'blocked' : warningCount > 0 ? 'needs_attention' : 'ready',
    issues,
    blockingCount,
    warningCount,
  };
}

/** Apply only deterministic, content-preserving fixes advertised by the assessment. */
export function autoFixScenarioHarness(input: ScenarioDefinition): ScenarioDefinition {
  const scenario = normalizeScenarioHarness(input);
  scenario.workflow = scenario.workflow.map((step, index) => {
    const goal = step.goal?.trim() || step.description.trim() || step.name;
    const prompt = step.prompt?.trim() || step.description.trim() || `Complete the goal: ${goal}`;
    const outputId = safeLocalId(`${step.id}-output`, `step-${index + 1}-output`);
    return {
      ...step,
      goal,
      prompt,
      outputs: step.outputs && step.outputs.length > 0 ? step.outputs : [{
        id: outputId,
        name: `${step.name} output`,
        format: 'artifact',
        description: goal,
        required: true,
      }],
      completionCriteria: step.completionCriteria && step.completionCriteria.length > 0
        ? step.completionCriteria
        : [`The declared output for “${step.name}” is complete and satisfies the step goal.`],
      condition: step.condition?.trim() ? step.condition : null,
    };
  });
  if (scenario.scenarioMetis && !scenario.scenarioMetis.markdown.trim()) {
    scenario.scenarioMetis.markdown = renderScenarioMetisMarkdown(scenario.scenarioMetis);
  }
  scenario.checkpointPolicy = {
    ...(scenario.checkpointPolicy ?? {
      enabled: true,
      afterEveryStep: true,
      afterEveryLoopIteration: true,
      includeToolCallSummary: true,
      resumeMode: 'continue',
    }),
    enabled: true,
    afterEveryStep: true,
  };
  scenario.agentIds = unique([...scenario.agentIds, ...scenario.workflow.flatMap((step) => step.agentId ? [step.agentId] : [])]);
  scenario.skillIds = unique([...scenario.skillIds, ...scenario.workflow.flatMap((step) => step.skillIds)]);
  scenario.mcpIds = unique([...scenario.mcpIds, ...scenario.workflow.flatMap((step) => step.mcpIds)]);
  return scenario;
}

/** Convenience helper for a new empty Harness quality gate. */
export function createScenarioQualityGate(index: number): ScenarioQualityGate {
  return {
    id: `quality-${index + 1}`,
    name: `Quality gate ${index + 1}`,
    scope: 'workflow',
    targetStepId: null,
    criterion: '',
    severity: 'blocking',
    autoFix: false,
  };
}
