/**
 * CollabPage — 协同对话站点管理 tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import CollabPage from '../../src/pages/CollabPage';
import type { MetisAPI } from '../../electron/preload';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setMockMetis(overrides?: Partial<MetisAPI>) {
  (window as Window).metis = {
    collabShow: vi.fn().mockResolvedValue({ ok: true }),
    collabHide: vi.fn().mockResolvedValue({ ok: true }),
    collabSetBounds: vi.fn().mockResolvedValue({ ok: true }),
    collabNavigate: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as MetisAPI;
}

function mockCollabNavigate() {
  return (window as Window).metis!.collabNavigate as ReturnType<typeof vi.fn>;
}

describe('CollabPage — 协同对话站点管理', () => {
  beforeEach(() => {
    window.localStorage.clear();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  });

  afterEach(() => {
    cleanup();
    (window as Window).metis = undefined;
  });

  it('renders the six default AI sites as icon tabs and navigates on click', async () => {
    setMockMetis();
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);

    for (const id of ['doubao', 'kimi', 'glm', 'chatgpt', 'claude', 'deepseek']) {
      expect(await screen.findByTestId(`collab-ai-${id}`)).toBeTruthy();
    }
    // 默认进入豆包。
    await waitFor(() => expect(mockCollabNavigate()).toHaveBeenCalledWith('https://www.doubao.com/chat/'));

    fireEvent.click(screen.getByTestId('collab-ai-kimi'));
    await waitFor(() => expect(mockCollabNavigate()).toHaveBeenCalledWith('https://www.kimi.com/'));
    expect(screen.getByTestId('collab-ai-kimi').getAttribute('aria-selected')).toBe('true');
  });

  it('lets the user add a custom AI site and persists it', async () => {
    setMockMetis();
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);

    // 添加按钮只在管理模式下出现。
    expect(screen.queryByTestId('collab-add')).toBeNull();
    fireEvent.click(await screen.findByTestId('collab-manage'));
    fireEvent.click(await screen.findByTestId('collab-add'));
    fireEvent.change(screen.getByTestId('collab-site-name-input'), { target: { value: '通义千问' } });
    fireEvent.change(screen.getByTestId('collab-site-url-input'), { target: { value: 'tongyi.aliyun.com' } });
    fireEvent.click(screen.getByTestId('collab-site-save'));

    // 新站点出现在标签页并自动选中（自动补全 https://）。
    await waitFor(() => expect(mockCollabNavigate()).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/tongyi\.aliyun\.com/)));
    expect(screen.getByText('通义千问')).toBeTruthy();

    // 持久化到 localStorage。
    const stored = JSON.parse(window.localStorage.getItem('metis-collab-sites-v1') ?? '[]') as Array<{ name: string }>;
    expect(stored.some((site) => site.name === '通义千问')).toBe(true);
  });

  it('rejects an invalid site entry with a visible error', async () => {
    setMockMetis();
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);

    fireEvent.click(await screen.findByTestId('collab-manage'));
    fireEvent.click(await screen.findByTestId('collab-add'));
    fireEvent.change(screen.getByTestId('collab-site-name-input'), { target: { value: '缺网址' } });
    fireEvent.click(screen.getByTestId('collab-site-save'));

    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('manage mode allows deleting a site and restoring defaults', async () => {
    setMockMetis();
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);
    await screen.findByTestId('collab-ai-doubao');

    // 管理模式：删除 Claude。
    fireEvent.click(screen.getByTestId('collab-manage'));
    fireEvent.click(await screen.findByTestId('collab-remove-claude'));
    await waitFor(() => expect(screen.queryByTestId('collab-ai-claude')).toBeNull());

    // 恢复默认列表（管理模式下头部直接可用）。
    fireEvent.click(await screen.findByTestId('collab-reset-sites'));
    await waitFor(() => expect(screen.getByTestId('collab-ai-claude')).toBeTruthy());
  });

  it('edit mode updates a site name and url', async () => {
    setMockMetis();
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);
    await screen.findByTestId('collab-ai-kimi');

    fireEvent.click(screen.getByTestId('collab-manage'));
    // 管理模式下点击标签进入编辑而非切换。
    fireEvent.click(screen.getByTestId('collab-ai-kimi'));
    const nameInput = await screen.findByTestId('collab-site-name-input');
    expect((nameInput as HTMLInputElement).value).toBe('Kimi');
    fireEvent.change(nameInput, { target: { value: 'Kimi 智能助手' } });
    fireEvent.click(screen.getByTestId('collab-site-save'));
    await waitFor(() => expect(screen.getByText('Kimi 智能助手')).toBeTruthy());
  });

  it('split handle drags resize the panes and persist the ratio', async () => {
    setMockMetis();
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);
    await screen.findByTestId('collab-split-handle');

    const external = document.querySelector('.collab-external') as HTMLElement;
    const before = external.style.flexBasis;
    expect(before).toBe('52.00%');

    const handle = screen.getByTestId('collab-split-handle');
    fireEvent.pointerDown(handle, { clientX: 700 });
    fireEvent.pointerMove(window, { clientX: 900 });
    fireEvent.pointerUp(window);

    // jsdom 无布局宽度，拖动会夹取到上限 75%。
    expect(external.style.flexBasis).toBe('75.00%');
    expect(window.localStorage.getItem('metis-collab-split')).toBe('0.75');
  });

  it('links the Metis chat to the current research project with a switcher', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({
      projects: [
        { id: 'proj-a', title: '民国救济制度研究', originalIntent: '', researchQuestion: '', lifecycle: 'draft', methodology: '', discipline: '', createdAt: 1, updatedAt: 1, archivedAt: null, version: 1, deletedAt: null },
        { id: 'proj-b', title: '档案数字化研究', originalIntent: '', researchQuestion: '', lifecycle: 'draft', methodology: '', discipline: '', createdAt: 1, updatedAt: 1, archivedAt: null, version: 1, deletedAt: null },
      ],
      activeProjectId: 'proj-a',
    } as never);
    setMockMetis();
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);

    // 头部显示当前链接的科研项目，可切换。
    const select = await screen.findByTestId('collab-project-select') as HTMLSelectElement;
    expect(select.value).toBe('proj-a');
    fireEvent.change(select, { target: { value: 'proj-b' } });
    await waitFor(() => expect(researchWorkspaceStore.getState().activeProjectId).toBe('proj-b'));
    // 有项目时不显示提示。
    expect(screen.queryByTestId('collab-no-project')).toBeNull();
  });

  it('shows a project notice and jump action when no project is linked', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({ projects: [], activeProjectId: null } as never);
    setMockMetis();
    const navigateListener = vi.fn();
    window.addEventListener('metis:navigate-projects', navigateListener);
    render(<CollabPage chatContent={<div data-testid="chat-slot" />} sessionPanel={null} rightPanel={null} />);

    expect(await screen.findByTestId('collab-no-project')).toBeTruthy();
    fireEvent.click(screen.getByTestId('collab-open-projects'));
    expect(navigateListener).toHaveBeenCalledTimes(1);
    window.removeEventListener('metis:navigate-projects', navigateListener);
  });
});
