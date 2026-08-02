/**
 * Electron preload script — exposes safe IPC APIs to the renderer process.
 *
 * All communication between renderer (React) and main process (Node.js)
 * goes through this bridge. No direct Node.js access in renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { inspectExternalNavigationUrl } from '../engine/security/ExternalNavigation.js';
import {
  AgentChatOptionsSchema,
  decodeAgentResponse,
  decodeGoalLiveEvent,
  decodeHistoryItems,
  decodeStoredHistoryEntry,
  RuntimeIdSchema,
  type AgentChatOptions,
  type GoalLiveEvent,
} from '../engine/runtime/ChatRuntimeContract.js';
import {
  decodeGoalCreateResponse,
  decodeGoalExecutionResult,
  decodeGoalListResponse,
  decodeGoalPlanResponse,
  decodeGoalSummaryResponse,
} from '../engine/runtime/GoalRuntimeContract.js';
import {
  createArtifactListRecovery,
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
  createFileCapabilityFailure,
  decodeFileCapabilityImportRequest,
  decodeFileCapabilitySelectionRequest,
  decodeFileCapabilitySelectionResult,
  decodeFileCapabilityUseRequest,
  decodeFileCapabilityUseResult,
  type FileCapabilityPurpose,
} from '../engine/runtime/FileCapabilityContract.js';
import {
  createLatexCompileRecovery,
  decodeLatexCompileRequest,
  decodeLatexCompileResponse,
} from '../engine/runtime/LatexRuntimeContract.js';
import {
  createPaperAttachmentFailure,
  createPaperDownloadFailure,
  createPaperMutationFailure,
  decodePaperAttachmentResult,
  decodePaperDownloadResult,
  decodePaperIdRequest,
  decodePaperMutationResult,
} from '../engine/runtime/PaperRuntimeContract.js';
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
  decodeExperimentDelete,
  decodeExperimentList,
  decodeExperimentListResult,
  decodeExperimentMutationResult,
  decodeExperimentSave,
} from '../engine/runtime/ExperimentMetadataContract.js';
import {
  ExperimentIdSchema,
  decodeExperimentExecutionGrantRequest,
  decodeExperimentExecutionGrantResult,
  decodeExperimentRunRequest,
  decodeExperimentRunResult,
  decodeExperimentScriptAttachRequest,
  decodeExperimentScriptAttachResult,
} from '../engine/runtime/ExperimentRuntimeContract.js';
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
  createExportFailure,
  decodeExportRequest,
  decodeExportResult,
  type ExportRequest,
} from '../engine/runtime/ExportRuntimeContract.js';
import {
  PersonalizationDeleteRequestSchema,
  PersonalizationForkRequestSchema,
  PersonalizationGetRequestSchema,
  PersonalizationListRequestSchema,
  PersonalizationResolveRequestSchema,
  PersonalizationRestoreRequestSchema,
  PersonalizationVersionsRequestSchema,
  PersonalizationSaveRequestSchema,
  decodePersonalizationGetResponse,
  decodePersonalizationListResponse,
  decodePersonalizationMutationResult,
  decodePersonalizationResolveResponse,
  decodePersonalizationVersionsResponse,
  type PersonalizationDeleteRequest,
  type PersonalizationForkRequest,
  type PersonalizationGetRequest,
  type PersonalizationListRequest,
  type PersonalizationResolveRequest,
  type PersonalizationRestoreRequest,
  type PersonalizationVersionsRequest,
  type PersonalizationSaveRequest,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
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
  AgentControlRequestSchema,
  decodeAgentControlResponse,
  type AgentControlRequest,
} from '../engine/runtime/LiveSteeringContract.js';
import {
  TerminalCreateRequestSchema,
  TerminalDataEventSchema,
  TerminalExitEventSchema,
  TerminalKillRequestSchema,
  TerminalResizeRequestSchema,
  TerminalWriteRequestSchema,
  createTerminalFailure,
  decodeTerminalCreateResult,
  decodeTerminalGrantResult,
  decodeTerminalOperationResult,
  type TerminalCreateRequest,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalKillRequest,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from '../engine/runtime/TerminalRuntimeContract.js';
import {
  createLibraryMutationFailure,
  decodeLibraryCollection,
  decodeLibraryCollectionList,
  decodeLibraryDeleteRequest,
  decodeLibraryMutationResult,
  decodeLibraryNote,
  decodeLibraryNoteList,
  decodeLibraryPaperList,
  decodeLibraryPaperSaveRequest,
} from '../engine/runtime/LibraryRuntimeContract.js';
import {
  createProjectMemoryMutationFailure,
  decodeProjectMemoryContent,
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

type GoalStepStartEvent = Extract<GoalLiveEvent, { type: 'step-start' }>;
type GoalStepCompleteEvent = Extract<GoalLiveEvent, { type: 'step-complete' }>;
type GoalStepFailedEvent = Extract<GoalLiveEvent, { type: 'step-failed' }>;
type GoalProgressEvent = Extract<GoalLiveEvent, { type: 'progress' }>;

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

const api = {
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
  createSession: async (sessionId: string) => {
    const decoded = decodeSessionCreateRequest({ sessionId });
    if (!decoded.ok) return decodeSessionMutationResult(null);
    return decodeSessionMutationResult(
      await ipcRenderer.invoke('session:create', decoded.value),
    );
  },
  listSessions: async () => {
    const decoded = decodeSessionListRequest({});
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

  // ── LaTeX ────────────────────────────────────────────────
  compileLatex: async (source: string, bib?: string) => {
    const request = decodeLatexCompileRequest({ source, bibliography: bib });
    if (!request.ok) return createLatexCompileRecovery();
    return decodeLatexCompileResponse(
      await ipcRenderer.invoke('latex:compile', request.value.source, request.value.bibliography),
    );
  },

  useFileCapability: async (request: unknown) => {
    const decoded = decodeFileCapabilityUseRequest(request);
    if (!decoded.ok) return createFileCapabilityFailure();
    return decodeFileCapabilityUseResult(
      await ipcRenderer.invoke('fileCapability:use', decoded.value),
    );
  },

  // ── Shell ────────────────────────────────────────────────
  selectFileCapability: async (purpose: FileCapabilityPurpose) => {
    const request = decodeFileCapabilitySelectionRequest({ purpose });
    if (!request) return createFileCapabilityFailure();
    return decodeFileCapabilitySelectionResult(
      await ipcRenderer.invoke('fileCapability:select', request),
    );
  },
  importFileCapability: async (request: unknown) => {
    const decoded = decodeFileCapabilityImportRequest(request);
    if (!decoded) return createFileCapabilityFailure();
    return decodeFileCapabilitySelectionResult(
      await ipcRenderer.invoke('fileCapability:import', decoded),
    );
  },
  selectExportDestination: async () => decodeFileCapabilitySelectionResult(
    await ipcRenderer.invoke('export:selectDestination'),
  ),
  previewResearchExport: async (rawRequest: ExportRequest) => {
    const request = decodeExportRequest(rawRequest);
    if (!request.ok) return createExportFailure();
    return decodeExportResult(await ipcRenderer.invoke('export:preview', request.value));
  },
  executeResearchExport: async (rawRequest: ExportRequest) => {
    const request = decodeExportRequest(rawRequest);
    if (!request.ok) return createExportFailure();
    return decodeExportResult(await ipcRenderer.invoke('export:execute', request.value));
  },

  openExternal: (rawUrl: string) => {
    const decision = inspectExternalNavigationUrl(rawUrl);
    if (!decision.ok) {
      return Promise.resolve({ success: false, error: 'External link blocked' });
    }
    return ipcRenderer.invoke('shell:openExternal', decision.url);
  },

  // ── Settings ───────────────────────────────────────────
  getSettings: async () => decodeSettingsView(await ipcRenderer.invoke('settings:get')),
  checkForUpdates: async () => ipcRenderer.invoke('update:check') as Promise<unknown>,
  getUpdateStatus: async () => ipcRenderer.invoke('update:status') as Promise<unknown>,
  downloadUpdate: async () => ipcRenderer.invoke('update:download') as Promise<unknown>,
  installUpdate: async () => ipcRenderer.invoke('update:install') as Promise<unknown>,
  importZotero: async (request: unknown) => ipcRenderer.invoke('zotero:import', request) as Promise<unknown>,
  setSettings: async (config: unknown) => {
    const request = decodeSettingsUpdateRequest(config);
    if (!request) return createSettingsMutationFailure('secure_setup_required');
    return decodeSettingsMutationResult(await ipcRenderer.invoke('settings:set', request));
  },

  // ── Agent ──────────────────────────────────────────────
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentChat: async (sessionId: string, messages: unknown[], skillId: string | undefined, rawOptions: AgentChatOptions) => {
    const options = AgentChatOptionsSchema.safeParse(rawOptions);
    if (!options.success) return decodeAgentResponse(null);
    return decodeAgentResponse(await ipcRenderer.invoke('agent:chat', sessionId, messages, skillId, options.data));
  },
  agentControl: async (rawRequest: AgentControlRequest) => {
    const request = AgentControlRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeAgentControlResponse(null);
    return decodeAgentControlResponse(
      await ipcRenderer.invoke('agent:control', request.data),
      request.data.operationId,
    );
  },

  // ── Papers ─────────────────────────────────────────────
  listPapers: async () => decodeLibraryPaperList(await ipcRenderer.invoke('paper:list')),
  savePaper: async (paper: unknown) => {
    const request = decodeLibraryPaperSaveRequest(paper);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('paper:save', request));
  },
  deletePaper: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('paper:delete', request.id));
  },
  attachPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperAttachmentFailure();
    return decodePaperAttachmentResult(await ipcRenderer.invoke('paper:attachPdf', request.value));
  },
  detachPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperMutationFailure();
    return decodePaperMutationResult(await ipcRenderer.invoke('paper:detachPdf', request.value));
  },
  downloadPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperDownloadFailure();
    return decodePaperDownloadResult(await ipcRenderer.invoke('paper:downloadPdf', request.value));
  },

  // ── Collections ────────────────────────────────────────
  listCollections: async () => decodeLibraryCollectionList(await ipcRenderer.invoke('collection:list')),
  saveCollection: async (collection: unknown) => {
    const request = decodeLibraryCollection(collection);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('collection:save', request));
  },
  deleteCollection: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('collection:delete', request.id));
  },

  // ── Notes ──────────────────────────────────────────────
  listNotes: async () => decodeLibraryNoteList(await ipcRenderer.invoke('note:list')),
  saveNote: async (note: unknown) => {
    const request = decodeLibraryNote(note);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('note:save', request));
  },
  deleteNote: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('note:delete', request.id));
  },

  // ── Experiments metadata CRUD (GLM-102: safe DTO) ────────
  listExperiments: async () => decodeExperimentListResult(
    await ipcRenderer.invoke('experiment:list'),
  ),
  saveExperiment: async (input: unknown) => {
    const request = decodeExperimentSave(input);
    if (!request) return decodeExperimentMutationResult({
      success: false,
      code: 'experiment_metadata_invalid',
    });
    return decodeExperimentMutationResult(await ipcRenderer.invoke('experiment:save', request));
  },
  deleteExperiment: async (id: string) => {
    const requestId = decodeExperimentDelete({ id });
    if (!requestId) return decodeExperimentMutationResult({
      success: false,
      code: 'experiment_metadata_invalid',
    });
    return decodeExperimentMutationResult(
      await ipcRenderer.invoke('experiment:delete', { id: requestId }),
    );
  },
  // ── Experiments secure execution (GLM-102) ────────────────
  attachExperimentScript: async (experimentId: string) => {
    const request = decodeExperimentScriptAttachRequest({ experimentId });
    return decodeExperimentScriptAttachResult(
      request
        ? await ipcRenderer.invoke('experiment:attachScript', request)
        : undefined,
    );
  },
  requestExperimentRunGrant: async (experimentId: string) => {
    const request = decodeExperimentExecutionGrantRequest({ experimentId });
    return decodeExperimentExecutionGrantResult(
      request
        ? await ipcRenderer.invoke('experiment:requestRunGrant', request)
        : undefined,
    );
  },
  runExperiment: async (input: { experimentId: string; grant: unknown }) => {
    const request = decodeExperimentRunRequest(input);
    return decodeExperimentRunResult(
      request ? await ipcRenderer.invoke('experiment:run', request) : undefined,
    );
  },
  cancelExperiment: async (experimentId: string) => {
    const parsed = ExperimentIdSchema.safeParse(experimentId);
    if (!parsed.success) return false;
    return (await ipcRenderer.invoke('experiment:cancel', parsed.data)) === true;
  },

  // ── Bulk Load ──────────────────────────────────────────
  loadAllData: async () => {
    const raw = await ipcRenderer.invoke('data:loadAll') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { papers: [], notes: [], experiments: [], collections: [] };
    }
    const data = raw as Record<string, unknown>;
    return {
      papers: Array.isArray(data.papers)
        ? data.papers.flatMap((item) => {
            const parsed = decodeLibraryPaperSaveRequest(item);
            return parsed && !(parsed as Record<string, unknown>).pdfPath && !(parsed as Record<string, unknown>).owner
              ? [parsed]
              : [];
          })
        : [],
      notes: Array.isArray(data.notes) ? data.notes : [],
      experiments: decodeExperimentList(data.experiments),
      collections: Array.isArray(data.collections) ? data.collections : [],
    };
  },

  // ── Memory ─────────────────────────────────────────────
  getProjectMemory: async () => decodeProjectMemoryContent(await ipcRenderer.invoke('memory:getProject')),
  setProjectMemory: async (content: string) => {
    const request = decodeProjectMemoryWriteRequest({ content });
    if (!request) return createProjectMemoryMutationFailure();
    return decodeProjectMemoryMutationResult(await ipcRenderer.invoke('memory:setProject', request));
  },

  // ── Project Metis.md (CAS-protected compatibility API) ──
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

  // ── Goal Engine ────────────────────────────────────────
  createGoal: async (description: string, context?: string) =>
    decodeGoalCreateResponse(await ipcRenderer.invoke('goal:create', description, context)),
  getGoal: async (goalId: string) =>
    decodeGoalSummaryResponse(await ipcRenderer.invoke('goal:get', goalId)),
  listGoals: async () => decodeGoalListResponse(await ipcRenderer.invoke('goal:list')),
  generatePlan: async (goalId: string) =>
    decodeGoalPlanResponse(await ipcRenderer.invoke('goal:generatePlan', goalId)),
  refinePlan: async (goalId: string, feedback: string) =>
    decodeGoalPlanResponse(await ipcRenderer.invoke('goal:refinePlan', goalId, feedback)),
  updatePlan: (goalId: string, workflow: Record<string, unknown>) => ipcRenderer.invoke('goal:updatePlan', goalId, workflow),
  executeGoal: async (goalId: string) =>
    decodeGoalExecutionResult(await ipcRenderer.invoke('goal:execute', goalId)),
  pauseGoal: (goalId: string) => ipcRenderer.invoke('goal:pause', goalId),
  resumeGoal: async (goalId: string, fromStepId?: string) =>
    decodeGoalExecutionResult(await ipcRenderer.invoke('goal:resume', goalId, fromStepId)),
  cancelGoal: (goalId: string) => ipcRenderer.invoke('goal:cancel', goalId),
  getGoalProgress: (goalId: string) => ipcRenderer.invoke('goal:getProgress', goalId),
  archiveGoal: (goalId: string) => ipcRenderer.invoke('goal:archive', goalId),
  listArchives: () => ipcRenderer.invoke('goal:listArchives'),

  onGoalStepStart: (callback: (data: GoalStepStartEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-start') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:start', handler);
    return () => { ipcRenderer.removeListener('goal:step:start', handler); };
  },
  onGoalStepComplete: (callback: (data: GoalStepCompleteEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-complete') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:complete', handler);
    return () => { ipcRenderer.removeListener('goal:step:complete', handler); };
  },
  onGoalStepFailed: (callback: (data: GoalStepFailedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-failed') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:failed', handler);
    return () => { ipcRenderer.removeListener('goal:step:failed', handler); };
  },
  onGoalProgress: (callback: (data: GoalProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'progress') callback(decoded.value);
    };
    ipcRenderer.on('goal:progress', handler);
    return () => { ipcRenderer.removeListener('goal:progress', handler); };
  },

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

  listPersonalization: async (rawRequest: PersonalizationListRequest) => {
    const request = PersonalizationListRequestSchema.safeParse(rawRequest);
    if (!request.success) throw new TypeError('Invalid personalization list request');
    const response = decodePersonalizationListResponse(
      await ipcRenderer.invoke('personalization:list', request.data),
    );
    if (!response.ok) throw new TypeError(`Personalization list failed: ${response.code}`);
    return response;
  },
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

  // ── Terminal ───────────────────────────────────────────
  requestTerminalGrant: async () => decodeTerminalGrantResult(
    await ipcRenderer.invoke('terminal:requestGrant'),
  ),
  createTerminal: async (rawRequest: TerminalCreateRequest) => {
    const request = TerminalCreateRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalCreateResult(await ipcRenderer.invoke('terminal:create', request.data));
  },
  writeTerminal: async (rawRequest: TerminalWriteRequest) => {
    const request = TerminalWriteRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalOperationResult(await ipcRenderer.invoke('terminal:write', request.data));
  },
  resizeTerminal: async (rawRequest: TerminalResizeRequest) => {
    const request = TerminalResizeRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalOperationResult(await ipcRenderer.invoke('terminal:resize', request.data));
  },
  killTerminal: async (rawRequest: TerminalKillRequest) => {
    const request = TerminalKillRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalOperationResult(await ipcRenderer.invoke('terminal:kill', request.data));
  },

  onTerminalData: (callback: (data: TerminalDataEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const data = TerminalDataEventSchema.safeParse(raw);
      if (data.success) callback(data.data);
    };
    ipcRenderer.on('terminal:data', handler);
    return () => { ipcRenderer.removeListener('terminal:data', handler); };
  },
  onTerminalExit: (callback: (data: TerminalExitEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const data = TerminalExitEventSchema.safeParse(raw);
      if (data.success) callback(data.data);
    };
    ipcRenderer.on('terminal:exit', handler);
    return () => { ipcRenderer.removeListener('terminal:exit', handler); };
  },

};

contextBridge.exposeInMainWorld('metis', api);

// Type declaration for TypeScript in renderer
export type MetisAPI = typeof api;
