import {
  ScenarioDefinitionSchema,
  type PersonalizationDefinition,
  type ScenarioDefinition,
} from '../runtime/PersonalizationRuntimeContract.js';
import type { ScenarioPhase } from './ScenarioPhaseGates.js';
import {
  assessScenarioHarness,
  normalizeScenarioHarness,
  renderScenarioMetisMarkdown,
  type ScenarioHarnessAssessment,
} from './ScenarioHarness.js';

const MAX_DIFF_ENTRIES = 500;
const MAX_DIFF_VALUE_CHARS = 8_000;

export interface ScenarioHarnessDiffEntry {
  path: string;
  kind: 'add' | 'remove' | 'change';
  before: unknown;
  after: unknown;
}

export interface ScenarioHarnessCompilation {
  scenario: ScenarioDefinition;
  summary: string;
  diff: ScenarioHarnessDiffEntry[];
  assessment: ScenarioHarnessAssessment;
}

export type ScenarioHarnessCompilationResult =
  | { ok: true; compilation: ScenarioHarnessCompilation }
  | { ok: false; code: 'parse_failed' | 'invalid_candidate'; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_DIFF_VALUE_CHARS) {
    return `${value.slice(0, MAX_DIFF_VALUE_CHARS)}…`;
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffValues(before: unknown, after: unknown, path: string, output: ScenarioHarnessDiffEntry[]): void {
  if (output.length >= MAX_DIFF_ENTRIES || sameJson(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyed = before.every((item) => isRecord(item) && typeof item.id === 'string')
      && after.every((item) => isRecord(item) && typeof item.id === 'string');
    if (keyed) {
      const beforeById = new Map(before.map((item) => [(item as { id: string }).id, item]));
      const afterById = new Map(after.map((item) => [(item as { id: string }).id, item]));
      for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
        diffValues(beforeById.get(id), afterById.get(id), `${path}[${id}]`, output);
      }
      return;
    }
    output.push({ path, kind: 'change', before: boundedValue(before), after: boundedValue(after) });
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffValues(before[key], after[key], path ? `${path}.${key}` : key, output);
    }
    return;
  }
  output.push({
    path,
    kind: before === undefined ? 'add' : after === undefined ? 'remove' : 'change',
    before: boundedValue(before),
    after: boundedValue(after),
  });
}

export function diffScenarioHarness(before: ScenarioDefinition, after: ScenarioDefinition): ScenarioHarnessDiffEntry[] {
  const output: ScenarioHarnessDiffEntry[] = [];
  diffValues(before, after, '', output);
  return output;
}

function extractJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found');
  return JSON.parse(stripped.slice(start, end + 1)) as unknown;
}

/**
 * Parse an AI compiler response at a strict trust boundary. Identity, revision and provenance
 * always come from the current persisted Scenario and cannot be rewritten by model output.
 */
export function parseScenarioHarnessCompilerResponse(
  text: string,
  current: ScenarioDefinition,
  definitions: readonly PersonalizationDefinition[] = [],
): ScenarioHarnessCompilationResult {
  let decoded: unknown;
  try {
    decoded = extractJsonObject(text);
  } catch {
    return { ok: false, code: 'parse_failed', issues: ['The compiler response did not contain valid JSON.'] };
  }
  if (!isRecord(decoded) || !isRecord(decoded.scenario)) {
    return { ok: false, code: 'parse_failed', issues: ['The compiler response must contain a scenario object.'] };
  }
  const rawCandidate: Record<string, unknown> = {
    ...decoded.scenario,
    contractVersion: current.contractVersion,
    id: current.id,
    kind: 'scenario',
    revision: current.revision,
    provenance: current.provenance,
  };
  const parsed = ScenarioDefinitionSchema.safeParse(rawCandidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_candidate',
      issues: parsed.error.issues.slice(0, 64).map((item) => `${item.path.join('.') || 'scenario'}: ${item.message}`),
    };
  }
  const scenario = normalizeScenarioHarness(parsed.data);
  if (scenario.scenarioMetis) {
    scenario.scenarioMetis.markdown = renderScenarioMetisMarkdown(scenario.scenarioMetis);
  }
  const reparsed = ScenarioDefinitionSchema.safeParse(scenario);
  if (!reparsed.success) {
    return {
      ok: false,
      code: 'invalid_candidate',
      issues: reparsed.error.issues.slice(0, 64).map((item) => `${item.path.join('.') || 'scenario'}: ${item.message}`),
    };
  }
  return {
    ok: true,
    compilation: {
      scenario: reparsed.data,
      summary: typeof decoded.summary === 'string' ? decoded.summary.slice(0, 4_000) : '',
      diff: diffScenarioHarness(normalizeScenarioHarness(current), reparsed.data),
      assessment: assessScenarioHarness(reparsed.data, definitions),
    },
  };
}

