/**
 * App component tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen, within, act } from '@testing-library/react';
import App from '../../src/App';
import { useMetisStore } from '../../src/store';
import { setDiagnosticMode } from '../../engine/capabilities/DiagnosticMode';

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
    weeklyReadingGoal: 5,
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
  });

  afterEach(() => {
    cleanup();
    clearMockMetis();
    setDiagnosticMode('normal');
  });

  it('renders exactly the three top-level research entries', async () => {
    resetStore();
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });
    const nav = screen.getByRole('navigation', { name: 'Metis' });
    const primaryItems = within(nav).getAllByRole('button').filter((button) => button.hasAttribute('data-nav-id'));

    expect(primaryItems.map((button) => button.getAttribute('data-nav-id'))).toEqual([
      'projects',
      'library',
      'settings',
    ]);
    expect(primaryItems.map((button) => button.textContent?.trim())).toEqual([
      '研究项目',
      '资料库',
      '设置',
    ]);
    expect(within(nav).queryByText('评估')).toBeNull();
    expect(screen.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens Personalization from the bottom-left control beside the theme toggle', async () => {
    resetStore();
    setMockMetis({
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
    });
    render(<App />);
    const trigger = await screen.findByTestId('personalization-trigger');
    const theme = screen.getByTitle('浅色');
    expect(trigger.parentElement).toBe(theme.parentElement);
    fireEvent.click(trigger);
    expect(await screen.findByRole('heading', { name: '个性化' })).toBeDefined();
    expect(screen.getByText('自动真实性层始终强制执行')).toBeDefined();
  });

  it('composes converse mode as exactly one project shell with one chat region per column', async () => {
    resetStore();
    const { container } = render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    expect(container.querySelectorAll('.project-shell')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-sidebar')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-main')).toHaveLength(1);
    expect(container.querySelectorAll('.right-panel')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-page-container')).toHaveLength(0);
    expect(container.querySelector('.shell-left-content > .chat-sidebar')).not.toBeNull();
    expect(container.querySelector('.shell-workspace--chat > .chat-main')).not.toBeNull();
    expect(container.querySelector('.shell-right-content > .right-panel--embedded')).not.toBeNull();
    expect(container.querySelector('.shell-right aside')).toBeNull();
    expect(screen.queryByRole('tablist', { name: '检查器视图' })).toBeNull();
    expect(screen.queryByText('项目资料')).toBeNull();
    expect(screen.queryByText('研究助手')).toBeNull();
  });

  it('preserves project panel collapse state across workspace modes', async () => {
    resetStore();
    render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    fireEvent.click(screen.getByLabelText('收起资料栏'));
    expect(screen.getByRole('region', { name: 'Metis 研究工作台' }).classList.contains('left-collapsed')).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: '阅读' }));
    await waitFor(() => expect(document.querySelector('[role="tabpanel"][aria-label="阅读工作区"]')).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Metis 研究工作台' }).classList.contains('left-collapsed')).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    await waitFor(() => expect(document.querySelector('[role="tabpanel"][aria-label="对话工作区"]')).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Metis 研究工作台' }).classList.contains('left-collapsed')).toBe(true);
  });

  it('switches all four project modes in the same research shell', async () => {
    resetStore();
    const { container } = render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    const labels = ['对话', '阅读', '分析', '写作'];
    expect(screen.getAllByRole('tab').filter((tab) => labels.includes(tab.textContent ?? '')).map((tab) => tab.textContent)).toEqual(labels);

    for (const label of ['阅读', '分析', '写作']) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      await waitFor(() => expect(
        document.querySelector(`[role="tabpanel"][aria-label="${label}工作区"]`),
      ).toBeTruthy());
      expect(container.querySelectorAll('.project-shell')).toHaveLength(1);
    }
  });

  it('preserves the ChatPage owner and draft across all project modes', async () => {
    resetStore();
    const { container } = render(<App />);
    await screen.findByRole('region', { name: 'Metis 研究工作台' });

    const input = screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '跨模式保留的研究草稿' } });

    for (const label of ['阅读', '分析', '写作', '对话']) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      await waitFor(() => expect(
        document.querySelector(`[role="tabpanel"][aria-label="${label}工作区"]`),
      ).toBeTruthy());
      expect(container.querySelectorAll('.project-shell')).toHaveLength(1);
    }

    expect(
      (screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement).value,
    ).toBe('跨模式保留的研究草稿');
  });

  it.each([
    ['dashboard', '.stat-grid'],
    ['goal', '.goal-page'],
    ['collections', '.collections-page'],
    ['tags', '.tags-page'],
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

  it('shows unread papers badge on library nav item', () => {
    resetStore();
    useMetisStore.setState({
      papers: [
        { id: 'p1', title: 'Unread', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: Date.now() },
        { id: 'p2', title: 'Read', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'read', rating: 0, referenceIds: [], addedAt: Date.now() },
      ],
    });
    const { container } = render(<App initialPage="dashboard" />);
    const badge = container.querySelector('.nav-badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('1');
  });

  it('does not show unread badge when there are no unread papers', () => {
    resetStore();
    useMetisStore.setState({
      papers: [
        { id: 'p1', title: 'Read', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'read', rating: 0, referenceIds: [], addedAt: Date.now() },
      ],
    });
    const { container } = render(<App initialPage="dashboard" />);
    expect(container.querySelector('.nav-badge')).toBeNull();
  });

  it('settings page renders data backup section without technical controls in normal mode', () => {
    resetStore();
    localStorage.removeItem('metis-diagnostic-mode');
    const { container } = render(<App initialPage="settings" />);
    expect(container.querySelector('[data-testid="export-backup"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="import-backup"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="backup-file-input"]')).toBeTruthy();
    expect(screen.queryByText('MCP 服务器')).toBeNull();
    expect(screen.queryByText('人工审批规则')).toBeNull();
    expect(container.querySelector('[data-testid="diagnostic-mcp-settings"]')).toBeNull();
    expect(container.querySelector('[data-testid="diagnostic-hitl-settings"]')).toBeNull();
    expect(container.querySelector('.app-layout')?.getAttribute('data-ui-mode')).toBe('normal');
    expect(screen.getByTestId('diagnostic-mode-toggle')).toBeTruthy();
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '研究项目' })); });

    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(await screen.findByText('技能：')).toBeTruthy();
    expect(screen.getByTestId('diagnostic-skill-controls')).toBeTruthy();
    expect(screen.getByTestId('diagnostic-terminal-toggle')).toBeTruthy();
    expect(screen.getByTitle('切换终端')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    await act(async () => { fireEvent.click(screen.getByTestId('diagnostic-mode-toggle')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '研究项目' })); });

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
    await waitFor(() => expect(screen.getByRole('button', { name: '研究项目' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: '审批队列' })).toBeNull();
    expect(screen.queryByText('approval-normal')).toBeNull();
    expect(getPendingApprovals).not.toHaveBeenCalled();
  });

  it('exports backup as JSON download', () => {
    resetStore();
    useMetisStore.setState({
      papers: [{ id: 'p1', title: 'Paper One', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: Date.now() }],
      notes: [{ id: 'n1', title: 'Note One', content: 'content', tags: [], createdAt: Date.now(), updatedAt: Date.now() }],
    });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-backup');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const { container } = render(<App initialPage="settings" />);
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
      settings: { locale: 'en', theme: 'dark', weeklyReadingGoal: 7 },
    };
    const file = new File([JSON.stringify(backup)], 'metis-backup.json', { type: 'application/json' });

    const { container } = render(<App initialPage="settings" />);
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
    expect(state.weeklyReadingGoal).toBe(7);
  });

  it('shows error when importing an invalid backup file', async () => {
    resetStore();
    const file = new File(['not valid json'], 'bad.json', { type: 'application/json' });

    const { container } = render(<App initialPage="settings" />);
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
    const dropZone = container.querySelector('[data-testid="backup-drop-zone"]')!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      const status = container.querySelector('[data-testid="backup-status"]');
      expect(status?.textContent).toContain('请上传 .json 格式');
    });

    expect(useMetisStore.getState().papers.length).toBe(0);
  });

  it('clamps reading goal input between 1 and 100 and supports reset', async () => {
    resetStore();
    const { container } = await act(async () => render(<App initialPage="settings" />));
    const input = container.querySelector('[data-testid="reading-goal-input"]') as HTMLInputElement;
    expect(input.value).toBe('5');

    await act(async () => { fireEvent.change(input, { target: { value: '0' } }); });
    expect(useMetisStore.getState().weeklyReadingGoal).toBe(1);

    await act(async () => { fireEvent.change(input, { target: { value: '200' } }); });
    expect(useMetisStore.getState().weeklyReadingGoal).toBe(100);

    await act(async () => { fireEvent.click(container.querySelector('[data-testid="reading-goal-reset"]')!); });
    expect(useMetisStore.getState().weeklyReadingGoal).toBe(5);
  });
});
