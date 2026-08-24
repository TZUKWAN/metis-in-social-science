/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useMetisStore } from '../../src/store.js';

// Mock window.metis for controlled IPC testing
interface MockSettingsResult { success: boolean; code: string }

function mockMetis(setSettingsResult: MockSettingsResult | Error) {
  const setSettings = vi.fn();
  if (setSettingsResult instanceof Error) {
    setSettings.mockRejectedValue(setSettingsResult);
  } else {
    setSettings.mockResolvedValue(setSettingsResult);
  }
  Object.defineProperty(window, 'metis', {
    value: { setSettings },
    writable: true,
    configurable: true,
  });
  return setSettings;
}

beforeEach(() => {
  // Reset store state
  useMetisStore.setState({ theme: 'light' });
  // Clear DOM
  document.documentElement.dataset.theme = '';
  // Clear localStorage
  try { localStorage.removeItem('metis-theme'); } catch { /* ignore */ }
});

describe('setTheme transactional rollback', () => {
  it('keeps new theme when IPC succeeds', async () => {
    const setSettings = mockMetis({ success: true, code: 'settings_saved' });
    useMetisStore.getState().setTheme('dark');
    // Wait for async IPC
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
    // Should keep dark theme
    expect(useMetisStore.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('rolls back to previous theme when IPC fails (success=false)', async () => {
    mockMetis({ success: false, code: 'secure_setup_required' });
    useMetisStore.getState().setTheme('dark');
    // Wait for async rollback
    await vi.waitFor(() => {
      expect(useMetisStore.getState().theme).toBe('light');
    });
    // Should have rolled back
    expect(useMetisStore.getState().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('rolls back when IPC throws', async () => {
    mockMetis(new Error('IPC crash'));
    useMetisStore.getState().setTheme('system');
    await vi.waitFor(() => {
      expect(useMetisStore.getState().theme).toBe('light');
    });
    expect(useMetisStore.getState().theme).toBe('light');
  });

  it('calls setSettings with the new theme', async () => {
    const setSettings = mockMetis({ success: true, code: 'settings_saved' });
    useMetisStore.getState().setTheme('dark');
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(setSettings).toHaveBeenCalledWith({ theme: 'dark' });
  });
});

describe('setTheme optimistic update (before IPC resolves)', () => {
  it('applies theme immediately before IPC resolves', () => {
    const setSettings = vi.fn().mockReturnValue(new Promise(() => {}));
    Object.defineProperty(window, 'metis', {
      value: { setSettings },
      writable: true,
      configurable: true,
    });
    useMetisStore.getState().setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('setTheme localStorage failure recovery', () => {
  beforeEach(() => {
    try { localStorage.removeItem('metis-theme'); } catch { /* ignore */ }
  });

  it('IPC success + localStorage setItem fails: keeps new theme, calls removeItem', async () => {
    let resolveSetSettings!: (v: unknown) => void;
    const setSettings = vi.fn().mockReturnValue(new Promise<unknown>((r) => { resolveSetSettings = r; }));
    Object.defineProperty(window, 'metis', { value: { setSettings }, writable: true, configurable: true });

    const origSetItem = Storage.prototype.setItem;
    const origRemoveItem = Storage.prototype.removeItem;
    const removeCalls: string[] = [];
    Storage.prototype.setItem = vi.fn(() => { throw new Error('quota exceeded'); });
    Storage.prototype.removeItem = vi.fn((key: string) => { removeCalls.push(key); });

    useMetisStore.getState().setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');

    // Resolve IPC success
    await vi.waitFor(async () => {
      resolveSetSettings({ success: true, code: 'settings_saved' });
      // Wait for microtasks to process the .then handler
      await new Promise((r) => setTimeout(r, 10));
    });

    // Theme must stay dark (main committed, no rollback)
    expect(useMetisStore.getState().theme).toBe('dark');
    // removeItem must have been called
    expect(removeCalls).toContain('metis-theme');

    Storage.prototype.setItem = origSetItem;
    Storage.prototype.removeItem = origRemoveItem;
  });

  it('IPC failure + setItem(prev) fails: rolls back, calls removeItem', async () => {
    let rejectSetSettings!: (e: Error) => void;
    const setSettings = vi.fn().mockReturnValue(new Promise<unknown>((_, rj) => { rejectSetSettings = rj; }));
    Object.defineProperty(window, 'metis', { value: { setSettings }, writable: true, configurable: true });

    const origSetItem = Storage.prototype.setItem;
    const origRemoveItem = Storage.prototype.removeItem;
    const removeCalls: string[] = [];
    // Always throw on setItem
    Storage.prototype.setItem = vi.fn(() => { throw new Error('quota exceeded'); });
    Storage.prototype.removeItem = vi.fn((key: string) => { removeCalls.push(key); });

    useMetisStore.getState().setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');

    // Reject IPC
    await vi.waitFor(async () => {
      rejectSetSettings(new Error('IPC disconnected'));
      await new Promise((r) => setTimeout(r, 10));
    });

    // Must roll back to light
    expect(useMetisStore.getState().theme).toBe('light');
    expect(removeCalls).toContain('metis-theme');

    Storage.prototype.setItem = origSetItem;
    Storage.prototype.removeItem = origRemoveItem;
  });

  it('IPC failure + setItem(prev) fails + removeItem also fails: still rolls back', async () => {
    let rejectSetSettings!: (e: Error) => void;
    const setSettings = vi.fn().mockReturnValue(new Promise<unknown>((_, rj) => { rejectSetSettings = rj; }));
    Object.defineProperty(window, 'metis', { value: { setSettings }, writable: true, configurable: true });

    const origSetItem = Storage.prototype.setItem;
    const origRemoveItem = Storage.prototype.removeItem;
    // Both setItem AND removeItem throw
    Storage.prototype.setItem = vi.fn(() => { throw new Error('quota exceeded'); });
    Storage.prototype.removeItem = vi.fn(() => { throw new Error('storage disconnected'); });

    useMetisStore.getState().setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');

    // Reject IPC
    await vi.waitFor(async () => {
      rejectSetSettings(new Error('IPC disconnected'));
      await new Promise((r) => setTimeout(r, 10));
    });

    // Must still roll back to light even when both storage ops fail
    // (Zustand state is the source of truth)
    expect(useMetisStore.getState().theme).toBe('light');
    // removeItem was attempted despite the error
    expect(Storage.prototype.removeItem).toHaveBeenCalledWith('metis-theme');

    Storage.prototype.setItem = origSetItem;
    Storage.prototype.removeItem = origRemoveItem;
  });

  it('IPC success + setItem succeeds: localStorage contains correct theme', async () => {
    let resolveSetSettings!: (v: unknown) => void;
    const setSettings = vi.fn().mockReturnValue(new Promise<unknown>((r) => { resolveSetSettings = r; }));
    Object.defineProperty(window, 'metis', { value: { setSettings }, writable: true, configurable: true });

    useMetisStore.getState().setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');
    // localStorage set during optimistic update
    expect(localStorage.getItem('metis-theme')).toBe('dark');

    // Resolve IPC success
    await vi.waitFor(async () => {
      resolveSetSettings({ success: true, code: 'settings_saved' });
      await new Promise((r) => setTimeout(r, 10));
    });

    // Theme stays dark, localStorage re-synced
    expect(useMetisStore.getState().theme).toBe('dark');
    expect(localStorage.getItem('metis-theme')).toBe('dark');
  });

  it('rapid sequential changes: stale failure does not rollback newer success', async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    const setSettings = vi.fn()
      .mockReturnValueOnce(new Promise<unknown>((r) => { resolveFirst = r; }))
      .mockReturnValueOnce(new Promise<unknown>((r) => { resolveSecond = r; }));

    Object.defineProperty(window, 'metis', { value: { setSettings }, writable: true, configurable: true });

    // Change 1: light → dark
    useMetisStore.getState().setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');
    // localStorage reflects optimistic dark
    expect(localStorage.getItem('metis-theme')).toBe('dark');

    // Change 2: dark → system (newer operation)
    useMetisStore.getState().setTheme('system');
    expect(useMetisStore.getState().theme).toBe('system');

    // Resolve change 1 (stale failure) — must NOT rollback
    await vi.waitFor(async () => {
      resolveFirst({ success: false, code: 'settings_update_unavailable' });
      await new Promise((r) => setTimeout(r, 10));
    });

    // Change 2 is still active — NOT rolled back by stale change 1
    expect(useMetisStore.getState().theme).toBe('system');

    // Resolve change 2 (success)
    await vi.waitFor(async () => {
      resolveSecond({ success: true, code: 'settings_saved' });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(useMetisStore.getState().theme).toBe('system');
  });

  it('rapid changes: second fails after first succeeded, stays on second (last writer)', async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    const setSettings = vi.fn()
      .mockReturnValueOnce(new Promise<unknown>((r) => { resolveFirst = r; }))
      .mockReturnValueOnce(new Promise<unknown>((r) => { resolveSecond = r; }));

    Object.defineProperty(window, 'metis', { value: { setSettings }, writable: true, configurable: true });

    // Change 1: light → dark
    useMetisStore.getState().setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');

    // Change 2: dark → system (newer)
    useMetisStore.getState().setTheme('system');
    expect(useMetisStore.getState().theme).toBe('system');

    // Resolve change 1 first (success, but stale — operationId=1 < themeOperationSeq=2)
    await vi.waitFor(async () => {
      resolveFirst({ success: true, code: 'settings_saved' });
      await new Promise((r) => setTimeout(r, 10));
    });
    // Change 1's success handler: operationId !== themeOperationSeq → no-op
    // State stays as 'system' (last optimistic write)
    expect(useMetisStore.getState().theme).toBe('system');

    // Resolve change 2 (failure) — rolls back to 'dark' (prevTheme at time of call)
    await vi.waitFor(async () => {
      resolveSecond({ success: false, code: 'settings_update_unavailable' });
      await new Promise((r) => setTimeout(r, 10));
    });

    // Change 2 fails → rollback to what theme was when change 2 started (dark)
    expect(useMetisStore.getState().theme).toBe('dark');
  });
});