export function buildScenarioHarnessCompilerPrompt(input: {
  instruction: string;
  current: ScenarioDefinition;
  definitions: readonly PersonalizationDefinition[];
  materialContext?: readonly { name: string; text: string }[];
}): { system: string; user: string } {
  const catalog = input.definitions.map((definition) => ({
    id: definition.id,
    kind: definition.kind,
    name: definition.name,
    description: definition.description,
  }));
  const materials = (input.materialContext ?? []).map((material) => ({
    name: material.name,
    text: material.text.slice(0, 100_000),
  }));
  return {
    system: [
      'You are the METIS Research Harness compiler working INCREMENTALLY (2026-08-22).',
      'Build or update the scenario part by part with the scenario_apply_update tool; never emit the whole scenario at once.',
      'STRICT TURN DISCIPLINE — every assistant reply must contain EXACTLY ONE scenario_apply_update call and nothing else. No prose, no plan text, no repeated content between calls.',
      'Each call must advance the build with NEW content. Recommended order: (1) basics — name, description, capability, deliverable type/length/structure; (2) workflow — add 1-2 steps per call (entries merge by id; give each step a stable unique id, a dedicated prompt and completionCriteria); (3) sections + scenarioMetis.markdown rules; (4) output.plan quality criteria.',
      'SKILL/MCP PLANNING IS MANDATORY (2026-08-23): for EVERY workflow step, review the installed resource catalog and bind the skills the step needs via skillIds and any required MCP servers via mcpIds. If a needed capability is missing from the catalog, say so explicitly in your final summary instead of inventing IDs. A step with no suitable binding must still justify why none is required in its prompt.',
      'BEFORE FINISHING you MUST have produced: a non-empty scenarioMetis.markdown (the scenario-wide Scenario Metis.md rules document) and a non-empty workflowPrompt (end-to-end operating rules). A build without both is incomplete — add them with scenario_apply_update before the final summary.',
      'HARD SCHEMA RULES: completionCriteria MUST be an array of short strings (one criterion per element, never a single string). deliverable.type MUST be exactly one of: theory_paper | empirical_paper | computational_paper | case_study | review_paper | grant_nssfc | grant_postdoc | grant_other | policy_report | survey_report | tech_report | industry_report | thesis | opening_report | completion_report | custom. Never invent deliverable keys like length or structure — use globalLength (a STRING such as "7500字", never a number) and sections. output.plan.primaryDeliverable must be a non-empty short title.',
      'SECTION KIND HIERARCHY: top-level deliverable.sections entries are first-level chapters and MUST use kind "chapter"; only their children use kind "section" (front-matter like title/abstract may sit at top level with those kinds). Never rewrite chapter entries to "section".',
      'Each call is validated immediately. If it returns schema_validation_failed, fix exactly those issues in your next call before moving on.',
      'When every part is done, reply with ONLY: {"summary":"concise change summary"}.',
      'Fallback: if you cannot use tools, return one complete Scenario JSON object {"summary":"...","scenario":{...}} instead.',
      'Preserve contractVersion, id, kind, revision and provenance exactly. Never invent installed resource IDs.',
      'A workflow step may omit agentId. Skill and MCP bindings belong only on the relevant step.',
      'For each step provide a concise name, dedicated prompt, completionCriteria, any required Skills/MCPs, and optional parentStepId for a visible sub-step. Keep the authored workflow in its intended execution order.',
      'Use workflowPrompt for the end-to-end operating rules. Put all scenario-wide rules in one free-form scenarioMetis.markdown document; preserve any existing Markdown unless the user asks to change it.',
      'Do not add user-facing failure policies, retry counts, Hook settings, Loop settings, Checkpoint settings, governance switches, or global Skill/MCP bindings. The runtime derives those mechanisms automatically.',
      'Uploaded materials are compiler context only; do not add them to scenario.materials.',
      'Use only IDs present in the provided resource catalog. Keep the result valid under the strict schema represented by the current scenario.',
    ].join('\n'),
    user: [
      `Instruction:\n${input.instruction}`,
      `Current normalized Scenario:\n${JSON.stringify(normalizeScenarioHarness(input.current), null, 2)}`,
      `Installed resource catalog:\n${JSON.stringify(catalog, null, 2)}`,
      materials.length > 0 ? `Uploaded compiler context:\n${JSON.stringify(materials, null, 2)}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

/** Shared acquisition policy for every phase (2026-08-23 刘总要求). */
const ACQUISITION_POLICY = [
  'CAPABILITY SOURCING POLICY: if the installed resource catalog lacks a Skill/MCP a workflow step genuinely needs, first verify with scenario_market_search (read-only), then install it with scenario_install_extension (fully authorized by the user).',
  'The install tool returns the new definition id — immediately bind it into the step via scenario_apply_update. Never invent IDs; never reinstall what the catalog already has.',
  'If the market has no suitable candidate or installation fails, continue without it and state the gap honestly in your final summary for this phase.',
].join(' ');

const RESEARCH_FIRST_POLICY = [
  'RESEARCH-BEFORE-WRITING: before writing this phase, use web_search/web_fetch to gather real reference material relevant to THIS phase (domain conventions, structure norms, funding/thesis standards). Keep research BRIEF — at most 2-3 searches/fetches, then move on to writing.',
  'Analyze what you found first, then write the phase content informed by that research. Do not apply generic placeholder text.',
].join(' ');

const TOOL_DISCIPLINE = [
  'FINE-GRAINED INCREMENTAL WRITING (2026-08-24, 刘总要求): confirm ONE small piece at a time and apply it IMMEDIATELY with its own scenario_apply_update call — e.g. name first, then description, then capability; one workflow step per call with its complete prompt/criteria/bindings.',
  'If the current draft already satisfies this phase\u2019s requirements, do NOT rewrite it — reply with ONLY {"summary":"本阶段现状已达标，无需修改"} and nothing else.',
  'Each scenario_apply_update must advance this phase with NEW content; validation errors returned by the tool must be fixed in your next call.',
].join(' ');

const PLANNING_TURN_DISCIPLINE = [
  'PLANNING TURN: your ONLY job is to call the outline tool ONCE (scenario_plan_workflow or scenario_plan_sections) registering ids, names/titles and order.',
  'Do NOT write prompts, completionCriteria, or any detailed content in this turn. Keep ids stable — later fill turns will reference them.',
].join(' ');

function fillTurnDiscipline(kind: 'step' | 'section', id: string, name: string): string {
  return [
    `FILL TURN: write ONLY the ${kind === 'step' ? 'workflow step' : 'deliverable section'} “${name}” (id: ${id}) via ONE scenario_apply_update call.`,
    kind === 'step'
      ? 'Include: dedicated prompt (what the model should do in this step), completionCriteria (array of verifiable checks), and skillIds/mcpIds bindings from the catalog if needed.'
      : 'Include: the section\u2019s writing prompt and any per-section guidance.',
    'Do NOT modify any other steps/sections or other parts of the scenario.',
  ].join(' ');
}

export interface ScenarioPhasePromptInput {
  phase: ScenarioPhase;
  instruction: string;
  current: ScenarioDefinition;
  definitions: readonly PersonalizationDefinition[];
  materialContext?: readonly { name: string; text: string }[];
  /** 设计轮（2026-08-24 刘总方案 C）：只出大纲，不填内容。 */
  planMode?: 'workflow' | 'sections';
  /** 填写轮：只填指定步骤/章节的详细内容。 */
  fillTarget?: { kind: 'step' | 'section'; id: string; name: string };
}

/**
 * Per-phase compiler prompt（2026-08-23 刘总方案 v2）：每个阶段独立一轮对话，
 * 强制「先检索 → 再分析 → 后写入」；阶段内容由主进程验收门确定性把关。
 */
export function buildScenarioPhasePrompt(input: ScenarioPhasePromptInput): { system: string; user: string } {
  const catalog = input.definitions.map((definition) => ({ id: definition.id, kind: definition.kind, name: definition.name, description: definition.description }));
  const materials = (input.materialContext ?? []).map((material) => ({ name: material.name, text: material.text.slice(0, 60_000) }));
  const currentJson = JSON.stringify(input.current, null, 2);

  const PHASE_GOALS: Record<ScenarioPhase, string[]> = {
    basics: [
      'PHASE GOAL — 基本信息：write scenario.name (specific, not generic), scenario.description (what this scenario produces, for whom, at least 20 characters of real content), and scenario.capability.',
      'Research how scenarios/tasks of this kind are normally framed before writing.',
    ],
    deliverable: [
      'PHASE GOAL — 交付物结构：write deliverable.type (allowed enum only), deliverable.globalLength (STRING like "7500字", never a number), and deliverable.sections with stable ids, non-empty titles and per-section prompts.',
      'Research the standard structure of this deliverable type (e.g. grant/postdoc application sections) and mirror it.',
    ],
    workflow: [
      'PHASE GOAL — 连续工作流：add workflow steps in SMALL BATCHES of 1-2 steps per call (entries merge by id). Every step needs: stable unique id, concise name, dedicated prompt, array completionCriteria, dependsOn chain, maxTurns.',
      'For each step decide which Skills/MCPs it needs: bind existing catalog ids directly; source missing ones via market search + automatic install.',
      'Keep steps strictly serial and ordered as they should execute.',
    ],
    rules: [
      'PHASE GOAL — 场景规则：write a substantive scenarioMetis.markdown document (scenario-wide Metis.md rules: purpose, role boundaries, research rules, writing rules, quality gates, failure recovery — real content, never leave the template) AND workflowPrompt (end-to-end operating rules connecting all steps).',
      'Base the rules on what the workflow actually does and on conventions found during research.',
    ],
    output_plan: [
      'PHASE GOAL — 输出计划：write output.plan.primaryDeliverable (short title), supportingArtifacts, and concrete qualityCriteria (verifiable statements about the final deliverable quality).',
    ],
  };

  return {
    system: [
      'You are the METIS Research Harness compiler working through ONE specific build phase.',
      ...(input.planMode === 'workflow' ? ['MODE: PLANNING TURN (workflow outline).', PLANNING_TURN_DISCIPLINE] : []),
      ...(input.planMode === 'sections' ? ['MODE: PLANNING TURN (deliverable section outline).', PLANNING_TURN_DISCIPLINE] : []),
      ...(input.fillTarget ? ['MODE: FILL TURN.', fillTurnDiscipline(input.fillTarget.kind, input.fillTarget.id, input.fillTarget.name)] : []),
      ...(input.planMode || input.fillTarget ? [] : [ ...PHASE_GOALS[input.phase], RESEARCH_FIRST_POLICY, ACQUISITION_POLICY, TOOL_DISCIPLINE ]),
      'HARD SCHEMA RULES: completionCriteria MUST be an array of short strings. deliverable.globalLength MUST be a string. Never touch contractVersion/id/kind/revision/provenance. Only use IDs present in the resource catalog or returned by scenario_install_extension.',
      'Preserve previously written parts: your patches merge into the draft — do not delete or rewrite other phases\u2019 content.',
    ].join('\n'),
    user: [
      `User instruction (overall goal):\n${input.instruction}`,
      `Your current phase: ${input.phase}`,
      `Current normalized Scenario:\n${currentJson}`,
      `Installed resource catalog:\n${JSON.stringify(catalog, null, 2)}`,
      materials.length > 0 ? `Uploaded compiler context:\n${JSON.stringify(materials, null, 2)}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}
