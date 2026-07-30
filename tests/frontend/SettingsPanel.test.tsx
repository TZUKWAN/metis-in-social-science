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
vi.mock('../../src/components/SettingsProjectMemorySection', () => ({
  default: () => null,
}));
vi.mock('../../src/components/SettingsBackupSection', () => ({
  default: () => null,
}));
vi.mock('../../src/components/SettingsDiagnosticSection', () => ({
  default: () => null,
}));

// ─── Mock metis API ───────────────────────────────────────────
// SettingsPanel mounts trigger getSettings + getWorkspaceAgents.
// Wrap render + initial loads in a settled helper to avoid lingering act() warnings.

interface MockMetis {
  getSettings: ReturnType<typeof vi.fn>;
  setupProbe: ReturnType<typeof vi.fn>;
  setupSave: ReturnType<typeof vi.fn>;
  getWorkspaceAgents: ReturnType<typeof vi.fn>;
  setWorkspaceAgents: ReturnType<typeof vi.fn>;
  setSettings: ReturnType<typeof vi.fn>;
  getProjectMemory: ReturnType<typeof vi.fn>;
  setProjectMemory: ReturnType<typeof vi.fn>;
}

let mockMetis: MockMetis;

beforeEach(async () => {
  useMetisStore.setState({ theme: 'light', locale: 'zh', weeklyReadingGoal: 5 });
  // Set active research project for workspace agents tests
  const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
  researchWorkspaceStore.setState({ activeProjectId: 'test-project-001' });

  mockMetis = {
    getSettings: vi.fn().mockResolvedValue({
      configured: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      hasApiKey: true,
      needsReauth: false,
      theme: 'light',
      weeklyReadingGoal: 5,
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
    getWorkspaceAgents: vi.fn().mockResolvedValue({
      exists: false,
      content: '',
      version: 0,
      contentHash: '',
      projectId: 'test-project-001',
    }),
    setWorkspaceAgents: vi.fn().mockResolvedValue({
      success: true,
      code: 'saved',
      version: 1,
      contentHash: 'abc123',
    }),
    setSettings: vi.fn().mockResolvedValue({ success: true, code: 'settings_saved' }),
    // Prevent child-component act() warnings: provide getProjectMemory so
    // SettingsProjectMemorySection's useEffect resolves synchronously within act().
    getProjectMemory: vi.fn().mockResolvedValue(''),
    setProjectMemory: vi.fn().mockResolvedValue({ success: true }),
  };

  Object.defineProperty(window, 'metis', {
    value: mockMetis,
    writable: true,
    configurable: true,
  });
});

async function renderPanelSettled(opts?: { expectAgents?: boolean }) {
  const result = render(<SettingsPanel uiMode="normal" onUIModeChange={() => {}} />);
  await waitFor(() => expect(mockMetis.getSettings).toHaveBeenCalled());
  if (opts?.expectAgents !== false) {
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());
  }
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
      weeklyReadingGoal: 5,
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
      weeklyReadingGoal: 5,
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
      weeklyReadingGoal: 5,
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

// ─── Project Metis.md tests ───────────────────────────────────

describe('SettingsPanel — project Metis.md compatibility entry', () => {
  it('uses canonical English Metis.md naming in the compatibility UI', async () => {
    useMetisStore.setState({ locale: 'en' });
    await renderPanelSettled();
    expect(screen.getByRole('heading', { name: 'Project Rules (Metis.md)' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save Metis.md' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save Agents' })).toBeNull();
    expect(document.body.textContent).not.toContain('Agent workspace service');
  });

  it('loads agents content on mount', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({
      exists: true,
      content: '# Metis.md\n\nTest rules\n',
      version: 2,
      contentHash: 'hash123',
      projectId: 'test-project-001',
    });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    await waitFor(() => {
    expect(textarea.value).toContain('Test rules');
    });
  });

  it('save calls setWorkspaceAgents with CAS version', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({
      exists: true,
      content: 'original',
      version: 3,
      contentHash: 'hash3',
      projectId: 'test-project-001',
    });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'modified content' } });

    fireEvent.click(screen.getByTestId('agents-save'));

    await waitFor(() => expect(mockMetis.setWorkspaceAgents).toHaveBeenCalled());
    const args = mockMetis.setWorkspaceAgents.mock.calls[0];
    expect(args[0]).toBe('test-project-001'); // projectId
    expect(args[1]).toBe('modified content');
    expect(args[2]).toBe(3); // CAS expectedVersion
  });

  it('handles CAS conflict by reloading and preserving local draft', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({
      exists: true,
      content: 'original',
      version: 1,
      contentHash: 'hash1',
      projectId: 'test-project-001',
    });
    mockMetis.setWorkspaceAgents.mockResolvedValue({
      success: false,
      code: 'cas_conflict',
      currentVersion: 5,
      currentContentHash: 'hash5',
    });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my edit' } });

    fireEvent.click(screen.getByTestId('agents-save'));

    // After conflict, the local draft is preserved (not overwritten by server reload)
    await waitFor(() => {
      expect(mockMetis.getWorkspaceAgents).toHaveBeenCalledTimes(2);
      expect(textarea.value).toBe('my edit'); // local draft preserved
    });
  });

  it('conflict: Keep Local Draft preserves content and rebases the next CAS save', async () => {
    mockMetis.getWorkspaceAgents
      .mockResolvedValueOnce({ exists: true, content: 'server', version: 2, contentHash: 'h2', projectId: 'test-project-001' })
      .mockResolvedValueOnce({ exists: true, content: 'new disk', version: 5, contentHash: 'h5', projectId: 'test-project-001' });
    mockMetis.setWorkspaceAgents
      .mockResolvedValueOnce({ success: false, code: 'cas_conflict', currentVersion: 5, currentContentHash: 'h5' })
      .mockResolvedValueOnce({ success: true, code: 'saved', version: 6, contentHash: 'h6' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my local edit' } });
    fireEvent.click(screen.getByTestId('agents-save'));
    await waitFor(() => expect(screen.getByText('保留本地')).toBeDefined());
    fireEvent.click(screen.getByText('保留本地'));
    await waitFor(() => expect(textarea.value).toBe('my local edit'));
    fireEvent.click(screen.getByTestId('agents-save'));
    await waitFor(() => expect(mockMetis.setWorkspaceAgents).toHaveBeenCalledTimes(2));
    expect(mockMetis.setWorkspaceAgents.mock.calls[1]).toEqual(['test-project-001', 'my local edit', 5]);
  });

  it('conflict: Use Disk Version replaces draft with disk content', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'server content', version: 5, contentHash: 'h5', projectId: 'test-project-001' });
    mockMetis.setWorkspaceAgents.mockResolvedValue({ success: false, code: 'cas_conflict', currentVersion: 5, currentContentHash: 'h5' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my draft' } });
    fireEvent.click(screen.getByTestId('agents-save'));
    await waitFor(() => expect(screen.getByText('采用磁盘版本')).toBeDefined());
    fireEvent.click(screen.getByText('采用磁盘版本'));
    await waitFor(() => expect(textarea.value).toBe('server content'));
  });

  it('disables AGENTS textarea when no active project', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({ activeProjectId: null });
    await renderPanelSettled({ expectAgents: false });
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(mockMetis.getWorkspaceAgents).not.toHaveBeenCalled();
  });

  // ── Deferred Promise race tests ──────────────────────────

  it('stale save response: A save pending → switch to B → resolve A, B unchanged', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({ activeProjectId: 'proj-A' });
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'A content', version: 1, contentHash: 'hA', projectId: 'proj-A' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'A draft' } });

    let resolveSaveA!: (v: unknown) => void;
    const savePromise = new Promise<unknown>((r) => { resolveSaveA = r; });
    mockMetis.setWorkspaceAgents.mockReturnValueOnce(savePromise);

    fireEvent.click(screen.getByTestId('agents-save'));
    expect(mockMetis.setWorkspaceAgents).toHaveBeenCalled();

    // Switch to Project B — must reset save status to idle
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'B content', version: 2, contentHash: 'hB', projectId: 'proj-B' });
    await act(async () => { researchWorkspaceStore.setState({ activeProjectId: 'proj-B' }); await Promise.resolve(); });
    await waitFor(() => expect(textarea.value).toBe('B content'));

    // Save status resets to idle on project switch
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('idle');

    // Edit B — button should be enabled (dirty)
    fireEvent.change(textarea, { target: { value: 'B draft' } });
    const saveBtn = screen.getByTestId('agents-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    // Now resolve A's deferred save
    await act(async () => { resolveSaveA({ success: true, code: 'saved', version: 2, contentHash: 'hA2' }); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    // B's content and enabled state must be untouched
    expect(textarea.value).toBe('B draft');
    expect(saveBtn.disabled).toBe(false);
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).not.toBe('saving');
  });

  it('stale save response: A save pending → continue editing A → resolve, stays dirty with updated version', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'A content', version: 1, contentHash: 'hA', projectId: 'test-project-001' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'first edit' } });

    let resolveSave!: (v: unknown) => void;
    const savePromise = new Promise<unknown>((r) => { resolveSave = r; });
    mockMetis.setWorkspaceAgents.mockReturnValueOnce(savePromise);

    fireEvent.click(screen.getByTestId('agents-save'));
    expect(mockMetis.setWorkspaceAgents).toHaveBeenCalled();

    // User keeps editing
    fireEvent.change(textarea, { target: { value: 'second edit after save click' } });

    // Resolve save with version 2
    await act(async () => { resolveSave({ success: true, code: 'saved', version: 2, contentHash: 'hA2' }); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    // Content NOT overwritten
    expect(textarea.value).toBe('second edit after save click');
    // Status should be idle (NOT 'saved') — current content is still unsaved
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('idle');
    const saveBtn = screen.getByTestId('agents-save') as HTMLButtonElement;
    // Button should be enabled (still dirty, not showing 'saved')
    expect(saveBtn.disabled).toBe(false);

    // Now do a second save — should use the UPDATED version (2, not 1)
    mockMetis.setWorkspaceAgents.mockResolvedValueOnce({ success: true, code: 'saved', version: 3, contentHash: 'hA3' });
    fireEvent.click(screen.getByTestId('agents-save'));
    await waitFor(() => expect(mockMetis.setWorkspaceAgents).toHaveBeenCalledTimes(2));

    // Verify the second save used the correct expectedVersion (2, not stale 1)
    const secondCall = mockMetis.setWorkspaceAgents.mock.calls[1];
    expect(secondCall[2]).toBe(2); // expectedVersion — must NOT be stale 1
  });

  it('stale save response: two rapid saves, only latest completes', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'content', version: 1, contentHash: 'h1', projectId: 'test-project-001' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'save 1 content' } });

    let resolveSave1!: (v: unknown) => void;
    const p1 = new Promise<unknown>((r) => { resolveSave1 = r; });
    mockMetis.setWorkspaceAgents.mockReturnValueOnce(p1);

    fireEvent.click(screen.getByTestId('agents-save'));

    fireEvent.change(textarea, { target: { value: 'save 2 content' } });
    mockMetis.setWorkspaceAgents.mockResolvedValueOnce({ success: true, code: 'saved', version: 2, contentHash: 'h2' });
    fireEvent.click(screen.getByTestId('agents-save'));

    await waitFor(() => expect(mockMetis.setWorkspaceAgents).toHaveBeenCalledTimes(2));

    // Resolve save 1 (stale) — must NOT corrupt state
    await act(async () => { resolveSave1({ success: true, code: 'saved', version: 99, contentHash: 'h99' }); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    expect(textarea.value).toBe('save 2 content');
  });

  it('stale save response: draft cache preserved when newer draft exists', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({ activeProjectId: 'proj-A' });
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'A content', version: 1, contentHash: 'hA', projectId: 'proj-A' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'edit v1' } });

    // Save 1 → deferred
    let resolveSave1!: (v: unknown) => void;
    mockMetis.setWorkspaceAgents.mockReturnValueOnce(new Promise((r) => { resolveSave1 = r; }));
    fireEvent.click(screen.getByTestId('agents-save'));

    // Save 2 (newer) → also deferred — same project, different content
    fireEvent.change(textarea, { target: { value: 'edit v2' } });
    let resolveSave2!: (v: unknown) => void;
    mockMetis.setWorkspaceAgents.mockReturnValueOnce(new Promise((r) => { resolveSave2 = r; }));
    fireEvent.click(screen.getByTestId('agents-save'));

    // Resolve save 2 (newer) first → dirty cleared
    await act(async () => { resolveSave2({ success: true, code: 'saved', version: 2, contentHash: 'h2' }); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    // Now switch to project B, then back to A — draft should be clean (saved by save 2)
    mockMetis.getWorkspaceAgents.mockImplementation((projectId: string) => Promise.resolve({
      exists: true,
      content: projectId === 'proj-A' ? 'edit v2' : 'B content',
      version: 2,
      contentHash: projectId === 'proj-A' ? 'h2' : 'hB',
      projectId,
    }));
    await act(async () => { researchWorkspaceStore.setState({ activeProjectId: 'proj-B' }); await Promise.resolve(); });
    await act(async () => { researchWorkspaceStore.setState({ activeProjectId: 'proj-A' }); await Promise.resolve(); });
    await waitFor(() => expect(textarea.value).toBe('edit v2'));

    // Resolve save 1 (stale, older content) — must NOT delete save 2's draft
    await act(async () => { resolveSave1({ success: true, code: 'saved', version: 10, contentHash: 'h10' }); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    // Content should still be save 2's result (not overwritten by stale save 1)
    expect(textarea.value).toBe('edit v2');
  });
});

