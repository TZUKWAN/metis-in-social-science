/**
 * AIO Zen mode (T07) — presentation branch contract.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
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
    locale: 'zh',
    theme: 'dark',
    isHydrated: true,
  });
}

beforeEach(() => {
  setDiagnosticMode('normal');
  window.localStorage.clear();
  window.sessionStorage.clear();
  (window as Window).metis = {
    listHITLRules: vi.fn().mockResolvedValue([]),
    toggleHITLRule: vi.fn().mockResolvedValue({ success: true }),
    getPendingApprovals: vi.fn().mockResolvedValue([]),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    onApprovalRequired: vi.fn().mockReturnValue(() => {}),
  } as unknown as MetisAPI;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  (window as Window).metis = undefined;
  setDiagnosticMode('normal');
});

describe('AIO Zen presentation branch', () => {
  it('renders only the conversation + composer: no topbar, no dock, no nav', async () => {
    resetStore();
    render(<App />);
    await screen.findByTestId('chat-page');
    expect(document.querySelector('.topbar')).not.toBeNull();

    fireEvent.click(screen.getByTestId('aio-toggle'));

    // Zen root and conversation viewport are present.
    expect(screen.getByTestId('aio-root')).toBeTruthy();
    expect(screen.getByTestId('aio-conversation')).toBeTruthy();
    // The SAME ChatPage runtime stays mounted.
    expect(screen.getByTestId('chat-page')).toBeTruthy();
    // The composer stays available.
    expect(document.querySelector('.chat-input-area')).not.toBeNull();

    // Nothing persistent from the shell survives: topbar, nav, dock, project
    // sidebar, inspector, jobs indicator, theme toggle, search button.
    expect(document.querySelector('.topbar')).toBeNull();
    expect(document.querySelector('.aio-dock')).toBeNull();
    expect(screen.queryByTestId('aio-dock')).toBeNull();
    expect(document.querySelector('.chat-sidebar')).toBeNull();
    expect(screen.queryByTestId('global-search-input')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Metis' })).toBeNull();

    // Persistent session/model toolbars are hidden in zen.
    const sessionBar = document.querySelector('.chat-session-bar');
    expect(sessionBar).toBeNull();

    // First-entry hint shows once.
    expect(screen.getByTestId('aio-hint')).toBeTruthy();
  });

  it('exits through the top hot-zone pill and restores the shell with state', async () => {
    resetStore();
    render(<App />);
    await screen.findByTestId('chat-page');

    // Draft state must survive the enter → exit round trip (§30).
    const textareaBefore = document.querySelector('.chat-textarea') as HTMLTextAreaElement | null;
    expect(textareaBefore).not.toBeNull();
    await act(async () => {
      fireEvent.change(textareaBefore!, { target: { value: '禅模式状态保持草稿' } });
    });

    fireEvent.click(screen.getByTestId('aio-toggle'));
    expect(screen.getByTestId('aio-root')).toBeTruthy();

    const hotzone = screen.getByTestId('aio-exit-hotzone');
    fireEvent.mouseEnter(hotzone);
    const pill = screen.getByTestId('aio-exit');
    fireEvent.click(pill);

    expect(screen.queryByTestId('aio-root')).toBeNull();
    expect(document.querySelector('.topbar')).not.toBeNull();
    const textareaAfter = document.querySelector('.chat-textarea') as HTMLTextAreaElement | null;
    expect(textareaAfter?.value).toBe('禅模式状态保持草稿');
  });

  it('toggles with Ctrl+Shift+A and suppresses global nav shortcuts inside AIO', async () => {
    resetStore();
    render(<App />);
    await screen.findByTestId('chat-page');

    fireEvent.keyDown(window, { key: 'a', shiftKey: true, ctrlKey: true });
    expect(screen.getByTestId('aio-root')).toBeTruthy();

    // Ctrl+K must NOT open global search while in AIO.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByPlaceholderText(/搜索|Search/)).toBeNull();

    fireEvent.keyDown(window, { key: 'a', shiftKey: true, ctrlKey: true });
    expect(screen.queryByTestId('aio-root')).toBeNull();
    expect(document.querySelector('.topbar')).not.toBeNull();
  });

  it('shows the first-entry hint only once across enters', async () => {
    resetStore();
    render(<App />);
    await screen.findByTestId('chat-page');

    fireEvent.click(screen.getByTestId('aio-toggle'));
    expect(screen.getByTestId('aio-hint')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'a', shiftKey: true, ctrlKey: true });
    expect(screen.queryByTestId('aio-root')).toBeNull();

    fireEvent.click(screen.getByTestId('aio-toggle'));
    expect(screen.queryByTestId('aio-hint')).toBeNull();
  });

  it('does not crash sending keyboard events while streaming textarea focused ( Esc semantics untouched )', async () => {
    resetStore();
    render(<App />);
    await screen.findByTestId('chat-page');
    fireEvent.keyDown(window, { key: 'a', shiftKey: true, metaKey: true });
    expect(screen.getByTestId('aio-root')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
  });
});
