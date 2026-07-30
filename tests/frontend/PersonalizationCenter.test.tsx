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

beforeEach(() => {
  useMetisStore.setState({ locale: 'en' });
  researchWorkspaceStore.setState({ activeProjectId: null });
  definitions = structuredClone(builtin);
  listPersonalization = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions }));
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
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
});

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
    expect(await screen.findByText('No scenarios yet. Start by creating one.')).toBeDefined();
    expect(screen.queryByText('General research')).toBeNull();
    expect(screen.queryByText('Academic monograph')).toBeNull();
    expect(screen.getByRole('button', { name: /Scenarios/u }).textContent).toContain('0');
    expect(screen.getByText('Automatic truth controls always remain enforced')).toBeDefined();
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
    await screen.findByText('Create your first scenario');
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
    expect(screen.getByRole('option', { name: 'global' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'scenario' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'project' })).toBeNull();
    fireEvent.change(editor, { target: { value: '# Metis.md\n\nCustom rule' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalled());
    const request = savePersonalization.mock.calls.at(-1)![0] as { expectedRevision: number; definition: PersonalizationDefinition };
    expect(request.expectedRevision).toBe(1);
    expect(request.definition.revision).toBe(2);
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
    await screen.findByText('Editable workflow');
    fireEvent.click(document.querySelector('[data-definition-id="user:scenarios/workflow-editor"]') as HTMLButtonElement);
    expect(await screen.findByText('Full Access')).toBeDefined();
    expect(screen.queryByRole('button', { name: /permission|confirm/iu })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(screen.getByDisplayValue('step-2')).toBeDefined();
    fireEvent.change(screen.getByDisplayValue('step-2'), { target: { value: 'audit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => {
      const request = savePersonalization.mock.calls.at(-1)?.[0] as { definition: PersonalizationDefinition };
      expect(request.definition.kind).toBe('scenario');
      if (request.definition.kind === 'scenario') {
        expect(request.definition.workflow.at(-1)?.id).toBe('audit');
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
      sourceCapabilityId: 'fc_personalizationskillpackage_123456789012345678',
    });
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
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
    const definitionButton = await screen.findByText('Pending URL MCP');
    fireEvent.click(definitionButton.closest('[data-definition-id]') as HTMLButtonElement);
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
    const first = await screen.findByText('Export root');
    fireEvent.click(first.closest('[data-definition-id]') as HTMLButtonElement);
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
    await screen.findByText('No scenarios yet. Start by creating one.');
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
    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
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
    const card = (await screen.findByText('Readable picker scenario')).closest('[data-definition-id]') as HTMLButtonElement;
    fireEvent.click(card);

    expect(screen.queryByRole('textbox', { name: 'Agent IDs' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Skill IDs' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'MCP IDs' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Metis.md rule IDs' })).toBeNull();

    fireEvent.click(document.querySelector(`[data-definition-id="${agent.id}"] input`) as HTMLInputElement);
    fireEvent.click(document.querySelector(`[data-definition-id="${skill.id}"] input`) as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const executingAgent = screen.getByRole('combobox', { name: 'Executing agent' }) as HTMLSelectElement;
    expect(executingAgent.value).toBe(agent.id);
    expect(screen.getByRole('option', { name: agent.name })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const saved = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition;
    expect(saved.kind).toBe('scenario');
    if (saved.kind === 'scenario') {
      expect(saved.agentIds).toEqual([agent.id]);
      expect(saved.skillIds).toEqual([skill.id]);
      expect(saved.workflow[0]?.agentId).toBe(agent.id);
    }
  });

  it('saves a readable scenario output plan without splitting commas inside a line', async () => {
    const source = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    definitions.push({
      ...structuredClone(source),
      id: 'user:scenarios/output-plan',
      name: 'Output plan scenario',
      revision: 1,
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      rulesIds: [],
      workflow: [],
      output: { ...source.output, plan: null },
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition);

    render(<PersonalizationCenter />);
    fireEvent.click((await screen.findByText('Output plan scenario')).closest('[data-definition-id]') as HTMLButtonElement);
    fireEvent.change(screen.getByRole('textbox', { name: 'Primary deliverable' }), {
      target: { value: 'Complete journal article' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Supporting artifacts (one per line)' }), {
      target: { value: 'Annotated bibliography, with source notes\nEvidence table' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Quality criteria (one per line)' }), {
      target: { value: 'Every claim has evidence\nMethods are reproducible' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const saved = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition;
    expect(saved.kind).toBe('scenario');
    if (saved.kind === 'scenario') {
      expect(saved.output.plan).toEqual({
        primaryDeliverable: 'Complete journal article',
        supportingArtifacts: ['Annotated bibliography, with source notes', 'Evidence table'],
        qualityCriteria: ['Every claim has evidence', 'Methods are reproducible'],
      });
    }
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
    fireEvent.click((await screen.findByText('Visual schema skill')).closest('[data-definition-id]') as HTMLButtonElement);
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

  it('shows a recoverable load error and retries without remounting the center', async () => {
    listPersonalization
      .mockRejectedValueOnce(new Error('temporary IPC outage'))
      .mockResolvedValueOnce({ ok: true, definitions });
    render(<PersonalizationCenter />);
    expect(await screen.findByText(/Personalization configurations could not be loaded/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No scenarios yet. Start by creating one.')).toBeDefined();
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
    const card = (await screen.findByText('My workflow')).closest('.personalization-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Use in conversation' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('user:scenarios/my-workflow'));
    expect(screen.queryByText('Academic monograph')).toBeNull();
  });
});
