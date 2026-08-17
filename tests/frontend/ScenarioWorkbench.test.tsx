/**
 * ScenarioWorkbench — 场景工作台组件测试（场景重构 P2）。
 * 覆盖：五分区导航、成果结构树编辑（增删锁、右栏上下文编辑）、
 * 自适应开关落草稿、保存调用、AI 精简调用、使用场景入口。
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalizationDefinition, ScenarioDefinition } from '../../src/../engine/runtime/PersonalizationRuntimeContract.js';

function makeScenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenario/emp',
    kind: 'scenario',
    name: 'CSSCI 实证论文',
    description: '实证研究场景',
    enabled: true,
    tags: [],
    revision: 3,
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
    deliverable: {
      type: 'empirical_paper',
      typeLabel: '实证论文',
      globalLength: '10000-12000 字',
      structurePolicy: { defaultSections: 5, suggestedMin: 4, suggestedMax: 7 },
      sections: [
        { id: 'title', title: '题目', kind: 'title', status: 'locked' },
        { id: 'c3', title: '3 研究设计', kind: 'chapter', status: 'required', purpose: '识别策略', requirements: ['数据来源'] },
      ],
    },
    adaptivity: {
      structure: { addSections: false, deleteUnlockedSections: false, splitSections: false, mergeSections: false, reorderSections: false, adjustLength: false },
      content: { reviseQuestion: false, addQuestion: false, reviseHypothesis: false, dropUnsupportedHypothesis: false, adjustFramework: false },
      method: { addMethod: false, replaceUnsuitableMethod: false, addRobustness: false, addHeterogeneity: false, addMechanism: false },
      allowedBacktracks: [],
      majorAdjustmentTriggers: [],
    },
    writingRules: ['摘要禁止出现本文'],
    materials: [{ id: 'mat-1', name: '投稿指南.pdf', kind: 'guide', analyzedAt: 1, insights: { structureRules: ['五章'], writingPrinciples: [], methodSuggestions: [], hardRequirements: ['引用可查'] } }],
    ...overrides,
  } as ScenarioDefinition;
}

function makeHarness(overrides: Partial<Parameters<typeof import('../../src/personalization/ScenarioWorkbench.js').default>[0]> = {}) {
  const scenario = makeScenario();
  const save = vi.fn().mockResolvedValue({ ok: true, definition: scenario });
  const reload = vi.fn().mockResolvedValue(undefined);
  const onActivateScenario = vi.fn();
  const onDeleteScenario = vi.fn();
  const props = {
    zh: true,
    definitions: [scenario as PersonalizationDefinition],
    selectedId: scenario.id,
    onSelect: vi.fn(),
    save,
    createScenario: vi.fn(),
    onActivateScenario,
    onDeleteScenario,
    reload,
    onOpenAiCreate: vi.fn(),
    ...overrides,
  };
  return { props, save, reload, onActivateScenario, onDeleteScenario, scenario };
}

describe('ScenarioWorkbench', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('五分区导航齐全且可切换', async () => {
    const { props } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    for (const label of ['总览', '成果结构', '规则与方法', '自适应', '能力与运行']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByTestId('sw-tab-adapt'));
    expect(screen.getByTestId('sw-adapt')).toBeTruthy();
  });

  it('成果结构树：点击章节 → 右栏编辑该部分规则并反映修改', async () => {
    const { props, save } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    fireEvent.click(screen.getByTestId('sw-tab-structure'));
    fireEvent.click(screen.getAllByTestId('sw-tree-row')[1]!);
    expect(screen.getByDisplayValue('识别策略')).toBeTruthy();
    const purpose = screen.getByDisplayValue('识别策略');
    fireEvent.change(purpose, { target: { value: '交代识别策略与稳健性' } });
    fireEvent.click(screen.getByTestId('sw-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0] as ScenarioDefinition;
    expect(saved.deliverable?.sections?.[1]?.purpose).toBe('交代识别策略与稳健性');
  });

  it('新增部分进入结构树；锁定部分不可删除', async () => {
    const { props } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    fireEvent.click(screen.getByTestId('sw-tab-structure'));
    const before = screen.getAllByTestId('sw-tree-row').length;
    fireEvent.click(screen.getByTestId('sw-add-section'));
    expect(screen.getAllByTestId('sw-tree-row').length).toBe(before + 1);
    // 锁定题目行：其删除按钮 disabled
    const lockedRow = screen.getAllByTestId('sw-tree-row')[0]!.closest('li')!;
    const deleteButton = lockedRow.querySelectorAll('button[title*="删除"]')[0] as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
  });

  it('自适应开关落入草稿并随保存提交', async () => {
    const { props, save } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    fireEvent.click(screen.getByTestId('sw-tab-adapt'));
    fireEvent.click(screen.getByTestId('sw-adapt-structure-addSections'));
    fireEvent.click(screen.getByTestId('sw-adapt-method-addRobustness'));
    fireEvent.click(screen.getByTestId('sw-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0] as ScenarioDefinition;
    expect(saved.adaptivity?.structure.addSections).toBe(true);
    expect(saved.adaptivity?.method.addRobustness).toBe(true);
    expect(saved.adaptivity?.content.reviseQuestion).toBe(false);
  });

  it('AI 精简：指令传入服务并把补丁应用到选中章节', async () => {
    const refine = vi.fn().mockResolvedValue({
      ok: true,
      patch: { purpose: 'AI 补全的作用', requirements: ['AI 要求 1'], forbidden: ['AI 禁止 1'] },
    });
    window.metis = { refineScenarioConfig: refine } as unknown as typeof window.metis;
    const { props } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    fireEvent.click(screen.getByTestId('sw-tab-structure'));
    fireEvent.click(screen.getAllByTestId('sw-tree-row')[1]!);
    fireEvent.change(screen.getByTestId('sw-ai-refine-input'), { target: { value: '按顶刊标准完善' } });
    fireEvent.click(screen.getByTestId('sw-ai-refine-run'));
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1));
    expect(refine.mock.calls[0]![0]).toMatchObject({ targetKind: 'section', targetTitle: '3 研究设计' });
    await waitFor(() => expect(screen.getByDisplayValue('AI 补全的作用')).toBeTruthy());
  });

  it('使用场景（当前项目）触发激活回调', async () => {
    // 无智能体场景会禁用「使用此场景」按钮，因此夹具绑定一个智能体。
    const bound = makeScenario({ agentIds: ['user:agent/emp'] });
    const { props, onActivateScenario } = makeHarness({ definitions: [bound as PersonalizationDefinition], selectedId: bound.id });
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    fireEvent.click(screen.getByTestId('sw-use'));
    fireEvent.click(screen.getByTestId('sw-use-menu').querySelector('button')!);
    expect(onActivateScenario).toHaveBeenCalledWith('user:scenario/emp');
  });

  it('左栏分类树与收藏入口存在', async () => {
    const { props } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    expect(screen.getByTestId('sw-ai-create')).toBeTruthy();
    expect(screen.getByTestId('sw-new-scenario')).toBeTruthy();
    expect(screen.getAllByTestId('sw-scenario-item').length).toBe(1);
  });

  it('删除场景：确认后调用 onDeleteScenario 并清选中', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { props, onDeleteScenario, scenario } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    // 头部删除按钮（选中场景时渲染）
    fireEvent.click(screen.getByTestId('sw-delete'));
    expect(onDeleteScenario).toHaveBeenCalledWith(scenario.id);
    expect(props.onSelect).toHaveBeenCalledWith(null);
    vi.restoreAllMocks();
  });

  it('删除场景：取消确认则不删除', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { props, onDeleteScenario } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    fireEvent.click(screen.getByTestId('sw-delete'));
    expect(onDeleteScenario).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('左栏场景项有删除按钮', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { props, onDeleteScenario, scenario } = makeHarness();
    const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
    render(<ScenarioWorkbench {...props} />);
    const delButtons = screen.getAllByTestId('sw-scenario-delete');
    expect(delButtons.length).toBe(1);
    fireEvent.click(delButtons[0]!);
    expect(onDeleteScenario).toHaveBeenCalledWith(scenario.id);
    vi.restoreAllMocks();
  });
});
