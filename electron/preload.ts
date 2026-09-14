/**
 * Electron preload script — exposes safe IPC APIs to the renderer process.
 *
 * All communication between renderer (React) and main process (Node.js)
 * goes through this bridge. No direct Node.js access in renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { experimentBridge } from './preload/experimentBridge.js';
import { outcomes2Bridge } from './preload/outcomes2Bridge.js';
import { autonomousBridge } from './preload/autonomousBridge.js';
import { libraryBridge } from './preload/libraryBridge.js';
import { agentBridge } from './preload/agentBridge.js';
import { backupBridge } from './preload/backupBridge.js';
import { jobsBridge } from './preload/jobsBridge.js';
import { researchWorkflowBridge } from './preload/researchWorkflowBridge.js';
import { submissionTrackingBridge } from './preload/submissionTrackingBridge.js';
import { documentBridge } from './preload/documentBridge.js';
import { officeBridge } from './preload/officeBridge.js';
import { goalBridge } from './preload/goalBridge.js';
import { terminalBridge } from './preload/terminalBridge.js';
import { OutcomeExternalEditorStateRequestSchema, OutcomeExternalEditorStateSchema } from '../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomeAssistantChatRequestSchema, OutcomeAssistantChatResultSchema, OutcomeExternalEditorCloseRequestSchema, OutcomeExternalEditorOpenRequestSchema, OutcomeExternalEditorOpenResultSchema, OutcomeExternalEditorSyncRequestSchema, OutcomeExternalEditorSyncResultSchema, ScopedConversationMessageRequestSchema, ScopedConversationRequestSchema } from '../engine/runtime/OutcomeRuntimeContract.js';
import {
  decodeHistoryItems,
  decodeStoredHistoryEntry,
  RuntimeIdSchema,
} from '../engine/runtime/ChatRuntimeContract.js';
import {
  createArtifactChartRegenerateRecovery,
  createArtifactListRecovery,
  decodeArtifactChartRegenerateRequest,
  decodeArtifactChartRegenerateResponse,
  decodeArtifactContentRequest,
  decodeArtifactContentResponse,
  decodeArtifactCreateRequest,
  decodeArtifactCreatedNotification,
  decodeArtifactListResponse,
  decodeArtifactMutationResult,
} from '../engine/runtime/ArtifactRuntimeContract.js';
import {
  createSessionListRecovery,
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionListRequest,
  decodeSessionListResponse,
  decodeSessionMutationResult,
  decodeSessionUpdateRequest,
  type SessionUpdateRequest,
} from '../engine/runtime/SessionRuntimeContract.js';
import {
  createApprovalMutationFailure,
  decodeApprovalMutationResult,
  decodeApprovalRequestView,
  decodeApprovalRuleToggleRequest,
  decodeApprovalRuleViews,
  decodeApprovalResponseRequest,
  type ApprovalRequestView,
} from '../engine/runtime/ApprovalRuntimeContract.js';
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
} from '../engine/runtime/ResearchRuntimeContract.js';
import {
  decodeResearchMediaAttachRequest,
  decodeResearchMediaAttachResult,
  decodeResearchMediaPurgeRequest,
  decodeResearchMediaPurgeResult,
  type ResearchMediaAttachRequest,
  type ResearchMediaPurgeRequest,
} from '../engine/runtime/ResearchMediaRuntimeContract.js';
import {
  SETUP_RUNTIME_CONTRACT_VERSION,
  SetupAbortResponseSchema,
  decodeSetupAbortRequest,
  decodeSetupProbeResponse,
  decodeSetupProgressEvent,
  decodeSetupRestoreRequest,
  decodeSetupRestoreResponse,
  decodeSetupSaveRequest,
  decodeSetupSaveResponse,
  type SetupAbortRequest,
  type SetupProbeRequest,
  type SetupProgressEvent,
  type SetupRestoreRequest,
  type SetupSaveRequest,
  decodeSettingsProviderProbeRequest,
  type SettingsProviderProbeRequest,
} from '../engine/runtime/SetupRuntimeContract.js';
import {
  createProviderProfileListRecovery,
  createProviderProfileMutationRecovery,
  decodeProviderProfileDeleteRequest,
  decodeProviderProfileListRequest,
  decodeProviderProfileListResponse,
  decodeProviderProfileMutationResponse,
  decodeProviderProfileResetRequest,
  decodeProviderProfileSaveRequest,
  decodeProviderProfileSwitchRequest,
  type ProviderProfileDeleteRequest,
  type ProviderProfileListRequest,
  type ProviderProfileResetRequest,
  type ProviderProfileSaveRequest,
  type ProviderProfileSwitchRequest,
} from '../engine/runtime/ProviderProfileContract.js';
import {
  PersonalizationDeleteRequestSchema,
  PersonalizationForkRequestSchema,
  PersonalizationGetRequestSchema,
  PersonalizationListRequestSchema,
  PersonalizationIntegrityListRequestSchema,
  PersonalizationIntegrityRecoverRequestSchema,
  PersonalizationTrashListRequestSchema,
  PersonalizationResolveRequestSchema,
  PersonalizationRestoreRequestSchema,
  PersonalizationTrashRestoreRequestSchema,
  PersonalizationVersionsRequestSchema,
  PersonalizationSaveRequestSchema,
  decodePersonalizationGetResponse,
  decodePersonalizationListResponse,
  decodePersonalizationIntegrityListResponse,
  decodePersonalizationTrashListResponse,
  decodePersonalizationMutationResult,
  decodePersonalizationResolveResponse,
  decodePersonalizationVersionsResponse,
  type PersonalizationDeleteRequest,
  type PersonalizationForkRequest,
  type PersonalizationGetRequest,
  type PersonalizationListRequest,
  type PersonalizationIntegrityListRequest,
  type PersonalizationIntegrityRecoverRequest,
  type PersonalizationTrashListRequest,
  type PersonalizationResolveRequest,
  type PersonalizationRestoreRequest,
  type PersonalizationTrashRestoreRequest,
  type PersonalizationVersionsRequest,
  type PersonalizationSaveRequest,
  type ScenarioDefinition,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import type {
  ScenarioHarnessAssessment,
} from '../engine/personalization/ScenarioHarness.js';
import type {
  ScenarioHarnessDiffEntry,
} from '../engine/personalization/ScenarioHarnessCompiler.js';
import {
  PersonalizationExtensionIpcRequestSchema,
  decodePersonalizationExtensionResponse,
  type PersonalizationExtensionIpcRequest,
} from '../engine/runtime/PersonalizationExtensionContract.js';
import {
  PersonalizationBundleExportIpcRequestSchema,
  PersonalizationBundleImportIpcRequestSchema,
  decodePersonalizationBundleIpcResponse,
  type PersonalizationBundleExportIpcRequest,
  type PersonalizationBundleImportIpcRequest,
} from '../engine/runtime/PersonalizationBundleContract.js';
import {
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretSetRequestSchema,
  decodePersonalizationSecretListResponse,
  decodePersonalizationSecretRemoveResponse,
  decodePersonalizationSecretSetResponse,
  type PersonalizationSecretListRequest,
  type PersonalizationSecretRemoveRequest,
  type PersonalizationSecretSetRequest,
} from '../engine/runtime/PersonalizationSecretContract.js';
import {
  FundingTemplateIpcRequestSchema,
  decodeFundingTemplateRuntimeResponse,
  type FundingTemplateIpcRequest,
} from '../engine/runtime/FundingTemplateRuntimeContract.js';
import {
  McpActivationIpcRequestSchema,
  decodeMcpActivationResponse,
  type McpActivationIpcRequest,
} from '../engine/runtime/McpActivationContract.js';
import {
  createProjectMemoryMutationFailure,
  decodeProjectMemoryMutationResult,
  decodeProjectMemoryWriteRequest,
} from '../engine/runtime/MemoryRuntimeContract.js';
import {
  createWorkspaceAgentsFailure,
  createWorkspaceAgentsViewEmpty,
  decodeWorkspaceAgentsGetRequest,
  decodeWorkspaceAgentsMutationResult,
  decodeWorkspaceAgentsView,
  decodeWorkspaceAgentsWriteRequest,
} from '../engine/runtime/WorkspaceAgentsContract.js';
import {
  createSettingsMutationFailure,
  decodeSettingsMutationResult,
  decodeSettingsUpdateRequest,
  decodeSettingsView,
} from '../engine/runtime/SettingsRuntimeContract.js';
import {
  CurrentAffairsResearchRequestSchema,
  CurrentAffairsApproveRequestSchema,
  CurrentAffairsExportRequestSchema,
  CurrentAffairsCancelRequestSchema,
  CurrentAffairsListSourcesRequestSchema,
  SourceReviewRequestSchema,
  decodeCurrentAffairsResearchResponse,
  decodeCurrentAffairsApproveResponse,
  decodeCurrentAffairsExportResponse,
  decodeCurrentAffairsCancelResponse,
  decodeCurrentAffairsListSourcesResponse,
  decodeSourceReviewResponse,
  type CurrentAffairsResearchRequest,
  type CurrentAffairsApproveRequest,
  type CurrentAffairsExportRequest,
  type CurrentAffairsCancelRequest,
  type CurrentAffairsListSourcesRequest,
  type SourceReviewRequest,
} from '../engine/runtime/CurrentAffairsRuntimeContract.js';
import {
  createEvalRunFailure,
  decodeEvalRunRequest,
  decodeEvalRunResult,
} from '../engine/runtime/EvalRuntimeContract.js';


async function invokeSetupWithProgress<T>(
  channel: 'setup:probe' | 'setup:save',
  request: SetupProbeRequest | SetupSaveRequest | SettingsProviderProbeRequest,
  decodeResponse: (input: unknown) => T,
  onProgress?: (event: SetupProgressEvent) => void,
): Promise<T> {
  const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
    const progress = decodeSetupProgressEvent(raw);
    if (progress?.operationId === request.operationId) onProgress?.(progress);
  };
  ipcRenderer.on('setup:progress', handler);
  try {
    return decodeResponse(await ipcRenderer.invoke(channel, request));
  } finally {
    ipcRenderer.removeListener('setup:progress', handler);
  }
}

import { submissionBridge } from './preload/submissionBridge.js';
import { outcomeBridge } from './preload/outcomeBridge.js';
import { topicBridge } from './preload/topicBridge.js';
import { freeModelBridge } from './preload/freeModelBridge.js';
import { systemBridge } from './preload/systemBridge.js';
const api = {
  ...experimentBridge,
  ...outcomes2Bridge,
  ...autonomousBridge,
  ...submissionBridge,
  ...outcomeBridge,
  ...topicBridge,
  ...freeModelBridge,
  ...systemBridge,
  ...libraryBridge,
  ...agentBridge,
  ...jobsBridge,
  ...researchWorkflowBridge,
  ...submissionTrackingBridge,
  ...backupBridge,
  ...documentBridge,
  ...officeBridge,
  ...goalBridge,
  ...terminalBridge,
  // ── Acceptance Environment ───────────────────────────────
  acceptanceEnvironment: () => ipcRenderer.invoke('acceptance:environment') as Promise<
    | { enabled: false }
    | {
        enabled: true;
        userDataPath: string;
        entryPath: string;
        tokenSha256: string;
      }
  >,
  acceptanceSetWindowSize: (request: {
    mode: 'outer' | 'content';
    width: number;
    height: number;
  }) => ipcRenderer.invoke('acceptance:window:setSize', request) as Promise<{
    mode: 'outer' | 'content';
    requested: { width: number; height: number };
    outerBounds: { x: number; y: number; width: number; height: number };
    contentBounds: { x: number; y: number; width: number; height: number };
    zoomFactor: number;
    display: {
      id: string;
      scaleFactor: number;
      bounds: { x: number; y: number; width: number; height: number };
      workArea: { x: number; y: number; width: number; height: number };
    };
    maximized: boolean;
    fullScreen: boolean;
  }>,
  acceptanceReleaseWindowControl: () =>
    ipcRenderer.invoke('acceptance:window:release') as Promise<{ released: true }>,

  // ── Store ──────────────────────────────────────────────
  storeReady: () => ipcRenderer.invoke('store:ready'),
  startupStatus: () => ipcRenderer.invoke('startup:status') as Promise<{ ready: boolean; storeReady: boolean }>,
  runtimeIdentity: () => ipcRenderer.invoke('runtime:identity') as Promise<{
    buildId: 'metis-alpha2-release';
    appVersion: string;
    mode: 'development' | 'packaged';
    sourceRoot: string;
    mainEntry: string;
    rendererEntry: string;
    dataDir: string;
    electronVersion: string;
    startedAt: number;
  }>,

  setupProbe: async (
    rawRequest: SettingsProviderProbeRequest,
    onProgress?: (event: SetupProgressEvent) => void,
  ) => {
    const decoded = decodeSettingsProviderProbeRequest(rawRequest);
    if (!decoded.ok) return decodeSetupProbeResponse(null);
    return invokeSetupWithProgress(
      'setup:probe',
      decoded.value,
      decodeSetupProbeResponse,
      onProgress,
    );
  },
  setupSave: async (
    rawRequest: SetupSaveRequest,
    onProgress?: (event: SetupProgressEvent) => void,
  ) => {
    const request = decodeSetupSaveRequest(rawRequest);
    if (!request.ok) return decodeSetupSaveResponse(null);
    return invokeSetupWithProgress(
      'setup:save',
      request.value,
      decodeSetupSaveResponse,
      onProgress,
    );
  },
  setupRestore: async (rawRequest: SetupRestoreRequest) => {
    const request = decodeSetupRestoreRequest(rawRequest);
    if (!request.ok) return decodeSetupRestoreResponse(null);
    return decodeSetupRestoreResponse(await ipcRenderer.invoke('setup:restore', request.value));
  },
  setupAbort: async (rawRequest: SetupAbortRequest) => {
    const request = decodeSetupAbortRequest(rawRequest);
    const fallback = {
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: 'setup-recovery',
      success: false,
      code: 'setup_operation_not_found',
    } as const;
    if (!request.ok) return fallback;
    const parsed = SetupAbortResponseSchema.safeParse(
      await ipcRenderer.invoke('setup:abort', request.value),
    );
    return parsed.success ? parsed.data : fallback;
  },

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

  // ── Current Affairs (strict decode) ─────────────────────
  currentAffairsResearch: async (raw: CurrentAffairsResearchRequest) => {
    const req = CurrentAffairsResearchRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsResearchResponse(null);
    const result = await ipcRenderer.invoke('ca:research', req.data);
    return decodeCurrentAffairsResearchResponse(result);
  },
  currentAffairsApprove: async (raw: CurrentAffairsApproveRequest) => {
    const req = CurrentAffairsApproveRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsApproveResponse(null);
    const result = await ipcRenderer.invoke('ca:approve', req.data);
    return decodeCurrentAffairsApproveResponse(result);
  },
  currentAffairsExport: async (raw: CurrentAffairsExportRequest) => {
    const req = CurrentAffairsExportRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsExportResponse(null);
    const result = await ipcRenderer.invoke('ca:export', req.data);
    return decodeCurrentAffairsExportResponse(result);
  },
  currentAffairsCancel: async (raw: CurrentAffairsCancelRequest) => {
    const req = CurrentAffairsCancelRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsCancelResponse(null);
    const result = await ipcRenderer.invoke('ca:cancel', req.data);
    return decodeCurrentAffairsCancelResponse(result);
  },
  currentAffairsReviewSource: async (raw: SourceReviewRequest) => {
    const req = SourceReviewRequestSchema.safeParse(raw);
    if (!req.success) return decodeSourceReviewResponse(null);
    return decodeSourceReviewResponse(await ipcRenderer.invoke('ca:review-source', req.data));
  },
  currentAffairsListSources: async (raw: CurrentAffairsListSourcesRequest) => {
    const req = CurrentAffairsListSourcesRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsListSourcesResponse(null);
    return decodeCurrentAffairsListSourcesResponse(await ipcRenderer.invoke('ca:list-sources', req.data));
  },

  // ── Session ────────────────────────────────────────────
  createSession: async (sessionId: string, projectId?: string) => {
    const decoded = decodeSessionCreateRequest({ sessionId, ...(projectId ? { projectId } : {}) });
    if (!decoded.ok) return decodeSessionMutationResult(null);
    return decodeSessionMutationResult(
      await ipcRenderer.invoke('session:create', decoded.value),
    );
  },
  listSessions: async (request?: { projectId?: string; includeArchived?: boolean }) => {
    // 多对话架构(2026-09-04):支持 projectId 过滤;契约仍严格校验。
    const decoded = decodeSessionListRequest(request ?? {});
    if (!decoded.ok) return createSessionListRecovery();
    return decodeSessionListResponse(
      await ipcRenderer.invoke('session:list', decoded.value),
    );
  },
  deleteSession: async (sessionId: string) => {
    const decoded = decodeSessionDeleteRequest({ sessionId });
    if (!decoded.ok) return decodeSessionMutationResult(null);
    return decodeSessionMutationResult(
      await ipcRenderer.invoke('session:delete', decoded.value),
    );
  },
  updateSession: async (
    sessionId: string,
    patch: SessionUpdateRequest['patch'],
  ) => {
    const decoded = decodeSessionUpdateRequest({ sessionId, patch });
    if (!decoded.ok) return decodeSessionMutationResult(null);
    return decodeSessionMutationResult(
      await ipcRenderer.invoke('session:update', decoded.value),
    );
  },
  createArtifact: async (record: Record<string, unknown>) => {
    const decoded = decodeArtifactCreateRequest(record);
    if (!decoded.ok) return decodeArtifactMutationResult(null);
    return decodeArtifactMutationResult(await ipcRenderer.invoke('artifact:create', decoded.value));
  },
  listArtifacts: async (sessionId: string) => {
    if (!RuntimeIdSchema.safeParse(sessionId).success) return createArtifactListRecovery();
    return decodeArtifactListResponse(await ipcRenderer.invoke('artifact:list', sessionId));
  },
  getArtifactContent: async (sessionId: string, artifactId: string) => {
    const decoded = decodeArtifactContentRequest({ sessionId, artifactId });
    if (!decoded.ok) return decodeArtifactContentResponse(null);
    return decodeArtifactContentResponse(
      await ipcRenderer.invoke('artifact:get-content', decoded.value),
    );
  },
  regenerateArtifactChart: async (rawRequest: unknown) => {
    const decoded = decodeArtifactChartRegenerateRequest(rawRequest);
    if (!decoded.ok) return createArtifactChartRegenerateRecovery();
    return decodeArtifactChartRegenerateResponse(
      await ipcRenderer.invoke('artifact:regenerate-chart', decoded.value),
    );
  },
  deleteArtifact: async (id: string) => {
    if (!RuntimeIdSchema.safeParse(id).success) return decodeArtifactMutationResult(null);
    return decodeArtifactMutationResult(await ipcRenderer.invoke('artifact:delete', id));
  },
  onArtifactCreated: (callback: (data: import('../engine/runtime/ArtifactRuntimeContract.js').ArtifactCreatedNotification) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeArtifactCreatedNotification(data);
      if (decoded.ok) callback(decoded.value);
    };
    ipcRenderer.on('artifact:created', handler);
    return () => { ipcRenderer.removeListener('artifact:created', handler); };
  },

  // ── Messages ───────────────────────────────────────────
  getMessages: async (sessionId: string) =>
    decodeHistoryItems(await ipcRenderer.invoke('messages:get', sessionId)),
  appendMessage: (sessionId: string, role: string, content: string) => {
    const decoded = decodeStoredHistoryEntry({ role, content });
    if (decoded.kind === 'recovery') return Promise.resolve(-1);
    return ipcRenderer.invoke('messages:append', sessionId, role, content);
  },

  // ── Eval ───────────────────────────────────────────────
  runEvalSuite: async (profile: unknown) => {
    const request = decodeEvalRunRequest({ profile });
    if (!request) return createEvalRunFailure();
    return decodeEvalRunResult(await ipcRenderer.invoke('eval:runSuite', request));
  },

  // ── Settings ───────────────────────────────────────────
  getSettings: async () => decodeSettingsView(await ipcRenderer.invoke('settings:get')),
  markSetupSkipped: async () => ipcRenderer.invoke('settings:markSetupSkipped') as Promise<{ ok: boolean; error?: string }>,
  checkForUpdates: async () => ipcRenderer.invoke('update:check') as Promise<unknown>,
  getUpdateStatus: async () => ipcRenderer.invoke('update:status') as Promise<unknown>,
  downloadUpdate: async () => ipcRenderer.invoke('update:download') as Promise<unknown>,
  installUpdate: async () => ipcRenderer.invoke('update:install') as Promise<unknown>,
  getHealthReport: async () => ipcRenderer.invoke('diagnostics:healthReport') as Promise<unknown>,
  exportDiagnosticBundle: async () => ipcRenderer.invoke('diagnostics:exportBundle') as Promise<{ ok: boolean; path?: string; sha256?: string; entries?: number; error?: string }>,

  linkPaperToProject: async (request: { paperId: string; projectId: string; link?: boolean }) => ipcRenderer.invoke('paper:linkToProject', request) as Promise<{ ok: boolean; error?: string }>,
  exportProject: async (request: { projectId: string; destPath?: string }) =>
    ipcRenderer.invoke('project:export', request) as Promise<{ ok: boolean; path?: string; error?: string; manifest?: unknown }>,
  importProject: async (request: { archivePath: string; projectId?: string; overwrite?: boolean }) =>
    ipcRenderer.invoke('project:import', request) as Promise<{ ok: boolean; projectId?: string; error?: string; restored?: unknown }>,
  listProjects: async () => ipcRenderer.invoke('project:list') as Promise<
    | { success: true; projects: Array<{ id: string; title: string; updatedAt: number; archivedAt: number | null }> }
    | { success: false; code: string }
  >,
  // ── O13: 项目级 provider/model 覆盖 ──
  getProjectProviderOverride: async (projectId: string) =>
    ipcRenderer.invoke('project:getProviderOverride', projectId) as Promise<
      { ok: true; override: import('../engine/runtime/ProviderProfileContract.js').ProjectProviderOverride | null }
      | { ok: false; code: string }
    >,
  setProjectProviderOverride: async (request: {
    projectId: string;
    override: import('../engine/runtime/ProviderProfileContract.js').ProjectProviderOverride | null;
  }) =>
    ipcRenderer.invoke('project:setProviderOverride', request) as Promise<{ ok: boolean; code?: string }>,
  pickProjectArchive: async () => ipcRenderer.invoke('project:pickArchive') as Promise<{ canceled: boolean; path?: string }>,
  // ── Storage location (user-configurable data directory) ──
  storageGetLocation: async () => ipcRenderer.invoke('storage:getLocation') as Promise<{
    ok: boolean;
    dataDir?: string;
    defaultDir?: string;
    usingDefault?: boolean;
    error?: string;
  }>,

  storageSetLocation: async (target: string) => ipcRenderer.invoke('storage:setLocation', target) as Promise<{
    ok: boolean;
    restarting?: boolean;
    dataDir?: string;
    error?: string;
  }>,

  browserShow: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:show', bounds) as Promise<{ ok: boolean; error?: string }>,
  browserHide: async () => ipcRenderer.invoke('browser:hide') as Promise<{ ok: boolean; error?: string }>,
  browserSetBounds: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:setBounds', bounds) as Promise<{ ok: boolean; error?: string }>,
  // 任务2：可显式声明本次导航归属的项目（供 AI 消费浏览器上下文前校验）。
  browserNavigate: async (url: string, projectId?: string | null) =>
    ipcRenderer.invoke('browser:navigate', projectId ? { url, projectId } : url) as Promise<{ ok: boolean; url?: string; error?: string }>,
  browserBack: async () => ipcRenderer.invoke('browser:back') as Promise<{ ok: boolean; error?: string }>,
  browserForward: async () => ipcRenderer.invoke('browser:forward') as Promise<{ ok: boolean; error?: string }>,
  browserReload: async () => ipcRenderer.invoke('browser:reload') as Promise<{ ok: boolean; error?: string }>,
  browserStop: async () => ipcRenderer.invoke('browser:stop') as Promise<{ ok: boolean; error?: string }>,
  browserFocusRenderer: async () => ipcRenderer.invoke('browser:focusRenderer') as Promise<{ ok: boolean; error?: string }>,
  // ── 协同对话（第三方 AI 网页版 WebContentsView） ──
  collabShow: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('collab:show', bounds) as Promise<{ ok: boolean; error?: string }>,
  collabHide: async () => ipcRenderer.invoke('collab:hide') as Promise<{ ok: boolean; error?: string }>,
  collabSetBounds: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('collab:setBounds', bounds) as Promise<{ ok: boolean; error?: string }>,
  collabNavigate: async (url: string) => ipcRenderer.invoke('collab:navigate', url) as Promise<{ ok: boolean; url?: string; error?: string }>,
  // ── Chatbot Context Bridge（2026-09-05 刘总规格书）──
  // METIS→Chatbot：把剪贴板内容粘贴进第三方 AI 页面（自动填入路径）。
  collabPaste: async () =>
    ipcRenderer.invoke('collab:paste') as Promise<{ ok: boolean; error?: string }>,
  // Chatbot→METIS：只读捕获选区原文；失败如实返回（渲染层走剪贴板 fallback）。
  collabCaptureSelection: async () =>
    ipcRenderer.invoke('collab:captureSelection') as Promise<{ ok: boolean; text?: string; error?: string }>,

  collabGetState: async () =>
    ipcRenderer.invoke('collab:getState') as Promise<{ ok: boolean; error?: string; state?: { url: string; title: string } }>,
  // 外部模型引用（外部参考·非证据）：确认卡通过后才调用 add。
  externalRefAdd: async (reference: Record<string, unknown>) =>
    ipcRenderer.invoke('externalRef:add', reference) as Promise<{
      ok: boolean; issues?: string[]; reference?: { v: 1; id: string; model: string; url: string; quotedText: string; contextDigest: string; capturedAt: number; projectId: string | null; sessionId: string | null }; duplicate?: boolean;
    }>,
  // 任务2 上下文隔离：读取必须显式给 projectId/sessionId（空 scope 返回
  // scope_required）；仅管理/审计页可传 global:true 浏览全量。
  externalRefList: async (query: { projectId?: string; sessionId?: string; limit?: number; global?: boolean } = {}) =>
    ipcRenderer.invoke('externalRef:list', query) as Promise<{
      ok: boolean; error?: string; references?: Array<{ v: 1; id: string; model: string; url: string; quotedText: string; contextDigest: string; capturedAt: number; projectId: string | null; sessionId: string | null }>;
    }>,
  externalRefRemove: async (id: string) =>
    ipcRenderer.invoke('externalRef:remove', id) as Promise<{ ok: boolean; error?: string }>,
  // ── 内置文献检索 ──
  literatureSearch: async (request: { query: string; sources: Array<'ncpssd' | 'openalex'>; page?: number; pageSize?: number; coreOnly?: boolean }) =>
    ipcRenderer.invoke('literature:search', request) as Promise<{
      ok: boolean;
      code?: string;
      recovery?: string;
      results?: Array<{
        id: string;
        source: 'ncpssd' | 'openalex';
        title: string;
        authors: string[];
        year: number;
        venue: string;
        abstract: string;
        doi?: string;
        url?: string;
        pdfUrl?: string;
        citationCount?: number;
        tags: string[];
        core: boolean;
      }>;
      total?: number;
      warnings?: string[];
    }>,
  getResumeBrief: async (projectId: string) => ipcRenderer.invoke('research:resumeBrief', projectId) as Promise<{
    projectId: string;
    generatedAt: number;
    lastActivityAt: number | null;
    openTasks: number;
    runningTasks: number;
    lastCompletedTask: string | null;
    lastRunStatus: string | null;
    lastRunAt: number | null;
    artifactCount: number;
    lastArtifactTitle: string | null;
    lastArtifactAt: number | null;
    paperCount: number;
    lastPaperTitle: string | null;
    summaryText: string;
  } | null>,
  getProjectStage: async (projectId: string) => ipcRenderer.invoke('research:getStage', projectId) as Promise<string | null>,
  setProjectStage: async (projectId: string, stage: string) =>
    ipcRenderer.invoke('research:setStage', { projectId, stage }) as Promise<{ ok: boolean }>,
  archiveProject: async (projectId: string) => ipcRenderer.invoke('research:archiveProject', projectId) as Promise<{ ok: boolean; error?: string }>,
  restoreProject: async (projectId: string) => ipcRenderer.invoke('research:restoreProject', projectId) as Promise<{ ok: boolean; restoredLifecycle?: string; error?: string }>,
  deleteProject: async (projectId: string) => ipcRenderer.invoke('research:deleteProject', projectId) as Promise<{ ok: boolean }>,
  openDirectoryDialog: async () => ipcRenderer.invoke('dialog:openDirectory') as Promise<string | null>,
  setProjectDir: async (projectId: string, projectDir: string) => ipcRenderer.invoke('research:setProjectDir', { projectId, projectDir }) as Promise<{ ok: boolean }>,

  importIssnList: async () => ipcRenderer.invoke('settings:importIssnList') as Promise<{ ok: boolean; added: number; totalCandidates?: number; error?: string }>,
  browserState: async () => ipcRenderer.invoke('browser:state') as Promise<{
    ok: boolean;
    state?: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };
    error?: string;
  }>,
  browserClick: async (x: number, y: number) => ipcRenderer.invoke('browser:click', { x, y }) as Promise<{ ok: boolean; error?: string }>,
  browserType: async (text: string) => ipcRenderer.invoke('browser:type', text) as Promise<{ ok: boolean; error?: string }>,
  browserKey: async (keyCode: string) => ipcRenderer.invoke('browser:key', keyCode) as Promise<{ ok: boolean; error?: string }>,
  browserScroll: async (deltaX: number, deltaY: number) => ipcRenderer.invoke('browser:scroll', { deltaX, deltaY }) as Promise<{ ok: boolean; error?: string }>,
  browserScreenshot: async () => ipcRenderer.invoke('browser:screenshot') as Promise<{ ok: boolean; imageBase64?: string; error?: string }>,
  browserExtract: async () => ipcRenderer.invoke('browser:extract') as Promise<{
    ok: boolean;
    page?: { title: string; text: string; url: string; links: string[] };
    error?: string;
  }>,
  browserCollect: async () => ipcRenderer.invoke('browser:collect') as Promise<{
    ok: boolean;
    paper?: { paperId: string; merged: boolean; title: string; doi?: string; metaSource?: 'complete' | 'crossref_enriched' | 'meta_only' | 'webpage' };
    error?: string;
  }>,
  browserListDownloads: async () => ipcRenderer.invoke('browser:listDownloads') as Promise<{
    ok: boolean;
    downloads: Array<{ id: string; url: string; filename: string; mimeType: string; pageUrl: string; pageTitle: string }>;
    error?: string;
  }>,
  browserAcceptDownload: async (id: string, projectId: string | null) =>
    ipcRenderer.invoke('browser:acceptDownload', { id, projectId }) as Promise<{ ok: boolean; savedPath?: string; paperId?: string; error?: string }>,
  browserCancelDownload: async (id: string) => ipcRenderer.invoke('browser:cancelDownload', id) as Promise<{ ok: boolean; error?: string }>,
  onBrowserState: (callback: (state: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }) => void): (() => void) => {
    const handler = (_event: unknown, state: unknown) => callback(state as Parameters<typeof callback>[0]);
    ipcRenderer.on('browser:state', handler);
    return () => { ipcRenderer.removeListener('browser:state', handler); };
  },
  onBrowserDownloadRequest: (callback: (download: { id: string; url: string; filename: string; mimeType: string; pageUrl: string; pageTitle: string }) => void): (() => void) => {
    const handler = (_event: unknown, download: unknown) => callback(download as Parameters<typeof callback>[0]);
    ipcRenderer.on('browser:download-request', handler);
    return () => { ipcRenderer.removeListener('browser:download-request', handler); };
  },

  loadPaperDetail: async (paperId: string) => ipcRenderer.invoke('data:loadPaperDetail', { paperId }) as Promise<{ found: boolean; paper?: unknown }>,
  searchPapersFullText: async (query: string, limit?: number) => ipcRenderer.invoke('papers:searchFullText', query, limit) as Promise<{ results: Array<{ id: string; title: string; snippet: string }> }>,
  aiExplainPaper: async (request: { passage: string; paperTitle?: string; action?: 'explain' | 'translate' | 'summarize' }) => ipcRenderer.invoke('papers:aiExplain', request) as Promise<{ ok: boolean; text?: string; error?: string }>,
  aiSynthesis: async (request: { mode?: 'synthesis' | 'compare' | 'report'; papers: Array<{ title: string; authors: string[]; year: number; venue: string; abstract: string }> }) => ipcRenderer.invoke('papers:aiSynthesis', request) as Promise<{ ok: boolean; text?: string; error?: string }>,

  providerProfilesList: async (rawRequest: ProviderProfileListRequest) => {
    const request = decodeProviderProfileListRequest(rawRequest);
    if (!request.ok) return createProviderProfileListRecovery(rawRequest);
    return decodeProviderProfileListResponse(
      await ipcRenderer.invoke('providerProfiles:list', request.value),
      request.value.operationId,
    );
  },
  providerProfilesSave: async (rawRequest: ProviderProfileSaveRequest) => {
    const request = decodeProviderProfileSaveRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:save', request.value),
      request.value.operationId,
    );
  },
  providerProfilesSwitch: async (rawRequest: ProviderProfileSwitchRequest) => {
    const request = decodeProviderProfileSwitchRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:switch', request.value),
      request.value.operationId,
    );
  },
  providerProfilesDelete: async (rawRequest: ProviderProfileDeleteRequest) => {
    const request = decodeProviderProfileDeleteRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:delete', request.value),
      request.value.operationId,
    );
  },
  providerProfilesReset: async (rawRequest: ProviderProfileResetRequest) => {
    const request = decodeProviderProfileResetRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:reset', request.value),
      request.value.operationId,
    );
  },

  setSettings: async (config: unknown) => {
    const request = decodeSettingsUpdateRequest(config);
    if (!request) return createSettingsMutationFailure('secure_setup_required');
    return decodeSettingsMutationResult(await ipcRenderer.invoke('settings:set', request));
  },

  setProjectMemory: async (content: string) => {
    const request = decodeProjectMemoryWriteRequest({ content });
    if (!request) return createProjectMemoryMutationFailure();
    return decodeProjectMemoryMutationResult(await ipcRenderer.invoke('memory:setProject', request));
  },

  getWorkspaceAgents: async (projectId: string) => {
    const request = decodeWorkspaceAgentsGetRequest({ projectId });
    if (!request) return createWorkspaceAgentsViewEmpty();
    return decodeWorkspaceAgentsView(await ipcRenderer.invoke('workspace:agents:get', request));
  },
  setWorkspaceAgents: async (projectId: string, content: string, expectedVersion: number) => {
    const request = decodeWorkspaceAgentsWriteRequest({ projectId, content, expectedVersion });
    if (!request) return createWorkspaceAgentsFailure('content_invalid');
    return decodeWorkspaceAgentsMutationResult(
      await ipcRenderer.invoke('workspace:agents:set', request),
    );
  },

  openOutcomeInGenoffice: async (raw: unknown) => { const p=OutcomeExternalEditorOpenRequestSchema.safeParse(raw); if (!p.success) return OutcomeExternalEditorOpenResultSchema.parse({ ok:false, code:'invalid_request', message:'GenOffice 编辑请求无效。' }); const result=OutcomeExternalEditorOpenResultSchema.safeParse(await ipcRenderer.invoke('outcomes:external-editor:open',p.data)); return result.success ? result.data : OutcomeExternalEditorOpenResultSchema.parse({ ok:false, code:'genoffice_open_failed', message:'GenOffice 编辑器打开失败。' }); },
  syncOutcomeFromGenoffice: async (raw: unknown) => { const p=OutcomeExternalEditorSyncRequestSchema.safeParse(raw); if (!p.success) return OutcomeExternalEditorSyncResultSchema.parse({ ok:false, code:'invalid_request', message:'GenOffice 同步请求无效。' }); const result=OutcomeExternalEditorSyncResultSchema.safeParse(await ipcRenderer.invoke('outcomes:external-editor:sync',p.data)); return result.success ? result.data : OutcomeExternalEditorSyncResultSchema.parse({ ok:false, code:'outcome_save_failed', message:'GenOffice 同步失败，当前成果没有被修改。' }); },
  closeOutcomeGenofficeEditor: async (raw: unknown) => { const p=OutcomeExternalEditorCloseRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:external-editor:close', p.data) as Promise<boolean> : false; },
  stateOutcomeGenofficeEditor: async (raw: unknown) => { const p=OutcomeExternalEditorStateRequestSchema.safeParse(raw); if (!p.success) return OutcomeExternalEditorStateSchema.parse({ exists: false, changed: false, session: null }); const result=OutcomeExternalEditorStateSchema.safeParse(await ipcRenderer.invoke('outcomes:external-editor:state', p.data)); return result.success ? result.data : OutcomeExternalEditorStateSchema.parse({ exists: false, changed: false, session: null }); },
  genofficeEmbeddedSetBounds: async (raw: unknown) => { try { return Boolean(await ipcRenderer.invoke('genoffice-embedded:set-bounds', raw)); } catch { return false; } },
  genofficeEmbeddedSetVisible: async (raw: unknown) => { try { return Boolean(await ipcRenderer.invoke('genoffice-embedded:set-visible', raw)); } catch { return false; } },
  genofficeEmbeddedFocus: async (raw: unknown) => { try { return Boolean(await ipcRenderer.invoke('genoffice-embedded:focus', raw)); } catch { return false; } },

  listScopedConversation: async (raw: unknown) => { const p=ScopedConversationRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:conversation:list',p.data) : []; },
  appendScopedConversation: async (raw: unknown) => { const p=ScopedConversationMessageRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:conversation:append',p.data) : null; },
  chatOutcomeAssistant: async (raw: unknown) => { const p=OutcomeAssistantChatRequestSchema.safeParse(raw); if (!p.success) return OutcomeAssistantChatResultSchema.parse({ status:'error', code:'invalid_request', message:'成果助手请求无效。', answer:'', sources:[], diagnostics:[{code:'invalid_request',message:'成果助手请求未通过契约校验。'}] }); const value=await ipcRenderer.invoke('outcomes:assistant:chat',p.data); const result=OutcomeAssistantChatResultSchema.safeParse(value); return result.success ? result.data : OutcomeAssistantChatResultSchema.parse({ status:'error', code:'assistant_unavailable', message:'成果助手响应无效，请重试。', answer:'', sources:[], diagnostics:[{code:'assistant_unavailable',message:'主进程返回了无效的成果助手响应。'}] }); },


  analyzeFundingTemplateForAssistant: async (projectId: string) =>
    ipcRenderer.invoke('fundingTemplate:analyzeForAssistant', { projectId }) as Promise<{
      ok: boolean; message?: string; templateId?: string; summary?: string;
    }>,
  // 项目参考材料库（2026-09-01 刘总要求）：上传/列表/删除/改大类。
  projectMaterialImportDialog: async (request: { projectId: string; category?: string }) =>
    ipcRenderer.invoke('scenario:material:importDialog', request) as Promise<{
      ok: boolean; error?: string; imported?: Array<{ id: string; name: string; category: string; charCount: number }>; errors?: Array<{ name: string; error: string }>;
    }>,
  projectMaterialList: async (projectId: string) =>
    ipcRenderer.invoke('scenario:material:list', { projectId }) as Promise<{
      ok: boolean; error?: string; materials?: Array<{ id: string; name: string; category: string; charCount: number; addedAt: number; binaryArchive?: string }>;
    }>,
  projectMaterialDelete: async (id: string) =>
    ipcRenderer.invoke('scenario:material:delete', { id }) as Promise<{ ok: boolean; error?: string }>,
  projectMaterialSetCategory: async (request: { id: string; category: string }) =>
    ipcRenderer.invoke('scenario:material:setCategory', request) as Promise<{ ok: boolean; error?: string }>,
  // 能力库 Capability Vault（任务7）：入库不注入，绑定才加载。列表接口绝不带出 systemPrompt。
  capabilityVaultSources: async () =>
    ipcRenderer.invoke('capability:vault:sources') as Promise<{
      ok: boolean; error?: string; sources?: Array<{
        id: string; repo: string; name: string; expansion: 'per_skill' | 'single';
        domains: string[]; researchStages: string[]; licenseStatus: 'verified' | 'unverified'; notes?: string; vaultCount: number;
      }>;
    }>,
  capabilityVaultStats: async () =>
    ipcRenderer.invoke('capability:vault:stats') as Promise<{
      ok: boolean; error?: string; stats?: { total: number; skills: number; mcps: number; installed: number; sources: number };
    }>,
  capabilityVaultImportSource: async (sourceId: string) =>
    ipcRenderer.invoke('capability:vault:importSource', sourceId) as Promise<{
      ok: boolean; imported: number; excluded: number; error?: string;
    }>,
  capabilityVaultList: async (query: { keyword?: string; sourceId?: string; kind?: 'skill' | 'mcp'; stage?: string; limit?: number } = {}) =>
    ipcRenderer.invoke('capability:vault:list', query) as Promise<{
      ok: boolean; error?: string; entries?: Array<{
        id: string; kind: 'skill' | 'mcp'; name: string; description: string;
        sourceId: string; sourceRepo: string; originalPath: string;
        license: string | null; licenseStatus: string;
        domains: string[]; researchStages: string[]; tags: string[];
        contentDigest: string; included: boolean; exclusionReason: string | null;
        installedDefinitionId: string | null; importedAt: number; updatedAt: number;
      }>;
    }>,
  capabilityVaultGetDetail: async (id: string) =>
    ipcRenderer.invoke('capability:vault:getDetail', id) as Promise<{
      ok: boolean; error?: string; entry?: { id: string; kind: 'skill' | 'mcp'; name: string; description: string;
        sourceId: string; sourceRepo: string; originalPath: string;
        license: string | null; licenseStatus: string;
        domains: string[]; researchStages: string[]; tags: string[];
        contentDigest: string; included: boolean; exclusionReason: string | null;
        installedDefinitionId: string | null; importedAt: number; updatedAt: number; systemPrompt?: string };
    }>,
  capabilityVaultInstall: async (id: string) =>
    ipcRenderer.invoke('capability:vault:install', id) as Promise<{
      ok: boolean; code?: 'not_found' | 'excluded' | 'already_installed' | 'install_failed'; definitionId?: string; message?: string;
    }>,
  capabilityVaultUninstall: async (id: string) =>
    ipcRenderer.invoke('capability:vault:uninstall', id) as Promise<{ ok: boolean; removed?: boolean; error?: string }>,

  draftFundingOutline: async (request: { projectId: string; templateId: string; materialText?: string }) =>
    ipcRenderer.invoke('fundingTemplate:draftOutline', request) as Promise<{
      ok: boolean; code?: string; message?: string; markdown?: string;
    }>,

  // ── MCP Servers ────────────────────────────────────────
  listMCPServers: () => ipcRenderer.invoke('mcp:list'),
  addMCPServer: (_config: { id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }) =>
    (void _config, Promise.resolve({ success: false, code: 'managed_mcp_required' })),
  removeMCPServer: (id: string) => ipcRenderer.invoke('mcp:remove', id),
  toggleMCPServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggle', id, enabled),
  testMCPServer: (_config: { command: string; args: string[]; env: Record<string, string> }) =>
    (void _config, Promise.resolve({ success: false, code: 'managed_mcp_required' })),

  // ── Skills ─────────────────────────────────────────────
  listSkills: () => ipcRenderer.invoke('skill:list'),
  getSkill: (id: string) => ipcRenderer.invoke('skill:get', id),
  setActiveSkill: (id: string | null) => ipcRenderer.invoke('skill:setActive', id),
  getActiveSkill: () => ipcRenderer.invoke('skill:getActive'),
  generateSkillFromConversation: async (request: { messages: Array<{ role: string; content: string }>; userIntent?: string }) =>
    ipcRenderer.invoke('skill:generateFromConversation', request) as Promise<{
      ok: boolean;
      error?: string;
      skill?: { id: string; name: string; description: string; systemPrompt: string; allowedTools: string[]; maxTurns: number; rationale: string };
    }>,
  deleteCustomSkill: (id: string) => ipcRenderer.invoke('skill:deleteCustom', id) as Promise<{ ok: boolean; error?: string }>,

  listPersonalization: async (rawRequest: PersonalizationListRequest) => {
    const request = PersonalizationListRequestSchema.safeParse(rawRequest);
    if (!request.success) throw new TypeError('Invalid personalization list request');
    const response = decodePersonalizationListResponse(
      await ipcRenderer.invoke('personalization:list', request.data),
    );
    if (!response.ok) throw new TypeError(`Personalization list failed: ${response.code}`);
    return response;
  },

  listPersonalizationTrash: async (rawRequest: PersonalizationTrashListRequest) => {
    const request = PersonalizationTrashListRequestSchema.safeParse(rawRequest);
    if (!request.success) throw new TypeError('Invalid personalization trash list request');
    const response = decodePersonalizationTrashListResponse(
      await ipcRenderer.invoke('personalization:trash:list', request.data),
    );
    if (!response.ok) throw new TypeError(`Personalization trash list failed: ${response.code}`);
    return response;
  },

  listPersonalizationIntegrityIssues: async (rawRequest: PersonalizationIntegrityListRequest) => {
    const request = PersonalizationIntegrityListRequestSchema.safeParse(rawRequest);
    if (!request.success) throw new TypeError('Invalid personalization integrity request');
    const response = decodePersonalizationIntegrityListResponse(
      await ipcRenderer.invoke('personalization:integrity:list', request.data),
    );
    if (!response.ok) throw new TypeError(`Personalization integrity list failed: ${response.code}`);
    return response;
  },

  recoverPersonalizationIntegrityIssue: async (rawRequest: PersonalizationIntegrityRecoverRequest) => {
    const request = PersonalizationIntegrityRecoverRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(
      await ipcRenderer.invoke('personalization:integrity:recover', request.data),
    );
  },

  aiGenerateScenario: async (rawRequest: unknown) => (
    ipcRenderer.invoke('personalization:aiGenerateScenario', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      scenario?: { name: string; description: string; triggerPhrases: string[]; deliverable: string };
      agents?: Array<{ name: string; role: string; systemPrompt: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
      workflow?: Array<{ name: string; description: string; agent: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
      rules?: string;
      paperStructure?: Array<{ title: string; instruction: string }> | null;
    }>
  ),
  aiGenerateAgent: async (rawRequest: unknown) => (
    ipcRenderer.invoke('personalization:aiGenerateAgent', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      agent?: { name: string; description: string; role: string; systemPrompt: string; maxTurns: number };
    }>
  ),
  marketSearch: async (rawRequest: { kind: 'skill' | 'mcp'; query: string; source?: 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld' }) => (
    ipcRenderer.invoke('market:search', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      source?: 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld';
      items?: Array<{
        source: 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld';
        owner: string;
        repo: string;
        name: string;
        description: string;
        stars: number;
        updatedAt: string;
        url: string;
        detailUrl?: string;
        installUrl?: string;
        filePath?: string;
        sourceId?: string;
        installable?: boolean;
        defaultBranch: string;
        topics: string[];
      }>;
      usingToken?: boolean;
    }>
  ),
  marketReadSkillDoc: async (rawRequest: { owner: string; repo: string; ref: string; source?: 'github' | 'skillsmp'; filePath?: string }) => (
    ipcRenderer.invoke('market:readSkillDoc', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      path?: string;
      content?: string;
    }>
  ),
  marketReadMcpDocs: async (rawRequest: { owner: string; repo: string; ref: string; source?: 'github' | 'mcpmarket_cn' | 'mcpworld'; sourceId?: string }) => (
    ipcRenderer.invoke('market:readMcpDocs', rawRequest) as Promise<{
      readme: { ok: boolean; code?: string; path?: string; content?: string };
      packageJson: { ok: boolean; npmPackage?: string };
    }>
  ),
  runScenarioLoopNow: async (rawRequest: { scenarioId: string; loopId: string }) => (
    ipcRenderer.invoke('scenario:loop:run-now', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      runCount?: number;
      error?: string;
    }>
  ),
  onScenarioApprovalRequired: (callback: (payload: { requestId: string; hookId: string; stepId: string; instruction: string; runId: string }) => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (payload && typeof payload === 'object' && typeof (payload as { requestId?: unknown }).requestId === 'string') {
        callback(payload as { requestId: string; hookId: string; stepId: string; instruction: string; runId: string });
      }
    };
    ipcRenderer.on('scenario:approval:required', listener);
    return () => { ipcRenderer.removeListener('scenario:approval:required', listener); };
  },
  respondScenarioApproval: async (requestId: string, approve: boolean) => (
    ipcRenderer.invoke('scenario:approval:respond', { requestId, approve }) as Promise<{ ok: boolean; code?: string }>
  ),
  openReferenceFileDialog: async () => ipcRenderer.invoke('dialog:openReferenceFiles') as Promise<string[]>,
  importScenarioMaterials: async (rawRequest: unknown) => (
    ipcRenderer.invoke('scenario:importMaterials', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      error?: string;
      errors?: Array<{ name: string; error: string }>;
      materials?: Array<{ id: string; name: string; kind: string; storageRef: string; charCount: number; text: string }>;
    }>
  ),
  analyzeScenarioMaterials: async (rawRequest: unknown) => (
    ipcRenderer.invoke('scenario:analyzeMaterials', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      error?: string;
      result?: {
        summary: {
          deliverableType: string;
          deliverableTypeLabel: string;
          structureTitles: string[];
          hardRuleCount: number;
          writingPrincipleCount: number;
          methods: string[];
          adjustable: string[];
          recommended: { agents: number; skills: number; mcps: number; rules: number };
        };
        materials: Array<{ name: string; kind: string; insights: { structureRules: string[]; writingPrinciples: string[]; methodSuggestions: string[]; hardRequirements: string[] } }>;
        draft: Record<string, unknown>;
      };
    }>
  ),
  scenarioConversationUnits: async (rawRequest: { projectId: string; scenarioId: string | null }) => (
    ipcRenderer.invoke('scenario:conversation:units', { projectId: rawRequest.projectId, scope: 'scenario', outcomeId: null, scenarioId: rawRequest.scenarioId }) as Promise<Array<{ id: string; title: string; messageCount: number; createdAt: number; updatedAt: number }>>
  ),
  scenarioConversationCreate: async (rawRequest: { projectId: string; scenarioId: string | null; title?: string }) => (
    ipcRenderer.invoke('scenario:conversation:create', { projectId: rawRequest.projectId, scope: 'scenario', outcomeId: null, scenarioId: rawRequest.scenarioId, title: rawRequest.title }) as Promise<{ id: string; title: string; createdAt: number } | null>
  ),
  scenarioConversationDelete: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('scenario:conversation:delete', rawRequest) as Promise<boolean>
  ),
  scenarioConversationMessages: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('scenario:conversation:messages', rawRequest) as Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: unknown[]; createdAt: number }>>
  ),
  scenarioConversationAppend: async (rawRequest: { projectId: string; conversationId: string; role: 'user' | 'assistant' | 'system'; content: string }) => (
    ipcRenderer.invoke('scenario:conversation:append', { projectId: rawRequest.projectId, conversationId: rawRequest.conversationId, role: rawRequest.role, content: rawRequest.content }) as Promise<{ id: string; createdAt: number } | null>
  ),
  outcomesConversationUnits: async (rawRequest: { projectId: string; outcomeId: string }) => (
    ipcRenderer.invoke('outcomes:conversation:units', { projectId: rawRequest.projectId, scope: 'outcome', outcomeId: rawRequest.outcomeId, scenarioId: null }) as Promise<Array<{ id: string; title: string; messageCount: number; createdAt: number; updatedAt: number }>>
  ),
  outcomesConversationCreate: async (rawRequest: { projectId: string; outcomeId: string; title?: string }) => (
    ipcRenderer.invoke('outcomes:conversation:create', { projectId: rawRequest.projectId, scope: 'outcome', outcomeId: rawRequest.outcomeId, scenarioId: null, title: rawRequest.title }) as Promise<{ id: string; title: string; createdAt: number } | null>
  ),
  outcomesConversationDelete: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('outcomes:conversation:delete', rawRequest) as Promise<boolean>
  ),
  outcomesConversationById: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('outcomes:conversation:byId', rawRequest) as Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: unknown[]; createdAt: number }>>
  ),

  topicChat: async (rawRequest: { sessionId: string; message: string }) => (
    ipcRenderer.invoke('topic:chat', rawRequest) as Promise<{
      ok: boolean; code?: string; message?: string; answer?: string;
      appliedBlocks?: string[]; session?: Record<string, unknown>; candidates?: Array<Record<string, unknown>>;
    }>
  ),
  onTopicStreamChunk: (handler: (chunk: { sessionId: string; content: string; reasoning?: string; isFinished: boolean }) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload as { sessionId: string; content: string; reasoning?: string; isFinished: boolean });
    ipcRenderer.on('topic:stream-chunk', listener as never);
    return () => { ipcRenderer.removeListener('topic:stream-chunk', listener as never); };
  },
  getScenarioRunForProject: async (projectId: string) => (
    ipcRenderer.invoke('scenario:runStateForProject', projectId) as Promise<{
      ok: boolean;
      runId?: string;
      scenarioId?: string;
      scenarioName?: string;
      status?: 'running' | 'completed' | 'failed' | 'interrupted' | 'paused' | 'cancelled';
      steps?: Array<{
        stepId: string;
        name: string;
        status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
      }>;
    }>
  ),
  compileScenarioHarness: async (rawRequest: { current: ScenarioDefinition; instruction: string; materialIds?: string[]; projectId?: string; scenarioId?: string; conversationId?: string; thinkingLevel?: string }) => (
    ipcRenderer.invoke('scenario:compileHarness', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      error?: string;
      issues?: string[];
      scenario?: ScenarioDefinition;
      summary?: string;
      diff?: ScenarioHarnessDiffEntry[];
      assessment?: ScenarioHarnessAssessment;
      /** 主进程已在编译成功后直接持久化（渲染端无需再保存）。 */
      autosaved?: boolean;
      /** 全自动安装（2026-08-23 刘总授权）：本次编译中自动安装的技能/MCP。 */
      installedDefinitions?: Array<{ id: string; name: string; kind: 'skill' | 'mcp'; url: string }>;
    }>
  ),
  /** 3.8 发送→中断：按场景 ID 中断在途编译（主进程按 scenario:<id> 寻址）。 */
  /** 语音输入（刘总 2026-09）：录音字节交给主进程用当前激活模型服务转写。 */
  transcribeAudio: async (bytes: Uint8Array, mime: string) => (
    ipcRenderer.invoke('audio:transcribe', { bytes, mime }) as Promise<{ ok: boolean; text?: string; code?: string; message?: string }>
  ),
  abortScenarioCompile: async (scenarioId: string) => (
    ipcRenderer.invoke('scenario:abort', { key: `scenario:${scenarioId}` }) as Promise<{ ok: boolean; aborted?: boolean; code?: string }>
  ),
  /** 3.8 当前在途场景编译清单（诊断用）。 */
  scenarioRunningCompiles: async () => (
    ipcRenderer.invoke('scenario:running') as Promise<{ count: number; keys: string[] }>
  ),
  onScenarioCompileEvent: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('scenario:compile-event', listener as never);
    return () => { ipcRenderer.removeListener('scenario:compile-event', listener as never); };
  },
  onScenarioDraftUpdated: (handler: (update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }) => void) => {
    const listener = (_event: unknown, update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }) => handler(update);
    ipcRenderer.on('scenario:draft-updated', listener as never);
    return () => { ipcRenderer.removeListener('scenario:draft-updated', listener as never); };
  },
  onScenarioStreamChunk: (handler: (chunk: { sessionId: string; content: string; reasoning?: string; isFinished: boolean }) => void) => {
    const listener = (_event: unknown, chunk: { sessionId: string; content: string; reasoning?: string; isFinished: boolean }) => handler(chunk);
    ipcRenderer.on('scenario:stream-chunk', listener as never);
    return () => { ipcRenderer.removeListener('scenario:stream-chunk', listener as never); };
  },

  onFreeModelAutoRegisterProgress: (handler: (snapshot: { running: boolean; batchTotal: number; batchDone: number; stations: Array<Record<string, unknown>> }) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: Parameters<typeof handler>[0]) => handler(snapshot);
    ipcRenderer.on('freeModel:autoRegisterProgress', listener as never);
    return () => { ipcRenderer.removeListener('freeModel:autoRegisterProgress', listener as never); };
  },

  refineScenarioConfig: async (rawRequest: unknown) => (
    ipcRenderer.invoke('scenario:aiRefine', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      patch?: unknown;
    }>
  ),
  aiParsePaperTemplate: async (rawRequest: unknown) => (
    ipcRenderer.invoke('personalization:parsePaperTemplate', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      sections?: Array<{ title: string; instruction: string }>;
    }>
  ),
  rendererLog: async (line: string) => { try { await ipcRenderer.invoke('diag:rendererLog', String(line).slice(0, 600)); } catch { /* 诊断日志不阻塞 */ } },
  getPersonalization: async (rawRequest: PersonalizationGetRequest) => {
    const request = PersonalizationGetRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: true as const, definition: null };
    return decodePersonalizationGetResponse(await ipcRenderer.invoke('personalization:get', request.data));
  },
  savePersonalization: async (rawRequest: PersonalizationSaveRequest) => {
    const request = PersonalizationSaveRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:save', request.data));
  },
  archivePersonalization: async (rawRequest: PersonalizationDeleteRequest) => {
    const request = PersonalizationDeleteRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:archive', request.data));
  },
  /** 永久删除定义及其全部版本历史；与归档不同，此操作不可恢复。 */
  deletePersonalization: async (rawRequest: PersonalizationDeleteRequest) => {
    const request = PersonalizationDeleteRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:delete', request.data));
  },
  forkPersonalization: async (rawRequest: PersonalizationForkRequest) => {
    const request = PersonalizationForkRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:fork', request.data));
  },
  restorePersonalization: async (rawRequest: PersonalizationRestoreRequest) => {
    const request = PersonalizationRestoreRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:restore', request.data));
  },
  restorePersonalizationFromTrash: async (rawRequest: PersonalizationTrashRestoreRequest) => {
    const request = PersonalizationTrashRestoreRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:trash:restore', request.data));
  },
  listPersonalizationVersions: async (rawRequest: PersonalizationVersionsRequest) => {
    const request = PersonalizationVersionsRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: true as const, versions: [] };
    return decodePersonalizationVersionsResponse(await ipcRenderer.invoke('personalization:versions', request.data));
  },
  resolvePersonalization: async (rawRequest: PersonalizationResolveRequest) => {
    const request = PersonalizationResolveRequestSchema.safeParse(rawRequest);
    if (!request.success) {
      return { ok: false as const, code: 'definition_corrupt' as const, issues: ['Invalid personalization request'] };
    }
    return decodePersonalizationResolveResponse(await ipcRenderer.invoke('personalization:resolve', request.data));
  },

  // ── HITL Approval ──────────────────────────────────────
  applyPersonalizationExtension: async (rawRequest: PersonalizationExtensionIpcRequest) => {
    const request = PersonalizationExtensionIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationExtensionResponse(null);
    return decodePersonalizationExtensionResponse(
      await ipcRenderer.invoke('personalization:extension:apply', request.data),
    );
  },

  activatePersonalizationMcp: async (rawRequest: McpActivationIpcRequest) => {
    const request = McpActivationIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeMcpActivationResponse(null);
    return decodeMcpActivationResponse(
      await ipcRenderer.invoke('personalization:mcp:activate', request.data),
    );
  },

  exportPersonalizationBundle: async (rawRequest: PersonalizationBundleExportIpcRequest) => {
    const request = PersonalizationBundleExportIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationBundleIpcResponse(null);
    return decodePersonalizationBundleIpcResponse(
      await ipcRenderer.invoke('personalization:bundle:export', request.data),
    );
  },
  importPersonalizationBundle: async (rawRequest: PersonalizationBundleImportIpcRequest) => {
    const request = PersonalizationBundleImportIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationBundleIpcResponse(null);
    return decodePersonalizationBundleIpcResponse(
      await ipcRenderer.invoke('personalization:bundle:import', request.data),
    );
  },
  listPersonalizationSecrets: async (rawRequest: PersonalizationSecretListRequest) => {
    const request = PersonalizationSecretListRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretListResponse(null);
    return decodePersonalizationSecretListResponse(
      await ipcRenderer.invoke('personalization:secrets:list', request.data),
      request.data.operationId,
    );
  },
  setPersonalizationSecret: async (rawRequest: PersonalizationSecretSetRequest) => {
    const request = PersonalizationSecretSetRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretSetResponse(null);
    return decodePersonalizationSecretSetResponse(
      await ipcRenderer.invoke('personalization:secrets:set', request.data),
      request.data.operationId,
    );
  },
  removePersonalizationSecret: async (rawRequest: PersonalizationSecretRemoveRequest) => {
    const request = PersonalizationSecretRemoveRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretRemoveResponse(null);
    return decodePersonalizationSecretRemoveResponse(
      await ipcRenderer.invoke('personalization:secrets:remove', request.data),
      request.data.operationId,
    );
  },
  fundingTemplate: async (rawRequest: FundingTemplateIpcRequest) => {
    const request = FundingTemplateIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeFundingTemplateRuntimeResponse(null);
    return decodeFundingTemplateRuntimeResponse(
      await ipcRenderer.invoke('fundingTemplate:invoke', request.data),
    );
  },

  onApprovalRequired: (callback: (request: ApprovalRequestView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, rawRequest: unknown) => {
      const request = decodeApprovalRequestView(rawRequest);
      if (request) callback(request);
    };
    ipcRenderer.on('hitl:approval:required', handler);
    return () => { ipcRenderer.removeListener('hitl:approval:required', handler); };
  },
  respondApproval: async (requestId: string, approved: boolean) => {
    const request = decodeApprovalResponseRequest({
      requestId,
      decision: approved ? 'approve' : 'reject',
    });
    if (!request) return createApprovalMutationFailure();
    return decodeApprovalMutationResult(await ipcRenderer.invoke('hitl:approval:respond', request));
  },
  getPendingApprovals: async () => {
    const raw = await ipcRenderer.invoke('hitl:approvals:pending') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const request = decodeApprovalRequestView(item);
      return request ? [request] : [];
    });
  },
  listHITLRules: async () => decodeApprovalRuleViews(await ipcRenderer.invoke('hitl:rules:list')),
  toggleHITLRule: async (ruleId: string, enabled: boolean) => {
    const request = decodeApprovalRuleToggleRequest({ ruleId, enabled });
    if (!request) return createApprovalMutationFailure();
    return decodeApprovalMutationResult(await ipcRenderer.invoke('hitl:rules:toggle', request));
  },

};

contextBridge.exposeInMainWorld('metis', api);

// Type declaration for TypeScript in renderer
export type MetisAPI = typeof api;
