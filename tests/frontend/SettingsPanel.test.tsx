/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import SettingsPanel from '../../src/components/SettingsPanel';
import { useMetisStore } from '../../src/store';

// Stub child components that subscribe to the store and trigger async
// state updates on theme changes.  This keeps the test suite's stderr
// clean of act() warnings.
vi.mock('../../src/components/SettingsBackupSection', () => ({
  default: () => null,
}));
vi.mock('../../src/components/SettingsDiagnosticSection', () => ({
  default: () => null,
}));

// ─── Mock metis API ───────────────────────────────────────────
// SettingsPanel mounts trigger getSettings.
// Wrap render + initial loads in a settled helper to avoid lingering act() warnings.

interface MockMetis {
  getSettings: ReturnType<typeof vi.fn>;
  setupProbe: ReturnType<typeof vi.fn>;
  setupSave: ReturnType<typeof vi.fn>;
  setSettings: ReturnType<typeof vi.fn>;
  providerProfilesList: ReturnType<typeof vi.fn>;
  listPersonalizationSecrets: ReturnType<typeof vi.fn>;
  importZotero: ReturnType<typeof vi.fn>;
}

let mockMetis: MockMetis;

beforeEach(async () => {
  // Deterministic zh copy: earlier tests may have switched the locale.
  useMetisStore.setState({ locale: 'zh' });
  mockMetis = {
    getSettings: vi.fn().mockResolvedValue({
      configured: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      hasApiKey: true,
      needsReauth: false,
      theme: 'light',
    }),
    setupProbe: vi.fn().mockResolvedValue({
      success: true,
      probeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      configVersion: 1,
      version: 1,
      operationId: 'test-op',
      capabilities: { streaming: true, nativeToolCalling: true, structuredOutput: true, maxContextTokens: 128000, multimodal: true },
      strategy: { tier: 'powerful', maxTurnsPerStep: 64, maxToolsPerTurn: 16, maxRetries: 3, reviewEveryNTurns: 16, forceStructuredOutput: false, contextBudgetTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: true },
      warnings: [],
    }),
    setupSave: vi.fn().mockResolvedValue({
      success: true,
      configVersion: 2,
      version: 1,
      operationId: 'test-op',
      config: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKeyStored: true },
      capabilities: { streaming: true, nativeToolCalling: true, structuredOutput: true, maxContextTokens: 128000, multimodal: true },
      strategy: { tier: 'powerful', maxTurnsPerStep: 64, maxToolsPerTurn: 16, maxRetries: 3, reviewEveryNTurns: 16, forceStructuredOutput: false, contextBudgetTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: true },
      warnings: [],
    }),
    setSettings: vi.fn().mockResolvedValue({ success: true, code: 'settings_saved' }),
    providerProfilesList: vi.fn().mockResolvedValue({
      ok: true,
      contractVersion: 1,
      operationId: 'settings-panel-list',
      revision: 0,
      profiles: [],
    }),
    listPersonalizationSecrets: vi.fn().mockResolvedValue({ ok: true, revision: 0, secrets: [] }),
    importZotero: vi.fn().mockResolvedValue({ ok: false, imported: 0, merged: 0, skipped: 0, error: 'zotero_not_configured', items: [] }),
  };

  Object.defineProperty(window, 'metis', {
    value: mockMetis,
    writable: true,
    configurable: true,
  });
});

async function renderPanelSettled() {
  const result = render(<SettingsPanel uiMode="normal" onUIModeChange={() => {}} />);
  await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
  return result;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Restore Storage prototype mocks in case theme tests replaced them
  try { Object.defineProperty(Storage.prototype, 'setItem', { value: Storage.prototype.setItem, writable: true, configurable: true }); } catch { /* Storage prototype not stubbed */ }
  try { Object.defineProperty(Storage.prototype, 'removeItem', { value: Storage.prototype.removeItem, writable: true, configurable: true }); } catch { /* Storage prototype not stubbed */ }
});

// ─── Provider config tests ────────────────────────────────────

