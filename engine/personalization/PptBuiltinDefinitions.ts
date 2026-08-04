/**
 * Built-in PPT scenario definition (Metis + OfficeCli).
 *
 * The scenario is seeded into the personalization repository on first launch.
 * The agent systemPrompt is intentionally left as a placeholder — the user
 * (research domain expert) writes the actual prompt that controls how the AI
 * generates academic PPT content via OfficeCli.
 */

import type { AgentDefinition, ScenarioDefinition, PersonalizationDefinition } from '../runtime/PersonalizationRuntimeContract.js';

const SEED_TIME = 1_780_000_000_000;

const PPT_AGENT_ID = 'builtin:agents/officecli-ppt';
const PPT_SCENARIO_ID = 'builtin:scenarios/officecli-ppt';

const provenance = {
  origin: 'builtin' as const,
  author: 'Metis',
  version: '1.0.0',
  license: 'Apache-2.0',
  sourceUrl: null,
  sourceRevision: null,
  installedDigest: null,
  parentId: null,
  parentVersion: null,
  locallyModified: false,
  createdAt: SEED_TIME,
  updatedAt: SEED_TIME,
};

/** TODO(刘总填写): 替换为实际的学术 PPT 生成提示词。 */
export const PPT_AGENT_SYSTEM_PROMPT_PLACEHOLDER = [
  '# 学术演示文稿生成（提示词占位 — 请替换）',
  '',
  '你是学术演示文稿生成助手。你通过 OfficeCli 工具创建和编辑 PowerPoint 文件。',
  '',
  '【请在此处填写完整的系统提示词，包括：】',
  '- 每页幻灯片的结构规范（标题页/目录/方法/结果/讨论/结论/参考文献）',
  '- 文字密度限制（每页不超过 N 字 / N 行）',
  '- 配色与字体规范（主题色、标题字体、正文字体）',
  '- 图表与表格的呈现规则',
  '- 引用格式',
  '- 元素布局约束（元素不得重叠）',
  '',
  '这段提示词控制 AI 如何理解用户需求并生成 PPT 内容。',
].join('\n');

/** The PPT agent that executes the scenario workflow. */
export function buildPptAgent(): AgentDefinition {
  return {
    contractVersion: 1,
    id: PPT_AGENT_ID,
    kind: 'agent',
    name: '演示文稿生成',
    description: '通过 OfficeCli 创建学术 PowerPoint 演示文稿。用户可在个人化中心编辑提示词。',
    enabled: true,
    tags: ['ppt', 'presentation', 'officecli'],
    revision: 1,
    provenance,
    role: 'presentation',
    systemPrompt: PPT_AGENT_SYSTEM_PROMPT_PLACEHOLDER,
    modelPreference: null,
    toolIds: [],
    mcpIds: [],
    skillIds: [],
    memory: {
      scope: 'session',
      retainDecisions: true,
      retainArtifacts: false,
      maxSummaryChars: 10_000,
    },
    output: {
      format: 'artifact_bundle',
      schema: null,
      requireEvidenceEnvelope: false,
      includeIntegrityReport: false,
    },
    maxTurns: 30,
    retryLimit: 2,
  };
}

/** The PPT scenario — triggered by phrases like "做个PPT" in the chat. */
export function buildPptScenario(): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: PPT_SCENARIO_ID,
    kind: 'scenario',
    name: '制作演示文稿',
    description: '根据用户需求，通过 OfficeCli 生成学术 PowerPoint 演示文稿。需要先在个人化中心填写 Agent 提示词。',
    enabled: false,
    tags: ['ppt', 'presentation', 'officecli'],
    revision: 1,
    provenance,
    agentIds: [PPT_AGENT_ID],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [
      {
        id: 'generate',
        name: '生成演示文稿',
        description: '理解用户需求，通过 OfficeCli 创建 PPT、设置主题、逐页添加内容。',
        agentId: PPT_AGENT_ID,
        skillIds: [],
        toolIds: [],
        mcpIds: [],
        dependsOn: [],
        maxTurns: 30,
      },
    ],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: false,
      rollbackOnFailure: false,
      persistAcrossRestart: false,
    },
    memory: {
      scope: 'session',
      retainDecisions: true,
      retainArtifacts: true,
      maxSummaryChars: 10_000,
    },
    output: {
      format: 'artifact_bundle',
      schema: null,
      requireEvidenceEnvelope: false,
      includeIntegrityReport: false,
    },
    triggerPhrases: [
      '做个PPT',
      '做幻灯片',
      '制作演示文稿',
      '生成PPT',
      'make ppt',
      'create presentation',
      'create slides',
      'powerpoint',
    ],
    capability: 'presentation_reserved',
  };
}

/** All builtin PPT definitions for seeding. */
export function buildPptBuiltinDefinitions(): PersonalizationDefinition[] {
  return [buildPptAgent(), buildPptScenario()];
}
