/**
 * App component tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen, within, act } from '@testing-library/react';
import App from '../../src/App';
import { useMetisStore } from '../../src/store';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';
import { setDiagnosticMode } from '../../engine/capabilities/DiagnosticMode';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions';

const builtinPersonalization = buildBuiltinPersonalizationDefinitions();

function editableAppSkill(): Extract<PersonalizationDefinition, { kind: 'skill' }> {
  const source = builtinPersonalization.find((item) => item.kind === 'skill')!;
  return {
    ...structuredClone(source),
    id: 'user:skills/app-navigation-draft',
    name: 'App navigation skill',
    description: '',
    revision: 1,
    provenance: {
      ...source.provenance,
      origin: 'user',
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: source.id,
      locallyModified: true,
    },
  };
}

function resetStore() {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
    locale: 'zh',
    theme: 'light',
    isHydrated: true,
  });
}

function setMockMetis(overrides?: Partial<MetisAPI>) {
  const api: Partial<MetisAPI> = {
    listHITLRules: vi.fn().mockResolvedValue([]),
    toggleHITLRule: vi.fn().mockResolvedValue({ success: true }),
    getPendingApprovals: vi.fn().mockResolvedValue([]),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    onApprovalRequired: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
  (window as Window).metis = api as MetisAPI;
}

function clearMockMetis() {
  (window as Window).metis = undefined;
}

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
});

describe('App', () => {
  beforeEach(() => {
    setDiagnosticMode('normal');
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    clearMockMetis();
    setDiagnosticMode('normal');
  });

  it('opens global search from the slash-command bus event', async () => {
    resetStore();
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });
    window.dispatchEvent(new CustomEvent('metis:open-search'));
    expect(await screen.findByPlaceholderText(/搜索|Search/)).toBeTruthy();
  });

  it('renders the fine top navigation with workspaces, research runs, and destinations', async () => {
    resetStore();
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });
    const nav = screen.getByRole('navigation', { name: 'Metis' });
    const primaryItems = within(nav).getAllByRole('button').filter((button) => button.hasAttribute('data-nav-id'));

    expect(primaryItems.map((button) => button.getAttribute('data-nav-id'))).toEqual([
      'converse',
      'projects',
      'topics',
      'outcomes',
      'submissions',
      'settings',
      'personalization',
    ]);
    expect(primaryItems.map((button) => button.textContent?.trim())).toEqual([
      '协同对话',
      '科研项目',
      '选题',
      '成果',
      '投稿',
      '设置',
      '场景',
    ]);
    expect(primaryItems.map((button) => button.getAttribute('aria-label'))).toEqual([
      '协同对话',
      '科研项目',
      '选题',
      '成果',
      '投稿',
      '设置',
      '场景',
    ]);
    // O11: top-bar tooltips now carry a one-line workspace orientation
    // (descriptionKey) instead of repeating the label. aria-label still holds
    // the plain label for accessibility; title holds the description.
    expect(primaryItems.map((button) => button.getAttribute('title'))).toEqual([
      '与其他 AI（豆包/Kimi/GLM/ChatGPT/Claude/DeepSeek）分屏协同：左边交流思路，右边让 Metis 干活。',
      '科研项目工作台：左侧项目列表，内含聊天、任务看板、资料与研究成果。',
      '从一个研究兴趣出发:真实检索、研究版图、候选论证,确定选题后一路进入场景与项目',
      '管理当前项目的论文、PPT、报告与其他正式交付物。',
      '从成果出发完成选刊、投稿、返修到录用的完整投稿生命周期。',
      '配置模型连接、外观、备份与偏好。',
      '场景中心、个性化偏好与外观定制。',
    ]);
    expect(primaryItems[0]!.getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByText('评估')).toBeNull();

    await act(async () => {
      useMetisStore.setState({ locale: 'en' });
      await Promise.resolve();
    });
    expect(primaryItems.map((button) => button.getAttribute('aria-label'))).toEqual([
      'AI Collab',
      'Research Projects',
      'Topic Selection',
      'Outcomes',
      'Submissions',
      'Settings',
      'Scenarios',
    ]);
  });

  it('opens the scenario center from the top-bar entry beside settings', async () => {
    resetStore();
    setMockMetis({
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
    });
    render(<App />);
    const trigger = await screen.findByTestId('personalization-trigger');
    expect(trigger.getAttribute('data-nav-id')).toBe('personalization');
    expect(trigger.className).toContain('topbar-nav__item');
    fireEvent.click(trigger);
    expect(await screen.findByTestId('scenario-workbench')).toBeDefined();
    expect(screen.queryByText('自动真实性层始终强制执行')).toBeNull();
  });

  it('restores an automatic personalization draft after leaving through the app sidebar', async () => {
    resetStore();
    const skill = editableAppSkill();
    const definitions: PersonalizationDefinition[] = [skill];
    const listPersonalization = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions }));
    setMockMetis({ listPersonalization });

    render(<App />);
    fireEvent.click(await screen.findByTestId('personalization-trigger'));
    fireEvent.click(await screen.findByRole('button', { name: /^技能/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${skill.id}"]`) as HTMLButtonElement);
    const description = await screen.findByRole('textbox', { name: '说明' });
    fireEvent.change(description, { target: { value: '从应用侧栏返回后仍在的草稿' } });
    expect(await screen.findByText('草稿已自动保留')).toBeDefined();

    fireEvent.click(document.querySelector('[data-nav-id="settings"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByRole('heading', { name: '场景' })).toBeNull());
    const callsBeforeReturn = listPersonalization.mock.calls.length;

    fireEvent.click(screen.getByTestId('personalization-trigger'));
    fireEvent.click(await screen.findByRole('button', { name: /^技能/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${skill.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('从应用侧栏返回后仍在的草稿')).toBeDefined();
    expect(screen.getByText('已恢复保留的草稿')).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: skill.name }),
    ));
    expect(listPersonalization.mock.calls.length).toBeGreaterThan(callsBeforeReturn);
  });

  it('composes converse mode as the AI-collab split view with the Metis chat embedded', async () => {
    resetStore();
    const { container } = render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    // 协同对话：左侧第三方 AI 嵌入区 + 右侧 Metis 对话。
    expect(await screen.findByTestId('collab-page')).toBeTruthy();
    expect(container.querySelectorAll('.project-shell')).toHaveLength(0);
    expect(screen.getByTestId('collab-host')).toBeTruthy();
    expect(container.querySelectorAll('.chat-main')).toHaveLength(1);
    expect(container.querySelector('.collab-metis__chat > .chat-main')).not.toBeNull();
    // 第三方 AI 站点页签齐全。
    for (const id of ['doubao', 'kimi', 'glm', 'chatgpt', 'claude', 'deepseek']) {
      expect(screen.getByTestId(`collab-ai-${id}`)).toBeTruthy();
    }
    // 会话列表与任务面板以抽屉形式存在，默认收起。
    expect(screen.queryByTestId('collab-sessions-drawer')).toBeNull();
    expect(screen.queryByTestId('collab-panel-drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('collab-toggle-sessions'));
    expect(await screen.findByTestId('collab-sessions-drawer')).toBeTruthy();
    expect(container.querySelectorAll('.chat-sidebar')).toHaveLength(1);
  });

  it('routes the visible research destination to Outcomes, not the removed autonomous page', async () => {
    resetStore();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '成果' }));
    expect(await screen.findByText('成果属于科研项目')).toBeDefined();
    expect(screen.queryByText('自主科研')).toBeNull();
  });

  it('keeps native embedded views behind an IPC-driven scenario approval modal and restores the active collab pane after it closes', async () => {
    resetStore();
    const listeners = new Set<(payload: {
      requestId: string;
      hookId: string;
      stepId: string;
      instruction: string;
      runId: string;
    }) => void>();
    const collabHide = vi.fn().mockResolvedValue({ ok: true });
    const browserHide = vi.fn().mockResolvedValue({ ok: true });
    const collabShow = vi.fn().mockResolvedValue({ ok: true });
    const respondScenarioApproval = vi.fn().mockResolvedValue(undefined);
    const onScenarioApprovalRequired = vi.fn((listener: (payload: {
      requestId: string;
      hookId: string;
      stepId: string;
      instruction: string;
      runId: string;
    }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    setMockMetis({
      collabHide,
      browserHide,
      collabShow,
      respondScenarioApproval,
      onScenarioApprovalRequired,
    });
    const originalResizeObserver = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });

    try {
      render(<App />);
      await screen.findByTestId('collab-page');
      await waitFor(() => expect(onScenarioApprovalRequired.mock.calls.length).toBeGreaterThanOrEqual(2));
      // Wait for CollabPage's effect to have attached its restore listener;
      // the page itself publishes its initial bounds asynchronously.
      await waitFor(() => expect(collabShow).toHaveBeenCalled());
      vi.spyOn(screen.getByTestId('collab-host'), 'getBoundingClientRect').mockReturnValue({
        x: 24,
        y: 56,
        top: 56,
        left: 24,
        right: 664,
        bottom: 536,
        width: 640,
        height: 480,
        toJSON: () => ({}),
      } as DOMRect);
      collabHide.mockClear();
      browserHide.mockClear();
      collabShow.mockClear();

      act(() => {
        for (const listener of listeners) {
          listener({
            requestId: 'scenario-approval-1',
            hookId: 'hook-1',
            stepId: 'step-1',
            instruction: '确认执行本步骤',
            runId: 'run-1',
          });
        }
      });

      expect(await screen.findByTestId('scenario-approval-dialog')).toBeDefined();
      await waitFor(() => {
        expect(collabHide).toHaveBeenCalled();
        expect(browserHide).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByTestId('scenario-approval-approve'));
      await waitFor(() => expect(respondScenarioApproval).toHaveBeenCalledWith('scenario-approval-1', true));
      await waitFor(() => expect(screen.queryByTestId('scenario-approval-dialog')).toBeNull());
      expect(document.querySelector('[aria-modal="true"]')).toBeNull();
      await waitFor(() => expect(collabShow).toHaveBeenCalled());
    } finally {
      if (originalResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalResizeObserver });
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
  });

  it('navigates from a board goal card to the conversation with a focused goal card', async () => {
    resetStore();
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    setMockMetis({
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      getGoal: vi.fn().mockResolvedValue({
        success: true,
        goal: { goalId: 'g1', label: '从看板来的任务', status: 'completed', createdAt: 1 },
      }),
      appendMessage,
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    window.dispatchEvent(new CustomEvent('metis:open-goal', { detail: { goalId: 'g1' } }));

    // The conversation is the active workspace and an inline goal card is
    // inserted for the handed-off task.
    await waitFor(() => {
      const nav = screen.getByRole('navigation', { name: 'Metis' });
      const active = within(nav).getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page');
      expect(active?.getAttribute('data-nav-id')).toBe('converse');
    });
    expect(await screen.findByText('从看板来的任务')).toBeDefined();
    expect(screen.getByText('研究任务已完成')).toBeDefined();
    // The sessionStorage fallback is consumed, not left dangling.
    expect(window.sessionStorage.getItem('metis-pending-goal')).toBeNull();
    // The card is persisted into the session history like a /goal card.
    expect(appendMessage).toHaveBeenCalledWith(expect.anything(), 'goal', expect.stringContaining('__GOAL_CARD__'));
  });

  it('refreshes a chat goal card when the engine broadcasts goal:changed', async () => {
    resetStore();
    let changedHandler: ((data: unknown) => void) | undefined;
    setMockMetis({
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      getGoal: vi.fn().mockResolvedValue({
        success: true,
        goal: { goalId: 'g1', label: '状态会变的任务', status: 'ready', createdAt: 1 },
      }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      onGoalChanged: vi.fn((callback: (data: unknown) => void) => {
        changedHandler = callback;
        return () => {};
      }),
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });
    window.dispatchEvent(new CustomEvent('metis:open-goal', { detail: { goalId: 'g1' } }));
    expect(await screen.findByText('状态会变的任务')).toBeDefined();

    // A board move to completed broadcasts goal:changed; the card follows.
    await act(async () => {
      changedHandler?.({ goalId: 'g1', label: '状态会变的任务', status: 'completed', createdAt: 1 });
    });
    await waitFor(() => expect(screen.getByText('研究任务已完成')).toBeDefined());
  });

  it('navigates from a chat goal card to the task board and focuses the handed-off card', async () => {
    resetStore();
    setMockMetis({
      listGoals: vi.fn().mockResolvedValue({
        success: true,
        goals: [{ goalId: 'g1', label: '去看板的任务', status: 'ready', createdAt: 1 }],
      }),
      onGoalChanged: vi.fn().mockReturnValue(() => {}),
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    window.dispatchEvent(new CustomEvent('metis:open-kanban', { detail: { goalId: 'g1' } }));

    expect(await screen.findByTestId('kanban-board')).toBeTruthy();
    // The handed-off card is selected (detail dialog open) and scrolled to.
    await waitFor(() => {
      expect(screen.getByTestId('kanban-detail')?.getAttribute('aria-label')).toBe('去看板的任务');
    });
    expect(window.sessionStorage.getItem('metis-pending-goal-focus')).toBeNull();
  });

  it('opens the project center from a library paper link (metis:open-project)', async () => {
    resetStore();
    setMockMetis({
      researchListProjects: vi.fn().mockResolvedValue({
        success: true,
        items: [{
          entityKind: 'project',
          value: {
            id: 'proj-1',
            title: '测试项目',
            originalIntent: '',
            researchQuestion: '',
            lifecycle: 'draft',
            methodology: '',
            discipline: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archivedAt: null,
            version: 1,
            deletedAt: null,
          },
        }],
      }),
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    window.dispatchEvent(new CustomEvent('metis:open-project', {
      detail: { projectId: 'proj-1', section: 'sources' },
    }));

    await waitFor(() => {
      const nav = screen.getByRole('navigation', { name: 'Metis' });
      const active = within(nav).getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page');
      expect(active?.getAttribute('data-nav-id')).toBe('projects');
    });
    expect(researchWorkspaceStore.getState().activeProjectId).toBe('proj-1');
    await waitFor(() => {
      expect(researchWorkspaceStore.getState().activeSection).toBe('sources');
    });

    window.dispatchEvent(new CustomEvent('metis:open-project', {
      detail: { projectId: 'proj-1', section: 'artifacts' },
    }));
    await waitFor(() => {
      expect(researchWorkspaceStore.getState().activeSection).toBe('artifacts');
    });
    // 研究成果页签已删除（2026-08-31 刘总要求）：open-project 事件只落到
    // 研究写作工作台的 artifacts 分区，不再有科研项目页签激活。
  });

  it('opens a library paper detail from a project source (metis:open-paper)', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [{
        id: 'paper-9',
        title: '项目来源跳转论文',
        authors: [],
        year: 2024,
        venue: '',
        abstract: '',
        tags: [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        referenceIds: [],
        addedAt: Date.now(),
        projectId: 'proj-1',
      }],
    });
    setMockMetis({});
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    window.dispatchEvent(new CustomEvent('metis:open-paper', { detail: { paperId: 'paper-9' } }));

    await waitFor(() => {
      expect(document.querySelector('.library-page')).toBeTruthy();
    });
    // open-paper 落在科研项目工作台的「资料」模式页签。
    const materialsTab = document.querySelector('[data-testid="projects-mode-materials"]');
    expect(materialsTab?.getAttribute('aria-selected')).toBe('true');
    expect(useMetisStore.getState().selectedPaperId).toBe('paper-9');
  });

  it('opens the scenario center from the managed MCP installer entry', async () => {
    resetStore();
    setMockMetis({
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    window.dispatchEvent(new CustomEvent('metis:open-mcp-installer'));

    expect(await screen.findByTestId('scenario-workbench')).toBeDefined();
  });

  it('keeps the Metis chat draft while toggling collab drawers and external pane', async () => {
    resetStore();
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    const input = screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '协同分屏下保留的草稿' } });

    // 展开/收起会话抽屉与面板，草稿不丢。
    fireEvent.click(screen.getByTestId('collab-toggle-sessions'));
    expect(await screen.findByTestId('collab-sessions-drawer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('collab-toggle-panel'));
    expect(await screen.findByTestId('collab-panel-drawer')).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement).value,
    ).toBe('协同分屏下保留的草稿');

    // 收起第三方 AI 分屏再展开，草稿仍在。
    fireEvent.click(screen.getByTestId('collab-hide-external'));
    expect(screen.queryByTestId('collab-host')).toBeNull();
    fireEvent.click(await screen.findByTestId('collab-show-external'));
    expect(await screen.findByTestId('collab-host')).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement).value,
    ).toBe('协同分屏下保留的草稿');
  });

  it('switches between conversation and the project center from the fine top navigation', async () => {
    resetStore();
    const { container } = render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    const labels = ['协同对话', '科研项目'];
    const modeButtons = screen.getAllByRole('button').filter((button) => ['converse', 'projects'].includes(button.getAttribute('data-nav-id') ?? ''));
    expect(modeButtons.map((button) => button.textContent)).toEqual(labels);

    fireEvent.click(screen.getByRole('button', { name: '科研项目' }));
    await waitFor(() => expect(screen.getByTestId('projects-page')).toBeTruthy());
    expect(container.querySelectorAll('.project-shell')).toHaveLength(0);

    // 科研项目工作台内的模式页签可切换（任务看板）。
    fireEvent.click(screen.getByTestId('projects-mode-kanban'));
    await waitFor(() => expect(screen.getByTestId('kanban-board')).toBeTruthy());
    expect(container.querySelectorAll('.project-shell')).toHaveLength(0);

    // 回到协同对话。
    fireEvent.click(screen.getByRole('button', { name: '协同对话' }));
    await waitFor(() => expect(screen.getByTestId('collab-page')).toBeTruthy());
  });

  it('preserves the ChatPage draft across project-center modes and the conversation workspace', async () => {
    resetStore();
    const { container } = render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    const input = screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '跨模式保留的研究草稿' } });

    // 进入科研项目工作台（默认聊天模式）——同一 ChatPage 实例保持挂载。
    fireEvent.click(screen.getByRole('button', { name: '科研项目' }));
    await waitFor(() => expect(screen.getByTestId('projects-page')).toBeTruthy());
    expect(container.querySelectorAll('.project-shell')).toHaveLength(0);
    expect(
      (screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement).value,
    ).toBe('跨模式保留的研究草稿');

    // 切到任务看板再切回聊天，草稿仍在。
    fireEvent.click(screen.getByTestId('projects-mode-kanban'));
    await waitFor(() => expect(screen.getByTestId('kanban-board')).toBeTruthy());
    fireEvent.click(screen.getByTestId('projects-mode-chat'));
    await waitFor(() => expect(screen.getByTestId('projects-page')).toBeTruthy());
    expect(
      (screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement).value,
    ).toBe('跨模式保留的研究草稿');

    // 返回协同对话，草稿依旧保留。
    fireEvent.click(screen.getByRole('button', { name: '协同对话' }));
    await waitFor(() => expect(screen.getByTestId('collab-page')).toBeTruthy());
    expect(
      (screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement).value,
    ).toBe('跨模式保留的研究草稿');
  });

  it.each([
    ['dashboard', '.stat-grid'],
    ['goal', '.goal-page'],
    ['timeline', '.timeline-filters'],
    ['experiments', '.experiments-page'],
  ] as const)('renders the implemented %s destination instead of collapsing it to a workspace mode', async (initialPage, selector) => {
    resetStore();
    const { container } = render(<App initialPage={initialPage} />);
    await waitFor(() => expect(container.querySelector(selector)).toBeTruthy());
  });

  it('renders the implemented LaTeX destination instead of collapsing it to Notes', async () => {
    resetStore();
    render(<App initialPage="latex" />);
    expect(await screen.findByText('LaTeX 编辑器')).toBeTruthy();
  });

  it('top bar never shows an unread-papers badge (feature removed)', () => {
    resetStore();
    useMetisStore.setState({
      papers: [
        { id: 'p1', title: 'Unread', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: Date.now() },
        { id: 'p2', title: 'Read', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'read', rating: 0, referenceIds: [], addedAt: Date.now() },
      ],
    });
    const { container } = render(<App initialPage="dashboard" />);
    expect(container.querySelector('.topbar-nav__badge')).toBeNull();
  });

  it('does not show unread badge when there are no unread papers', () => {
    resetStore();
    useMetisStore.setState({
      papers: [
        { id: 'p1', title: 'Read', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'read', rating: 0, referenceIds: [], addedAt: Date.now() },
      ],
    });
    const { container } = render(<App initialPage="dashboard" />);
    expect(container.querySelector('.topbar-nav__badge')).toBeNull();
  });

  /** 高频设置保留主页；备份/云同步/ISSN/令牌/诊断在「高级设置」二级弹窗（2026-08-23 精简版布局）。 */
  const openAdvancedTab = async (tab: 'backup' | 'cloudSync' | 'issn' | 'tokens' | 'diagnostics'): Promise<HTMLElement> => {
    fireEvent.click(screen.getByTestId('advanced-settings-button'));
    const dialog = await screen.findByRole('dialog', { name: '高级设置' });
    const labels: Record<string, string> = {
      backup: '数据备份',
      cloudSync: '云备份 (WebDAV)',
      issn: '核心期刊白名单',
      tokens: '市场 / 集成令牌',
      diagnostics: '开发者诊断',
    };
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: labels[tab] })); });
    return dialog;
  };

  it('settings page renders data backup section without technical controls in normal mode', async () => {
    resetStore();
    localStorage.removeItem('metis-diagnostic-mode');
    const { container } = render(<App initialPage="settings" />);
    // 主页不直接渲染备份区；入口为「高级设置」按钮。
    expect(container.querySelector('[data-testid="export-backup"]')).toBeNull();
    expect(screen.getByTestId('advanced-settings-button')).toBeTruthy();
    expect(screen.getByTestId('diagnostic-mode-toggle')).toBeTruthy();
    await openAdvancedTab('backup');
    expect(container.querySelector('[data-testid="export-backup"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="import-backup"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="backup-file-input"]')).toBeTruthy();
    expect(screen.queryByText('MCP 服务器')).toBeNull();
    expect(screen.queryByText('人工审批规则')).toBeNull();
    expect(container.querySelector('[data-testid="diagnostic-mcp-settings"]')).toBeNull();
    expect(container.querySelector('[data-testid="diagnostic-hitl-settings"]')).toBeNull();
    expect(container.querySelector('.app-layout')?.getAttribute('data-ui-mode')).toBe('normal');
  });

  it('reveals technical settings only after developer diagnostics is enabled', async () => {
    resetStore();
    localStorage.removeItem('metis-diagnostic-mode');
    const { container } = render(<App initialPage="settings" />);

    fireEvent.click(screen.getByTestId('diagnostic-mode-toggle'));

    await waitFor(() => {
      expect(container.querySelector('[data-testid="diagnostic-mode-toggle"]')).toBeTruthy();
      expect(localStorage.getItem('metis-diagnostic-mode')).toBe('diagnostic');
    });
    // 技术控制项位于高级设置的开发者诊断页签。
    await openAdvancedTab('diagnostics');
    expect(screen.getByText('MCP 服务器')).toBeTruthy();
    expect(screen.getByText('人工审批规则')).toBeTruthy();
    expect(container.querySelector('[data-testid="diagnostic-mcp-settings"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="diagnostic-hitl-settings"]')).toBeTruthy();
    expect(container.querySelector('.app-layout')?.getAttribute('data-ui-mode')).toBe('diagnostic');
  });

  it('updates chat technical controls reactively when developer diagnostics changes', async () => {
    resetStore();
    const listSkills = vi.fn().mockResolvedValue([{
      id: 'diagnostic-skill',
      name: 'Diagnostic Skill',
      description: 'Developer only',
      category: 'diagnostic',
      systemPrompt: '',
    }]);
    setMockMetis({
      listSessions: vi.fn().mockResolvedValue([]),
      listSkills,
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
    });

    await act(async () => { render(<App initialPage="settings" />); });
    await act(async () => { fireEvent.click(screen.getByTestId('diagnostic-mode-toggle')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '协同对话' })); });

    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(await screen.findByText('技能：')).toBeTruthy();
    expect(screen.getByTestId('diagnostic-skill-controls')).toBeTruthy();
    expect(screen.getByTestId('diagnostic-terminal-toggle')).toBeTruthy();
    expect(screen.getByTitle('切换终端')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    await act(async () => { fireEvent.click(screen.getByTestId('diagnostic-mode-toggle')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '协同对话' })); });

    expect(screen.queryByText('技能：')).toBeNull();
    expect(screen.queryByTestId('diagnostic-skill-controls')).toBeNull();
    expect(screen.queryByTestId('diagnostic-terminal-toggle')).toBeNull();
    expect(screen.queryByTitle('切换终端')).toBeNull();
  });

  it('does not mount a permission approval queue in Full Access mode', async () => {
    resetStore();
    const getPendingApprovals = vi.fn().mockResolvedValue([{
        requestId: 'approval-normal',
        action: 'run_analysis' as const,
        createdAt: 1700000000000,
      }]);
    setMockMetis({ getPendingApprovals });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: '协同对话' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: '审批队列' })).toBeNull();
    expect(screen.queryByText('approval-normal')).toBeNull();
    expect(getPendingApprovals).not.toHaveBeenCalled();
  });

  it('exports backup as JSON download', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [{ id: 'p1', title: 'Paper One', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: Date.now() }],
      notes: [{ id: 'n1', title: 'Note One', content: 'content', tags: [], createdAt: Date.now(), updatedAt: Date.now() }],
    });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-backup');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('backup');
    fireEvent.click(container.querySelector('[data-testid="export-backup"]')!);

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-backup');

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    clickSpy.mockRestore();
  });

  it('imports backup and updates the store', async () => {
    resetStore();
    const backup = {
      version: 1,
      papers: [{ id: 'p2', title: 'Imported Paper', authors: ['A. Author'], year: 2023, venue: 'Journal', abstract: '', tags: [], notes: '', readStatus: 'read', rating: 4, referenceIds: [], addedAt: Date.now() }],
      notes: [{ id: 'n2', title: 'Imported Note', content: 'note content', tags: ['tag'], createdAt: Date.now(), updatedAt: Date.now() }],
      experiments: [{ id: 'e1', name: 'Imported Experiment', description: 'desc', status: 'running', createdAt: Date.now(), updatedAt: Date.now() }],
      collections: [{ id: 'c1', name: 'Imported Collection', paperIds: [], createdAt: Date.now(), updatedAt: Date.now() }],
      settings: { locale: 'en', theme: 'dark' },
    };
    const file = new File([JSON.stringify(backup)], 'metis-backup.json', { type: 'application/json' });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('backup');
    const input = container.querySelector('[data-testid="backup-file-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const status = container.querySelector('[data-testid="backup-status"]');
      expect(status?.textContent).toContain('已导入');
    });

    const state = useMetisStore.getState();
    expect(state.papers.length).toBe(1);
    expect(state.papers[0].title).toBe('Imported Paper');
    expect(state.notes.length).toBe(1);
    expect(state.experiments.length).toBe(1);
    expect(state.collections.length).toBe(1);
    expect(state.locale).toBe('en');
    expect(state.theme).toBe('dark');
  });

  it('shows error when importing an invalid backup file', async () => {
    resetStore();
    const file = new File(['not valid json'], 'bad.json', { type: 'application/json' });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('backup');
    const input = container.querySelector('[data-testid="backup-file-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const status = container.querySelector('[data-testid="backup-status"]');
      expect(status?.textContent).toContain('无法导入备份');
      expect(status?.textContent).not.toContain('JSON');
      expect(status?.textContent).not.toContain('Unexpected');
    });
  });

  it('skips existing items when importing without overwrite', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [{ id: 'p2', title: 'Existing Paper', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: Date.now() }],
    });
    const backup = {
      version: 1,
      papers: [{ id: 'p2', title: 'Imported Paper', authors: [], year: 2023, venue: '', abstract: '', tags: [], notes: '', readStatus: 'read', rating: 5, referenceIds: [], addedAt: Date.now() }],
    };
    const file = new File([JSON.stringify(backup)], 'metis-backup.json', { type: 'application/json' });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('backup');
    const input = container.querySelector('[data-testid="backup-file-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const status = container.querySelector('[data-testid="backup-status"]');
      expect(status?.textContent).toContain('已导入 0 篇论文');
    });

    expect(useMetisStore.getState().papers[0]?.title).toBe('Existing Paper');
  });

  it('overwrites existing items when overwrite checkbox is checked', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [{ id: 'p2', title: 'Existing Paper', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: Date.now() }],
    });
    const backup = {
      version: 1,
      papers: [{ id: 'p2', title: 'Imported Paper', authors: [], year: 2023, venue: '', abstract: '', tags: [], notes: '', readStatus: 'read', rating: 5, referenceIds: [], addedAt: Date.now() }],
    };
    const file = new File([JSON.stringify(backup)], 'metis-backup.json', { type: 'application/json' });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('backup');
    const checkbox = container.querySelector('[data-testid="overwrite-existing"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    const input = container.querySelector('[data-testid="backup-file-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const status = container.querySelector('[data-testid="backup-status"]');
      expect(status?.textContent).toContain('已导入 1 篇论文');
    });

    expect(useMetisStore.getState().papers[0]?.title).toBe('Imported Paper');
  });

  it('renders HITL approval rules from the backend', async () => {
    resetStore();
    setDiagnosticMode('diagnostic');
    setMockMetis({
      listHITLRules: vi.fn().mockResolvedValue([
        { id: 'write-approval', name: 'Write Approval', description: 'Require approval for writes', enabled: true },
        { id: 'dangerous-command', name: 'Dangerous Command', description: 'Require approval for destructive commands', enabled: false },
      ]),
    });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('diagnostics');
    await waitFor(() => {
      expect(container.querySelector('[data-testid="hitl-toggle-write-approval"]')).toBeTruthy();
    });

    const buttons = container.querySelectorAll('[data-testid^="hitl-toggle-"]');
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.textContent).toBe('禁用');
    expect(buttons[1]?.textContent).toBe('启用');
  });

  it('toggles a HITL rule and reloads the list', async () => {
    resetStore();
    setDiagnosticMode('diagnostic');
    const listHITLRules = vi.fn().mockResolvedValue([
      { id: 'write-approval', name: 'Write Approval', description: 'Require approval for writes', enabled: true },
    ]);
    const toggleHITLRule = vi.fn().mockResolvedValue({ success: true });
    setMockMetis({ listHITLRules, toggleHITLRule });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('diagnostics');
    await waitFor(() => {
      expect(container.querySelector('[data-testid="hitl-toggle-write-approval"]')).toBeTruthy();
    });

    fireEvent.click(container.querySelector('[data-testid="hitl-toggle-write-approval"]')!);

    await waitFor(() => {
      expect(toggleHITLRule).toHaveBeenCalledWith('write-approval', false);
    });
    expect(listHITLRules).toHaveBeenCalledTimes(2);
  });

  it('imports backup by dropping a JSON file onto the drop zone', async () => {
    resetStore();
    const backup = {
      version: 1,
      papers: [{ id: 'p3', title: 'Dropped Paper', authors: [], year: 2022, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: Date.now() }],
    };
    const file = new File([JSON.stringify(backup)], 'dropped.json', { type: 'application/json' });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('backup');
    const dropZone = container.querySelector('[data-testid="backup-drop-zone"]')!;

    fireEvent.dragOver(dropZone);
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      const status = container.querySelector('[data-testid="backup-status"]');
      expect(status?.textContent).toContain('已导入');
    });

    expect(useMetisStore.getState().papers[0]?.title).toBe('Dropped Paper');
  });

  it('shows an error when dropping a non-JSON file onto the backup zone', async () => {
    resetStore();
    const file = new File(['not json'], 'notes.txt', { type: 'text/plain' });

    const { container } = render(<App initialPage="settings" />);
    await openAdvancedTab('backup');
    const dropZone = container.querySelector('[data-testid="backup-drop-zone"]')!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      const status = container.querySelector('[data-testid="backup-status"]');
      expect(status?.textContent).toContain('请上传 .json 格式');
    });

    expect(useMetisStore.getState().papers.length).toBe(0);
  });
});