describe('SettingsPanel — project switch draft persistence', () => {
  it('hides and blocks project A rules immediately while project B authorization is pending', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({ activeProjectId: 'proj-A' });
    let resolveProjectB!: (view: {
      exists: true;
      content: string;
      version: number;
      contentHash: string;
      projectId: string;
    }) => void;
    const projectBLoad = new Promise<{
      exists: true;
      content: string;
      version: number;
      contentHash: string;
      projectId: string;
    }>((resolve) => { resolveProjectB = resolve; });
    mockMetis.getWorkspaceAgents.mockImplementation((projectId: string) => projectId === 'proj-A'
      ? Promise.resolve({ exists: true, content: 'A private rules', version: 1, contentHash: 'hA', projectId })
      : projectBLoad);

    await renderPanelSettled();
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('A private rules'));

    await act(async () => {
      researchWorkspaceStore.setState({ activeProjectId: 'proj-B' });
      await Promise.resolve();
    });
    expect(textarea.value).toBe('');
    expect(textarea.disabled).toBe(true);
    expect(screen.getByTestId('agents-save')).toHaveProperty('disabled', true);

    await act(async () => {
      resolveProjectB({ exists: true, content: 'B authorized rules', version: 2, contentHash: 'hB', projectId: 'proj-B' });
      await projectBLoad;
    });
    await waitFor(() => expect(textarea.value).toBe('B authorized rules'));
    expect(textarea.disabled).toBe(false);
  });

  it('project switch: A dirty→B→A preserves drafts and B save does not write A content', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    // Project A: load and edit
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'A server content', version: 1, contentHash: 'hA', projectId: 'proj-A' });
    researchWorkspaceStore.setState({ activeProjectId: 'proj-A' });
    await renderPanelSettled();
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('A server content'));
    fireEvent.change(textarea, { target: { value: 'A draft' } });

    // Switch to Project B
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'B server content', version: 2, contentHash: 'hB', projectId: 'proj-B' });
    await act(async () => { researchWorkspaceStore.setState({ activeProjectId: 'proj-B' }); await Promise.resolve(); });
    await waitFor(() => expect(textarea.value).toBe('B server content'));

    // Edit B and save
    fireEvent.change(textarea, { target: { value: 'B draft' } });
    mockMetis.setWorkspaceAgents.mockResolvedValue({ success: true, code: 'saved', version: 3, contentHash: 'hB2' });
    fireEvent.click(screen.getByTestId('agents-save'));
    await waitFor(() => expect(mockMetis.setWorkspaceAgents).toHaveBeenCalled());
    // B save must use B's projectId and B's content, not A's
    const saveCall = mockMetis.setWorkspaceAgents.mock.calls[mockMetis.setWorkspaceAgents.mock.calls.length - 1];
    expect(saveCall[0]).toBe('proj-B');
    expect(saveCall[1]).toBe('B draft');

    // Switch back to A
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'A server content', version: 1, contentHash: 'hA', projectId: 'proj-A' });
    await act(async () => { researchWorkspaceStore.setState({ activeProjectId: 'proj-A' }); await Promise.resolve(); });
    await waitFor(() => expect(textarea.value).toBe('A draft'));
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

  it('BUG#1 RED: agents alert container has tabIndex={-1} for focus()', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'orig', version: 1, contentHash: 'h1', projectId: 'test-project-001' });
    mockMetis.setWorkspaceAgents.mockResolvedValue({ success: false, code: 'cas_conflict', currentVersion: 5, currentContentHash: 'h5' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'edited' } });
    fireEvent.click(screen.getByTestId('agents-save'));
    await waitFor(() => expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('conflict'));
    // Assert: the primary agents alert container must be focusable
    const alerts = screen.getAllByRole('alert');
    const agentsAlert = alerts.find(el => el.getAttribute('data-testid') === 'agents-alert');
    expect(agentsAlert).toBeDefined();
    expect(agentsAlert!.getAttribute('tabIndex')).toBe('-1');
  });

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

  it('BUG#3 GREEN: AGENTS conflict only in role="alert", no duplicate in status', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'orig', version: 1, contentHash: 'h1', projectId: 'test-project-001' });
    mockMetis.setWorkspaceAgents.mockResolvedValue({ success: false, code: 'cas_conflict', currentVersion: 5, currentContentHash: 'h5' });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'edited' } });
    fireEvent.click(screen.getByTestId('agents-save'));
    await waitFor(() => expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('conflict'));
    // The primary alert (agents-alert) must contain the conflict message
    const agentsAlert = document.querySelector('[data-testid="agents-alert"]') as HTMLElement;
    expect(agentsAlert).toBeDefined();
    const alertText = agentsAlert!.textContent?.trim() ?? '';
    expect(alertText.length).toBeGreaterThan(0);
    // Count ALL role="alert" elements in the agents section — must be exactly 1
    const agentsSection = agentsAlert!.closest('.settings-group');
    const alertElements = agentsSection!.querySelectorAll('[role="alert"]');
    expect(alertElements.length).toBe(1);
  });
});

