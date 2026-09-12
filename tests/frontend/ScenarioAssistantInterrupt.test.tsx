/**
 * 3.8 发送→中断→继续（刘总 2026-09）：场景配置助手在编译期间必须提供
 * 真实可用的中断按钮——点击后调用 scenario:abort（按场景 ID 寻址），
 * 编译结算后按钮收起、用户可直接继续对话修改草稿。
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalizationDefinition, ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

function scenario(): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenario/research-paper',
    kind: 'scenario',
    name: '实证论文',
    description: '',
    enabled: true,
    tags: [],
    revision: 3,
    provenance: { origin: 'user', author: 'test', version: '1.0.0', license: null, sourceUrl: null, sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null, locallyModified: true, createdAt: 1, updatedAt: 1 },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [],
    fullAccess: { mode: 'full_access', perActionConfirmation: false, liveSteering: true, silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 4_000 },
    output: { format: 'markdown', schema: null, plan: { primaryDeliverable: '实证论文', supportingArtifacts: [], qualityCriteria: [] }, requireEvidenceEnvelope: false, includeIntegrityReport: false },
    triggerPhrases: [],
    capability: 'research',
    deliverable: {
      type: 'empirical_paper', language: 'zh', globalLength: '', secondarySections: { min: 2, max: 4 },
      structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
      sections: [],
    },
  } as ScenarioDefinition;
}

let resolveCompile: ((value: { ok: boolean; summary: string; scenario: ScenarioDefinition }) => void) | undefined;

function installMetis() {
  const abortScenarioCompile = vi.fn().mockResolvedValue({ ok: true, aborted: true });
  const metis = {
    // 首轮编译挂起，制造真实的「构建中」窗口。
    compileScenarioHarness: vi.fn().mockImplementation(() => new Promise<typeof resolveCompile extends ((value: infer V) => void) | undefined ? V : never>((resolve) => {
      resolveCompile = resolve;
    })),
    abortScenarioCompile,
    scenarioConversationUnits: vi.fn().mockResolvedValue([]),
    scenarioConversationCreate: vi.fn(),
    scenarioConversationDelete: vi.fn(),
    scenarioConversationMessages: vi.fn().mockResolvedValue([]),
    onScenarioStreamChunk: vi.fn().mockReturnValue(() => {}),
    onScenarioCompileEvent: vi.fn().mockReturnValue(() => {}),
  };
  window.metis = metis as unknown as typeof window.metis;
  return { abortScenarioCompile };
}

async function renderWorkbench(): Promise<void> {
  const current = scenario();
  const props = {
    zh: true,
    definitions: [current] as PersonalizationDefinition[],
    selectedId: current.id,
    onSelect: vi.fn(),
    save: vi.fn().mockImplementation(async (definition: PersonalizationDefinition) => ({
      ok: true, code: 'saved', definition: { ...definition, revision: definition.revision + 1 },
    })),
    createScenario: vi.fn(),
    onActivateScenario: vi.fn(),
    onDeleteScenario: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    projectId: 'project-1',
  };
  const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
  render(<ScenarioWorkbench {...props} />);
  await waitFor(() => expect(screen.getByTestId('sw-configuration-assistant')).toBeTruthy());
}

describe('ScenarioConfigurationAssistant interrupt (3.8)', () => {
  beforeEach(() => {
    window.metis = undefined;
    resolveCompile = undefined;
  });

  it('interrupts the in-flight build through scenario:abort and returns to an editable state', async () => {
    const { abortScenarioCompile } = installMetis();
    await renderWorkbench();

    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '帮我构建一个实证研究场景' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));
    await waitFor(() => expect(screen.getByTestId('sw-assistant-interrupt')).toBeTruthy());

    fireEvent.click(screen.getByTestId('sw-assistant-interrupt'));
    await waitFor(() => expect(abortScenarioCompile).toHaveBeenCalledWith('user:scenario/research-paper'));

    // 编译以「被中断」结算：助手回到可输入状态（继续 = 直接下一轮对话）。
    resolveCompile?.({ ok: false, summary: '已按您的请求中断本轮场景构建；已生成内容已保留为草稿。', scenario: scenario() });
    await waitFor(() => expect(screen.queryByTestId('sw-assistant-interrupt')).toBeNull());
    const composer = screen.getByTestId('sw-assistant-input') as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
  });
});