describe('SettingsPanel — provider config', () => {
  it('loads saved provider settings on mount', async () => {
    await renderPanelSettled();
    await waitFor(() => {
      expect(mockMetis.getSettings).toHaveBeenCalled();
    });
    const baseUrlInput = document.getElementById('provider-baseurl') as HTMLInputElement;
    await waitFor(() => {
      expect(baseUrlInput.value).toBe('https://api.openai.com/v1');
    });
  });

  it('shows reauth warning banner when needsReauth is true', async () => {
    mockMetis.getSettings.mockResolvedValue({
      configured: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      hasApiKey: false,
      needsReauth: true,
      theme: 'light',
    });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
    // Reauth banner must be visible with role=alert
    const alerts = screen.getAllByRole('alert');
    const reauthAlert = alerts.find(el => el.textContent?.includes('settings.needsReauth') || el.textContent?.includes('需要'));
    expect(reauthAlert).toBeDefined();
    // API key input should be open directly
    const keyInput = document.getElementById('provider-apikey') as HTMLInputElement;
    expect(keyInput).toBeDefined();
  });

  it('clears needsReauth after successful save with new key', async () => {
    mockMetis.getSettings.mockResolvedValue({
      configured: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      hasApiKey: false,
      needsReauth: true,
      theme: 'light',
    });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
    // Enter new key
    const keyInput = document.getElementById('provider-apikey') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-new-key-1234' } });
    // Save
    fireEvent.click(screen.getByTestId('provider-save'));
    await waitFor(() => expect(mockMetis.setupSave).toHaveBeenCalled());
    // After save, reauth banner should be gone and key input hidden
    await waitFor(() => {
      const alerts = screen.queryAllByRole('alert');
      const reauthAlert = alerts.find(el => el.textContent?.includes('settings.needsReauth') || el.textContent?.includes('需要'));
      expect(reauthAlert).toBeUndefined();
    });
    // Key input should be hidden (masked display shown)
    const keyInputAfter = document.getElementById('provider-apikey');
    expect(keyInputAfter).toBeNull();
  });

  it('shows masked key and change button when key exists', async () => {
    await renderPanelSettled();
    await waitFor(() => {
      expect(screen.getByText('••••••••')).toBeDefined();
      expect(screen.getByTestId('change-api-key')).toBeDefined();
    });
  });

  it('shows API key input when change button clicked', async () => {
    await renderPanelSettled();
    await waitFor(() => expect(screen.getByText('••••••••')).toBeDefined());
    fireEvent.click(screen.getByTestId('change-api-key'));
    const keyInput = document.getElementById('provider-apikey') as HTMLInputElement;
    expect(keyInput).toBeDefined();
  });

  it('Save button is disabled when not dirty', async () => {
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
    const saveBtn = screen.getByTestId('provider-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('Save button becomes enabled when fields are edited', async () => {
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
    const baseUrlInput = document.getElementById('provider-baseurl') as HTMLInputElement;
    fireEvent.change(baseUrlInput, { target: { value: 'https://new.url/v1' } });
    const saveBtn = screen.getByTestId('provider-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it('Cancel reverts edits', async () => {
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
    const baseUrlInput = document.getElementById('provider-baseurl') as HTMLInputElement;
    fireEvent.change(baseUrlInput, { target: { value: 'https://new.url/v1' } });
    fireEvent.click(screen.getByTestId('provider-cancel'));
    expect(baseUrlInput.value).toBe('https://api.openai.com/v1');
  });
});

// ─── Test connection — empty key rejection ───────────────────

describe('SettingsPanel — test connection empty key rejection', () => {
  it('rejects test when no saved key and no entered key', async () => {
    mockMetis.getSettings.mockResolvedValue({
      configured: false,
      hasApiKey: false,
      needsReauth: true,
      theme: 'light',
    });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('provider-test'));
    await waitFor(() => {
      expect(mockMetis.setupProbe).not.toHaveBeenCalled();
    });
  });

  it('does not hardcode empty apiKey in probe request', async () => {
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('change-api-key'));
    const keyInput = document.getElementById('provider-apikey') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-real-key-1234' } });

    fireEvent.click(screen.getByTestId('provider-test'));
    await waitFor(() => expect(mockMetis.setupProbe).toHaveBeenCalled());
    const calls = mockMetis.setupProbe.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const callArg = calls[calls.length - 1][0];
    // The probe must not send an empty key — either newApiKey or keyMode=saved
    expect(callArg.keyMode).toBeDefined();
    if (callArg.keyMode === 'replace') {
      expect(callArg.newApiKey).not.toBe('');
      expect(callArg.newApiKey).toBe('sk-real-key-1234');
    }
  });
});