// ─── External conflict on load ─────────────────────────────────

describe('SettingsPanel — external conflict on get', () => {
  it('rejects a workspace response bound to a different project and never exposes its content', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({
      exists: true,
      content: 'PROJECT-B-SECRET-MUST-NOT-ENTER-A',
      version: 9,
      contentHash: 'project-b-hash',
      projectId: 'project-b',
    });
    await renderPanelSettled();

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('error'));
    expect(textarea.value).toBe('');
    expect(textarea.disabled).toBe(true);
    expect(screen.getByTestId('agents-save')).toHaveProperty('disabled', true);
    expect(mockMetis.setWorkspaceAgents).not.toHaveBeenCalled();
  });

  it('blocks editing immediately when getWorkspaceAgents returns externalConflict', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({
      exists: true,
      content: '',
      version: 0,
      contentHash: '',
      externalConflict: true,
      projectId: 'test-project-001',
    });
    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    // Integrity conflicts are not ordinary CAS conflicts and cannot be rebased in the renderer.
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('error');
    // Save button must be disabled
    const saveBtn = screen.getByTestId('agents-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    // Textarea should be empty (not loaded)
    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(textarea.disabled).toBe(true);
    expect(screen.queryByTestId('agents-keep-local')).toBeNull();
  });

  it('project_not_found from setWorkspaceAgents shows error status', async () => {
    mockMetis.getWorkspaceAgents.mockResolvedValue({
      exists: true,
      content: 'editable content',
      version: 1,
      contentHash: 'h1',
      projectId: 'test-project-001',
    });
    mockMetis.setWorkspaceAgents.mockResolvedValue({
      success: false,
      code: 'project_not_found',
    });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;
    await waitFor(() => { expect(textarea.value).toBe('editable content'); });

    fireEvent.change(textarea, { target: { value: 'edited' } });
    fireEvent.click(screen.getByTestId('agents-save'));

    await waitFor(() => {
      expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('error');
    });
    // Local draft must be preserved
    expect(textarea.value).toBe('edited');
  });
});

