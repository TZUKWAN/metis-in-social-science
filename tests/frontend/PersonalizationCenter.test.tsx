/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useMetisStore } from '../../src/store.js';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import PersonalizationCenter from '../../src/personalization/PersonalizationCenter.js';

const builtin = buildBuiltinPersonalizationDefinitions();
const PENDING_MCP_INSTALLATION = `mcp_${'c'.repeat(32)}`;

function editableUserDefinition<T extends PersonalizationDefinition>(
  source: T,
  id: string,
  name: string,
): T {
  return {
    ...structuredClone(source),
    id,
    name,
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
  } as T;
}

function pendingUrlMcp(): Extract<PersonalizationDefinition, { kind: 'mcp' }> {
  return {
    contractVersion: 1,
    id: 'url:mcp/center-activation',
    kind: 'mcp',
    name: 'Pending URL MCP',
    description: 'Installed and awaiting a controlled list-only probe.',
    enabled: false,
    tags: ['url', 'pending-probe'],
    revision: 1,
    provenance: {
      origin: 'url',
      author: 'External MCP package',
      version: '1.0.0',
      license: null,
      sourceUrl: 'https://packages.example.org/mcp/manifest.json',
      sourceRevision: PENDING_MCP_INSTALLATION,
      installedDigest: 'c'.repeat(64),
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 10,
      updatedAt: 10,
    },
    sourceMode: 'url',
    transport: 'stdio',
    command: 'metis-managed-mcp',
    args: [PENDING_MCP_INSTALLATION],
    environment: {},
    sourceUrl: 'https://packages.example.org/mcp/manifest.json',
    exposedTools: [],
    workingDirectoryToken: PENDING_MCP_INSTALLATION,
  };
}
let definitions: PersonalizationDefinition[];
let listPersonalization: ReturnType<typeof vi.fn>;
let savePersonalization: ReturnType<typeof vi.fn>;
let forkPersonalization: ReturnType<typeof vi.fn>;
let archivePersonalization: ReturnType<typeof vi.fn>;
let applyPersonalizationExtension: ReturnType<typeof vi.fn>;
let selectFileCapability: ReturnType<typeof vi.fn>;
let exportPersonalizationBundle: ReturnType<typeof vi.fn>;
let importPersonalizationBundle: ReturnType<typeof vi.fn>;
let listPersonalizationSecrets: ReturnType<typeof vi.fn>;
let setPersonalizationSecret: ReturnType<typeof vi.fn>;
let removePersonalizationSecret: ReturnType<typeof vi.fn>;
let fundingTemplate: ReturnType<typeof vi.fn>;
let activatePersonalizationMcp: ReturnType<typeof vi.fn>;
let getWorkspaceAgents: ReturnType<typeof vi.fn>;
let setWorkspaceAgents: ReturnType<typeof vi.fn>;
let aiGenerateScenario: ReturnType<typeof vi.fn>;
let analyzeScenarioMaterials: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useMetisStore.setState({ locale: 'en' });
  researchWorkspaceStore.setState({ activeProjectId: null });
  definitions = structuredClone(builtin);
  listPersonalization = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions: [...definitions] }));
  savePersonalization = vi.fn().mockImplementation((request: { definition: PersonalizationDefinition }) => {
    const existing = definitions.findIndex((item) => item.id === request.definition.id);
    if (existing >= 0) definitions[existing] = request.definition;
    else definitions.push(request.definition);
    return Promise.resolve({ ok: true, code: 'saved', definition: request.definition });
  });
  forkPersonalization = vi.fn().mockImplementation((request: { sourceId: string; targetId: string }) => {
    const source = definitions.find((item) => item.id === request.sourceId)!;
    const copy = {
      ...structuredClone(source),
      id: request.targetId,
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', locallyModified: true, parentId: source.id },
    } as PersonalizationDefinition;
    definitions.push(copy);
    return Promise.resolve({ ok: true, code: 'saved', definition: copy });
  });
  archivePersonalization = vi.fn().mockResolvedValue({ ok: true, code: 'deleted', id: 'user:x' });
  applyPersonalizationExtension = vi.fn().mockResolvedValue({
    ok: true,
    definition: { id: 'user:skills/installed' },
  });
  selectFileCapability = vi.fn().mockResolvedValue({
    success: true,
    capability: {
      capabilityId: 'fc_personalizationskillpackage_123456789012345678',
      kind: 'file',
      mime: 'application/zip',
      displayName: 'review-skill.zip',
      operations: ['file'],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  });
  exportPersonalizationBundle = vi.fn().mockResolvedValue({
    ok: true,
    operationId: '11111111-1111-4111-8111-111111111111',
    action: 'exported',
    bundleDigest: 'a'.repeat(64),
    definitionCount: 2,
  });
  importPersonalizationBundle = vi.fn().mockResolvedValue({
    ok: true,
    operationId: '22222222-2222-4222-8222-222222222222',
    action: 'imported',
    bundleDigest: 'b'.repeat(64),
    definitionCount: 2,
  });
  listPersonalizationSecrets = vi.fn().mockResolvedValue({
    ok: true,
    contractVersion: 1,
    operationId: '33333333-3333-4333-8333-333333333333',
    revision: 0,
    secrets: [],
  });
  setPersonalizationSecret = vi.fn().mockResolvedValue({
    ok: true,
    contractVersion: 1,
    operationId: '44444444-4444-4444-8444-444444444444',
    revision: 1,
    secret: { name: 'ZOTERO_API_KEY', createdAt: 10, updatedAt: 10 },
  });
  removePersonalizationSecret = vi.fn().mockResolvedValue({
    ok: true,
    contractVersion: 1,
    operationId: '55555555-5555-4555-8555-555555555555',
    revision: 2,
    removed: true,
    name: 'ZOTERO_API_KEY',
  });
  fundingTemplate = vi.fn().mockImplementation((request: { action: string; operationId: string; projectId: string }) => Promise.resolve({
    ok: true,
    contractVersion: 1,
    operationId: request.operationId,
    action: request.action,
    ownerId: 'local-user',
    projectId: request.projectId,
    templates: [],
  }));
  activatePersonalizationMcp = vi.fn();
  getWorkspaceAgents = vi.fn().mockImplementation((projectId: string) => Promise.resolve({
    exists: true,
    content: `# ${projectId} Metis.md\n`,
    version: 2,
    contentHash: 'project-rules-digest',
    projectId,
  }));
  aiGenerateScenario = vi.fn().mockResolvedValue({
    ok: false,
    code: 'not_configured',
  });
  analyzeScenarioMaterials = vi.fn().mockResolvedValue({ ok: false, code: 'not_configured' });
  setWorkspaceAgents = vi.fn().mockResolvedValue({
    success: true,
    code: 'saved',
    version: 3,
    contentHash: 'saved-project-rules-digest',
  });
  Object.defineProperty(window, 'metis', {
    configurable: true,
    writable: true,
    value: {
      listPersonalization,
      savePersonalization,
      forkPersonalization,
      archivePersonalization,
      applyPersonalizationExtension,
      selectFileCapability,
      exportPersonalizationBundle,
      importPersonalizationBundle,
      listPersonalizationSecrets,
      setPersonalizationSecret,
      removePersonalizationSecret,
      fundingTemplate,
      activatePersonalizationMcp,
      getWorkspaceAgents,
      setWorkspaceAgents,
      aiGenerateScenario,
      analyzeScenarioMaterials,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
});

async function selectScenarioInWorkbench(name: string | RegExp) {
  // 树形库中同一场景会在「全部」与其所属分组重复出现，取第一个匹配项点击。
  const items = await screen.findAllByText(name);
  const item = items[0]!;
  fireEvent.click(item.closest('[data-testid="sw-scenario-item"]')?.querySelector('button') ?? item.closest('button')!);
}

describe('PersonalizationCenter', () => {
  it('does not background-load authoritative project rules while another personalization tab is active', async () => {
    researchWorkspaceStore.setState({ activeProjectId: 'project-background' });
    render(<PersonalizationCenter />);

    await act(async () => { await Promise.resolve(); });
    expect(getWorkspaceAgents).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /Metis\.md/ }));
    await waitFor(() => expect(getWorkspaceAgents).toHaveBeenCalledWith('project-background'));
  });

  it('retries the same project after a transient rules-load failure when the user reopens the tab', async () => {
    researchWorkspaceStore.setState({ activeProjectId: 'project-retry' });
    getWorkspaceAgents
      .mockRejectedValueOnce(new Error('transient main-process read failure'))
      .mockResolvedValueOnce({
        exists: true,
        content: '# Reauthorized project rule\n',
        version: 3,
        contentHash: 'reauthorized-rule-digest',
        projectId: 'project-retry',
      });
    render(<PersonalizationCenter />);

    fireEvent.click(await screen.findByRole('button', { name: /Metis\.md/ }));
    expect(await screen.findByText('Could not read the current project Metis.md. Your local draft is preserved.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Scenarios/ }));
    expect(screen.queryByTestId('project-metis-rules-textarea')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Metis\.md/ }));

    const textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('# Reauthorized project rule\n'));
    expect(getWorkspaceAgents).toHaveBeenCalledTimes(2);
  });

  it('starts with an empty user library even when legacy factory definitions are returned', async () => {
    render(<PersonalizationCenter />);
    expect(await screen.findAllByText('No scenarios')).toBeDefined();
    expect(screen.queryByText('General research')).toBeNull();
    expect(screen.queryByText('Academic monograph')).toBeNull();
    expect(screen.getByRole('button', { name: /Scenarios/u }).textContent).toContain('0');
    expect(screen.getByText('Automatic truth controls always remain enforced')).toBeDefined();
    expect(screen.getByTestId('scenario-workbench')).toBeDefined();
    expect(listPersonalization).toHaveBeenCalledWith({ contractVersion: 1, includeDisabled: true });
  });

  it('creates a strict Markdown skill for a beginner', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalled());
    const request = savePersonalization.mock.calls[0]![0] as { expectedRevision: number; definition: PersonalizationDefinition };
    expect(request.expectedRevision).toBe(0);
    expect(request.definition.kind).toBe('skill');
    expect(request.definition.id).toMatch(/^user:skills\//u);
    if (request.definition.kind === 'skill') expect(request.definition.sourceMode).toBe('markdown');
  });

  it('does not expose factory-copy actions in the zero-preset product', async () => {
    render(<PersonalizationCenter />);
    await screen.findAllByText('No scenarios');
    expect(screen.queryByRole('button', { name: 'Create editable copy' })).toBeNull();
    expect(forkPersonalization).not.toHaveBeenCalled();
  });

  it('saves edits as a new CAS revision', async () => {
    const source = builtin.find((item) => item.kind === 'rules')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:rules/my-metis',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Metis\.md/ }));
    await screen.findAllByText(custom.name);
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const editor = await screen.findByRole('textbox', { name: 'Metis.md' });
    expect(screen.getByRole('option', { name: 'Global' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Scenario' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Project' })).toBeNull();
    fireEvent.change(editor, { target: { value: '# Metis.md\n\nCustom rule' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalled());
    const request = savePersonalization.mock.calls.at(-1)![0] as { expectedRevision: number; definition: PersonalizationDefinition };
    expect(request.expectedRevision).toBe(1);
    expect(request.definition.revision).toBe(2);
  });

  it('preserves independent drafts across card switches, category switches, and remounts', async () => {
    const source = builtin.find((item) => item.kind === 'agent')!;
    const first = editableUserDefinition(source, 'user:agents/draft-one', 'Draft one agent');
    const second = editableUserDefinition(source, 'user:agents/draft-two', 'Draft two agent');
    definitions.push(first, second);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: first.name })));

    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'First retained draft' },
    });
    expect(await screen.findByText('Draft preserved automatically')).toBeDefined();
    expect(within(document.querySelector(`[data-definition-id="${first.id}"]`)!.closest('.personalization-card') as HTMLElement).getByText('Draft preserved')).toBeDefined();

    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: second.name })));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Second retained draft' },
    });
    expect(await screen.findByText('Draft preserved automatically')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Scenarios/ }));
    fireEvent.click(screen.getByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('First retained draft')).toBeDefined();
    expect(screen.getByText('Preserved draft restored')).toBeDefined();

    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('Second retained draft')).toBeDefined();

    view.unmount();
    expect([...Array(window.localStorage.length)].map((_item, index) => window.localStorage.key(index)))
      .toContain(`metis:personalization-draft:v1:${first.id}`);
    window.sessionStorage.clear();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('First retained draft')).toBeDefined();
    expect(screen.getByText('Preserved draft restored')).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: first.name })));
  });

  it('restores a valid in-progress draft even when a required field is temporarily blank', async () => {
    const source = builtin.find((item) => item.kind === 'agent')!;
    const custom = editableUserDefinition(source, 'user:agents/in-progress-blank-name', 'Blank-name draft');
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: '' } });
    expect(name).toHaveProperty('value', '');
    view.unmount();

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveProperty('value', '');
    expect(screen.getByText('Preserved draft restored')).toBeDefined();
  });

  it('debounces durable draft writes and flushes the latest value across rapid navigation and unmount', async () => {
    const source = builtin.find((item) => item.kind === 'agent')!;
    const first = editableUserDefinition(source, 'user:agents/debounce-one', 'Debounce one');
    const second = editableUserDefinition(source, 'user:agents/debounce-two', 'Debounce two');
    definitions.push(first, second);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: first.name })));

    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'd' } });
    fireEvent.change(description, { target: { value: 'de' } });
    fireEvent.change(description, { target: { value: 'debounced latest' } });
    expect(setItem).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(199); });
    expect(setItem).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${first.id}`)!).draft.description)
      .toBe('debounced latest');

    setItem.mockClear();
    fireEvent.change(description, { target: { value: 'flushed on card switch' } });
    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${first.id}`)!).draft.description)
      .toBe('flushed on card switch');

    setItem.mockClear();
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'flushed on category switch' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Scenarios/ }));
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${second.id}`)!).draft.description)
      .toBe('flushed on category switch');

    fireEvent.click(screen.getByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    setItem.mockClear();
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'flushed on center unmount' },
    });
    view.unmount();
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${first.id}`)!).draft.description)
      .toBe('flushed on center unmount');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('rebases edits made while an earlier save is pending instead of clearing the newer draft', async () => {
    const source = builtin.find((item) => item.kind === 'agent')!;
    const custom = editableUserDefinition(source, 'user:agents/pending-save', 'Pending save agent');
    definitions.push(custom);
    let resolveSave: ((result: {
      ok: true;
      code: 'saved';
      definition: PersonalizationDefinition;
    }) => void) | undefined;
    savePersonalization.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const description = await screen.findByRole('textbox', { name: 'Description' });
    vi.useFakeTimers();
    fireEvent.change(description, { target: { value: 'Submitted revision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(savePersonalization).toHaveBeenCalledTimes(1);
    fireEvent.change(description, { target: { value: 'Edited while save was pending' } });
    expect(screen.getByText('Draft preserved automatically')).toBeDefined();

    const request = savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition };
    definitions = definitions.map((definition) => definition.id === custom.id ? request.definition : definition);
    await act(async () => {
      resolveSave?.({ ok: true, code: 'saved', definition: request.definition });
      await Promise.resolve();
    });
    vi.useRealTimers();

    expect(await screen.findByDisplayValue('Edited while save was pending')).toBeDefined();
    expect(await screen.findByText('Preserved draft restored')).toBeDefined();
    const raw = window.localStorage.getItem(`metis:personalization-draft:v1:${custom.id}`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as { baseRevision: number; draft: PersonalizationDefinition };
    expect(stored.baseRevision).toBe(request.definition.revision);
    expect(stored.draft.revision).toBe(request.definition.revision + 1);
    expect(stored.draft.description).toBe('Edited while save was pending');
  });

  it('rebases edits made after save succeeds but before the saved revision reloads', async () => {
    const source = builtin.find((item) => item.kind === 'agent')!;
    const custom = editableUserDefinition(source, 'user:agents/post-save-edit', 'Post-save edit agent');
    definitions.push(custom);
    let resolveReload: ((value: { ok: true; definitions: PersonalizationDefinition[] }) => void) | undefined;
    listPersonalization
      .mockImplementationOnce(() => Promise.resolve({ ok: true, definitions: [...definitions] }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReload = resolve; }));

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const description = await screen.findByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'Saved revision content' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(2));

    fireEvent.change(description, { target: { value: 'Newer edit during reload' } });
    expect(description).toHaveProperty('value', 'Newer edit during reload');
    expect(await screen.findByText('Draft preserved automatically')).toBeDefined();
    await act(async () => {
      resolveReload?.({ ok: true, definitions: [...definitions] });
      await Promise.resolve();
    });

    expect(await screen.findByDisplayValue('Newer edit during reload')).toBeDefined();
    expect(screen.getByText('Preserved draft restored')).toBeDefined();
    const raw = window.localStorage.getItem(`metis:personalization-draft:v1:${custom.id}`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as { baseRevision: number; draft: PersonalizationDefinition };
    expect(stored.baseRevision).toBe(2);
    expect(stored.draft.revision).toBe(3);
    expect(stored.draft.description).toBe('Newer edit during reload');
  });

  it('clears a retained draft after save and focuses the remounted revision heading', async () => {
    const source = builtin.find((item) => item.kind === 'agent')!;
    const custom = editableUserDefinition(source, 'user:agents/saved-draft', 'Saved draft agent');
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Persisted by the save service' },
    });
    await screen.findByText('Draft preserved automatically');
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: custom.name })));
    expect(screen.queryByText('Draft preserved')).toBeNull();
    expect(screen.queryByText('Preserved draft restored')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveProperty('value', 'Persisted by the save service');

    view.unmount();
    expect(window.localStorage.getItem(`metis:personalization-draft:v1:${custom.id}`)).toBeNull();
    expect(window.sessionStorage.getItem(`metis:personalization-draft:v1:${custom.id}`)).toBeNull();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('Persisted by the save service')).toBeDefined();
    expect(screen.queryByText('Preserved draft restored')).toBeNull();
  });

  it('moves focus to the new definition heading after creation', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    await screen.findByText('No custom definitions yet.');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const heading = await screen.findByRole('heading', { name: 'My Agents' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('scrolls a selected editor into view only when the layout is stacked', async () => {
    const source = builtin.find((item) => item.kind === 'agent')!;
    const first = editableUserDefinition(source, 'user:agents/narrow-scroll', 'Narrow scroll agent');
    const second = editableUserDefinition(source, 'user:agents/desktop-focus', 'Desktop focus agent');
    definitions.push(first, second);
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    let narrow = true;
    const scrollIntoView = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: narrow })),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    const narrowHeading = await screen.findByRole('heading', { name: first.name });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' }));
    expect(scrollIntoView.mock.instances[0]).toBe(narrowHeading);

    view.unmount();
    narrow = false;
    scrollIntoView.mockClear();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: second.name })));
    expect(scrollIntoView).not.toHaveBeenCalled();

    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  it('uses natural localized labels for the workbench and editable enum fields', async () => {
    useMetisStore.setState({ locale: 'zh' });
    const scenarioSource = builtin.find((item) => item.kind === 'scenario')!;
    const rulesSource = builtin.find((item) => item.kind === 'rules')!;
    const skillSource = builtin.find((item) => item.kind === 'skill')!;
    const scenario = editableUserDefinition(scenarioSource, 'user:scenarios/localized-labels', '本地化场景');
    const rules = {
      ...editableUserDefinition(rulesSource, 'user:rules/localized-labels', '本地化规则'),
      scope: 'project',
      scopeId: 'legacy-project',
    } as PersonalizationDefinition;
    const skill = editableUserDefinition(skillSource, 'user:skills/localized-labels', '本地化技能');
    definitions.push(scenario, rules, skill);

    render(<PersonalizationCenter />);
    expect(await screen.findByText('研究场景工作台')).toBeDefined();
    fireEvent.click(screen.getAllByTestId('sw-scenario-item')[0]!);
    fireEvent.click(screen.getByTestId('sw-tab-capability'));
    expect(await screen.findByText('全权限运行：自动执行、实时纠偏、失败不自动回滚外部副作用；真实性层始终强制。')).toBeDefined();

    // UX: 工作台不展示「场景能力」「产物格式」旧字段名。
    expect(screen.queryByRole('combobox', { name: '场景能力' })).toBeNull();

    const memory = screen.getByRole('combobox', { name: '记忆范围' });
    expect(within(memory).getByRole('option', { name: '当前项目' })).toBeDefined();

    fireEvent.click(screen.getAllByRole('button', { name: /Metis\.md/u })[0]!);
    fireEvent.click(document.querySelector(`[data-definition-id="${rules.id}"]`) as HTMLButtonElement);
    const scope = await screen.findByRole('combobox', { name: '规则层级' });
    expect(within(scope).getByRole('option', { name: '全局' })).toBeDefined();
    expect(within(scope).getByRole('option', { name: '场景' })).toBeDefined();
    expect(within(scope).getByRole('option', { name: '项目（非权威旧定义）' })).toBeDefined();
    expect(within(scope).queryByRole('option', { name: 'global' })).toBeNull();
    expect(screen.getByText('请使用上方“打开当前项目 Metis.md”返回独立编辑器。也可将此旧定义转换为全局或场景规则后再保存。')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /技能/u }));
    expect(await screen.findByText('技能', { selector: '.personalization-eyebrow' })).toBeDefined();
    fireEvent.click(document.querySelector(`[data-definition-id="${skill.id}"]`) as HTMLButtonElement);
    fireEvent.click((await screen.findAllByRole('button', { name: '添加字段' }))[0]!);
    const fieldType = screen.getAllByRole('combobox', { name: '类型' })[0]!;
    expect(within(fieldType).getByRole('option', { name: '文本' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '数值' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '整数' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '是 / 否' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '列表' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '对象' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^MCP/u }));
    expect(await screen.findByText('凭据', { selector: '.personalization-eyebrow' })).toBeDefined();
    fireEvent.change(screen.getByRole('combobox', { name: '模式' }), { target: { value: 'mcp_url' } });
    expect(await screen.findByText('粘贴 MCP 清单的 HTTPS 地址，核验通过后才启用。')).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'MCP 清单 HTTPS 地址' })).toBeDefined();
  });

  it('hosts the main-authoritative project Metis.md editor and reacts to the active project', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Metis\.md/ }));
    const textarea = screen.getByRole('textbox', { name: 'Current project Metis.md content' }) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(getWorkspaceAgents).not.toHaveBeenCalled();

    await act(async () => {
      researchWorkspaceStore.setState({ activeProjectId: 'project-authoritative' });
      await Promise.resolve();
    });
    await waitFor(() => expect(textarea.value).toBe('# project-authoritative Metis.md\n'));
    expect(getWorkspaceAgents).toHaveBeenCalledWith('project-authoritative');

    fireEvent.change(textarea, { target: { value: '# Authoritative project rule\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(setWorkspaceAgents).toHaveBeenCalledWith(
      'project-authoritative',
      '# Authoritative project rule\n',
      2,
    ));
    expect(screen.queryByRole('option', { name: 'project' })).toBeNull();
  });

  it('never renders the authoritative project editor beside a global or scenario Metis.md definition form', async () => {
    const source = builtin.find((item) => item.kind === 'rules')!;
    const globalRule = {
      ...editableUserDefinition(source, 'user:rules/global-separation', 'Global separation rule'),
      scope: 'global',
      scopeId: null,
    } as PersonalizationDefinition;
    definitions.push(globalRule);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Metis\.md/u }));
    expect(screen.getByRole('textbox', { name: 'Current project Metis.md content' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Definition editor' })).toBeNull();

    fireEvent.click((await screen.findByText(globalRule.name)).closest('[data-definition-id]') as HTMLButtonElement);
    expect(screen.queryByRole('textbox', { name: 'Current project Metis.md content' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Definition editor' })).toBeDefined();
    expect(screen.getByText('Global Metis.md definition')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Open current project Metis.md' }));
    expect(screen.getByRole('textbox', { name: 'Current project Metis.md content' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Definition editor' })).toBeNull();
  });

  it('prevents a legacy project-scoped definition from impersonating the authoritative file', async () => {
    const source = builtin.find((item) => item.kind === 'rules')!;
    const legacyProjectRule = {
      ...structuredClone(source),
      id: 'user:rules/legacy-project-slot',
      name: 'Legacy project slot',
      revision: 1,
      scope: 'project',
      scopeId: 'user:projects/project-a',
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(legacyProjectRule);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Metis\.md/ }));
    fireEvent.click(await screen.findByText('Legacy project slot'));
    expect(await screen.findByText('This is not the authoritative project Metis.md')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByRole('combobox', { name: 'Rule scope' }), { target: { value: 'global' } });
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => {
      const request = savePersonalization.mock.calls.at(-1)?.[0] as { definition: PersonalizationDefinition };
      expect(request.definition.kind).toBe('rules');
      if (request.definition.kind === 'rules') {
        expect(request.definition.scope).toBe('global');
        expect(request.definition.scopeId).toBeNull();
      }
    });
  });

  it('edits a scenario workflow without exposing permission confirmation settings', async () => {
    const source = builtin.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:scenarios/workflow-editor',
      name: 'Editable workflow',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Editable workflow');
    fireEvent.click(screen.getByTestId('sw-tab-capability'));
    expect(await screen.findByTestId('sw-full-access')).toBeDefined();
    expect(screen.queryByRole('button', { name: /permission|confirm/iu })).toBeNull();
    const steps = () => screen.getAllByTestId('sw-workflow-step');
    const before = steps().length;
    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    expect(steps().length).toBe(before + 1);
    const firstAdded = steps()[before]!;
    const addedId = firstAdded.querySelector<HTMLInputElement>('input[aria-label*="name"]')!.getAttribute('aria-label')!.match(/Step (.+) name/)![1];
    fireEvent.change(firstAdded.querySelector<HTMLInputElement>('input[aria-label*="name"]')!, { target: { value: 'Audit pass' } });
    fireEvent.click(firstAdded.querySelector('button[title="Remove step"]')!);
    expect(steps().length).toBe(before);
    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    const secondAdded = steps()[before]!;
    const secondId = secondAdded.querySelector<HTMLInputElement>('input[aria-label*="name"]')!.getAttribute('aria-label')!.match(/Step (.+) name/)![1];
    fireEvent.click(screen.getByTestId('sw-save'));
    await waitFor(() => {
      const request = savePersonalization.mock.calls.at(-1)?.[0] as { definition: PersonalizationDefinition };
      expect(request.definition.kind).toBe('scenario');
      if (request.definition.kind === 'scenario') {
        const originalIds = request.definition.workflow.slice(0, before).map((step) => step.id);
        expect(request.definition.workflow).toHaveLength(before + 1);
        expect(request.definition.workflow[request.definition.workflow.length - 1]?.name).toBe('New step');
        expect(request.definition.workflow[request.definition.workflow.length - 1]?.dependsOn)
          .toEqual([request.definition.workflow[request.definition.workflow.length - 2]?.id]);
        expect(originalIds.length).toBe(before);
        expect(addedId).toBeTruthy();
        expect(secondId).toBeTruthy();
      }
    });
  });

  it('installs a selected ZIP skill through the main-process extension boundary', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await waitFor(() => expect(selectFileCapability).toHaveBeenCalledWith('personalization-skill-package'));
    expect(await screen.findByText('ZIP: review-skill.zip')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'skill_package',
      expectedRevision: 0,
      expectedId: null,
      sourceCapabilityId: 'fc_personalizationskillpackage_123456789012345678',
    });
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it('discards a consumed package selection after a CAS conflict and requires a fresh selection', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const existing = editableUserDefinition(source, 'user:skills/update-target', 'Update target skill');
    existing.revision = 3;
    definitions.push(existing);
    selectFileCapability
      .mockReset()
      .mockResolvedValueOnce({
        success: true,
        capability: {
          capabilityId: 'fc_firstpackagecapability_123456789012345',
          kind: 'file',
          mime: 'application/zip',
          displayName: 'first-review-skill.zip',
          operations: ['file'],
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        capability: {
          capabilityId: 'fc_freshpackagecapability_123456789012345',
          kind: 'file',
          mime: 'application/zip',
          displayName: 'fresh-review-skill.zip',
          operations: ['file'],
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      });
    applyPersonalizationExtension
      .mockImplementationOnce(() => {
        definitions = definitions.map((definition) => definition.id === existing.id
          ? { ...definition, revision: 4 }
          : definition) as PersonalizationDefinition[];
        return Promise.resolve({
          ok: false,
          mode: 'skill_package',
          code: 'definition_rejected',
          detailCode: 'definition_cas_failed',
          compensated: false,
        });
      })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        definition: definitions.find((definition) => definition.id === existing.id)!,
      }));

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    expect(screen.queryByRole('spinbutton', { name: /revision/u })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Installation target' }), {
      target: { value: existing.id },
    });
    expect(screen.getByText(/Updating “Update target skill”/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await screen.findByText('ZIP: first-review-skill.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));

    expect(await screen.findByText(/select the target and skill package again/u)).toBeDefined();
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      mode: 'skill_package',
      expectedRevision: 3,
      expectedId: existing.id,
      sourceCapabilityId: 'fc_firstpackagecapability_123456789012345',
    });
    await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('combobox', { name: 'Installation target' })).toHaveProperty('value', '');
    expect(screen.getByText('Nothing selected')).toBeDefined();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify and install' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Choose a skill ZIP package or folder first')).toBeDefined();

    fireEvent.change(screen.getByRole('combobox', { name: 'Installation target' }), {
      target: { value: existing.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await screen.findByText('ZIP: fresh-review-skill.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(2));
    expect(applyPersonalizationExtension.mock.calls[1]?.[0]).toMatchObject({
      mode: 'skill_package',
      expectedRevision: 4,
      expectedId: existing.id,
      sourceCapabilityId: 'fc_freshpackagecapability_123456789012345',
    });
  });

  it('shows only Skill targets compatible with the selected installation mode', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const packageTarget = editableUserDefinition(source, 'user:skills/package-target', 'Package target');
    const urlTarget = {
      ...editableUserDefinition(source, 'url:skills/url-target', 'URL target'),
      provenance: {
        ...source.provenance,
        origin: 'url',
        sourceUrl: 'https://example.com/url-target.zip',
        sourceRevision: '1.0.0',
        locallyModified: false,
      },
      sourceMode: 'url',
    } as Extract<PersonalizationDefinition, { kind: 'skill' }>;
    definitions.push(packageTarget, urlTarget);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    const target = screen.getByRole('combobox', { name: 'Installation target' });
    expect(within(target).getByRole('option', { name: packageTarget.name })).toBeDefined();
    expect(within(target).queryByRole('option', { name: urlTarget.name })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'skill_url' } });
    expect(within(target).queryByRole('option', { name: packageTarget.name })).toBeNull();
    expect(within(target).getByRole('option', { name: urlTarget.name })).toBeDefined();
  });

  it('resets the installer mode when switching between Skills and MCP', async () => {
    render(<PersonalizationCenter />);

    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveProperty('value', 'skill_package');
    expect(screen.getByRole('button', { name: 'Choose skill ZIP package' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^MCP/u }));
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveProperty('value', 'mcp_requirements');
    expect(screen.getByRole('textbox', { name: 'Describe what the MCP must do' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Choose skill ZIP package' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Skills/u }));
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveProperty('value', 'skill_package');
    expect(screen.getByRole('button', { name: 'Choose skill ZIP package' })).toBeDefined();
  });

  it('saves an edited Markdown skill through the signed extension service', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/signed-markdown',
      revision: 3,
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const editor = await screen.findByRole('textbox', { name: 'Skill Markdown' });
    fireEvent.change(editor, { target: { value: '# Signed skill\n\nUse bounded evidence.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'skill_markdown',
      expectedRevision: 3,
      id: custom.id,
      markdown: '# Signed skill\n\nUse bounded evidence.',
    });
    expect(savePersonalization).not.toHaveBeenCalled();
  });

  it('submits an MCP Builder requirement without exposing raw command or environment fields', async () => {
    applyPersonalizationExtension.mockResolvedValueOnce({
      ok: true,
      definition: { id: 'generated:mcp/my-mcp' },
    });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    await waitFor(() => expect(listPersonalizationSecrets).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe what the MCP must do' }), {
      target: { value: 'Build a bounded literature metadata lookup tool.' },
    });
    expect(screen.queryByLabelText(/raw command|command arguments|parent environment/iu)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Personalization definition ID' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Generated package ID' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'mcp_requirements',
      definitionId: 'generated:mcp/my-mcp',
      requestedPackageId: 'my-mcp',
      requirement: 'Build a bounded literature metadata lookup tool.',
      expectedRevision: 0,
      runProbe: true,
    });
  });

  it('keeps generated and URL MCP update targets isolated when the installation mode changes', async () => {
    const generated = {
      ...pendingUrlMcp(),
      id: 'generated:mcp/my-mcp',
      name: 'Generated My MCP',
      revision: 2,
      provenance: {
        ...pendingUrlMcp().provenance,
        origin: 'generated',
        sourceUrl: null,
      },
      sourceMode: 'generated',
      sourceUrl: null,
    } as Extract<PersonalizationDefinition, { kind: 'mcp' }>;
    const fromUrl = {
      ...pendingUrlMcp(),
      id: 'url:mcp/my-mcp',
      name: 'URL My MCP',
      revision: 5,
    } as Extract<PersonalizationDefinition, { kind: 'mcp' }>;
    definitions.push(generated, fromUrl);
    applyPersonalizationExtension.mockResolvedValueOnce({
      ok: true,
      definition: fromUrl,
    });

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    const target = screen.getByRole('combobox', { name: 'Installation target' });
    expect(target).toHaveProperty('value', generated.id);
    expect(within(target).queryByRole('option', { name: fromUrl.name })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'mcp_url' } });
    expect(target).toHaveProperty('value', fromUrl.id);
    expect(within(target).queryByRole('option', { name: generated.name })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'MCP manifest HTTPS URL' }), {
      target: { value: 'https://example.com/mcp/manifest.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      mode: 'mcp_url',
      definitionId: fromUrl.id,
      expectedRevision: 5,
    });
  });

  it('wires pending URL MCP activation through an owner-blind request', async () => {
    definitions.push(pendingUrlMcp());
    activatePersonalizationMcp.mockImplementation((request: { operationId: string }) => Promise.resolve({
      ok: false,
      contractVersion: 1,
      operationId: request.operationId,
      code: 'probe_failed',
      compensated: true,
      recoveryPending: false,
    }));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    await waitFor(() => expect(document.querySelector('[data-definition-id="url:mcp/center-activation"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-definition-id="url:mcp/center-activation"]') as HTMLButtonElement);
    const activateButton = document.querySelector('.mcp-activation-panel__action') as HTMLButtonElement;
    expect(activateButton).toBeDefined();
    fireEvent.click(activateButton);
    await waitFor(() => expect(activatePersonalizationMcp).toHaveBeenCalledTimes(1));
    const request = activatePersonalizationMcp.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      contractVersion: 1,
      definitionId: 'url:mcp/center-activation',
      installationId: PENDING_MCP_INSTALLATION,
      expectedRevision: 1,
    });
    expect(Object.keys(request).sort()).toEqual([
      'contractVersion', 'definitionId', 'expectedRevision', 'installationId', 'operationId',
    ]);
    expect(request).not.toHaveProperty('owner');
    expect(request).not.toHaveProperty('evidenceContext');
    expect(request).not.toHaveProperty('sampleCall');
  });

  it('stores MCP credentials through the write-only encrypted vault and clears the input', async () => {
    listPersonalizationSecrets
      .mockResolvedValueOnce({
        ok: true,
        contractVersion: 1,
        operationId: '33333333-3333-4333-8333-333333333333',
        revision: 0,
        secrets: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        contractVersion: 1,
        operationId: '66666666-6666-4666-8666-666666666666',
        revision: 1,
        secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 10, updatedAt: 10 }],
      });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    const nameInput = screen.getByRole('textbox', { name: 'Environment name' });
    const valueInput = screen.getByLabelText('Credential value') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'zotero_api_key' } });
    fireEvent.change(valueInput, { target: { value: 'write-only-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save encrypted' }));
    await waitFor(() => expect(setPersonalizationSecret).toHaveBeenCalledTimes(1));
    expect(setPersonalizationSecret.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      expectedRevision: 0,
      name: 'ZOTERO_API_KEY',
      value: 'write-only-secret',
    });
    await waitFor(() => expect(valueInput.value).toBe(''));
    expect(await screen.findByText('Value hidden', { exact: false })).toBeDefined();
    expect(document.body.textContent).not.toContain('write-only-secret');
  });

  it('imports and exports a selected dependency graph without credential fields', async () => {
    const source = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:scenarios/export-root',
      name: 'Export root',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Export root');
    fireEvent.click(screen.getByRole('button', { name: 'Export selected configuration' }));
    await waitFor(() => expect(exportPersonalizationBundle).toHaveBeenCalledTimes(1));
    const exportRequest = exportPersonalizationBundle.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(exportRequest).toMatchObject({ contractVersion: 1, rootDefinitionIds: ['user:scenarios/export-root'] });
    expect(Object.keys(exportRequest).sort()).toEqual(['contractVersion', 'operationId', 'rootDefinitionIds']);

    fireEvent.click(screen.getByRole('button', { name: 'Import bundle' }));
    await waitFor(() => expect(importPersonalizationBundle).toHaveBeenCalledTimes(1));
    const importRequest = importPersonalizationBundle.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(importRequest).sort()).toEqual(['contractVersion', 'operationId']);
  });

  it('does not inject a funding preset workflow into a blank scenario library', async () => {
    researchWorkspaceStore.setState({ activeProjectId: 'project-funding' });
    render(<PersonalizationCenter />);
    await screen.findAllByText('No scenarios');
    expect(screen.queryByRole('region', { name: 'Funding application templates' })).toBeNull();
    expect(fundingTemplate).not.toHaveBeenCalled();
  });

  it('creates stable ASCII IDs for Chinese names and keeps repeated creations unique', async () => {
    useMetisStore.setState({ locale: 'zh' });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /技能/u }));
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(2));

    const ids = savePersonalization.mock.calls.map(([request]) => (
      request as { definition: PersonalizationDefinition }
    ).definition.id);
    expect(ids).toEqual(['user:skills/custom-skill', 'user:skills/custom-skill-2']);
    expect(ids.every((id) => /^(?:builtin|user|url|generated):[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(id))).toBe(true);
  });

  it('creates a blank custom scenario without silently binding arbitrary definitions', async () => {
    render(<PersonalizationCenter />);
    // 新建场景按钮点击直接创建空白场景（不再有下拉菜单）。
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const request = savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition };
    expect(request.definition.kind).toBe('scenario');
    if (request.definition.kind === 'scenario') {
      expect(request.definition.agentIds).toEqual([]);
      expect(request.definition.skillIds).toEqual([]);
      expect(request.definition.mcpIds).toEqual([]);
      expect(request.definition.rulesIds).toEqual([]);
      expect(request.definition.workflow).toEqual([]);
    }
  });

  it('新建场景：id 被已删除（归档）记录占用时自动换唯一 id 重试，保证创建成功', async () => {
    // 第一次保存：id 被归档记录占用 → revision_conflict；重试换 id 后回落到默认 mock（saved）。
    savePersonalization.mockImplementationOnce(() => Promise.resolve({ ok: false, code: 'revision_conflict', currentRevision: 1 }));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(2));
    const firstId = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition.id;
    const secondId = (savePersonalization.mock.calls[1]![0] as { definition: PersonalizationDefinition }).definition.id;
    // 重试时 id 追加唯一后缀，避开被占用的 id。
    expect(secondId).not.toBe(firstId);
    expect(secondId.startsWith(firstId + '-')).toBe(true);
  });

  it('binds scenario agents and skills by readable choices instead of raw IDs', async () => {
    const builtinAgent = definitions.find((item) => item.kind === 'agent' && item.enabled)!;
    const builtinSkill = definitions.find((item) => item.kind === 'skill' && item.enabled)!;
    const agent = {
      ...structuredClone(builtinAgent),
      id: 'user:agents/readable-agent',
      name: 'Readable Agent',
      provenance: { ...builtinAgent.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    const skill = {
      ...structuredClone(builtinSkill),
      id: 'user:skills/readable-skill',
      name: 'Readable Skill',
      provenance: { ...builtinSkill.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    const source = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:scenarios/readable-picker',
      name: 'Readable picker scenario',
      revision: 1,
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      rulesIds: [],
      workflow: [],
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(agent, skill, custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Readable picker scenario');
    fireEvent.click(screen.getByTestId('sw-tab-capability'));

    // 绑定以可读名称的勾选项呈现，而不是原始 ID 输入框。
    expect(screen.queryByRole('textbox', { name: 'Agent IDs' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Skill IDs' })).toBeNull();
    const agentCheckbox = screen.getAllByTestId('sw-cap-agent')
      .find((input) => input.closest('label')?.textContent?.includes(agent.name)) as HTMLInputElement;
    const skillCheckbox = screen.getAllByTestId('sw-cap-skill')
      .find((input) => input.closest('label')?.textContent?.includes(skill.name)) as HTMLInputElement;
    fireEvent.click(agentCheckbox);
    fireEvent.click(skillCheckbox);

    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    const stepAgentSelect = screen.getAllByTestId('sw-workflow-step')[0]!
      .querySelector('select') as HTMLSelectElement;
    expect(stepAgentSelect.value).toBe(agent.id);
    expect(screen.getByRole('option', { name: agent.name })).toBeDefined();

    fireEvent.click(screen.getByTestId('sw-save'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const saved = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition;
    expect(saved.kind).toBe('scenario');
    if (saved.kind === 'scenario') {
      expect(saved.agentIds).toEqual([agent.id]);
      expect(saved.skillIds).toEqual([skill.id]);
      expect(saved.workflow[0]?.agentId).toBe(agent.id);
    }
  });

  it('allows output-plan fields in any order and validates the primary deliverable only on save', async () => {
    const source = definitions.find((item) => item.kind === 'agent')!;
    definitions.push({
      ...structuredClone(source),
      id: 'user:agents/output-plan',
      name: 'Output plan agent',
      revision: 1,
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      output: { ...source.output, plan: null },
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/u }));
    fireEvent.click((await screen.findByText('Output plan agent')).closest('[data-definition-id]') as HTMLButtonElement);
    const supporting = screen.getByRole('textbox', { name: 'Supporting artifacts (one per line)' });
    const quality = screen.getByRole('textbox', { name: 'Quality criteria (one per line)' });
    expect(supporting).toHaveProperty('disabled', false);
    expect(quality).toHaveProperty('disabled', false);
    fireEvent.change(supporting, {
      target: { value: 'Annotated bibliography, with source notes\nEvidence table' },
    });
    fireEvent.change(quality, {
      target: { value: 'Every claim has evidence\nMethods are reproducible' },
    });
    expect(screen.getByText(/Add the primary deliverable before saving/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(await screen.findByText(/Primary deliverable is required/u)).toBeDefined();
    expect(savePersonalization).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Primary deliverable' }), {
      target: { value: 'Complete journal article' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const saved = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition;
    expect(saved.kind).toBe('agent');
    if (saved.kind === 'agent') {
      expect(saved.output.plan).toEqual({
        primaryDeliverable: 'Complete journal article',
        supportingArtifacts: ['Annotated bibliography, with source notes', 'Evidence table'],
        qualityCriteria: ['Every claim has evidence', 'Methods are reproducible'],
      });
    }
  });

  it('normalizes an output plan to null when all three fields become empty', async () => {
    const source = definitions.find((item) => item.kind === 'agent')!;
    definitions.push({
      ...structuredClone(source),
      id: 'user:agents/empty-output-plan',
      name: 'Empty output plan agent',
      revision: 1,
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      output: {
        ...source.output,
        plan: {
          primaryDeliverable: 'Draft article',
          supportingArtifacts: ['Evidence table'],
          qualityCriteria: ['Every claim is supported'],
        },
      },
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/u }));
    fireEvent.click((await screen.findByText('Empty output plan agent')).closest('[data-definition-id]') as HTMLButtonElement);
    fireEvent.change(screen.getByRole('textbox', { name: 'Primary deliverable' }), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Supporting artifacts (one per line)' }), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Quality criteria (one per line)' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const saved = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition;
    expect(saved.kind).toBe('agent');
    if (saved.kind === 'agent') expect(saved.output.plan).toBeNull();
  });

  it('builds strict Skill input and output structures through visual fields without raw JSON', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    definitions.push({
      ...structuredClone(source),
      id: 'user:skills/visual-schema',
      name: 'Visual schema skill',
      revision: 1,
      inputSchema: null,
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector('[data-definition-id="user:skills/visual-schema"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-definition-id="user:skills/visual-schema"]') as HTMLButtonElement);
    expect(screen.queryByRole('textbox', { name: /JSON/u })).toBeNull();

    let addButtons = screen.getAllByRole('button', { name: 'Add field' });
    fireEvent.click(addButtons[0]!);
    let names = screen.getAllByRole('textbox', { name: 'Field name' });
    fireEvent.change(names[0]!, { target: { value: 'research_question' } });
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Required' })[0]!);

    addButtons = screen.getAllByRole('button', { name: 'Add field' });
    fireEvent.click(addButtons[1]!);
    names = screen.getAllByRole('textbox', { name: 'Field name' });
    fireEvent.change(names[1]!, { target: { value: 'findings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    const request = applyPersonalizationExtension.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { research_question: { type: 'string' } },
      required: ['research_question'],
    });
    expect(request.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { findings: { type: 'string' } },
      required: [],
    });
  });

  it('preserves an invalid visual field name and blocks saving until the user fixes it', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/invalid-visual-field',
      name: 'Invalid visual field skill',
      revision: 1,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { topic: { type: 'string' } },
        required: [],
      },
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'invalid field name' },
    });

    expect(screen.getByRole('textbox', { name: 'Field name' })).toHaveProperty('value', 'invalid field name');
    expect(screen.getByText('Field names must be unique and start with a letter or underscore.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', true);
    expect(applyPersonalizationExtension).not.toHaveBeenCalled();

    view.unmount();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('invalid field name')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'research_topic' },
    });
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect((applyPersonalizationExtension.mock.calls[0]![0] as { inputSchema: unknown }).inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { research_topic: { type: 'string' } },
      required: [],
    });
  });

  it('keeps advanced schemas read-only until the user explicitly replaces them', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    const advancedSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: { type: 'array', items: { type: 'string' } },
        method: { type: 'string', enum: ['qualitative', 'quantitative'], default: 'qualitative' },
        options: {
          type: 'object',
          additionalProperties: false,
          properties: { includeAppendix: { type: 'boolean' } },
          required: [],
        },
      },
      required: ['sources'],
    };
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/advanced-schema',
      name: 'Advanced schema skill',
      revision: 1,
      inputSchema: advancedSchema,
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(screen.getByText('Existing advanced schema preserved')).toBeDefined();
    expect(screen.queryByDisplayValue('sources')).toBeNull();
    let inputEditor = screen.getByRole('group', { name: 'Input fields' });
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Replace with visual fields' }));
    expect(screen.getByText('Visual replacement not applied')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', true);
    inputEditor = screen.getByRole('group', { name: 'Input fields' });
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Add field' }));
    fireEvent.change(within(inputEditor).getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'replacement_topic' },
    });
    view.unmount();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('replacement_topic')).toBeDefined();
    expect(screen.getByText('Visual replacement not applied')).toBeDefined();
    inputEditor = screen.getByRole('group', { name: 'Input fields' });
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Cancel replacement' }));
    expect(screen.getByText('Existing advanced schema preserved')).toBeDefined();
    expect(screen.queryByDisplayValue('replacement_topic')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect((applyPersonalizationExtension.mock.calls[0]![0] as { inputSchema: unknown }).inputSchema)
      .toEqual(advancedSchema);
  });

  it('distinguishes a strict empty-object schema from removing all fields from no schema', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    const strictEmptyObject = {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    };
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/empty-schema-semantics',
      name: 'Empty schema semantics skill',
      revision: 1,
      inputSchema: strictEmptyObject,
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const inputEditor = screen.getByRole('group', { name: 'Input fields' });
    const outputEditor = screen.getByRole('group', { name: 'Output fields' });

    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Add field' }));
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(outputEditor).getByRole('button', { name: 'Add field' }));
    fireEvent.click(within(outputEditor).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    const request = applyPersonalizationExtension.mock.calls[0]![0] as {
      inputSchema: unknown;
      outputSchema: unknown;
    };
    expect(request.inputSchema).toEqual(strictEmptyObject);
    expect(request.outputSchema).toBeNull();
  });

  it('shows a recoverable load error and retries without remounting the center', async () => {
    listPersonalization
      .mockRejectedValueOnce(new Error('temporary IPC outage'))
      .mockResolvedValueOnce({ ok: true, definitions });
    render(<PersonalizationCenter />);
    expect(await screen.findByText(/Personalization configurations could not be loaded/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByText('No scenarios')).toBeDefined();
    expect(screen.queryByText('General research')).toBeNull();
    expect(listPersonalization).toHaveBeenCalledTimes(2);
  });

  it('preserves an edited draft and re-enables save after an IPC rejection', async () => {
    const source = definitions.find((item) => item.kind === 'agent')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:agents/retry-save',
      name: 'Retry save agent',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    savePersonalization.mockRejectedValueOnce(new Error('main process disconnected'));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Agents/ }));
    fireEvent.click((await screen.findByText('Retry save agent')).closest('[data-definition-id]') as HTMLButtonElement);
    const description = screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: 'Local draft must survive.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(await screen.findByText(/Save did not complete/u)).toBeDefined();
    expect(description.value).toBe('Local draft must survive.');
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', false);
  });

  it('recovers the installer UI after a rejected extension request', async () => {
    applyPersonalizationExtension.mockRejectedValueOnce(new Error('installer IPC unavailable'));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await screen.findByText('ZIP: review-skill.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    expect(await screen.findByText(/Installation did not complete/u)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Verify and install' })).toHaveProperty('disabled', false);
  });

  it('hands a user-created scenario to conversation without exposing presets', async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const source = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    definitions.push({
      ...structuredClone(source),
      id: 'user:scenarios/my-workflow',
      name: 'My workflow',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition);
    render(<PersonalizationCenter onActivateScenario={activate} />);
    await selectScenarioInWorkbench('My workflow');
    fireEvent.click(screen.getByTestId('sw-use'));
    fireEvent.click(screen.getByTestId('sw-use-current'));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('user:scenarios/my-workflow'));
    expect(screen.queryByText('Academic monograph')).toBeNull();
  });

  it('keeps zero-Agent scenarios editable but only enables conversation use after an Agent is bound', async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const scenarioSource = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const agentSource = definitions.find((item) => item.kind === 'agent')!;
    const agent = editableUserDefinition(agentSource, 'user:agents/single-agent', 'Single Agent');
    const emptyScenario = {
      ...editableUserDefinition(scenarioSource, 'user:scenarios/empty-agent', 'Empty Agent scenario'),
      agentIds: [],
      workflow: [],
    } as PersonalizationDefinition;
    const singleAgentScenario = {
      ...editableUserDefinition(scenarioSource, 'user:scenarios/single-agent', 'Single Agent scenario'),
      agentIds: [agent.id],
      workflow: [],
    } as PersonalizationDefinition;
    definitions.push(agent, emptyScenario, singleAgentScenario);

    render(<PersonalizationCenter onActivateScenario={activate} />);
    await selectScenarioInWorkbench('Empty Agent scenario');
    const nameInput = await screen.findByDisplayValue('Empty Agent scenario');
    expect(nameInput).toBeDefined();
    fireEvent.click(screen.getByTestId('sw-use'));
    const emptyUseButton = screen.getByTestId('sw-use-current');
    expect(emptyUseButton).toHaveProperty('disabled', true);
    expect(emptyUseButton.getAttribute('title')).toContain('Bind at least one Agent');
    fireEvent.click(screen.getByTestId('sw-use'));
    expect(activate).not.toHaveBeenCalled();

    await selectScenarioInWorkbench('Single Agent scenario');
    fireEvent.click(screen.getByTestId('sw-use'));
    const singleAgentUseButton = screen.getByTestId('sw-use-current');
    expect(singleAgentUseButton).toHaveProperty('disabled', false);
    fireEvent.click(singleAgentUseButton);
    await waitFor(() => expect(activate).toHaveBeenCalledWith('user:scenarios/single-agent'));
  });

  it('requires one Agent for an output-planned scenario without workflow but permits routed multi-Agent workflows', async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const scenarioSource = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const agentSource = definitions.find((item) => item.kind === 'agent')!;
    const firstAgent = editableUserDefinition(agentSource, 'user:agents/plan-first', 'Plan First Agent');
    const secondAgent = editableUserDefinition(agentSource, 'user:agents/plan-second', 'Plan Second Agent');
    const plannedOutput = {
      ...scenarioSource.output,
      plan: {
        primaryDeliverable: 'Complete article',
        supportingArtifacts: [],
        qualityCriteria: [],
      },
    };
    const ambiguous = {
      ...editableUserDefinition(scenarioSource, 'user:scenarios/ambiguous-plan', 'Ambiguous plan'),
      agentIds: [firstAgent.id, secondAgent.id],
      workflow: [],
      output: plannedOutput,
    } as PersonalizationDefinition;
    const routed = {
      ...editableUserDefinition(scenarioSource, 'user:scenarios/routed-plan', 'Routed plan'),
      agentIds: [firstAgent.id, secondAgent.id],
      workflow: [{
        id: 'draft',
        name: 'Draft',
        description: 'Produce the routed draft.',
        agentId: firstAgent.id,
        skillIds: [],
        toolIds: [],
        mcpIds: [],
        dependsOn: [],
        maxTurns: 12,
      }],
      output: plannedOutput,
    } as PersonalizationDefinition;
    definitions.push(firstAgent, secondAgent, ambiguous, routed);

    render(<PersonalizationCenter onActivateScenario={activate} />);
    await selectScenarioInWorkbench(ambiguous.name);
    fireEvent.click(screen.getByTestId('sw-use'));
    const ambiguousUse = screen.getByTestId('sw-use-current');
    expect(ambiguousUse).toHaveProperty('disabled', true);
    expect(ambiguousUse.getAttribute('title')).toMatch(/Bind exactly one Agent, or add workflow steps/u);
    fireEvent.click(screen.getByTestId('sw-use'));
    expect(activate).not.toHaveBeenCalledWith(ambiguous.id);

    await selectScenarioInWorkbench(routed.name);
    fireEvent.click(screen.getByTestId('sw-use'));
    const routedUse = screen.getByTestId('sw-use-current');
    expect(routedUse).toHaveProperty('disabled', false);
    fireEvent.click(routedUse);
    await waitFor(() => expect(activate).toHaveBeenCalledWith(routed.id));
  });

  it('AI-assisted creation generates agents and a scenario, then selects it in the workbench', async () => {
    analyzeScenarioMaterials.mockResolvedValue({
      ok: true,
      result: {
        summary: {
          deliverableType: 'survey_report',
          deliverableTypeLabel: '调研报告',
          structureTitles: ['题目', '摘要', '1 引言'],
          hardRuleCount: 2,
          writingPrincipleCount: 3,
          methods: ['档案分析'],
          adjustable: ['主体章节'],
          recommended: { agents: 1, skills: 2, mcps: 0, rules: 1 },
        },
        materials: [],
        draft: {
          name: 'AI Archive Scenario',
          description: 'Analyze local archives and build a claim network.',
          triggerPhrases: ['archive'],
          deliverableType: 'survey_report',
          deliverableTypeLabel: '调研报告',
          sections: [
            { id: 'title', title: '题目', kind: 'title', status: 'locked' },
            { id: 'c1', title: '1 引言', kind: 'chapter', status: 'required', requirements: ['研究缺口'] },
          ],
          structurePolicy: { defaultSections: 3, suggestedMin: 3, suggestedMax: 5 },
          writingRules: ['引用必须真实可查'],
          agents: [{
            name: 'Archivist',
            role: 'Evidence extraction',
            systemPrompt: 'Extract evidence from archives and mark source boundaries.',
            skillIds: [],
            toolIds: ['list_sources', 'extract_evidence'],
            mcpIds: [],
            maxTurns: 12,
          }],
          workflow: [
            { name: 'List catalogs', description: 'List archive catalogs.', agent: 'Archivist', skillIds: [], toolIds: ['list_sources'], mcpIds: [], maxTurns: 8 },
            { name: 'Extract evidence', description: 'Extract evidence excerpts.', agent: 'Archivist', skillIds: [], toolIds: ['extract_evidence'], mcpIds: [], maxTurns: 8 },
          ],
          rulesMarkdown: '',
        },
      },
    });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-ai-create'));
    fireEvent.change(await screen.findByTestId('scai-description'), { target: { value: 'Analyze local historical archives and build a claim network.' } });
    fireEvent.click(screen.getByTestId('scai-analyze'));
    expect(await screen.findByTestId('scai-summary')).toBeDefined();
    fireEvent.click(screen.getByTestId('scai-generate'));
    await waitFor(() => expect(savePersonalization.mock.calls.length).toBeGreaterThanOrEqual(2));

    const calls = savePersonalization.mock.calls.map(
      (call) => (call[0] as { definition: PersonalizationDefinition }).definition,
    );
    const savedAgents = calls.filter((definition) => definition.kind === 'agent');
    const savedScenarios = calls.filter((definition) => definition.kind === 'scenario');
    expect(savedAgents).toHaveLength(1);
    expect(savedScenarios).toHaveLength(1);
    const scenario = savedScenarios[0]!;
    expect(scenario.name).toBe('AI Archive Scenario');
    expect(scenario.agentIds).toContain(savedAgents[0]!.id);
    expect(scenario.workflow).toHaveLength(2);
    expect(scenario.workflow[0]!.agentId).toBe(savedAgents[0]!.id);
    expect(scenario.workflow[1]!.dependsOn).toContain(scenario.workflow[0]!.id);
    // 成果结构与写作规范进入场景定义（场景真正驱动执行的数据基础）。
    expect(scenario.deliverable?.type).toBe('survey_report');
    expect(scenario.deliverable?.sections?.[1]?.requirements).toContain('研究缺口');
    expect(scenario.writingRules).toContain('引用必须真实可查');

    // 生成后选中新场景，工作台直接展示。
    expect(await screen.findByDisplayValue('AI Archive Scenario')).toBeDefined();
  });

  it('scenario editor no longer shows capability or artifact format fields', async () => {
    const source = builtin.find((item) => item.kind === 'scenario')!;
    const custom = editableUserDefinition(source, 'user:scenarios/cleanup', 'Cleanup scenario');
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Cleanup scenario');
    expect(await screen.findByDisplayValue('Cleanup scenario')).toBeDefined();
    expect(screen.queryByText('Scenario capability')).toBeNull();
    expect(screen.queryByText('Artifact format')).toBeNull();
  });

  it('workflow add-step stays disabled until an agent is bound', async () => {
    const source = builtin.find((item) => item.kind === 'scenario')!;
    const custom = {
      ...editableUserDefinition(source, 'user:scenarios/gating', 'Gating scenario'),
      agentIds: [],
      workflow: [],
    } as PersonalizationDefinition;
    definitions.push(custom);
    const agentSource = builtin.find((item) => item.kind === 'agent')!;
    const agent = editableUserDefinition(agentSource, 'user:agents/gating-agent', 'Gating agent');
    definitions.push(agent);

    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Gating scenario');
    fireEvent.click(screen.getByTestId('sw-tab-capability'));
    const addStep = await screen.findByTestId('sw-workflow-add');
    expect(addStep).toHaveProperty('disabled', true);

    // 勾选智能体后步骤添加可用。
    const agentCheckbox = screen.getAllByTestId('sw-cap-agent')
      .find((input) => input.closest('label')?.textContent?.includes(agent.name)) as HTMLInputElement;
    fireEvent.click(agentCheckbox);
    await waitFor(() => expect(screen.getByTestId('sw-workflow-add')).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    expect(screen.getAllByTestId('sw-workflow-step').length).toBe(1);
  });

  it('scenario editor offers one simplified deliverable field', async () => {
    const source = builtin.find((item) => item.kind === 'scenario')!;
    const custom = editableUserDefinition(source, 'user:scenarios/deliverable', 'Deliverable scenario');
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Deliverable scenario');
    fireEvent.click(screen.getByTestId('sw-tab-capability'));
    const field = await screen.findByRole('textbox', { name: 'Primary deliverable' });
    fireEvent.change(field, { target: { value: 'A review report' } });
    fireEvent.click(screen.getByTestId('sw-save'));
    await waitFor(() => {
      const lastCall = savePersonalization.mock.calls.at(-1)![0] as { definition: PersonalizationDefinition };
      expect(lastCall.definition.output.plan?.primaryDeliverable).toBe('A review report');
    });
  });

  it('AI-assisted creation surfaces a friendly error when analysis fails', async () => {
    analyzeScenarioMaterials.mockResolvedValue({ ok: false, code: 'parse_failed' });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-ai-create'));
    fireEvent.change(await screen.findByTestId('scai-description'), { target: { value: 'Analyze archives' } });
    fireEvent.click(screen.getByTestId('scai-analyze'));
    const status = await screen.findByTestId('scai-status');
    await waitFor(() => expect(status.textContent).toMatch(/parse_failed/u));
  });

  it('AI-assisted creation also saves the scenario memory doc and carries the deliverable structure', async () => {
    analyzeScenarioMaterials.mockResolvedValue({
      ok: true,
      result: {
        summary: {
          deliverableType: 'theory_paper',
          deliverableTypeLabel: '纯理论论文',
          structureTitles: ['题目', '摘要', '关键词'],
          hardRuleCount: 1,
          writingPrincipleCount: 2,
          methods: ['概念分析'],
          adjustable: ['主体章节'],
          recommended: { agents: 1, skills: 0, mcps: 0, rules: 1 },
        },
        materials: [],
        draft: {
          name: 'Archive Memory Scenario',
          description: 'Analyze archives.',
          triggerPhrases: ['archive'],
          deliverableType: 'theory_paper',
          deliverableTypeLabel: '纯理论论文',
          sections: [
            { id: 'title', title: '题目', kind: 'title', status: 'locked' },
            { id: 'abs', title: '摘要', kind: 'abstract', status: 'required' },
            { id: 'kw', title: '关键词', kind: 'keywords', status: 'required' },
          ],
          writingRules: [],
          agents: [{
            name: 'Archivist', role: 'Extraction', systemPrompt: 'Extract evidence.', skillIds: [], toolIds: [], mcpIds: [], maxTurns: 12,
          }],
          workflow: [{ name: 'List', description: 'List catalogs.', agent: 'Archivist', skillIds: [], toolIds: [], mcpIds: [], maxTurns: 8 }],
          rulesMarkdown: '## 研究边界\n只使用地方档案作为证据来源。',
        },
      },
    });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-ai-create'));
    fireEvent.change(await screen.findByTestId('scai-description'), { target: { value: 'Archive memory analysis scenario' } });
    fireEvent.click(screen.getByTestId('scai-analyze'));
    await screen.findByTestId('scai-summary');
    fireEvent.click(screen.getByTestId('scai-generate'));

    const savedDefinitions = () => savePersonalization.mock.calls.map(
      (call) => (call[0] as { definition: PersonalizationDefinition }).definition,
    );
    await waitFor(() => {
      expect(savedDefinitions().filter((d) => d.kind === 'rules')).toHaveLength(1);
    });
    // 场景保存两次：首次创建 + 绑定规则后的版本递增更新。
    const savedScenarios = savedDefinitions().filter((d) => d.kind === 'scenario');
    expect(savedScenarios.length).toBe(2);
    const scenario = savedScenarios.at(-1)!;
    const rules = savedDefinitions().find((d) => d.kind === 'rules') as unknown as {
      id: string;
      scope: string;
      scopeId: string | null;
      markdown: string;
    };
    expect(rules.scope).toBe('scenario');
    expect(rules.scopeId).toBe(scenario.id);
    expect(rules.markdown).toContain('只使用地方档案作为证据来源');
    expect(scenario.rulesIds).toContain(rules.id);
    // 论文结构不再另存为独立模板：作为成果结构进入场景本身（供对话与自主科研直接执行）。
    expect(scenario.deliverable?.sections?.map((section) => section.title)).toEqual(['题目', '摘要', '关键词']);
  });

  it('template recognition parses a pasted template into editable sections and saves it', async () => {
    const aiParsePaperTemplate = vi.fn().mockResolvedValue({
      ok: true,
      sections: [
        { title: '引言', instruction: '交代背景与问题。' },
        { title: '文献综述', instruction: '梳理已有研究。' },
        { title: '结论', instruction: '总结。' },
      ],
    });
    const structureSave = vi.fn().mockResolvedValue({ ok: true });
    Object.assign(window.metis, { aiParsePaperTemplate, structureSave });
    render(<PersonalizationCenter />);
    // 模板识别入口在「新建场景」菜单中。
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    fireEvent.click(await screen.findByTestId('sw-new-template'));
    await screen.findByTestId('template-parse-panel');

    fireEvent.change(screen.getByTestId('template-parse-input'), {
      target: { value: '一、引言…… 二、文献综述…… 三、结论……' },
    });
    fireEvent.click(screen.getByTestId('template-parse-submit'));

    await waitFor(() => {
      expect(aiParsePaperTemplate).toHaveBeenCalledWith({ text: expect.stringContaining('引言') });
    });
    await waitFor(() => expect(screen.getAllByTestId('template-section').length).toBe(3));
    expect(screen.getByTestId('template-parse-status').textContent).toContain('3 sections');

    // 逐节修改写作指引后保存为论文结构。
    const instructionInputs = screen.getAllByRole('textbox', { name: /Section .* writing guide/u });
    fireEvent.change(instructionInputs[1]!, { target: { value: '按时间顺序梳理已有研究。' } });
    fireEvent.change(screen.getByTestId('template-name-input'), { target: { value: '国社科模板' } });
    fireEvent.click(screen.getByTestId('template-save'));

    await waitFor(() => expect(structureSave).toHaveBeenCalledTimes(1));
    const saved = structureSave.mock.calls[0]![0] as { name: string; sections: Array<{ title: string; instruction: string }> };
    expect(saved.name).toBe('国社科模板');
    expect(saved.sections).toHaveLength(3);
    expect(saved.sections[1]!.instruction).toBe('按时间顺序梳理已有研究。');
  });
});