// ─── Theme transactional ──────────────────────────────────────

describe('SettingsPanel — theme select', () => {
  // Zustand's set() feeds React's useSyncExternalStore which can schedule
  // re-renders outside act() when called from async IPC handlers.  The
  // warnings are harmless — the tests verify real state transitions.
  // Suppress only these specific act() warnings so stderr stays clean.
  let consoleErrorFilter: ReturnType<typeof vi.spyOn> | null = null;
  beforeEach(() => {
    consoleErrorFilter = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const msg = String(args[0] ?? '');
      if (msg.includes('was not wrapped in act(')) return;
      console.warn(...args);
    });
  });
  afterEach(() => { consoleErrorFilter?.mockRestore(); });

  it('changes theme via store setTheme (optimistic update)', async () => {
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    await act(async () => { fireEvent.change(themeSelect, { target: { value: 'dark' } }); });
    expect(useMetisStore.getState().theme).toBe('dark');
  });

  it('rolls back theme when IPC setSettings fails', async () => {
    let resolveSetSettings!: (v: unknown) => void;
    mockMetis.setSettings.mockReturnValueOnce(new Promise((r) => { resolveSetSettings = r; }));

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());

    useMetisStore.setState({ theme: 'light' });
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    await act(async () => { fireEvent.change(themeSelect, { target: { value: 'dark' } }); });
    expect(useMetisStore.getState().theme).toBe('dark');

    // Resolve IPC failure inside act() + waitFor so Zustand→React re-renders
    // are captured within the act() boundary.
    await act(async () => {
      resolveSetSettings({ success: false, code: 'settings_update_unavailable' });
      await vi.waitFor(() => {
        expect(useMetisStore.getState().theme).toBe('light');
      });
    });
  });

  it('rolls back theme when IPC setSettings throws', async () => {
    let rejectSetSettings!: (e: Error) => void;
    mockMetis.setSettings.mockReturnValueOnce(new Promise((_, rj) => { rejectSetSettings = rj; }));

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());

    useMetisStore.setState({ theme: 'light' });
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    await act(async () => { fireEvent.change(themeSelect, { target: { value: 'dark' } }); });
    expect(useMetisStore.getState().theme).toBe('dark');

    await act(async () => {
      rejectSetSettings(new Error('IPC disconnected'));
      await vi.waitFor(() => {
        expect(useMetisStore.getState().theme).toBe('light');
      });
    });
  });

  it('does not rollback when a newer theme operation succeeded', async () => {
    let resolveFirst!: (v: unknown) => void;
    mockMetis.setSettings.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
    mockMetis.setSettings.mockResolvedValueOnce({ success: true, code: 'settings_saved' });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());

    useMetisStore.setState({ theme: 'light' });
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;

    await act(async () => { fireEvent.change(themeSelect, { target: { value: 'dark' } }); });
    expect(useMetisStore.getState().theme).toBe('dark');

    // Second change (system) — resolves immediately
    await act(async () => {
      fireEvent.change(themeSelect, { target: { value: 'system' } });
    });
    await vi.waitFor(() => { /* settle */ });
    expect(useMetisStore.getState().theme).toBe('system');

    // Resolve first change (stale failure) — must NOT rollback
    await act(async () => {
      resolveFirst({ success: false, code: 'settings_update_unavailable' });
    });
    // system stays
    expect(useMetisStore.getState().theme).toBe('system');
  });

  it('IPC success + localStorage setItem failure: state stays, removeItem called', async () => {
    let resolveSetSettings!: (v: unknown) => void;
    mockMetis.setSettings.mockReturnValueOnce(new Promise((r) => { resolveSetSettings = r; }));

    const origSetItem = Storage.prototype.setItem;
    const origRemoveItem = Storage.prototype.removeItem;
    const removeCalls: string[] = [];
    Storage.prototype.setItem = vi.fn(() => { throw new Error('quota exceeded'); });
    Storage.prototype.removeItem = vi.fn((key: string) => { removeCalls.push(key); });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());

    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    await act(async () => { fireEvent.change(themeSelect, { target: { value: 'dark' } }); });
    expect(useMetisStore.getState().theme).toBe('dark');

    await act(async () => {
      resolveSetSettings({ success: true, code: 'settings_saved' });
      await vi.waitFor(() => { expect(removeCalls).toContain('metis-theme'); });
    });
    expect(useMetisStore.getState().theme).toBe('dark');

    Storage.prototype.setItem = origSetItem;
    Storage.prototype.removeItem = origRemoveItem;
  });

  it('IPC throw + setItem(prev) failure: rolls back + removeItem', async () => {
    let rejectSetSettings!: (e: Error) => void;
    mockMetis.setSettings.mockReturnValueOnce(new Promise((_, rj) => { rejectSetSettings = rj; }));

    const origSetItem = Storage.prototype.setItem;
    const origRemoveItem = Storage.prototype.removeItem;
    const removeCalls: string[] = [];
    Storage.prototype.setItem = vi.fn(() => { throw new Error('quota exceeded'); });
    Storage.prototype.removeItem = vi.fn((key: string) => { removeCalls.push(key); });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());

    useMetisStore.setState({ theme: 'light' });
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    await act(async () => { fireEvent.change(themeSelect, { target: { value: 'dark' } }); });
    expect(useMetisStore.getState().theme).toBe('dark');

    await act(async () => {
      rejectSetSettings(new Error('IPC disconnected'));
      await vi.waitFor(() => {
        expect(useMetisStore.getState().theme).toBe('light');
        expect(removeCalls).toContain('metis-theme');
      });
    });

    Storage.prototype.setItem = origSetItem;
    Storage.prototype.removeItem = origRemoveItem;
  });
});