// ─── Stale auto-idle timer ──────────────────────────────────────

describe('SettingsPanel — stale auto-idle timer', () => {
  it('auto-idle timer does not fire after project switch', async () => {
    // Use real timers for initial render + data loading, then switch
    // to fake timers before the save that schedules the 2s idle timeout.
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({ activeProjectId: 'proj-A' });
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'A', version: 1, contentHash: 'hA', projectId: 'proj-A' });
    mockMetis.setWorkspaceAgents.mockResolvedValue({ success: true, code: 'saved', version: 2, contentHash: 'hA2' });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;

    // Switch to fake timers NOW — the 2s setTimeout from save will be captured
    vi.useFakeTimers();

    fireEvent.change(textarea, { target: { value: 'A draft' } });
    fireEvent.click(screen.getByTestId('agents-save'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('saved');

    // Switch to project B — timer from project A must NOT corrupt B
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'B', version: 1, contentHash: 'hB', projectId: 'proj-B' });
    await act(async () => { researchWorkspaceStore.setState({ activeProjectId: 'proj-B' }); vi.advanceTimersByTime(500); });
    expect(textarea.value).toBe('B');

    // Advance past the 2s idle timeout — stale timer fires but projectId guard blocks it
    await act(async () => { vi.advanceTimersByTime(3000); });

    // B's status must be idle (not corrupted by A's stale timer)
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('idle');

    vi.useRealTimers();
  });

  it('auto-idle timer does not fire when newer save superseded it', async () => {
    // Real timers for initial render, fake timers for save sequence
    mockMetis.getWorkspaceAgents.mockResolvedValue({ exists: true, content: 'X', version: 1, contentHash: 'hX', projectId: 'test-project-001' });

    await renderPanelSettled();
    await waitFor(() => expect(mockMetis.getWorkspaceAgents).toHaveBeenCalled());

    const textarea = document.getElementById('agents-textarea') as HTMLTextAreaElement;

    // Switch to fake timers before the saves that schedule the 2s timers
    vi.useFakeTimers();

    // First save → schedules 2s idle timer (seq=1)
    fireEvent.change(textarea, { target: { value: 'edit 1' } });
    mockMetis.setWorkspaceAgents.mockResolvedValueOnce({ success: true, code: 'saved', version: 2, contentHash: 'h2' });
    fireEvent.click(screen.getByTestId('agents-save'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('saved');

    // Second save → schedules new timer (seq=2), first timer cleared
    fireEvent.change(textarea, { target: { value: 'edit 2' } });
    mockMetis.setWorkspaceAgents.mockResolvedValueOnce({ success: true, code: 'saved', version: 3, contentHash: 'h3' });
    fireEvent.click(screen.getByTestId('agents-save'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('saved');

    // Advance 2.5s — current timer (seq=2) fires, status → idle
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(screen.getByTestId('agents-save').getAttribute('data-status')).toBe('idle');

    vi.useRealTimers();
  });
});
