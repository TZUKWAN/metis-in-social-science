import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { projectMetisRulesFromWorkspace } from '../../electron/ProjectMetisRulesBridge.js';
import { hashWorkspaceAgentsContent } from '../../engine/memory/WorkspaceAgentsHash.js';

describe('PersonalizationRuntimeService', () => {
  let db: Database.Database | undefined;
  let service: PersonalizationRuntimeService;
  let repository: PersonalizationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new PersonalizationRepository(db);
    repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    service = new PersonalizationRuntimeService(repository, Buffer.alloc(32, 7));
  });

  afterEach(() => db?.close());

  it('lists factory definitions through a strict request', () => {
    const result = service.list({ contractVersion: 1, includeDisabled: true });
    expect(result.ok).toBe(true);
    expect(result.definitions.length).toBeGreaterThan(12);
    expect(result.definitions.some((definition) => definition.id === 'builtin:scenarios/general-research')).toBe(true);
  });

  it('rejects malformed save and archive requests without mutation', () => {
    expect(service.save({ definition: {} })).toEqual({ ok: false, code: 'invalid_request' });
    expect(service.archive({ contractVersion: 1, id: '../escape', expectedRevision: 1 }))
      .toEqual({ ok: false, code: 'invalid_request' });
  });

  it('forks a built-in skill and resolves the factory scenario', () => {
    const fork = service.fork({
      contractVersion: 1,
      sourceId: 'builtin:skills/literature-review',
      targetId: 'user:skills/my-literature-review',
      author: 'Researcher',
    });
    expect(fork.ok).toBe(true);
    expect(service.get({ contractVersion: 1, id: 'user:skills/my-literature-review' }).definition).not.toBeNull();

    const resolved = service.resolve({
      contractVersion: 1,
      sessionId: 'session-one',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.manifest.truthPolicy).toBe('automatic_required');
      expect(resolved.manifest.fullAccess.perActionConfirmation).toBe(false);
    }
  });

  it('does not expose a workflow for the reserved Presentation scenario', () => {
    const result = service.get({
      contractVersion: 1,
      id: 'builtin:scenarios/presentation-reserved',
    });
    expect(result.definition?.kind).toBe('scenario');
    if (result.definition?.kind === 'scenario') {
      expect(result.definition.enabled).toBe(false);
      expect(result.definition.workflow).toEqual([]);
    }
  });

  it('lists immutable version history through a strict request', () => {
    const result = service.versions({
      contractVersion: 1,
      id: 'builtin:scenarios/general-research',
    });
    expect(result.ok).toBe(true);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]?.revision).toBe(1);
    expect(service.versions({ id: '../escape' })).toEqual({ ok: true, versions: [] });
  });

  it('freezes and reuses the active run manifest across definition changes', () => {
    const request = {
      contractVersion: 1 as const,
      sessionId: 'session-frozen',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
    };
    const first = service.resolveForAgent(request);
    expect(first?.ok).toBe(true);
    const frozenDigest = first?.manifest.manifestDigest;
    const current = repository.get('builtin:scenarios/general-research');
    expect(current?.kind).toBe('scenario');
    // Factory reseeding creates a newer definition revision, but the running
    // session remains bound to its persisted snapshot.
    const reseeded = buildBuiltinPersonalizationDefinitions().map((definition) => (
      definition.id === 'builtin:scenarios/general-research'
        ? { ...definition, description: `${definition.description} Updated.` }
        : definition
    ));
    repository.seedBuiltins(reseeded);
    const second = service.resolveForAgent(request);
    expect(second?.manifest.manifestDigest).toBe(frozenDigest);
    expect(repository.listRunManifests('session-frozen')).toHaveLength(1);
  });

  it('binds authoritative project Metis.md and replaces the session snapshot when that file revision changes', () => {
    const firstMarkdown = '# Metis.md\n\n- Use Chicago citations.\n';
    const firstProjection = projectMetisRulesFromWorkspace({
      exists: true,
      content: firstMarkdown,
      version: 1,
      contentHash: hashWorkspaceAgentsContent(firstMarkdown),
      projectId: 'project-one',
    }, 'project-one');
    expect(firstProjection.ok).toBe(true);
    if (!firstProjection.ok || !firstProjection.definition || !firstProjection.projectRulesId) return;
    const request = {
      contractVersion: 1 as const,
      sessionId: 'session-project-metis',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
      projectRulesId: firstProjection.projectRulesId,
    };
    const first = service.resolveForAgent(request, firstProjection.definition);
    expect(first?.ok).toBe(true);
    expect(first?.manifest.promptStack).toContainEqual(expect.objectContaining({
      sourceId: firstProjection.projectRulesId,
      sourceKind: 'rules',
      precedence: 500,
      content: firstMarkdown,
    }));

    const secondMarkdown = '# Metis.md\n\n- Use APA citations.\n';
    const secondProjection = projectMetisRulesFromWorkspace({
      exists: true,
      content: secondMarkdown,
      version: 2,
      contentHash: hashWorkspaceAgentsContent(secondMarkdown),
      projectId: 'project-one',
    }, 'project-one');
    expect(secondProjection.ok).toBe(true);
    if (!secondProjection.ok || !secondProjection.definition || !secondProjection.projectRulesId) return;
    const second = service.resolveForAgent(request, secondProjection.definition);
    expect(second?.ok).toBe(true);
    expect(second?.manifest.manifestDigest).not.toBe(first?.manifest.manifestDigest);
    expect(second?.manifest.definitionRevisions[secondProjection.projectRulesId]).toBe(2);
    expect(second?.systemPrompt).toContain(secondMarkdown);
    expect(second?.systemPrompt).not.toContain(firstMarkdown);
    expect(repository.listRunManifests('session-project-metis')).toHaveLength(2);
  });

  it('rejects a project rule id without the main-derived definition and removes an old project layer when no file remains', () => {
    const markdown = '# Metis.md\n\n- Preserve quotations exactly.\n';
    const projection = projectMetisRulesFromWorkspace({
      exists: true,
      content: markdown,
      version: 1,
      contentHash: hashWorkspaceAgentsContent(markdown),
      projectId: 'project-one',
    }, 'project-one');
    expect(projection.ok).toBe(true);
    if (!projection.ok || !projection.definition || !projection.projectRulesId) return;
    const boundRequest = {
      contractVersion: 1 as const,
      sessionId: 'session-project-rule-removal',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
      projectRulesId: projection.projectRulesId,
    };
    expect(service.resolveForAgent(boundRequest)).toBeUndefined();
    expect(service.resolveForAgent(boundRequest, projection.definition)?.ok).toBe(true);

    const withoutFile = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'session-project-rule-removal',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
    });
    expect(withoutFile?.ok).toBe(true);
    expect(withoutFile?.manifest.promptStack.some((layer) => layer.precedence === 500)).toBe(false);
    expect(repository.listRunManifests('session-project-rule-removal')).toHaveLength(2);
  });
});