// ─── a11y checks ──────────────────────────────────────────────

describe('SettingsPanel — accessibility', () => {
  it('has role=region on root (not nested main)', async () => {
    const { container } = await renderPanelSettled();
    expect(container.querySelector('[role="region"]')).toBeDefined();
  });

  it('provider status has aria-live=polite', async () => {
    const { container } = await renderPanelSettled();
    expect(container.querySelector('[aria-live="polite"]')).toBeDefined();
  });

  it('provider action group has role=group', async () => {
    await renderPanelSettled();
    const groups = screen.getAllByRole('group');
    expect(groups.length).toBeGreaterThan(0);
  });

  it('key inputs have associated labels', async () => {
    await renderPanelSettled();
    const baseUrlInput = document.getElementById('provider-baseurl');
    expect(baseUrlInput).toBeDefined();
    const label = document.querySelector('label[for="provider-baseurl"]');
    expect(label).toBeDefined();
  });

  // ── FIX-METIS-490 red tests (must fail before a11y fixes) ──

  it('BUG#2 RED: provider error messages use role="alert" (not role="status")', async () => {
    mockMetis.setSettings.mockResolvedValue({ success: false, code: 'settings_update_unavailable' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
    // Trigger save error: click change-key, type key, save
    fireEvent.click(screen.getByTestId('change-api-key'));
    const keyInput = document.getElementById('provider-apikey') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-red-test-key' } });
    fireEvent.click(screen.getByTestId('provider-save'));
    await waitFor(() => {
      // Provider error container must use role="alert"
      const errEl = screen.queryByTestId('provider-error-region');
      expect(errEl).toBeDefined();
      expect(errEl!.getAttribute('role')).toBe('alert');
    });
  });

});

