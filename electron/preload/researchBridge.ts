/**
 * Research bridge — 持久化研究工作区 CRUD/link/review/restore/version/
 * checkpoint/decision/snapshot/media（从 preload.ts 迁出，2026-09-15 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 * 请求与响应在 context-isolated bridge 两侧独立严格解码。
 */
import { ipcRenderer } from 'electron';
import {
  createResearchMutationRecovery,
  decodeResearchArtifactVersionListResult,
  decodeResearchArtifactVersionRequest,
  decodeResearchArtifactVersionResult,
  decodeResearchCheckpointListResult,
  decodeResearchCheckpointRequest,
  decodeResearchCheckpointResult,
  decodeResearchCrudRequest,
  decodeResearchDecisionListResult,
  decodeResearchDecisionRequest,
  decodeResearchEntityListResult,
  decodeResearchEntityResult,
  decodeResearchLinkListResult,
  decodeResearchLinkRequest,
  decodeResearchMutationResult,
  decodeResearchRestoreRequest,
  decodeResearchReviewRequest,
  decodeResearchSnapshotRequest,
  decodeResearchSnapshotResult,
  type ResearchArtifactVersionRequest,
  type ResearchCheckpointRequest,
  type ResearchCrudRequest,
  type ResearchDecisionRequest,
  type ResearchLinkRequest,
  type ResearchRestoreRequest,
  type ResearchReviewRequest,
  type ResearchSnapshotRequest,
} from '../../engine/runtime/ResearchRuntimeContract.js';
import {
  decodeResearchMediaAttachRequest,
  decodeResearchMediaAttachResult,
  decodeResearchMediaPurgeRequest,
  decodeResearchMediaPurgeResult,
  type ResearchMediaAttachRequest,
  type ResearchMediaPurgeRequest,
} from '../../engine/runtime/ResearchMediaRuntimeContract.js';

export const researchBridge = {
  // Persistent research workspace (Project, Source, Evidence, NoteCode,
  // Claim and Artifact). Requests and responses are independently decoded on
  // both sides of the context-isolated bridge.
  researchListProjects: async (options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}) => {
    const request = decodeResearchCrudRequest({
      operation: 'list',
      entityKind: 'project',
      projectId: 'project-list',
      includeDeleted: options.includeDeleted ?? false,
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    });
    if (!request.ok) return decodeResearchEntityListResult(null);
    return decodeResearchEntityListResult(
      await ipcRenderer.invoke('research:crud', request.value),
    );
  },
  researchCrud: async (rawRequest: ResearchCrudRequest) => {
    const request = decodeResearchCrudRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:crud', request.value) as unknown;
    if (request.value.operation === 'get') return decodeResearchEntityResult(raw);
    if (request.value.operation === 'list') return decodeResearchEntityListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchLink: async (rawRequest: ResearchLinkRequest) => {
    const request = decodeResearchLinkRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:link', request.value) as unknown;
    return request.value.operation === 'list_links'
      ? decodeResearchLinkListResult(raw)
      : decodeResearchMutationResult(raw);
  },
  researchReview: async (rawRequest: ResearchReviewRequest) => {
    const request = decodeResearchReviewRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    return decodeResearchMutationResult(
      await ipcRenderer.invoke('research:review', request.value),
    );
  },
  researchRestore: async (rawRequest: ResearchRestoreRequest) => {
    const request = decodeResearchRestoreRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    return decodeResearchMutationResult(
      await ipcRenderer.invoke('research:restore', request.value),
    );
  },
  researchVersion: async (rawRequest: ResearchArtifactVersionRequest) => {
    const request = decodeResearchArtifactVersionRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:version', request.value) as unknown;
    if (request.value.operation === 'get_version') return decodeResearchArtifactVersionResult(raw);
    if (request.value.operation === 'list_versions') return decodeResearchArtifactVersionListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchCheckpoint: async (rawRequest: ResearchCheckpointRequest) => {
    const request = decodeResearchCheckpointRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:checkpoint', request.value) as unknown;
    if (request.value.operation === 'latest_checkpoint') return decodeResearchCheckpointResult(raw);
    if (request.value.operation === 'list_checkpoints') return decodeResearchCheckpointListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchDecision: async (rawRequest: ResearchDecisionRequest) => {
    const request = decodeResearchDecisionRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:decision', request.value) as unknown;
    if (request.value.operation === 'list_decisions') return decodeResearchDecisionListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchSnapshot: async (rawRequest: ResearchSnapshotRequest) => {
    const request = decodeResearchSnapshotRequest(rawRequest);
    if (!request.ok) return decodeResearchSnapshotResult(null);
    return decodeResearchSnapshotResult(
      await ipcRenderer.invoke('research:snapshot', request.value),
    );
  },
  researchMediaAttach: async (rawRequest: ResearchMediaAttachRequest) => {
    const request = decodeResearchMediaAttachRequest(rawRequest);
    if (!request) return decodeResearchMediaAttachResult(null);
    return decodeResearchMediaAttachResult(
      await ipcRenderer.invoke('research:mediaAttach', request),
    );
  },
  researchMediaPurge: async (rawRequest: ResearchMediaPurgeRequest) => {
    const request = decodeResearchMediaPurgeRequest(rawRequest);
    if (!request) return decodeResearchMediaPurgeResult(null);
    return decodeResearchMediaPurgeResult(
      await ipcRenderer.invoke('research:mediaPurge', request),
    );
  },
};
