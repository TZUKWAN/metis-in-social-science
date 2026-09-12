/**
 * Artifact domain IPC registrar — Task 3 §4.
 * Migrated verbatim from `electron/main.ts` setupIPC(); channel names, decode
 * contracts, capability checks and recovery shapes unchanged.
 */

import {
  RuntimeIdSchema,
} from '../../engine/runtime/ChatRuntimeContract.js';
import { randomUUID } from 'node:crypto';
import {
  ArtifactContentSchema,
  createArtifactChartRegenerateRecovery,
  decodeArtifactChartRegenerateRequest,
  decodeArtifactChartRegenerateResponse,
  decodeArtifactContentRequest,
  decodeArtifactContentResponse,
  decodeArtifactCreateRequest,
  decodeArtifactCreatedNotification,
  decodeArtifactListResponse,
  decodeArtifactMutationResult,
} from '../../engine/runtime/ArtifactRuntimeContract.js';
import type { DomainIpcContext } from './DomainIpcContext.js';
import { executionOwnerFor, mimeForLocalFile } from './sharedGuards.js';

export function registerArtifactIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, store, researchRepository } = ctx;
  const fileCapabilities = () => ctx.fileCapabilities();
  const dom = ctx.registry.domain('artifact', ['artifact:']);

  // ── Artifacts ───────────────────────────────────────────
  dom.handle('artifact:create', (event, rawRecord: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const decoded = decodeArtifactCreateRequest(rawRecord);
      if (!decoded.ok || !store()) return decodeArtifactMutationResult(null);
      const source = decoded.value.sourceCapabilityId
        ? fileCapabilities().resolve({
            capabilityId: decoded.value.sourceCapabilityId,
            operation: 'read',
            maxBytes: 1,
          }, owner)
        : undefined;
      if (source && !source.ok) return decodeArtifactMutationResult({ success: false, code: 'rejected' });
      const createdAt = Date.now();
      store()!.createArtifact({
        id: decoded.value.id,
        sessionId: decoded.value.sessionId,
        name: decoded.value.name,
        type: decoded.value.type,
        path: source?.ok ? source.resolvedPath : undefined,
        size: decoded.value.size,
        metadata: {},
      });
      const notification = decodeArtifactCreatedNotification({
        artifactId: decoded.value.id,
        sessionId: decoded.value.sessionId,
        name: decoded.value.name,
        type: decoded.value.type,
        size: decoded.value.size,
        contentAvailable: false,
        sourceCapability: source?.ok ? source.capability : undefined,
        createdAt,
      });
      if (notification.ok) event.sender.send('artifact:created', notification.value);
      return decodeArtifactMutationResult({ success: true, code: 'created' });
    } catch {
      return decodeArtifactMutationResult(null);
    }
  });
  dom.handle('artifact:list', (event, rawSessionId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const sessionId = RuntimeIdSchema.parse(rawSessionId);
      const items = (store()?.listArtifacts(sessionId) ?? []).map((item) => {
        const issued = item.path
          ? fileCapabilities().issue({
              path: item.path,
              kind: 'file',
              mime: mimeForLocalFile(item.path),
              displayName: item.name,
              operations: ['file', 'folder', 'read', 'extract'],
            }, owner)
          : undefined;
        return {
          id: item.id,
          sessionId: item.sessionId,
          name: item.name,
          type: item.type,
          size: item.size,
          contentAvailable: item.contentAvailable,
          sourceCapability: issued?.success ? issued.capability : undefined,
          createdAt: item.createdAt,
        };
      });
      return decodeArtifactListResponse({ success: true, items });
    } catch {
      return decodeArtifactListResponse(null);
    }
  });
  dom.handle('artifact:get-content', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeArtifactContentRequest(rawRequest);
      if (!decoded.ok || !store()) return decodeArtifactContentResponse(null);
      const artifact = store()!.getArtifactContent(
        decoded.value.artifactId,
        decoded.value.sessionId,
      );
      if (!artifact) {
        return decodeArtifactContentResponse({ success: false, code: 'not_found' });
      }
      return decodeArtifactContentResponse({ success: true, ...artifact });
    } catch {
      return decodeArtifactContentResponse(null);
    }
  });
  dom.handle('artifact:regenerate-chart', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeArtifactChartRegenerateRequest(rawRequest);
      const persistence = store();
      const provider = ctx.provider();
      if (!decoded.ok || !persistence) return createArtifactChartRegenerateRecovery();
      const request = decoded.value;
      const original = persistence.getArtifactContent(request.artifactId, request.sessionId);
      if (!original) {
        return decodeArtifactChartRegenerateResponse({ success: false, code: 'not_found' });
      }
      if (!request.sourceData.trim()) {
        return decodeArtifactChartRegenerateResponse({ success: false, code: 'source_data_required' });
      }
      if (!provider) {
        return decodeArtifactChartRegenerateResponse({ success: false, code: 'provider_unavailable' });
      }

      const fence = '```';
      // The request language is an enum with regex-safe literals. Build the
      // backslash explicitly so this pattern remains correct through source
      // generators and never turns `\s` into the literal letter `s`.
      const regexSlash = String.fromCharCode(92);
      const chartMarker = new RegExp(
        `${fence}(?:${request.chartLanguage})?${regexSlash}s*([${regexSlash}s${regexSlash}S]*?)${fence}`,
        'u',
      );
      const sourceMatch = original.content.match(chartMarker);
      const suppliedBlock = `${fence}${request.chartLanguage}\n${request.chartSource.trim()}\n${fence}`;
      const chartToReplace = sourceMatch?.[1]?.trim() === request.chartSource.trim()
        ? sourceMatch[0]
        : suppliedBlock;

      const response = await provider.complete([
        {
          role: 'system',
          content: 'You regenerate chart specifications. Return exactly one fenced code block in the requested language, with no prose. Preserve data fidelity: use only the supplied raw data and do not invent observations.',
        },
        {
          role: 'user',
          content: [
            `Chart language: ${request.chartLanguage}`,
            `Current chart:\n${fence}\n${request.chartSource}\n${fence}`,
            `Raw source data:\n${fence}text\n${request.sourceData}\n${fence}`,
            `Requested adjustment: ${request.instruction}`,
          ].join('\n\n'),
        },
      ], undefined, { temperature: 0 });
      const generated = response.content.trim();
      const generatedBlock = generated.match(new RegExp(
        `${fence}(?:mermaid|chart|vega|vega-lite|echarts)?${regexSlash}s*([${regexSlash}s${regexSlash}S]*?)${fence}`,
        'iu',
      ));
      const chartSource = (generatedBlock?.[1] ?? '').trim();
      if (!chartSource || chartSource.length > 1_500_000) {
        return decodeArtifactChartRegenerateResponse({ success: false, code: 'invalid_chart_output' });
      }

      const replacementBlock = `${fence}${request.chartLanguage}\n${chartSource}\n${fence}`;
      const nextContent = original.content.includes(chartToReplace)
        ? original.content.replace(chartToReplace, replacementBlock)
        : `${original.content.trim()}\n\n${replacementBlock}`;
      if (!ArtifactContentSchema.safeParse(nextContent).success) {
        return decodeArtifactChartRegenerateResponse({ success: false, code: 'invalid_chart_output' });
      }
      const suffix = Date.now().toString(36);
      const sourceDataArtifactId = `chart-data-${randomUUID()}`;
      const revisedArtifactId = `chart-revision-${randomUUID()}`;
      const sourceDataName = `${original.name.replace(/\.[^.]+$/u, '')}-chart-data-${suffix}.txt`;
      const revisedName = `${original.name.replace(/\.[^.]+$/u, '')}-chart-revised-${suffix}.md`;
      persistence.createArtifacts([
        {
          id: sourceDataArtifactId,
          sessionId: request.sessionId,
          name: sourceDataName,
          type: 'other',
          size: `${Buffer.byteLength(request.sourceData, 'utf8')} B`,
          content: request.sourceData,
          metadata: {
            kind: 'chart_source_data',
            parentArtifactId: request.artifactId,
            chartLanguage: request.chartLanguage,
          },
        },
        {
          id: revisedArtifactId,
          sessionId: request.sessionId,
          name: revisedName,
          type: 'md',
          size: `${Buffer.byteLength(nextContent, 'utf8')} B`,
          content: nextContent,
          metadata: {
            kind: 'chart_revision',
            parentArtifactId: request.artifactId,
            sourceDataArtifactId,
            chartLanguage: request.chartLanguage,
            adjustment: request.instruction,
          },
        },
      ]);
      for (const artifact of [
        { artifactId: sourceDataArtifactId, name: sourceDataName, type: 'other', contentAvailable: true, size: `${Buffer.byteLength(request.sourceData, 'utf8')} B` },
        { artifactId: revisedArtifactId, name: revisedName, type: 'md', contentAvailable: true, size: `${Buffer.byteLength(nextContent, 'utf8')} B` },
      ]) {
        const notification = decodeArtifactCreatedNotification({
          ...artifact,
          sessionId: request.sessionId,
          createdAt: Date.now(),
        });
        if (notification.ok && !event.sender.isDestroyed()) event.sender.send('artifact:created', notification.value);
      }
      return decodeArtifactChartRegenerateResponse({
        success: true,
        artifactId: revisedArtifactId,
        name: revisedName,
        content: nextContent,
        sourceDataArtifactId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : undefined;
      return decodeArtifactChartRegenerateResponse({ success: false, code: 'generation_failed', ...(message ? { message } : {}) });
    }
  });

  dom.handle('artifact:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = RuntimeIdSchema.parse(rawId);
      if (!store()) return decodeArtifactMutationResult(null);
      store()!.deleteArtifact(id);
      return decodeArtifactMutationResult({ success: true, code: 'deleted' });
    } catch {
      return decodeArtifactMutationResult(null);
    }
  });

  // ── Project artifact management (research_artifacts, project-scoped) ──
  dom.handle('artifact:listByProject', (event, rawProjectId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
      if (!projectId || !researchRepository()) return { items: [] };
      const repository = researchRepository()!;
      const items = repository.listArtifacts(projectId).map((artifact) => {
        const current = repository.getArtifactVersion(artifact.id);
        const manifest = (current?.manifest ?? {}) as Record<string, unknown>;
        return {
          id: artifact.id,
          projectId: artifact.projectId,
          title: artifact.title,
          artifactType: artifact.artifactType,
          reviewStatus: artifact.reviewStatus,
          version: artifact.version,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
          citedSourceIds: Array.isArray(manifest.citedSourceIds) ? manifest.citedSourceIds : [],
          reviewTrail: Array.isArray(manifest.reviewTrail) ? manifest.reviewTrail : [],
        };
      });
      return { items };
    } catch {
      return { items: [] };
    }
  });

  dom.handle('artifact:updateReviewStatus', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { artifactId?: unknown; toStatus?: unknown; reason?: unknown };
      const artifactId = typeof request?.artifactId === 'string' ? request.artifactId : '';
      const toStatus = typeof request?.toStatus === 'string' ? request.toStatus : '';
      const reason = typeof request?.reason === 'string' ? request.reason : '';
      const allowed = new Set(['draft', 'pending', 'partial', 'verified', 'stale']);
      if (!artifactId || !allowed.has(toStatus) || !researchRepository()) {
        return { ok: false, error: 'invalid_request' };
      }
      const updated = researchRepository()!.updateArtifactReviewStatus(artifactId, toStatus, reason || 'manual');
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'update_failed' };
    }
  });

  dom.handle('artifact:listVersions', (event, rawArtifactId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const artifactId = typeof rawArtifactId === 'string' ? rawArtifactId : '';
      if (!artifactId || !researchRepository()) return { versions: [] };
      const versions = researchRepository()!.listArtifactVersions(artifactId).map((record) => ({
        version: record.version,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        contentPreview: typeof record.content === 'string' ? record.content.slice(0, 2000) : '',
      }));
      return { versions };
    } catch {
      return { versions: [] };
    }
  });

  dom.handle('artifact:restoreVersion', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { artifactId?: unknown; version?: unknown };
      const artifactId = typeof request?.artifactId === 'string' ? request.artifactId : '';
      const version = typeof request?.version === 'number' ? request.version : 0;
      if (!artifactId || version < 1 || !researchRepository()) return { ok: false, error: 'invalid_request' };
      const restored = researchRepository()!.restoreArtifactVersion(artifactId, version);
      return restored ? { ok: true, version: restored.version } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'restore_failed' };
    }
  });

  return () => dom.dispose();
}
