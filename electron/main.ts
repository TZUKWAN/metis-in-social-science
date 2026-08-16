/**
 * Electron main process — Metis Research Workbench.
 *
 * Responsibilities:
 *  - Create BrowserWindow with preload
 *  - Initialize PersistenceStore (SQLite)
 *  - Initialize OpenAICompatProvider + AgentLoop from engine
 *  - Handle IPC from renderer (agent run, streaming chat, settings, session CRUD)
 *  - Encrypt/decrypt provider config via SecureStorage
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  screen,
  shell,
  protocol,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawnSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Windows occlusion tracking can throttle — or fully stall — input delivery to
// windows the OS reports as occluded. This is common on VMs / remote-desktop
// sessions and manifests as wheel/click events never reaching the renderer.
// Disabling the optimization costs nothing on normal desktops and restores
// reliable input everywhere. Must run before app ready.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
import {
  createLayoutAcceptanceMetadata,
  extractLayoutAcceptanceToken,
  isExpectedLayoutAcceptanceFrame,
  nextLayoutAcceptanceContentSize,
  parseLayoutAcceptanceWindowRequest,
  requireLayoutAcceptanceRequest,
} from './LayoutAcceptance.js';

// ESM-compatible __dirname (not available by default in ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import * as pty from 'node-pty';
import { PersistenceStore, setSharedStore } from '../engine/persistence/PersistenceStore.js';
import { BrowserService, type BrowserBounds } from './BrowserService.js';
import { CollabService } from './CollabService.js';
import { LiteratureSearchService } from './LiteratureSearchService.js';
import { RESEARCH_CAPABILITY_TASKS } from '../engine/evals/research-capability-suite.js';
import { extendSciSsciIssns } from '../engine/literature/CoreJournalLists.js';
import { detectStage } from '../engine/research/StageDetector.js';
import { JobQueueService } from './JobQueueService.js';
import { ResearchJournalService } from './ResearchJournalService.js';
import { MethodLibraryService } from './MethodLibraryService.js';
import { SubmissionTrackerService } from './SubmissionTrackerService.js';
import { LiteratureWatchService } from './LiteratureWatchService.js';
import { ResearchAgendaService } from './ResearchAgendaService.js';
import { CloudSyncService } from './CloudSyncService.js';
import { AutonomousProfileService } from './AutonomousProfileService.js';
import { AutonomousWorkspaceService } from './AutonomousWorkspaceService.js';
import { setBrowserControlBridge } from '../engine/tools/browser-tools.js';
import { BackupService } from './BackupService.js';
import { WeChatBotService } from './WeChatBotService.js';
import { IlinkClient } from '../engine/im/IlinkClient.js';
import {
  PROJECT_ARCHIVE_EXT,
  PROJECT_ARCHIVE_LEGACY_EXTS,
  exportProjectArchive,
  importProjectArchive,
} from '../engine/export/ProjectArchiveExporter.js';
import { UpdateCheckerService } from './UpdateCheckerService.js';
import { AutoUpdaterService } from './AutoUpdaterService.js';
import { ZoteroImportService } from './ZoteroImportService.js';
import {
  LOCATION_POINTER_VERSION,
  resolveDataDir,
  validateTargetLocation,
  writeLocationPointer,
} from './StorageLocation.js';
import { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import { OpenAICompatProvider } from '../engine/providers/OpenAICompatProvider.js';
import { AgentLoop } from '../engine/core/AgentLoop.js';
import { ToolRegistry } from '../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../engine/tools/ToolDispatcher.js';
import { registerBuiltinTools } from '../engine/tools/index.js';
import { MULTI_AGENT_TOOL, createMultiAgentHandler } from '../engine/tools/builtin/MultiAgentTool.js';
import type { PersonalizationMcpToolRegistration } from './PersonalizationMcpToolBridge.js';
import { HookBus } from '../engine/core/HookBus.js';
import { ContextEngine } from '../engine/context/ContextEngine.js';
import { EvidenceLedger } from '../engine/evidence/EvidenceLedger.js';
import { ApprovalStore } from '../engine/hitl/HITLCore.js';
import { BehaviorRegistry } from '../engine/behavior/BehaviorRegistry.js';
import {
  decryptProviderConfig,
  getSecureStorage,
  initSecureStorage,
} from '../engine/core/SecureStorage.js';
import type { ProviderConfig } from '../engine/core/types.js';
import { MemoryManager } from '../engine/memory/MemoryManager.js';
import { LearningEngine } from '../engine/learning/LearningEngine.js';
import { WorkspaceAgentsManager } from '../engine/memory/WorkspaceAgentsManager.js';
import {
  decodeWorkspaceAgentsWriteRequest,
  decodeWorkspaceAgentsGetRequest,
} from '../engine/runtime/WorkspaceAgentsContract.js';
import { GoalEngine, type GoalExecutionOptions } from '../engine/goal/GoalEngine.js';
import type { Goal } from '../engine/goal/GoalPlanner.js';
import type { GoalPersistence } from '../engine/goal/GoalPersistence.js';
import { createGoalPersistence } from './GoalPersistenceStore.js';
import { WorkflowEngine } from '../engine/workflow/WorkflowEngine.js';
import { ResearchEventBus } from '../engine/research/ResearchEventBus.js';
import { ResearchStrategyStore } from '../engine/persistence/ResearchStrategyStore.js';
import {
  decodeStrategySaveRequest,
  decodeStrategyDeleteRequest,
  decodeStrategySetDefaultRequest,
  decodePaperStructureSaveRequest,
  decodePaperStructureDeleteRequest,
  type ResearchStrategy,
  type PaperStructureTemplate,
} from '../engine/runtime/ResearchStrategyContract.js';
import { AutonomousPlanner } from '../engine/research/AutonomousPlanner.js';
import { AutonomousResearchEngine } from '../engine/research/AutonomousResearchEngine.js';
import {
  applyAutonomousResearchEvent,
  beginAutonomousResearchRun,
  createAutonomousResearchArtifactSink,
  ensureAutonomousResearchProject,
} from '../engine/research/AutonomousResearchPersistence.js';
import { collectPdfCandidates } from '../engine/research/UnpaywallClient.js';
import { resolveDoi } from '../engine/research/DoiResolver.js';
import { searchWorks } from '../engine/research/CrossrefClient.js';
import {
  AUTONOMOUS_CONTRACT_VERSION,
  AUTONOMOUS_CHANNELS,
  decodeAutonomousStartRequest,
  decodeAutonomousControlRequest,
  decodeAutonomousLiveEvent,
} from '../engine/runtime/AutonomousRuntimeContract.js';
import { parseLatexLog } from '../engine/latex/LatexLogParser.js';
import type { WorkflowDefinition, WorkflowHooks, WorkflowRun } from '../engine/workflow/types.js';
import { MCPManager } from '../engine/mcp/MCPManager.js';
import { SkillRegistry, registerDefaultSkills } from '../engine/skills/SkillRegistry.js';
import { SkillExtractor, type ExtractedSkill } from '../engine/skills/SkillExtractor.js';
import { PersonalizationRepository } from '../engine/personalization/PersonalizationRepository.js';
import { isFundingTemplateBuiltinDraftReady } from '../engine/personalization/FundingTemplateBuiltinDraft.js';
import { PersonalizationRuntimeService } from './PersonalizationRuntimeService.js';
import { projectMetisRulesFromWorkspace } from './ProjectMetisRulesBridge.js';
import { EvidenceEnvelopeService } from './EvidenceEnvelopeService.js';
import { PersonalizationSkillInstaller } from './PersonalizationSkillInstaller.js';
import { PersonalizationMcpInstaller } from './PersonalizationMcpInstaller.js';
import { ManagedPersonalizationMcpRuntime } from './ManagedPersonalizationMcpRuntime.js';
import { PersonalizationMcpProbeRunner } from './PersonalizationMcpProbeRunner.js';
import { PersonalizationMcpActivationService } from './PersonalizationMcpActivationService.js';
import { GeneratedMcpActivationCoordinator } from './GeneratedMcpActivationCoordinator.js';
import { PersonalizationMcpToolBridge } from './PersonalizationMcpToolBridge.js';
import { McpBuilderService } from './McpBuilderService.js';
import {
  FilesystemMcpInstallationCompensator,
  PersonalizationExtensionService,
} from './PersonalizationExtensionService.js';
import {
  PersonalizationExtensionApplyRequestSchema,
  PersonalizationExtensionIpcRequestSchema,
  decodePersonalizationExtensionResponse,
  type PersonalizationExtensionApplyRequest,
  type PersonalizationExtensionIpcRequest,
} from '../engine/runtime/PersonalizationExtensionContract.js';
import { McpBuilderSpecificationSchema } from '../engine/runtime/McpInstallationContract.js';
import {
  McpActivationIpcRequestSchema,
  McpActivationRequestSchema,
  decodeMcpActivationResponse,
  type McpActivationIpcRequest,
  type McpActivationRequest,
} from '../engine/runtime/McpActivationContract.js';
import { PersonalizationBundleService } from './PersonalizationBundleService.js';
import { PersonalizationBundleRepositorySink } from './PersonalizationBundleRepositorySink.js';
import { PersonalizationBundleImportCoordinator } from './PersonalizationBundleImportCoordinator.js';
import { PersonalizationBundleSkillRehydrationService } from './PersonalizationBundleSkillRehydrationService.js';
import { PersonalizationBundleSkillAssetSource } from './PersonalizationBundleSkillAssetSource.js';
import { PersonalizationSecretVault } from './PersonalizationSecretVault.js';
import { FundingTemplateRepository } from './FundingTemplateRepository.js';
import { FundingTemplateService } from './FundingTemplateService.js';
import { FundingTemplateToolService } from './FundingTemplateToolService.js';
import { FundingTemplateIpcService } from './FundingTemplateIpcService.js';
import { decodeFundingTemplateRuntimeResponse } from '../engine/runtime/FundingTemplateRuntimeContract.js';
import {
  PERSONALIZATION_BUNDLE_LIMITS,
  PersonalizationBundleSchema,
  PersonalizationBundleExportIpcRequestSchema,
  PersonalizationBundleImportIpcRequestSchema,
  PersonalizationBundleIpcResponseSchema,
} from '../engine/runtime/PersonalizationBundleContract.js';
import {
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretSetRequestSchema,
  decodePersonalizationSecretListResponse,
  decodePersonalizationSecretRemoveResponse,
  decodePersonalizationSecretSetResponse,
} from '../engine/runtime/PersonalizationSecretContract.js';
import { EvalRunner, suiteSummary } from '../engine/evals/EvalRunner.js';
import { evaluateGate } from '../engine/evals/GateEvaluator.js';
import type { EvalTaskSpec } from '../engine/evals/types.js';
import {
  createChatTurnErrorResponse,
  runPersistedChatTurn,
  runEphemeralChatTurn,
} from './ChatTurnService.js';
import { compileScenarioExecutionManifest, runPersistedScenarioWorkflow } from './ScenarioWorkflowService.js';
import { isAuthorizedRendererMainFrame } from './RendererAuthorization.js';
import { createSecureExternalOpenHandler } from './SecureExternalOpenHandler.js';
import {
  AgentChatRequestSchema,
  CHAT_RUNTIME_CONTRACT_VERSION,
  decodeGoalLiveEvent,
  decodeStoredHistoryEntry,
  decodeStoredHistory,
  RuntimeIdSchema,
} from '../engine/runtime/ChatRuntimeContract.js';
import {
  AgentControlRequestSchema,
  InMemoryLiveSteeringQueue,
  LIVE_STEERING_CONTRACT_VERSION,
  decodeAgentControlResponse,
} from '../engine/runtime/LiveSteeringContract.js';
import {
  createGoalWorkflowRecovery,
  decodeGoalChangedEvent,
  decodeGoalCreateResponse,
  decodeGoalListResponse,
  decodeGoalPlanResponse,
  decodeGoalSummaryResponse,
  decodeGoalWorkflowResponse,
  GOAL_PLAN_LABEL,
  GOAL_PLAN_STEP_LABEL,
  GOAL_RUNTIME_LIMITS,
  GoalCreateRequestSchema,
  GoalIdRequestSchema,
  GoalRefineRequestSchema,
} from '../engine/runtime/GoalRuntimeContract.js';
import {
  decodeArtifactContentRequest,
  decodeArtifactContentResponse,
  decodeArtifactCreateRequest,
  decodeArtifactCreatedNotification,
  decodeArtifactListResponse,
  decodeArtifactMutationResult,
} from '../engine/runtime/ArtifactRuntimeContract.js';
import {
  createSessionListRecovery,
  decodeLegacySessionList,
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionListRequest,
  decodeSessionMutationResult,
  decodeSessionUpdateRequest,
} from '../engine/runtime/SessionRuntimeContract.js';
import {
  createFileCapabilityFailure,
  decodeFileCapabilityImportRequest,
  decodeFileCapabilitySelectionRequest,
  decodeFileCapabilitySelectionResult,
} from '../engine/runtime/FileCapabilityContract.js';
import {
  createLatexCompileRecovery,
  decodeLatexCompileRequest,
  decodeLatexCompileResponse,
  type LatexCompileResponse,
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
  ApprovalRequestViewSchema,
  createApprovalMutationFailure,
  decodeApprovalMutationResult,
  decodeApprovalResponseRequest,
  decodeApprovalRuleToggleRequest,
  decodeApprovalRuleViews,
  presentApprovalAction,
} from '../engine/runtime/ApprovalRuntimeContract.js';
import { FileCapabilityRegistry } from './FileCapabilityRegistry.js';
import { createFileCapabilityUseHandler } from './FileCapabilityHandler.js';
import {
  ExecutionCapabilityRegistry,
  type ExecutionOwnerIdentity,
} from './ExecutionCapabilityRegistry.js';
import { createSecureIpcHandler, decoded, rejected } from './SecureIpc.js';
import { SecureDownloadService } from './SecureDownloadService.js';
import { SecureExportService } from './SecureExportService.js';
import { buildResearchExport, type SecureExportPlan } from '../engine/export/ResearchExportBuilder.js';
import {
  buildExportSnapshot,
  resolveTrustedArtifactExportBinding,
} from './ResearchExportAdapter.js';
import {
  createExportFailure,
  decodeExportRequest,
  decodeExportResult,
  type ExportRequest,
} from '../engine/runtime/ExportRuntimeContract.js';
import {
  CA_RUNTIME_CONTRACT_VERSION,
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
} from '../engine/runtime/CurrentAffairsRuntimeContract.js';
import { loadOrCreateCurrentAffairsReceiptSecret } from './CurrentAffairsReceiptKeyStore.js';
import { CurrentAffairsApprovalStore } from '../engine/writing/CurrentAffairsApprovalStore.js';
import { CurrentAffairsArtifactService } from '../engine/writing/CurrentAffairsArtifactService.js';
import { CurrentAffairsSessionState } from '../engine/writing/CurrentAffairsSessionState.js';
import { CurrentAffairsRepositoryService } from '../engine/writing/CurrentAffairsRepositoryService.js';
import { adaptSource } from '../engine/writing/CurrentAffairsSourceAdapter.js';
import { ResearchRuntimeService } from './ResearchRuntimeService.js';
import { ResearchMediaService } from './ResearchMediaService.js';
import { CitationTruthReceiptService } from './CitationTruthReceiptService.js';
import { loadOrCreateCitationTruthSecret } from './CitationTruthKeyStore.js';
import {
  verifyArtifactForExport,
  verifyArtifactForPersistence,
} from './ResearchArtifactTrust.js';
import { ArtifactManifestSchema } from '../engine/artifacts/ArtifactManifest.js';
import {
  createResearchMediaAttachFailure,
  createResearchMediaPurgeFailure,
  decodeResearchMediaAttachRequest,
  decodeResearchMediaAttachResult,
  decodeResearchMediaPurgeRequest,
  decodeResearchMediaPurgeResult,
} from '../engine/runtime/ResearchMediaRuntimeContract.js';
import {
  TERMINAL_RUNTIME_LIMITS,
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
} from '../engine/runtime/TerminalRuntimeContract.js';
import {
  FirstRunSetupService,
  createFirstRunSecureStorage,
  type FirstRunSecureStorage,
  type PreparedSetupRuntime,
  type SetupRuntimeBuildContext,
} from './FirstRunSetupService.js';
import { ProviderProfileStore } from './ProviderProfileStore.js';
import {
  PROVIDER_PROFILE_CONTRACT_VERSION,
  createProviderProfileListRecovery,
  createProviderProfileMutationRecovery,
  decodeProjectProviderOverride,
  decodeProviderProfileDeleteRequest,
  decodeProviderProfileListRequest,
  decodeProviderProfileSaveRequest,
  decodeProviderProfileSwitchRequest,
  decodeProviderProfileResetRequest,
  resolveProviderProfileBinding,
  ProjectProviderOverrideSchema,
  ProviderProfileIdSchema,
  type ProviderProfileBinding,
  type ProviderProfileMutationResponse,
} from '../engine/runtime/ProviderProfileContract.js';
import { OpenAISetupProbeTransport } from './OpenAISetupProbeTransport.js';
import {
  SETUP_RUNTIME_CONTRACT_VERSION,
  decodeSetupAbortRequest,
  decodeSetupProbeResponse,
  type SetupProbeResponse,
  decodeSetupRestoreRequest,
  decodeSetupRestoreResponse,
  decodeSetupSaveRequest,
  decodeSetupSaveResponse,
  decodeSettingsProviderProbeRequest,
  createSetupRecovery,
} from '../engine/runtime/SetupRuntimeContract.js';
import {
  createResearchMutationRecovery,
  createResearchSnapshotRecovery,
  decodeResearchArtifactVersionRequest,
  decodeResearchCheckpointRequest,
  decodeResearchCrudRequest,
  decodeResearchDecisionRequest,
  decodeResearchLinkRequest,
  decodeResearchRestoreRequest,
  decodeResearchReviewRequest,
  decodeResearchSnapshotRequest,
} from '../engine/runtime/ResearchRuntimeContract.js';
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
  createSettingsMutationFailure,
  createSettingsViewRecovery,
  decodeSettingsMutationResult,
  decodeSettingsUpdateRequest,
  decodeSettingsView,
} from '../engine/runtime/SettingsRuntimeContract.js';
import {
  createEvalRunFailure,
  decodeEvalRunRequest,
  decodeEvalRunResult,
} from '../engine/runtime/EvalRuntimeContract.js';
import { createExperimentScriptAdapter, type ExperimentScriptAdapter } from './ExperimentScriptAdapter.js';
import { getOfficeCliService } from './OfficeCliService.js';
import { findNonOverlappingPosition } from './OfficeCliService.js';
import {
  decodeExperimentDelete,
  decodeExperimentList,
  decodeExperimentListResult,
  decodeExperimentMutationResult,
  decodeExperimentSave,
} from '../engine/runtime/ExperimentMetadataContract.js';
import {
  decodeExperimentRunRequest,
  decodeExperimentRunResult,
} from '../engine/runtime/ExperimentRuntimeContract.js';

// ─── Globals ──────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let store: PersistenceStore | null = null;
let backupService: BackupService | null = null;
let backupTimer: NodeJS.Timeout | null = null;
let updateChecker: UpdateCheckerService | null = null;
let autoUpdaterService: AutoUpdaterService | null = null;
let zoteroImportService: ZoteroImportService | null = null;
/** Project targeted by the current zotero:import request (read by the
 *  lazily-created service's linkToProject callback). */
let zoteroImportTargetProjectId: string | undefined;
// Latest auto-update event, kept for the renderer to query on demand.
let lastUpdateEvent: { type: string; version?: string; percent?: number; message?: string } = { type: 'idle' };
let researchRepository: ResearchRepository | null = null;
let researchRuntime: ResearchRuntimeService | null = null;
let researchMedia: ResearchMediaService | null = null;
let weChatBotService: WeChatBotService | null = null;
let startupReady = false;
let firstRunSetup: FirstRunSetupService | null = null;
let providerProfileStore: ProviderProfileStore | null = null;
let providerProfileStorage: FirstRunSecureStorage | null = null;
let runtimeGeneration = 0;
let agentLoop: AgentLoop | null = null;
let provider: OpenAICompatProvider | null = null;
let memoryManager: MemoryManager | null = null;
let learningEngine: LearningEngine | null = null;
let goalEngine: GoalEngine | null = null;
/** Lazily-created durable goal store (rebound to the same sqlite store). */
let goalPersistence: GoalPersistence | null = null;
let researchStrategyStoreInstance: ResearchStrategyStore | null = null;
function strategyStore(): ResearchStrategyStore | null {
  if (!researchStrategyStoreInstance && store) {
    researchStrategyStoreInstance = new ResearchStrategyStore(store);
  }
  return researchStrategyStoreInstance;
}
let autonomousEngine: AutonomousResearchEngine | null = null;
let researchEventBus: ResearchEventBus | null = null;
/** Active autonomous session id (single concurrent run for now). */
let activeAutonomousSessionId: string | null = null;
let mcpManager: MCPManager | null = null;
let skillRegistry: SkillRegistry | null = null;
let skillExtractor: SkillExtractor | null = null;
const CUSTOM_SKILLS_MEMORY_KEY = 'skills:custom';
let personalizationRepository: PersonalizationRepository | null = null;
let personalizationRuntime: PersonalizationRuntimeService | null = null;
let evidenceEnvelopes: EvidenceEnvelopeService | null = null;
let personalizationSkills: PersonalizationSkillInstaller | null = null;
let personalizationMcp: PersonalizationMcpInstaller | null = null;
let personalizationMcpRuntime: ManagedPersonalizationMcpRuntime | null = null;
let personalizationMcpBridge: PersonalizationMcpToolBridge | null = null;
let personalizationMcpActivation: PersonalizationMcpActivationService | null = null;
let personalizationGeneratedMcpActivation: GeneratedMcpActivationCoordinator | null = null;
let personalizationExtensions: PersonalizationExtensionService | null = null;
let personalizationBundles: PersonalizationBundleService | null = null;
let personalizationBundleSink: PersonalizationBundleRepositorySink | null = null;
let personalizationBundleCoordinator: PersonalizationBundleImportCoordinator | null = null;
let personalizationBundleSkillAssets: PersonalizationBundleSkillAssetSource | null = null;
let personalizationSecretVault: PersonalizationSecretVault | null = null;
let fundingTemplateRepository: FundingTemplateRepository | null = null;
let fundingTemplateService: FundingTemplateService | null = null;
let fundingTemplateTools: FundingTemplateToolService | null = null;
const activeFundingToolScopes = new Map<string, {
  ownerId: string;
  projectId: string;
  ownerWebContentsId: number;
}>();
const FUNDING_LOCAL_OWNER_ID = 'local-user' as const;
let approvalStore: ApprovalStore | null = null;
interface ActiveChatRun {
  ownerWebContentsId: number;
  controller: AbortController;
  nextSequence: number;
}
const activeChatRuns = new Map<string, ActiveChatRun>();
/**
 * O15: 多模型对比回合的运行登记。key 为 `${sessionId}::${profileId}`，
 * 与 activeChatRuns 分离——同一会话的多个 profile 对比调用是合法并行，
 * 但同一 profile 的重复并发与「正常回合 + 对比回合」混跑都要拦住。
 */
const activeCompareRuns = new Map<string, { ownerWebContentsId: number; controller: AbortController }>();
/** O15: 判断某会话是否已有对比回合在跑（供正常回合入口做互斥）。 */
function hasCompareRunForSession(sessionId: string): boolean {
  const prefix = `${sessionId}::`;
  for (const key of activeCompareRuns.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
const liveSteeringQueue = new InMemoryLiveSteeringQueue();
let experimentScriptAdapter: ExperimentScriptAdapter | null = null;
let caReceiptSecret: Buffer | null = null; // Current Affairs HMAC signing key
let caRuntime: import('./CurrentAffairsRuntimeService.js').CurrentAffairsRuntimeService | null = null;
/** Maps ownerSessionId (webContentsId) → invoking BrowserWindow for native approval dialog targeting. */
const caOwnerWindows = new Map<string, BrowserWindow>();
const EXPERIMENT_SESSION_SECRET = randomBytes(32).toString('base64url');
let citationTruthReceipts: CitationTruthReceiptService | null = null;
let currentConfig: ProviderConfig | null = null;
let currentTheme: string = 'light';
let layoutAcceptanceWindowControlEnabled = false;
const fileCapabilities = new FileCapabilityRegistry();
let executionCapabilities: ExecutionCapabilityRegistry | null = null;
const secureDownloads = new SecureDownloadService({
  sourceResolver: async (paperId) => {
    const paper = store?.getPapers().find((item) => item.id === paperId);
    return paper?.pdfUrl ? { url: paper.pdfUrl } : null;
  },
});
const secureExports = new SecureExportService();
const exportPreviews = new Map<string, {
  request: ExportRequest;
  plan: SecureExportPlan;
  expiresAt: number;
}>();

// ─── PTY (Terminal) ────────────────────────────────────────
interface ActiveTerminalSession {
  terminal: pty.IPty;
  grantId: string;
  owner: ExecutionOwnerIdentity;
  sequence: number;
  killed: boolean;
}
const activeTerminals = new Map<string, ActiveTerminalSession>();

let requestCounter = 0;

// Lazy browser service (created on first use; needs the main window + store).
let browserService: BrowserService | null = null;
function ensureBrowserService(): BrowserService | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  if (!browserService) {
    browserService = new BrowserService({ window: win, dataDir: DATA_DIR, store: store ?? null });
  }
  return browserService;
}

// 协同对话视图（第三方 AI 网页版）：独立持久分区，与研究浏览器互不干扰。
let collabService: CollabService | null = null;
function ensureCollabService(): CollabService | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  if (!collabService) {
    collabService = new CollabService({ window: win });
  }
  return collabService;
}

// 内置文献检索服务（无状态，直接实例化）。
const literatureSearchService = new LiteratureSearchService();

// Agent-visible browser bridge (kimi-bridge style control for chat/strategy runs).
setBrowserControlBridge({
  navigate: async (url) => {
    const service = ensureBrowserService();
    return service ? service.navigate(url) : { ok: false, error: 'browser_unavailable' };
  },
  back: () => ensureBrowserService()?.goBack(),
  forward: () => ensureBrowserService()?.goForward(),
  reload: () => ensureBrowserService()?.reload(),
  click: (x, y) => ensureBrowserService()?.click(x, y),
  type: (text) => ensureBrowserService()?.type(text),
  scroll: (deltaX, deltaY) => ensureBrowserService()?.scroll(deltaX, deltaY),
  screenshot: async () => {
    const service = ensureBrowserService();
    return service ? service.screenshot() : { ok: false, error: 'browser_unavailable' };
  },
  extract: async () => {
    const service = ensureBrowserService();
    return service ? service.extract() : { ok: false, error: 'browser_unavailable' };
  },
  collect: async () => {
    const service = ensureBrowserService();
    return service ? service.collect() : { ok: false, error: 'browser_unavailable' };
  },
});

// ── Storage location ──────────────────────────────────────────
// The data directory is user-configurable (Settings → 存储位置). Only a tiny
// pointer file lives in `userData`; everything else follows DATA_DIR. Any
// pending relocation runs here, before any database handle is opened.
const USER_DATA_DIR = app.getPath('userData');
const DEFAULT_DATA_DIR = path.join(USER_DATA_DIR, 'metis-data');
const resolvedLocation = resolveDataDir(USER_DATA_DIR, (message) => console.log(`[Main] ${message}`));
const DATA_DIR = resolvedLocation.dataDir;
if (resolvedLocation.migrated) {
  console.log('[Main] Data directory migrated to:', DATA_DIR);
} else if (resolvedLocation.migrationError) {
  console.error(
    `[Main] Data directory migration failed (${resolvedLocation.migrationError}) — continuing at:`,
    DATA_DIR,
  );
}

// 后台作业队列（T10）：PDF 全文抽取等长任务，断点可恢复。
const jobQueueService = new JobQueueService({ dataDir: DATA_DIR, store: null });
jobQueueService.registerIpc();

// 方法库（T4）：跑通的做法沉淀为可参数化重放的资产。
const methodLibrary = new MethodLibraryService(DATA_DIR);
methodLibrary.registerIpc();

// 投稿管理（T20）：状态跟踪 + 退修意见 + 修改说明信。
const submissionTracker = new SubmissionTrackerService(DATA_DIR);
submissionTracker.registerIpc();

// 文献订阅监控（T25）：关键词定期查新，新文献入库待审（不自动下载）。
const literatureWatch = new LiteratureWatchService(DATA_DIR);
literatureWatch.registerIpc();

// 研究议程（T24）：自主科研自动接续队列（每项目上限 + 总量上限 + 冷却 + 可见通知）。
const researchAgenda = new ResearchAgendaService(DATA_DIR);
researchAgenda.registerIpc();

// 自主科研独立配置 + 用户画像（自主改造 A/B）。
const autonomousProfile = new AutonomousProfileService(DATA_DIR);
autonomousProfile.registerIpc();

// 自主科研工作区数据（重构 R1）：研究内容直展的真实数据组装。
const autoWorkspace = new AutonomousWorkspaceService(null, null);
autoWorkspace.registerIpc();

// 批量选题生成（B）：提示词 + 画像 + 约束 → N 个差异化选题，批量入队自主议程。
ipcMain.handle('autonomous:generateBatch', async (event, raw: unknown) => {
  try {
    requireRendererMainFrame(event);
    const input = raw as { prompt?: unknown; count?: unknown };
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim().slice(0, 2000) : '';
    const count = Math.min(5, Math.max(1, Math.trunc(Number(input?.count)) || autonomousProfile.getProfile().defaultBatchSize));
    if (!prompt) return { ok: false, error: 'empty_prompt' };
    const activeProvider = provider;
    if (!activeProvider) return { ok: false, error: 'provider_unavailable' };

    // 上下文：提示词 + 独立约束 + 用户画像（memory/learning）。
    const memoryContext = memoryManager?.buildMemoryContext(undefined) ?? '';
    const learningContext = learningEngine?.buildLearningContext(undefined) ?? '';
    const context = autonomousProfile.buildContext({ prompt, memoryContext, learningContext });

    // 排除已有项目主题（避免重复选题）。
    const existingTitles = researchRepository?.listProjects().map((project) => project.title).slice(0, 50) ?? [];

    const systemPrompt = [
      '你是人文社科科研选题专家。基于用户指令、约束与画像，生成互不相同的候选研究选题。',
      `要求生成 ${count} 个选题。每个选题必须与其他选题、与已有项目在研究问题上有实质差异。`,
      existingTitles.length > 0 ? `已有项目（避免重复）：${existingTitles.join('；')}` : '',
      '只输出一个 JSON 数组，不要 Markdown 代码块，格式：[{"title":"项目名（10-20字）","researchQuestion":"具体可研究的问题","rationale":"为什么值得做（结合用户画像/约束，30-60字）"}]',
    ].filter(Boolean).join('\n');

    const response = await activeProvider.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
    ]);
    const text = (response.content ?? '').trim().replace(/^```(?:json)?/u, '').replace(/```$/u, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return { ok: false, error: 'parse_failed', raw: text.slice(0, 200) };
    let topics: Array<{ title?: unknown; researchQuestion?: unknown; rationale?: unknown }>;
    try {
      topics = JSON.parse(text.slice(start, end + 1)) as typeof topics;
    } catch {
      return { ok: false, error: 'parse_failed', raw: text.slice(0, 200) };
    }
    const valid = topics
      .filter((topic) => typeof topic?.title === 'string' && typeof topic?.researchQuestion === 'string' && (topic.title as string).trim())
      .slice(0, count)
      .map((topic, index) => ({
        title: (topic.title as string).trim().slice(0, 120),
        researchQuestion: (topic.researchQuestion as string).trim().slice(0, 1000),
        rationale: typeof topic.rationale === 'string' ? topic.rationale.trim().slice(0, 500) : '',
        key: `auto-${Date.now().toString(36)}-${index}`,
      }));
    if (valid.length === 0) return { ok: false, error: 'no_valid_topics' };
    // 每个选题的完整 goal = 用户上下文 + 选题本身。
    const entries = valid.map((topic) => ({
      key: topic.key,
      title: topic.title,
      goalPrompt: `${context}\n\n## 本次选题（与其他选题独立执行）\n题目：${topic.title}\n研究问题：${topic.researchQuestion}\n选题理由：${topic.rationale}`,
    }));
    const added = researchAgenda.enqueueAutonomousBatch(entries, 1);
    return {
      ok: true,
      added,
      topics: valid.map((topic) => ({ title: topic.title, researchQuestion: topic.researchQuestion, rationale: topic.rationale })),
    };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 200) };
  }
});

// 自主条目的项目落库：创建新 research project（执行端在接续自主条目时调用）。
ipcMain.handle('autonomous:createProjectFor', (event, raw: unknown) => {
  try {
    requireRendererMainFrame(event);
    const input = raw as { title?: unknown; researchQuestion?: unknown };
    const title = typeof input?.title === 'string' ? input.title.trim().slice(0, 200) : '';
    if (!title || !researchRepository) return { ok: false, projectId: null };
    const now = Date.now();
    const projectId = `project-auto-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    researchRepository.createProject({
      id: projectId,
      title,
      originalIntent: '',
      researchQuestion: typeof input?.researchQuestion === 'string' ? input.researchQuestion.slice(0, 2000) : '',
      lifecycle: 'draft',
      methodology: '',
      discipline: '',
      metadata: { source: 'autonomous' },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      version: 1,
      source: 'autonomous',
      deletedAt: null,
    });
    return { ok: true, projectId };
  } catch {
    return { ok: false, projectId: null };
  }
});

// 自定义 ISSN 白名单导入（T1 补全路径）：用户可导入官方 JCR/CSSCI 目录。
const CUSTOM_ISSN_PATH = path.join(DATA_DIR, 'custom-issns.json');
function loadCustomIssns(): void {
  try {
    if (!fs.existsSync(CUSTOM_ISSN_PATH)) return;
    const list = JSON.parse(fs.readFileSync(CUSTOM_ISSN_PATH, 'utf8')) as string[];
    if (Array.isArray(list)) extendSciSsciIssns(list);
  } catch { /* 脏文件忽略 */ }
}
loadCustomIssns();
ipcMain.handle('settings:importIssnList', async (event) => {
  try {
    requireRendererMainFrame(event);
    const { dialog } = await import('electron');
    const picked = await dialog.showOpenDialog({
      title: '选择 ISSN 清单文件（每行一个 ISSN）',
      filters: [{ name: '文本/CSV', extensions: ['txt', 'csv', 'tsv'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, added: 0 };
    const content = fs.readFileSync(picked.filePaths[0]!, 'utf8');
    const candidates = content.split(/[\r\n,;\t]+/u).map((line) => line.trim()).filter(Boolean);
    const added = extendSciSsciIssns(candidates);
    if (added > 0) {
      const previous = fs.existsSync(CUSTOM_ISSN_PATH)
        ? (JSON.parse(fs.readFileSync(CUSTOM_ISSN_PATH, 'utf8')) as string[])
        : [];
      fs.writeFileSync(CUSTOM_ISSN_PATH, JSON.stringify([...new Set([...previous, ...candidates])], null, 1), 'utf8');
    }
    return { ok: true, added, totalCandidates: candidates.length };
  } catch (err) {
    return { ok: false, added: 0, error: String((err as Error).message ?? err).slice(0, 160) };
  }
});

// ── ASR 访谈转写（T23）：走当前已配置的 OpenAI 兼容 audio 端点 ──
ipcMain.handle('dialog:openAudio', async (event) => {
  try {
    requireRendererMainFrame(event);
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择要转写的音频文件',
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'webm', 'ogg', 'flac'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } catch {
    return null;
  }
});

ipcMain.handle('transcribe:audio', async (event, raw: unknown) => {
  try {
    requireRendererMainFrame(event);
    const request = raw as { filePath?: unknown; language?: unknown };
    const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'file_not_found' };
    const config = currentConfig;
    if (!config?.baseUrl || !config.apiKey) {
      return { ok: false, error: 'provider_not_configured', hint: '请先在设置中配置模型连接（ baseUrl + API Key ）。' };
    }
    const audioModel = (config as { audioModel?: string }).audioModel || config.model;
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), path.basename(filePath));
    form.append('model', audioModel);
    if (typeof request?.language === 'string' && request.language) form.append('language', request.language);
    const base = config.baseUrl.replace(/\/+$/u, '');
    const url = /\/chat\/completions$/u.test(base) ? base.replace(/\/chat\/completions$/u, '/audio/transcriptions') : `${base}/audio/transcriptions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return {
        ok: false,
        error: `audio_http_${response.status}`,
        hint: `当前端点/模型（${audioModel}）可能不支持音频转写：${detail}`,
      };
    }
    const payload = await response.json() as { text?: string };
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) return { ok: false, error: 'empty_transcript' };
    return { ok: true, text: text.slice(0, 100_000), model: audioModel };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 200) };
  }
});

// 概念图谱（T28）：从项目真实数据（资料/编码/论断）组装节点与边。
ipcMain.handle('concept:getGraph', (event, rawProjectId: unknown) => {  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    const repo = researchRepository;
    if (!projectId || !repo) return null;
    const sources = repo.listSources(projectId).slice(0, 60).map((source) => ({
      id: source.id, kind: 'source' as const, label: source.title.slice(0, 40),
    }));
    const codes = repo.listNoteCodes(projectId).slice(0, 80).map((code) => ({
      id: code.id, kind: 'code' as const, label: code.code.slice(0, 30), evidenceId: code.evidenceId,
    }));
    const claims = repo.listClaims(projectId).slice(0, 80).map((claim) => ({
      id: claim.id, kind: 'claim' as const, label: claim.statement.slice(0, 60),
    }));
    const links = repo.listClaimEvidenceLinks(projectId).map((link) => {
      const evidence = repo.getEvidence(link.evidenceId);
      const sourceId = evidence?.sourceId ?? null;
      return { claimId: link.claimId, evidenceId: link.evidenceId, sourceId };
    });
    // 边：论断—证据挂接的资料；若证据被编码过，同时连 编码—论断。
    const edges: Array<{ from: string; to: string; kind: 'supports' | 'coded' }> = [];
    for (const link of links) {
      if (link.sourceId) edges.push({ from: link.claimId, to: link.sourceId, kind: 'supports' });
      for (const code of codes) {
        if (code.evidenceId && code.evidenceId === link.evidenceId) {
          edges.push({ from: link.claimId, to: code.id, kind: 'coded' });
        }
      }
    }
    const nodes = [...sources.map(({ id, kind, label }) => ({ id, kind, label })),
      ...codes.map(({ id, kind, label }) => ({ id, kind, label })),
      ...claims];
    return { nodes, edges };
  } catch {
    return null;
  }
});

  // ── PDF bulk import (T26): native file picker for real paths ──
  ipcMain.handle('dialog:openPdf', async (event) => {
    try {
      requireRendererMainFrame(event);
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog({
        title: '选择要导入的 PDF 文献',
        filters: [{ name: 'PDF 文献', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths;
    } catch {
      return [];
    }
  });

// PDF 批量导入（T26 冷启动）：拷入 dataDir/papers + Crossref 元数据反查 + 入队全文抽取。
// 请求可带 projectId：有自定义目录时归档到 projectDir/pdfs（批2）。
ipcMain.handle('import:pdfFiles', async (event, raw: unknown, rawProjectId?: unknown) => {
  try {
    requireRendererMainFrame(event);
    const files = Array.isArray(raw) ? (raw as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    if (files.length === 0 || !store) return { ok: true, imported: 0, enriched: 0 };
    let outDir = path.join(DATA_DIR, 'papers');
    try {
      if (typeof rawProjectId === 'string' && rawProjectId && researchRepository) {
        const project = researchRepository.getProject(rawProjectId, false);
        const projectDir = (project?.metadata as { projectDir?: string } | undefined)?.projectDir;
        if (projectDir) outDir = path.join(projectDir, 'pdfs');
      }
    } catch { /* 回退默认目录 */ }
    fs.mkdirSync(outDir, { recursive: true });
    let imported = 0;
    let enriched = 0;
    for (const source of files.slice(0, 50)) {
      if (!fs.existsSync(source) || !/\.pdf$/iu.test(source)) continue;
      const dest = path.join(outDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${path.basename(source).replace(/[^\w.-]/gu, '_').slice(0, 120)}`);
      fs.copyFileSync(source, dest);
      const baseTitle = path.basename(source, '.pdf').replace(/[_-]+/gu, ' ').trim().slice(0, 300);
      let title = baseTitle || path.basename(source);
      let authors: string[] = [];
      let year = 0;
      let venue = '';
      let doi = '';
      // Crossref 题名反查（尽力而为，失败不阻塞导入）。
      try {
        const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(baseTitle)}&rows=1&select=title,author,issued,container-title,DOI`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Metis-Workbench/0.1 (mailto:metis-workbench@localhost)' },
          signal: AbortSignal.timeout(12_000),
        });
        if (response.ok) {
          const payload = await response.json() as { message?: { items?: Array<{ title?: string[]; author?: Array<{ given?: string; family?: string }>; issued?: { 'date-parts'?: number[][] }; 'container-title'?: string[]; DOI?: string }> } };
          const hit = payload.message?.items?.[0];
          if (hit && hit.title?.[0]) {
            title = hit.title[0]!;
            authors = (hit.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 12);
            year = hit.issued?.['date-parts']?.[0]?.[0] ?? 0;
            venue = hit['container-title']?.[0] ?? '';
            doi = hit.DOI ?? '';
            enriched += 1;
          }
        }
      } catch { /* 离线/超时：保留文件名题录 */ }
      const paperId = `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      store.savePaper({
        id: paperId,
        title,
        authors,
        year,
        venue,
        abstract: '',
        doi,
        arxivId: '',
        pdfPath: dest,
        pdfUrl: '',
        tags: ['imported:pdf'],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        addedAt: Date.now(),
      });
      jobQueueService.enqueueExtract(paperId, dest);
      imported += 1;
    }
    return { ok: true, imported, enriched };
  } catch (err) {
    return { ok: false, imported: 0, enriched: 0, error: String((err as Error).message ?? err).slice(0, 200) };
  }
});

// 研究日志（T27）：惰性依赖 repository/goalEngine/store，请求时取最新引用。
ipcMain.handle('research:resumeBrief', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId) return null;
    const liveJournal = new ResearchJournalService(researchRepository, goalEngine, store);
    return liveJournal.buildResumeBrief(projectId);
  } catch {
    return null;
  }
});

// 科研阶段（T5）：存储于 project.metadata.stage，与 lifecycle 状态机正交。
ipcMain.handle('research:getStage', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return null;
    const project = researchRepository.getProject(projectId, false);
    return (project?.metadata as { stage?: string } | undefined)?.stage ?? null;
  } catch {
    return null;
  }
});
ipcMain.handle('research:setStage', (event, rawRequest: unknown) => {
  try {
    requireRendererMainFrame(event);
    const request = rawRequest as { projectId?: unknown; stage?: unknown };
    const projectId = typeof request?.projectId === 'string' ? request.projectId : '';
    const stage = typeof request?.stage === 'string' ? request.stage.slice(0, 32) : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project) return { ok: false };
    researchRepository.updateProject(projectId, {
      metadata: { ...project.metadata, ...(stage ? { stage } : {}) },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ── 项目归档/恢复/删除（批1）────────────────────────────────
ipcMain.handle('research:archiveProject', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project || project.lifecycle === 'archived') return { ok: false };
    // 归档前记住原生命周期，恢复时转回。
    researchRepository.updateProject(projectId, {
      lifecycle: 'archived',
      metadata: { ...project.metadata, preArchiveLifecycle: project.lifecycle },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) };
  }
});
ipcMain.handle('research:restoreProject', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project || project.lifecycle !== 'archived') return { ok: false };
    const prior = (project.metadata as { preArchiveLifecycle?: string }).preArchiveLifecycle;
    const target = prior === 'completed' || prior === 'reviewing' ? prior : 'draft';
    researchRepository.updateProject(projectId, {
      lifecycle: target,
      metadata: { ...project.metadata, preArchiveLifecycle: undefined },
    });
    return { ok: true, restoredLifecycle: target };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) };
  }
});
ipcMain.handle('research:deleteProject', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return { ok: false };
    const removed = researchRepository.softDeleteProject(projectId);
    return { ok: removed };
  } catch {
    return { ok: false };
  }
});

// ── 项目自定义目录（批2）：PDF 归档位置，默认数据目录自动管理 ──
ipcMain.handle('dialog:openDirectory', async (event) => {
  try {
    requireRendererMainFrame(event);
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择项目文件夹（PDF 将归档到其 pdfs 子目录）',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } catch {
    return null;
  }
});
ipcMain.handle('research:setProjectDir', (event, rawRequest: unknown) => {
  try {
    requireRendererMainFrame(event);
    const request = rawRequest as { projectId?: unknown; projectDir?: unknown };
    const projectId = typeof request?.projectId === 'string' ? request.projectId : '';
    const projectDir = typeof request?.projectDir === 'string' ? request.projectDir.trim().slice(0, 500) : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project) return { ok: false };
    researchRepository.updateProject(projectId, {
      metadata: { ...project.metadata, ...(projectDir ? { projectDir } : { projectDir: undefined }) },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ── AI 阶段自动判定（批3）：实时规则评分，用户不可手选 ──
ipcMain.handle('research:detectStage', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository || !store) return null;
    const project = researchRepository.getProject(projectId, false);
    if (!project) return null;
    const papers = store.getPapers().filter((paper) => paper.projectId === projectId);
    const goals = (goalEngine?.listGoals() ?? []).filter((goal) => goal.projectId === projectId);
    const artifacts = researchRepository.listArtifacts(projectId);
    const noteCodes = researchRepository.listNoteCodes(projectId);
    const runs = researchRepository.listRuns(projectId);
    const latestRun = runs.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const transcripts = store.raw.prepare(
      "SELECT COUNT(*) as c FROM notes WHERE project_id = ? AND tags LIKE '%type:transcript%'",
    ).get(projectId) as { c: number };
    const submissions = new SubmissionTrackerService(DATA_DIR).list(projectId).length;
    const result = detectStage({
      paperCount: papers.length,
      paperWithPdfCount: papers.filter((paper) => Boolean(paper.pdfPath)).length,
      completedTasks: goals.filter((goal) => goal.status === 'completed').length,
      openTasks: goals.filter((goal) => goal.status !== 'completed').length,
      artifactCount: artifacts.length,
      noteCodeCount: noteCodes.length,
      transcriptCount: transcripts.c,
      researchQuestionFilled: Boolean(project.researchQuestion.trim()),
      lastRunStatus: latestRun?.status ?? null,
      submissionCount: submissions,
    });
    return result;
  } catch {
    return null;
  }
});

// ── Custom app scheme for the production renderer ─────────────
// file:// URLs cannot load ESM bundles (Chromium blocks module scripts with a
// null origin + crossorigin attribute), so production serves dist/ over a
// privileged `metis://` scheme. Must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'metis-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
process.env.METIS_DATA_DIR = DATA_DIR;

const PAPERS_DIR = path.join(DATA_DIR, 'papers');
const IMPORTS_DIR = path.join(DATA_DIR, 'imports');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const RESEARCH_MEDIA_DIR = path.join(DATA_DIR, 'research-media');
const TERMINAL_WORKSPACE_DIR = path.join(DATA_DIR, 'terminal-workspace');
const DB_PATH = path.join(DATA_DIR, 'metis.db');
const CONFIG_PATH = path.join(DATA_DIR, 'provider-config.json');
const SETUP_CONFIG_PATH = path.join(DATA_DIR, 'provider-setup.json');
const THEME_PATH = path.join(DATA_DIR, 'theme.txt');

// WebDAV 云备份（T33）：用户自填服务器；启动时应用恢复暂存（DB_PATH 已就绪）。
const cloudSync = new CloudSyncService(DATA_DIR, DB_PATH);
cloudSync.registerIpc();
const layoutAcceptanceToken = extractLayoutAcceptanceToken(process.argv);
export const layoutAcceptanceEntryPath = path.resolve(__dirname, '../../dist/index.html');
const rendererEntryUrl = process.env.VITE_DEV_SERVER_URL
  ?? 'metis-app://renderer/index.html';

export function getRendererEntryUrl(): string {
  return rendererEntryUrl;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function mimeForLocalFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.tex': 'application/x-tex',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return known[extension] ?? 'application/octet-stream';
}

// Per-WebContents generation counter for SetupOwner revocation.
// Incremented on main-frame navigation/reload; cleared on destroy.
const webContentsGenerations = new Map<number, number>();

function setupOwnerFor(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame?.processId || !frame?.routingId) {
    throw new Error("Setup owner requires a valid sender frame");
  }
  const wcId = event.sender.id;
  const generation = webContentsGenerations.get(wcId) ?? 0;
  return { webContentsId: wcId, processId: frame.processId, routingId: frame.routingId, generation };
}

function bumpWebContentsGeneration(wcId: number) {
  webContentsGenerations.set(wcId, (webContentsGenerations.get(wcId) ?? 0) + 1);
}

function cleanupActiveChatRuns(wcId: number) {
  for (const [sessionId, run] of activeChatRuns) {
    if (run.ownerWebContentsId !== wcId) continue;
    run.controller.abort();
    liveSteeringQueue.clear(sessionId);
    activeChatRuns.delete(sessionId);
    activeFundingToolScopes.delete(sessionId);
  }
}

function cleanupWebContentsOwner(wcId: number) {
  webContentsGenerations.delete(wcId);
  firstRunSetup?.revokeWebContents(wcId);
  caRuntime?.clearOwner(String(wcId));
  caOwnerWindows.delete(String(wcId));
  cleanupActiveChatRuns(wcId);
  void personalizationMcpRuntime?.shutdownWebContents(wcId);
}


function sanitizeListUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    return null; // reject file://, local paths, etc.
  } catch { return null; }
}

function getLayoutAcceptanceMetadata() {
  return createLayoutAcceptanceMetadata(
    layoutAcceptanceToken,
    app.getPath('userData'),
    layoutAcceptanceEntryPath,
  );
}

function requireLayoutAcceptanceMainFrame(event: IpcMainInvokeEvent): BrowserWindow {
  const liveMainWindow = getMainWindow();
  const window = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  const senderWindowMatches = Boolean(
    window && window === liveMainWindow && !window.isDestroyed(),
  );
  requireLayoutAcceptanceRequest({
    token: layoutAcceptanceToken,
    controlEnabled: layoutAcceptanceWindowControlEnabled,
    senderWindowMatches,
    senderFrameMatches: Boolean(
      senderWindowMatches && senderFrame === window?.webContents.mainFrame,
    ),
    senderFrameUrl: senderFrame?.url ?? '',
    expectedEntryPath: layoutAcceptanceEntryPath,
  });
  return window!;
}

export function requireRendererMainFrame(event: IpcMainInvokeEvent): BrowserWindow {
  const liveMainWindow = getMainWindow();
  const liveEntryUrl = getRendererEntryUrl();
  const window = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  const senderWindowMatches = Boolean(
    window && window === liveMainWindow && !window.isDestroyed(),
  );
  const authorized = isAuthorizedRendererMainFrame({
    senderWindowMatches,
    senderFrameMatches: Boolean(
      senderWindowMatches && senderFrame === window?.webContents.mainFrame,
    ),
    senderFrameUrl: senderFrame?.url ?? '',
    expectedEntryUrl: liveEntryUrl,
  });
  if (!authorized) throw new Error('Unauthorized IPC sender');
  return window!;
}

export function executionOwnerFor(event: IpcMainInvokeEvent): ExecutionOwnerIdentity {
  const frame = event.senderFrame;
  if (!frame) throw new Error('Execution owner is unavailable');
  return {
    webContentsId: event.sender.id,
    mainFrameProcessId: frame.processId,
    mainFrameRoutingId: frame.routingId,
  };
}

function managedMcpOwnerFor(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) throw new Error('Managed MCP owner is unavailable');
  return {
    webContentsId: event.sender.id,
    processId: frame.processId,
    routingId: frame.routingId,
    generation: webContentsGenerations.get(event.sender.id) ?? 0,
  };
}

function canonicalPersonalizationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPersonalizationJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalPersonalizationJson(record[key])}`).join(',')}}`;
}

function bindPersonalizationExtensionRequest(
  request: PersonalizationExtensionIpcRequest,
  event: IpcMainInvokeEvent,
): PersonalizationExtensionApplyRequest | undefined {
  const owner = executionOwnerFor(event);
  const operationId = request.operationId;
  const runManifestDigest = createHash('sha256')
    .update('metis:personalization-extension-ipc:v1\0')
    .update(canonicalPersonalizationJson({ owner, request }))
    .digest('hex');
  const evidenceContext = {
    sessionId: `personalization-${owner.webContentsId}`,
    projectId: 'global',
    operationId,
    runManifestDigest,
    observedAt: Date.now(),
  };
  const { operationId: _operationId, ...withoutOperationId } = request;
  const internal = request.mode === 'mcp_requirements'
    ? { ...withoutOperationId, operationId, evidenceContext }
    : { ...withoutOperationId, evidenceContext };
  void _operationId;
  const parsed = PersonalizationExtensionApplyRequestSchema.safeParse(internal);
  return parsed.success ? parsed.data : undefined;
}

function bindMcpActivationRequest(
  request: McpActivationIpcRequest,
  event: IpcMainInvokeEvent,
): McpActivationRequest | undefined {
  const owner = managedMcpOwnerFor(event);
  const runManifestDigest = createHash('sha256')
    .update('metis:personalization-mcp-activation-ipc:v1\0')
    .update(canonicalPersonalizationJson({ owner, request }))
    .digest('hex');
  const parsed = McpActivationRequestSchema.safeParse({
    contractVersion: 1,
    definitionId: request.definitionId,
    installationId: request.installationId,
    expectedRevision: request.expectedRevision,
    evidenceContext: {
      sessionId: `personalization-${owner.webContentsId}-${owner.generation}`,
      projectId: 'global',
      operationId: request.operationId,
      runManifestDigest,
      observedAt: Date.now(),
      owner,
    },
  });
  return parsed.success ? parsed.data : undefined;
}

function writePersonalizationBundleFile(destination: string, bytes: Uint8Array): void {
  const parent = path.dirname(path.resolve(destination));
  const parentStat = fs.lstatSync(parent);
  const parentReal = fs.realpathSync.native(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (process.platform === 'win32' ? parentReal.toLowerCase() !== parent.toLowerCase() : parentReal !== parent)) {
    throw new Error('Unsafe bundle destination');
  }
  if (fs.existsSync(destination)) throw new Error('Bundle destination already exists');
  const temporary = path.join(parent, `.metis-bundle-${randomUUID()}.tmp`);
  let published = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    published = true;
    if (process.platform !== 'win32') {
      const directory = fs.openSync(parent, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (!published && fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function readPersonalizationBundleFile(source: string): Uint8Array {
  const resolved = fs.realpathSync.native(path.resolve(source));
  const lstat = fs.lstatSync(resolved);
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size <= 0
    || lstat.size > PERSONALIZATION_BUNDLE_LIMITS.encodedBytes) {
    throw new Error('Unsafe personalization bundle');
  }
  const fd = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error('Personalization bundle changed while being read');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function nextTerminalId(): string {
  return `ts_${randomBytes(32).toString('base64url')}`;
}

function presentGoalPlan(goalId: string, workflow: WorkflowDefinition) {
  return decodeGoalPlanResponse({
    success: true,
    goalId,
    label: GOAL_PLAN_LABEL,
    steps: workflow.steps.map((step, index) => ({
      stepId: step.id,
      label: GOAL_PLAN_STEP_LABEL,
      ordinal: index + 1,
    })),
  });
}

function presentGoalSummary(
  goal: { id: string; description?: unknown; status: unknown; createdAt: number; projectId?: string },
  checkpoint?: { resumable: boolean; completedSteps: number; totalSteps: number },
) {
  // UX-GOAL-001: 看板/列表展示持久化的 goal.description，而不是统一占位
  // 标题。空值或损坏记录才回退到固定兜底文案。
  const rawDescription = typeof goal.description === 'string' ? goal.description.trim() : '';
  const label = rawDescription
    ? rawDescription.slice(0, GOAL_RUNTIME_LIMITS.labelChars)
    : 'Research goal';
  return {
    goalId: goal.id,
    label,
    status: goal.status,
    createdAt: goal.createdAt,
    ...(goal.projectId ? { projectId: goal.projectId } : {}),
    // O14: 附带 checkpoint 摘要，渲染端据此显示「从上次断点继续」。
    ...(checkpoint ? { checkpoint } : {}),
  };
}

/** O14: 读取 goal 的 checkpoint 摘要；无持久化 run 时返回 undefined。 */
function goalCheckpointSummary(goalId: string): { resumable: boolean; completedSteps: number; totalSteps: number } | undefined {
  if (!goalEngine) return undefined;
  const info = goalEngine.getCheckpointInfo(goalId);
  if (!info.hasCheckpoint) return undefined;
  return { resumable: info.resumable, completedSteps: info.completedSteps, totalSteps: info.totalSteps };
}

// ─── O17: 工作流可视化 presenter ──────────────────────────────

/** 契约文本上限，与 GoalRuntimeContract 的 WORKFLOW_VIEW_TEXT_LIMIT 对齐。 */
const WORKFLOW_VIEW_TEXT_LIMIT = 20_000;
// eslint-disable-next-line no-control-regex
const WORKFLOW_VIEW_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** 契约化清洗：去控制字符（保留换行/回车）并截断到上限。 */
function workflowViewText(value: unknown, limit = WORKFLOW_VIEW_TEXT_LIMIT): string {
  if (typeof value !== 'string') return '';
  return value.replace(WORKFLOW_VIEW_UNSAFE, ' ').slice(0, limit);
}

function workflowViewId(value: unknown): string {
  return workflowViewText(value, 200).replace(/\s+/gu, ' ').trim();
}

/** 验收标准 → 人类可读摘要串（kind + 值/描述）。 */
function presentAcceptanceCriteria(criteria: readonly import('../engine/workflow/AcceptanceCriteria.js').AcceptanceCriterion[] | undefined): string[] | undefined {
  if (!criteria || criteria.length === 0) return undefined;
  return criteria.map((criterion) => {
    const note = criterion.description?.trim();
    const base = note ? `${note}` : criterion.kind;
    return workflowViewText(`${base} (${criterion.kind}: ${criterion.value})`, 500);
  });
}

/**
 * O17: 把 GoalEngine 的只读视图映射为契约形状。所有自由文本都在这里
 * 截断清洗，保证渲染端拿到的内容可直接安全渲染。
 */
function presentGoalWorkflow(
  goalId: string,
  view: { workflow: WorkflowDefinition; run: WorkflowRun | undefined },
) {
  const { workflow, run } = view;
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  const dependencies: Record<string, string[]> = {};
  for (const [stepId, deps] of Object.entries(workflow.dependencies)) {
    if (!stepIds.has(stepId)) continue;
    dependencies[stepId] = deps.filter((dep) => stepIds.has(dep));
  }
  const KNOWN_STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'skipped']);
  const stepResults: Record<string, {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    output: string;
    retryCount: number;
    failureReasons?: string[];
    decisionRequired?: boolean;
  }> = {};
  for (const [stepId, result] of Object.entries(run?.stepResults ?? {})) {
    if (!stepIds.has(stepId)) continue;
    stepResults[stepId] = {
      status: (KNOWN_STEP_STATUSES.has(result.status) ? result.status : 'pending') as 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
      output: workflowViewText(result.output),
      retryCount: Number.isFinite(result.retryCount) ? Math.max(0, Math.floor(result.retryCount)) : 0,
      ...(result.failureReasons?.length ? { failureReasons: result.failureReasons.map((reason) => workflowViewText(reason, 500)) } : {}),
      ...(result.decisionRequired ? { decisionRequired: true } : {}),
    };
  }
  return {
    success: true as const,
    goalId,
    workflow: {
      id: workflowViewId(workflow.id) || 'workflow',
      name: workflowViewText(workflow.name, 500),
      description: workflowViewText(workflow.description, 2000),
      version: workflowViewId(workflow.version) || '1',
      steps: workflow.steps.map((step) => ({
        id: step.id,
        name: workflowViewText(step.name, 500),
        description: workflowViewText(step.description, 2000),
        prompt: workflowViewText(step.prompt),
        tools: step.tools.map((tool) => workflowViewId(tool)).filter(Boolean),
        maxTurns: Number.isFinite(step.maxTurns) ? Math.max(0, Math.floor(step.maxTurns)) : 0,
        ...(presentAcceptanceCriteria(step.acceptanceCriteria) ? { acceptanceCriteria: presentAcceptanceCriteria(step.acceptanceCriteria) } : {}),
      })),
      dependencies,
    },
    stepResults,
  };
}

/**
 * O13: 解析 goal 执行的 provider 绑定。goal 所属项目存在覆盖时，用覆盖
 * profile 的配置（含解密 key）构建临时 AgentLoop，使该项目真正以独立模型
 * 执行；任何一步不可用都回退全局运行时，绑定如实记录实际生效来源。
 */
function resolveGoalExecutionOptions(goal: { projectId?: string }): GoalExecutionOptions {
  // 全局参考：激活 profile 优先；无 profile 体系时退回 currentConfig。
  const globalRef = (() => {
    const listed = providerProfileStore?.list();
    if (listed?.ok) {
      const active = listed.value.profiles.find((p) => p.isActive);
      if (active) return { profileId: active.id as string, model: active.model };
    }
    return { profileId: null, model: currentConfig?.model ?? '' };
  })();
  const globalBinding: ProviderProfileBinding = {
    source: 'global',
    profileId: globalRef.profileId,
    model: globalRef.model,
  };
  if (!goal.projectId || !researchRepository) return { providerBinding: globalBinding };
  const override = researchRepository.getProjectProviderOverride(goal.projectId);
  if (!override) return { providerBinding: globalBinding };

  const overrideProfileModel = (() => {
    if (!override.providerProfileId || !providerProfileStore) return undefined;
    const listed = providerProfileStore.list();
    if (!listed.ok) return undefined;
    return listed.value.profiles.find((p) => p.id === override.providerProfileId)?.model;
  })();
  const binding = resolveProviderProfileBinding(globalRef, override, overrideProfileModel);

  // 覆盖运行时：覆盖 profile 的完整配置，或基于当前配置仅换模型。
  let overrideConfig: ProviderConfig | null = null;
  if (override.providerProfileId && providerProfileStore) {
    const result = providerProfileStore.configFor(override.providerProfileId);
    if (result.ok && result.value.apiKey) {
      overrideConfig = override.model ? { ...result.value, model: override.model } : result.value;
    }
  } else if (override.model && currentConfig?.apiKey) {
    overrideConfig = { ...currentConfig, model: override.model };
  }
  if (!overrideConfig) {
    console.warn('[Main] O13: project provider override unavailable; falling back to global runtime', { projectId: goal.projectId });
    return { providerBinding: globalBinding };
  }
  try {
    const overrideProvider = createProvider(overrideConfig);
    const loop = createAgentLoop(overrideProvider, buildRuntimeRegistry(), approvalStore ?? undefined, [], overrideConfig);
    return { providerBinding: binding, agentOverride: loop.agentLoop };
  } catch (error) {
    console.warn('[Main] O13: failed to build override runtime; falling back to global', error);
    return { providerBinding: globalBinding };
  }
}

/** Durable goal store bound to the shared sqlite PersistenceStore. */
function currentGoalPersistence(): GoalPersistence | undefined {
  if (store && !goalPersistence) {
    goalPersistence = createGoalPersistence(store);
  }
  return goalPersistence ?? undefined;
}

/**
 * Broadcast a goal state change to the renderer (chat cards and the kanban
 * board both refresh from this). Payload is contract-validated before send;
 * an invalid payload is dropped rather than risking a mis-shaped event.
 */
function broadcastGoalChanged(sender: Electron.WebContents, goal: Goal, statusOverride?: Goal['status'] | 'cancelled') {
  try {
    const event = decodeGoalChangedEvent({
      goalId: goal.id,
      label: goal.description,
      status: statusOverride ?? goal.status,
      priority: goal.priority,
      createdAt: goal.createdAt,
    });
    if (event) sender.send('goal:changed', event);
  } catch {
    // Broadcast must never break the caller.
  }
}

// ─── Autonomous research helpers ──────────────────────────────

/**
 * Map an internal ResearchEvent (producer shape) to a live-event payload that
 * satisfies AutonomousLiveEventSchema (renderer-consumable). Adds the contract
 * version + monotonic sequence the renderer expects.
 */
function toLivePayload(
  evt: import('../engine/research/ResearchEventBus.js').ResearchEvent,
  sessionId: string,
  sequence: number,
): unknown {
  const base = { version: AUTONOMOUS_CONTRACT_VERSION, sessionId, sequence };
  switch (evt.type) {
    case 'engine-started':
      return { ...base, type: 'engine-started', goal: evt.goal, plan: evt.plan, method: evt.method };
    case 'phase-started':
      return { ...base, type: 'phase-started', phase: evt.phase, phaseIteration: evt.phaseIteration, phaseName: evt.phaseName };
    case 'step-start':
    case 'step-complete':
    case 'step-failed':
      return { ...base, type: evt.type, phase: evt.phase, stepId: evt.stepId, stepName: evt.stepName, output: evt.output, error: evt.error };
    case 'reflection':
      return {
        ...base, type: 'reflection', phase: evt.phase, decision: evt.decision,
        nextPhase: evt.nextPhase, qualityScore: evt.qualityScore, reasoning: evt.reasoning, revisionNote: evt.revisionNote,
      };
    case 'progress':
      return { ...base, type: 'progress', completedPhases: evt.completedPhases, totalPhases: evt.totalPhases, currentPhase: evt.currentPhase };
    case 'engine-completed':
      return { ...base, type: 'engine-completed', summary: evt.summary, artifactIds: evt.artifactIds };
    case 'engine-failed':
      return { ...base, type: 'engine-failed', reason: evt.reason, completedPhases: evt.completedPhases, recoverable: evt.recoverable };
    case 'engine-interrupted':
      return { ...base, type: 'engine-interrupted', reason: evt.reason };
    case 'engine-paused':
      return { ...base, type: 'engine-paused', reason: evt.reason };
    case 'engine-resumed':
      return { ...base, type: 'engine-resumed', completedPhases: evt.completedPhases };
    default:
      return null;
  }
}

function channelForEvent(evt: import('../engine/research/ResearchEventBus.js').ResearchEvent): string | null {
  const C = AUTONOMOUS_CHANNELS.live;
  switch (evt.type) {
    case 'engine-started': return C.engineStarted;
    case 'phase-started': return C.phaseStarted;
    case 'step-start': return C.stepStart;
    case 'step-complete': return C.stepComplete;
    case 'step-failed': return C.stepFailed;
    case 'reflection': return C.reflection;
    case 'progress': return C.progress;
    case 'engine-completed': return C.engineCompleted;
    case 'engine-failed': return C.engineFailed;
    case 'engine-interrupted': return C.engineInterrupted;
    case 'engine-paused': return C.enginePaused;
    case 'engine-resumed': return C.engineResumed;
    default: return null;
  }
}

/**
 * Subscribe the LearningEngine to the research event bus so autonomous output
 * feeds back into memory (the "hook extends learning scenarios" goal). This is
 * the closed loop: research produces knowledge → learning persists it → future
 * research/prompts benefit from it.
 */
function subscribeLearningToResearchBus(
  bus: ResearchEventBus,
  learning: import('../engine/learning/LearningEngine.js').LearningEngine | null,
): void {
  if (!learning) return;
  bus.subscribe((evt) => {
    try {
      if (evt.type === 'step-complete' && evt.output && evt.output.length > 40) {
        // Treat substantial step outputs as experience worth remembering.
        learning.rememberAutonomousOutput?.(evt.phase, evt.stepName, evt.output);
      }
      if (evt.type === 'reflection' && evt.decision === 'advance') {
        learning.rememberAutonomousDecision?.(evt.phase, evt.reasoning);
      }
    } catch { /* learning must never break the research bus */ }
  });
}

function presentPaper(
  paper: ReturnType<PersistenceStore['getPapers']>[number],
  owner: ExecutionOwnerIdentity,
): Omit<ReturnType<PersistenceStore['getPapers']>[number], 'pdfPath'> & {
  pdfCapability?: import('../engine/runtime/FileCapabilityContract.js').FileCapabilityDescriptor;
} {
  const { pdfPath, ...safePaper } = paper;
  // The renderer contract has no null projectId — drop unlinked papers' id.
  const summary = safePaper.projectId === null
    ? { ...safePaper, projectId: undefined }
    : safePaper;
  if (!pdfPath) return summary;
  const issued = fileCapabilities.issue({
    path: pdfPath,
    kind: 'file',
    mime: 'application/pdf',
    displayName: path.basename(pdfPath),
    operations: ['file', 'read', 'extract'],
  }, owner);
  return issued.success
    ? { ...summary, pdfCapability: issued.capability }
    : summary;
}

/**
 * Link a canonical library paper to a project-local research source. The
 * repository owns the many-to-many relation and keeps each project's evidence
 * chain isolated while the paper remains globally reusable.
 */
function linkPaperToProjectSource(
  paper: { id: string; title: string; authors: string[]; year: number; venue: string; doi?: string; arxivId?: string },
  projectId: string,
): boolean {
  if (!store || !researchRepository) return false;
  return researchRepository.linkLibraryPaperToProject({
    paperId: paper.id,
    projectId,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    ...(paper.doi ? { doi: paper.doi } : {}),
    ...(paper.arxivId ? { arxivId: paper.arxivId } : {}),
  }) !== undefined;
}

async function isPdfFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size < 5) return false;
    const handle = await fs.promises.open(filePath, 'r');
    try {      const header = Buffer.alloc(5);
      await handle.read(header, 0, header.length, 0);
      return header.toString('ascii') === '%PDF-';
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function waitForNativeWindowResize(
  window: BrowserWindow,
  applySize: () => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      window.off('resize', onResize);
      setImmediate(resolve);
    };
    const onResize = () => finish();
    const deadline = setTimeout(finish, 2_000);
    window.once('resize', onResize);
    applySize();
  });
}

async function getAcceptanceRendererSize(
  window: BrowserWindow,
): Promise<{ width: number; height: number }> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
    ))
  `);
}

async function setAcceptanceContentSize(
  window: BrowserWindow,
  width: number,
  height: number,
): Promise<void> {
  let applied = { width, height };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForNativeWindowResize(window, () => {
      window.setContentSize(applied.width, applied.height, false);
    });

    const measuredContent = window.getContentBounds();
    const measuredRenderer = await getAcceptanceRendererSize(window);
    const next = nextLayoutAcceptanceContentSize(
      { width, height },
      applied,
      measuredContent,
      measuredRenderer,
    );
    if (!next) return;
    applied = next;
  }

  const measuredContent = window.getContentBounds();
  const measuredRenderer = await getAcceptanceRendererSize(window);
  const display = screen.getDisplayMatching(window.getBounds());
  throw new Error(
    'Native content size did not converge: ' +
    `requested=${width}x${height}, ` +
    `content=${measuredContent.width}x${measuredContent.height}, ` +
    `renderer=${measuredRenderer.width}x${measuredRenderer.height}, ` +
    `outer=${window.getBounds().width}x${window.getBounds().height}, ` +
    `minWidth=${window.getMinimumSize()[0]}, ` +
    `scaleFactor=${display?.scaleFactor ?? 'unknown'}, ` +
    `zoomFactor=${window.webContents.getZoomFactor?.() ?? 'unknown'}`,
  );
}

// ─── Provider & Agent Creation ────────────────────────────────

function createProvider(config: ProviderConfig): OpenAICompatProvider {
  return new OpenAICompatProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryBackoffSeconds: config.retryBackoffSeconds,
    ...(config.vision ? { vision: true } : {}),
  });
}

function createAgentLoop(
  prov: OpenAICompatProvider,
  registry?: ToolRegistry,
  sharedApprovalStore?: ApprovalStore,
  additionalRegistrations: readonly PersonalizationMcpToolRegistration[] = [],
  config: ProviderConfig = currentConfig ?? {
    baseUrl: '',
    apiKey: '',
    model: '',
    timeout: 30_000,
    maxRetries: 2,
    retryBackoffSeconds: 1,
  },
): { agentLoop: AgentLoop; approvalStore: ApprovalStore } {
  const toolRegistry = registry ?? new ToolRegistry();
  const hooks = new HookBus();
  const dispatcher = new ToolDispatcher(toolRegistry, hooks);
  registerBuiltinTools(toolRegistry, dispatcher, {
    store: store ?? undefined,
    researchRepository: researchRepository ?? undefined,
  });
  fundingTemplateTools?.register(toolRegistry, dispatcher);
  for (const registration of additionalRegistrations) {
    toolRegistry.register(registration.spec);
    dispatcher.registerHandler(registration.spec.name, registration.handler);
  }
  const evidenceLedger = new EvidenceLedger();
  const approvalStore = sharedApprovalStore ?? new ApprovalStore();
  const behaviorRegistry = new BehaviorRegistry();

  const caps = prov.capabilities();

  // Context compression: user-declared maxContextTokens overrides auto-detect;
  // 70% threshold triggers compression; LLM summarizer activates for old messages.
  const userMaxContext = config.maxContextTokens ?? 0;
  const effectiveMaxContext = userMaxContext > 0 ? userMaxContext : (caps.maxContextTokens > 0 ? caps.maxContextTokens : 32_000);

  const contextEngine = new ContextEngine({
    budget: {
      modelContextTokens: effectiveMaxContext,
      modelOutputTokens: caps.maxOutputTokens,
      contextThreshold: 0.7, // 70% — compress when context fills to 70%
      perToolChars: 2000,
      maxToolResultChars: 8000,
      maxTurns: 12,
    },
    overrideMaxContextTokens: effectiveMaxContext,
    summarizer: async (msgs) => {
      // Use the provider itself to summarize old messages.
      const systemPrompt = 'Summarize the following conversation history concisely, preserving key decisions, context, and any important data. Output only the summary, no preamble.';
      try {
        const response = await prov.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: msgs.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 12000) },
        ], undefined, { temperature: 0.2, thinking: true });
        return `[对话摘要] ${response.content}`;
      } catch {
        return '[对话摘要不可用] 以下是最近的消息。';
      }
    },
  });

  const agentLoop = new AgentLoop({
    provider: prov,
    registry: toolRegistry,
    dispatcher,
    hooks,
    contextEngine,
    evidenceLedger,
    approvalStore,
    behaviorRegistry,
    // Learning (C): record every tool outcome for reliability statistics.
    onToolResult: (outcome) => learningEngine?.recordToolOutcome(outcome),
  });

  // Register the multi-agent orchestration tool now that the AgentLoop exists.
  // It needs the loop to run specialist agents internally.
  toolRegistry.register(MULTI_AGENT_TOOL);
  dispatcher.registerHandler(MULTI_AGENT_TOOL.name, createMultiAgentHandler({ agentLoop }));

  return { agentLoop, approvalStore };
}

function buildRuntimeRegistry(): ToolRegistry {
  return new ToolRegistry();
}

function builtinToolNames(): string[] {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new ToolDispatcher(registry));
  const names = registry.list().map((tool) => tool.name);
  return fundingTemplateTools
    ? [...names, ...fundingTemplateTools.getSpecs().map((tool) => tool.name)]
    : names;
}

// ─── Custom skill persistence (generated from conversations) ──

/** Persisted shape of a user-generated skill. */
interface PersistedCustomSkill {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  maxTurns: number;
  rationale: string;
  createdAt: number;
}

/** Register an extracted skill into the live SkillRegistry + persist it. */
function installSkill(extracted: ExtractedSkill): void {
  if (!skillRegistry) return;
  // Unregister first so re-generating updates in place (register throws on dup id).
  if (skillRegistry.has(extracted.id)) skillRegistry.unregister(extracted.id);
  skillRegistry.register({
    id: extracted.id,
    name: extracted.name,
    description: extracted.description,
    category: 'custom',
    systemPrompt: extracted.systemPrompt,
    allowedTools: extracted.allowedTools,
    maxTurns: extracted.maxTurns,
    tags: ['auto-generated'],
  });
  // Persist.
  if (store) {
    const custom = loadCustomSkills();
    const without = custom.filter((s) => s.id !== extracted.id);
    without.push({
      id: extracted.id,
      name: extracted.name,
      description: extracted.description,
      systemPrompt: extracted.systemPrompt,
      allowedTools: extracted.allowedTools,
      maxTurns: extracted.maxTurns,
      rationale: extracted.rationale,
      createdAt: Date.now(),
    });
    store.setMemory(CUSTOM_SKILLS_MEMORY_KEY, JSON.stringify(without), 'custom_skills');
  }
}

/** Load persisted custom skills (empty if none / store unavailable). */
function loadCustomSkills(): PersistedCustomSkill[] {
  if (!store) return [];
  try {
    const entry = store.getMemory(CUSTOM_SKILLS_MEMORY_KEY);
    if (!entry?.value) return [];
    const parsed = JSON.parse(entry.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Reload all persisted custom skills into the live registry at startup. */
function loadAndInstallCustomSkills(): void {
  const custom = loadCustomSkills();
  for (const skill of custom) {
    if (!skillRegistry?.has(skill.id)) {
      skillRegistry?.register({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category: 'custom',
        systemPrompt: skill.systemPrompt,
        allowedTools: skill.allowedTools,
        maxTurns: skill.maxTurns,
        tags: ['auto-generated'],
      });
    }
  }
}

/**
 * Exercise the same registration order used by createAgentLoop before a
 * funding-template built-in may be seeded. Merely constructing the service is
 * not proof that its tools can coexist in the real runtime registry.
 */
function auditFundingTemplateToolRegistration(
  service: FundingTemplateToolService,
): ReadonlySet<string> {
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  registerBuiltinTools(registry, dispatcher);
  service.register(registry, dispatcher);
  return new Set(registry.list().map((tool) => tool.name));
}

function providerProfileListFailure(
  operationId: string,
  result: { code: string },
) {
  return {
    ok: false as const,
    contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
    operationId,
    code: result.code,
  };
}

function providerProfileMutationResponse(
  operationId: string,
  action: 'saved' | 'switched' | 'deleted' | 'reset',
  result: { ok: true; value: { revision: number; profile?: import('../engine/runtime/ProviderProfileContract.js').ProviderProfileSummary; activeId?: string | null } } | { ok: false; code: string; currentRevision?: number },
): ProviderProfileMutationResponse {
  if (!result.ok) {
    return {
      ok: false,
      contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
      operationId,
      code: result.code as import('../engine/runtime/ProviderProfileContract.js').ProviderProfileErrorCode,
      ...(result.currentRevision === undefined ? {} : { currentRevision: result.currentRevision }),
    };
  }
  return {
    ok: true,
    contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
    operationId,
    action,
    revision: result.value.revision,
    ...(result.value.profile === undefined ? {} : { profile: result.value.profile }),
    activeId: result.value.activeId ?? (result.value.profile?.isActive ? result.value.profile.id : null),
  };
}

function providerProfileRuntimeContext(
  config: ProviderConfig,
  reason: SetupRuntimeBuildContext['reason'],
): SetupRuntimeBuildContext {
  const maxContextTokens = config.maxContextTokens && config.maxContextTokens > 0
    ? config.maxContextTokens
    : 32_000;
  return {
    config,
    capabilities: {
      streaming: true,
      nativeToolCalling: false,
      structuredOutput: false,
      maxContextTokens: null,
      multimodal: config.vision === true,
    },
    strategy: {
      tier: 'standard',
      maxTurnsPerStep: 12,
      maxToolsPerTurn: 32,
      maxRetries: config.maxRetries,
      reviewEveryNTurns: 3,
      forceStructuredOutput: false,
      contextBudgetTokens: maxContextTokens,
      maxOutputTokens: 16_384,
      nativeToolCalling: false,
    },
    previousConfigVersion: runtimeGeneration,
    nextConfigVersion: runtimeGeneration + 1,
    reason,
    signal: new AbortController().signal,
  };
}

function deactivateProviderRuntime(reason: string): void {
  for (const [sessionId, run] of activeChatRuns) {
    run.controller.abort();
    liveSteeringQueue.clear(sessionId);
    activeChatRuns.delete(sessionId);
    activeFundingToolScopes.delete(sessionId);
  }
  if (activeAutonomousSessionId) autonomousEngine?.interrupt(activeAutonomousSessionId, reason);
  activeAutonomousSessionId = null;
  provider = null;
  agentLoop = null;
  goalEngine = null;
  autonomousEngine = null;
  researchEventBus = null;
  currentConfig = null;
  runtimeGeneration += 1;
}

function prepareProviderRuntime(context: SetupRuntimeBuildContext): PreparedSetupRuntime {
  if (!store) throw new Error('Persistence is unavailable');
  const runtimeStore = store;
  const runtimeMemoryManager = memoryManager ?? new MemoryManager(runtimeStore, DATA_DIR);
  // WorkspaceAgentsManager now requires explicit projectId per request.
  const candidateConfig = { ...context.config } as ProviderConfig;
  const candidateProvider = createProvider(candidateConfig);
  const candidateLoop = createAgentLoop(
    candidateProvider,
    buildRuntimeRegistry(),
    approvalStore ?? undefined,
    [],
    candidateConfig,
  );
  const candidateGoalEngine = new GoalEngine(candidateLoop.agentLoop, runtimeMemoryManager, currentGoalPersistence());
  const candidateWorkflowEngine = new WorkflowEngine(candidateLoop.agentLoop);
  const candidateResearchEventBus = new ResearchEventBus();
  const candidateAutonomousEngine = new AutonomousResearchEngine({
    workflowEngine: candidateWorkflowEngine,
    planner: new AutonomousPlanner({ provider: candidateProvider }),
    eventBus: candidateResearchEventBus,
    liveSteering: liveSteeringQueue,
    store: runtimeStore,
    artifactSink: researchRepository
      ? createAutonomousResearchArtifactSink(researchRepository)
      : undefined,
  });
  let state: 'prepared' | 'committed' | 'discarded' = 'prepared';

  return {
    async commitAndAbortPrevious(): Promise<void> {
      if (state !== 'prepared' || context.signal.aborted) {
        throw new Error('Candidate runtime is unavailable');
      }
      // No old provider request may survive the configuration generation swap.
      for (const [sessionId, run] of activeChatRuns) {
        run.controller.abort();
        liveSteeringQueue.clear(sessionId);
        activeChatRuns.delete(sessionId);
        activeFundingToolScopes.delete(sessionId);
      }
      if (activeAutonomousSessionId) autonomousEngine?.interrupt(activeAutonomousSessionId, 'provider_reconfigured');
      activeAutonomousSessionId = null;

      runtimeGeneration = context.nextConfigVersion;
      currentConfig = candidateConfig;
      provider = candidateProvider;
      agentLoop = candidateLoop.agentLoop;
      approvalStore = candidateLoop.approvalStore;
      memoryManager = runtimeMemoryManager;
      goalEngine = candidateGoalEngine;
      researchEventBus = candidateResearchEventBus;
      autonomousEngine = candidateAutonomousEngine;
      learningEngine = new LearningEngine({ memory: runtimeMemoryManager, provider: candidateProvider, store: runtimeStore });
      subscribeLearningToResearchBus(candidateResearchEventBus, learningEngine);
      state = 'committed';
    },
    async discard(): Promise<void> {
      if (state === 'prepared') state = 'discarded';
    },
  };
}

// ─── Config Persistence ───────────────────────────────────────

function loadConfig(): ProviderConfig | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('[Main] loadConfig: Config file not found at', CONFIG_PATH);
      return null;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const encrypted = JSON.parse(raw);

    // Detect InMemorySecureStorage format: base64 decodes to "metis:v1:key_N_TS"
    // This happens when config was saved while safeStorage was unavailable.
    // In that case, we cannot recover the original API key from the in-memory reference.
    if (encrypted.encryptedApiKey && typeof encrypted.encryptedApiKey === 'string') {
      try {
        const decoded = Buffer.from(encrypted.encryptedApiKey, 'base64').toString('utf-8');
        if (decoded.startsWith('metis:v1:key_')) {
          console.warn('[Main] loadConfig: Config was saved with InMemorySecureStorage (safeStorage was unavailable).');
          console.warn('[Main] loadConfig: The API key cannot be recovered. User must re-enter it in Settings.');
          console.warn('[Main] loadConfig: Returning config with empty apiKey so user sees their baseUrl/model.');
          return {
            baseUrl: encrypted.baseUrl ?? '',
            apiKey: '',
            model: encrypted.model ?? '',
            timeout: encrypted.timeout ?? 30000,
            maxRetries: encrypted.maxRetries ?? 2,
            retryBackoffSeconds: encrypted.retryBackoffSeconds ?? 1,
          };
        }
      } catch {
        // Not base64 decodable — proceed with normal decryption
      }
    }

    const config = decryptProviderConfig(encrypted);
    console.log('[Main] loadConfig: Successfully loaded config — baseUrl:', config.baseUrl, 'model:', config.model);
    return config;
  } catch (err) {
    console.error('[Main] loadConfig: Failed to load config:', (err as Error)?.message);
    return null;
  }
}

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

interface PersistedSettings { theme: string; providerVision: boolean; providerMaxContextTokens: number; setupSkipped: boolean; }

function loadPersistedSettings(): PersistedSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      return {
        theme: raw.theme || 'light',
        providerVision: raw.providerVision === true,
        providerMaxContextTokens: Number(raw.providerMaxContextTokens) > 0 ? Number(raw.providerMaxContextTokens) : 0,
        setupSkipped: raw.setupSkipped === true,
      };
    }
  } catch { /* ignore */ }
  // Backward compat: read old theme.txt
  try {
    if (fs.existsSync(THEME_PATH)) {
      return { theme: fs.readFileSync(THEME_PATH, 'utf-8').trim() || 'light', providerVision: false, providerMaxContextTokens: 0, setupSkipped: false };
    }
  } catch { /* ignore */ }
  return { theme: 'light', providerVision: false, providerMaxContextTokens: 0, setupSkipped: false };
}

function loadTheme(): string { return loadPersistedSettings().theme; }
function loadProviderVision(): boolean { return loadPersistedSettings().providerVision; }
function loadProviderMaxContextTokens(): number { return loadPersistedSettings().providerMaxContextTokens; }
function loadSetupSkipped(): boolean { return loadPersistedSettings().setupSkipped; }

function saveSettings(theme: string, providerVision: boolean, providerMaxContextTokens: number): boolean {
  try {
    // Merge so unrelated persisted keys (setupSkipped) survive a theme update.
    const merged = { ...loadPersistedSettings(), theme, providerVision, providerMaxContextTokens };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged), 'utf-8');
    return true;
  } catch (err) {
    console.warn('Failed to save settings:', err);
    return false;
  }
}

/** Persist the user's explicit 「稍后配置」 choice so the first-run wizard does
 *  not reappear on every launch. Research execution stays provider-gated. */
function saveSetupSkipped(): boolean {
  try {
    const merged = { ...loadPersistedSettings(), setupSkipped: true };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged), 'utf-8');
    return true;
  } catch (err) {
    console.warn('Failed to persist setup-skip flag:', err);
    return false;
  }
}

function initProviderAndAgent(): void {
  const config = loadConfig();
  if (!config) {
    console.log('[Main] initProviderAndAgent: No saved config found.');
    return;
  }
  if (!config.apiKey) {
    console.warn('[Main] initProviderAndAgent: Config loaded but apiKey is empty — user must re-enter API key in Settings.');
    currentConfig = config;
    currentTheme = loadTheme();
    return;
  }
  currentConfig = config;
  // METIS-WX-2: multimodal support is a user-declared setting merged at init.
  currentConfig.vision = loadProviderVision();
  // User-declared context window (0 = auto-detect from model capabilities).
  currentConfig.maxContextTokens = loadProviderMaxContextTokens();
  provider = createProvider(config);
  currentTheme = loadTheme();
  console.log('[Main] initProviderAndAgent: Config loaded — baseUrl:', config.baseUrl, 'model:', config.model, 'store:', !!store);
  if (store) {
    memoryManager = new MemoryManager(store, DATA_DIR);
    // Autonomous learning (A memory / B prompt adaptation / C tool usage):
    // created alongside memory so tool outcomes can be tracked and persisted.
    learningEngine = new LearningEngine({ memory: memoryManager, provider, store });
    // Initialize MCP manager. Stored executables are never auto-started;
    // activation requires a separately consented execution capability.
    mcpManager = new MCPManager(store, new ToolRegistry());
    // Create agent loop with MCP-registered tools
    const registry = new ToolRegistry();
    if (mcpManager) {
      const mcpTools = mcpManager.getAllTools();
      for (const tool of mcpTools) {
        registry.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        });
      }
    }
    const loopResult = createAgentLoop(provider, registry, approvalStore ?? undefined);
    agentLoop = loopResult.agentLoop;
    approvalStore = loopResult.approvalStore;
    console.log('[Main] initProviderAndAgent: agentLoop created:', !!agentLoop);
    if (agentLoop) {
      goalEngine = new GoalEngine(agentLoop, memoryManager, currentGoalPersistence());
      // Autonomous research engine: composes a dedicated WorkflowEngine (bound
      // to this agentLoop) + reflective planner + event bus. Live steering
      // reuses the global queue so pause/interrupt share the control channel.
      const autonomousWorkflowEngine = new WorkflowEngine(agentLoop);
      researchEventBus = new ResearchEventBus();
      const planner = new AutonomousPlanner({ provider });
      autonomousEngine = new AutonomousResearchEngine({
        workflowEngine: autonomousWorkflowEngine,
        planner,
        eventBus: researchEventBus,
        liveSteering: liveSteeringQueue,
        store: store ?? undefined,
        artifactSink: researchRepository
          ? createAutonomousResearchArtifactSink(researchRepository)
          : undefined,
      });
      // Hook closure: learning ingests durable knowledge from autonomous output.
      subscribeLearningToResearchBus(researchEventBus, learningEngine);
    }
  } else {
    console.warn('[Main] initProviderAndAgent: store is null, skipping agentLoop creation');
  }
}

// ─── Window Creation ──────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Automated product simulations run against the real renderer and IPC
    // stack but must not steal focus from the researcher's desktop. This flag
    // is intentionally process-local and is never enabled by normal launches.
    show: process.env.METIS_BACKGROUND_AUDIT !== '1',
    // The acceptance run needs to exercise the real narrow-shell bands, so it
    // may shrink the window below the product minimum of 1000px.
    minWidth: layoutAcceptanceToken ? 320 : 1000,
    minHeight: 700,
    title: 'Metis Research Workbench',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for better-sqlite3
    },
    titleBarStyle: 'hiddenInset', // macOS unified title bar
  });

  // Renderer content never receives ambient navigation authority. Clean HTTPS
  // links may leave the app only through the validated IPC handler below.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  const fileCapabilityWebContentsId = mainWindow.webContents.id;
  const mainWcId = mainWindow.webContents.id;
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return; // Only main-frame navigation (not subframe) invalidates
    bumpWebContentsGeneration(mainWcId);
    firstRunSetup?.revokeWebContents(mainWcId);
    caRuntime?.clearOwner(String(mainWcId));
    caOwnerWindows.delete(String(mainWcId));
    cleanupActiveChatRuns(mainWcId);
  });
  mainWindow.webContents.on('render-process-gone', () => {
    cleanupWebContentsOwner(mainWcId);
  });
  mainWindow.webContents.once('destroyed', () => {
    fileCapabilities.clearWebContents(fileCapabilityWebContentsId);
    cleanupWebContentsOwner(mainWcId);
  });

  // Always clear the renderer cache before loading to ensure the latest
  // dist files are used after rebuilds (Electron caches file:// URLs).
  mainWindow.webContents.session.clearCache().catch(() => {});

  // In dev, load from Vite dev server; in prod, serve dist/ over metis-app://
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('metis-app://renderer/index.html');
  }

  mainWindow.on('closed', () => {
    fileCapabilities.clear();
    exportPreviews.clear();
    for (const session of activeTerminals.values()) {
      session.killed = true;
      session.terminal.kill();
    }
    activeTerminals.clear();
    executionCapabilities?.clear();
    mainWindow = null;
  });
}

// ─── LaTeX Compilation Helpers ─────────────────────────────────


const execAsync = promisify(exec);

/** Compile LaTeX source using local pdflatex. */
async function compileLatexLocal(source: string, bib?: string): Promise<{
  status: string; pdfPath?: string; errors?: Array<{ line: number; message: string; severity: 'error' | 'warning' }>; error?: string;
}> {
  const pdflatexCheck = spawnSync('pdflatex', ['--version'], { encoding: 'utf8' });
  if (pdflatexCheck.error || pdflatexCheck.status !== 0) {
    return {
      status: 'noCompiler',
      error: 'pdflatex not found. Install TeX Live (or MiKTeX) and ensure pdflatex is in PATH.',
    };
  }

  const needsBib = /\\(bibliography|addbibresource)\{[^}]*\}/.test(source);
  const tmpDir = path.join(os.tmpdir(), `metis-latex-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const texPath = path.join(tmpDir, 'document.tex');
  fs.writeFileSync(texPath, source, 'utf8');
  if (needsBib && bib) {
    fs.writeFileSync(path.join(tmpDir, 'references.bib'), bib, 'utf8');
  }

  const runCommand = async (command: string): Promise<{ stdout: string; stderr: string }> => {
    const { stdout, stderr } = await execAsync(command, { cwd: tmpDir, timeout: 30000 });
    return { stdout, stderr };
  };

  let stdout = '';
  try {
    const r1 = await runCommand('pdflatex -interaction=nonstopmode -halt-on-error document.tex');
    stdout += r1.stdout;
    if (needsBib && bib) {
      try {
        const rb = await runCommand('bibtex document');
        stdout += rb.stdout;
      } catch (err) {
        stdout += err instanceof Error ? err.message : String(err);
      }
    }
    const r2 = await runCommand('pdflatex -interaction=nonstopmode -halt-on-error document.tex');
    stdout += r2.stdout;
  } catch (err) {
    stdout += err instanceof Error ? err.message : String(err);
  }

  const pdfPath = path.join(tmpDir, 'document.pdf');
  const pdfExists = fs.existsSync(pdfPath);

  const errors = parseLatexLog(stdout);

  if (pdfExists) {
    const outDir = path.join(DATA_DIR, 'latex-output');
    fs.mkdirSync(outDir, { recursive: true });
    const outPdf = path.join(outDir, `document-${Date.now()}.pdf`);
    fs.copyFileSync(pdfPath, outPdf);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { status: 'success', pdfPath: outPdf, errors };
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return {
    status: 'error',
    errors,
    error: errors.length > 0 ? errors[0].message : 'Compilation failed — no PDF generated',
  };
}

// ─── IPC Handlers ─────────────────────────────────────────────

/**
 * Lazily construct the WeChat bot service (METIS-WX-1). Module-level so both
 * setupIPC() handlers and the startup resume path can reach it.
 */
function ensureWeChatBot(): WeChatBotService | null {
  if (weChatBotService) return weChatBotService;
  if (!store) return null;
  weChatBotService = new WeChatBotService({
    client: new IlinkClient({}),
    store: getSecureStorage(),
    statePath: path.join(DATA_DIR, 'bot-state.json'),
    mediaDir: path.join(DATA_DIR, 'wechat-media'),
    runTurn: async ({ sessionId, userText, projectId, signal, attachments, images }) => {
      if (!store || !agentLoop) return { ok: false, error: 'Metis 服务未就绪' };
      try {
        const history = store.getMessages(sessionId).map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.name ? { name: m.name } : {}),
        }));
        // Memory injection (F12 project isolation applies when a project is bound).
        let skillPrompt: string | undefined;
        try {
          const memoryContext = memoryManager?.buildMemoryContext(projectId ?? undefined);
          if (memoryContext && memoryContext.trim()) skillPrompt = memoryContext;
          // Autonomous learning (B + C): behavior preferences + tool reliability.
          const learningContext = learningEngine?.buildLearningContext(projectId ?? undefined);
          if (learningContext && learningContext.trim()) {
            skillPrompt = [skillPrompt, learningContext].filter(Boolean).join('\n\n');
          }
        } catch { /* memory must never break a turn */ }
        // WeChat media attachments (METIS-WX-2): point the agent at local files
        // so its file tools (read_pdf, etc.) can analyze them.
        if (attachments && attachments.length > 0) {
          const attachmentBlock = [
            '用户通过微信发送了以下附件（本地文件，可直接用工具读取分析）：',
            ...attachments.map((a) => `- ${a.name} (${a.mime}) → ${a.path}`),
          ].join('\n');
          skillPrompt = [attachmentBlock, skillPrompt].filter(Boolean).join('\n\n');
        }
        const response = await runPersistedChatTurn({
          agentLoop,
          store,
          sessionId,
          messages: [
            ...history,
            {
              role: 'user' as const,
              content: userText,
              ...(images && images.length > 0 ? { images } : {}),
            },
          ],
          requestId: `wx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`.slice(0, 128),
          taskContractHash: '',
          promptStackHash: '',
          skillPrompt,
          projectId,
          signal,
          options: { mode: 'send' },
        });
        if (response.status === 'completed' && response.answer) {
          // Autonomous learning after the WeChat turn (fire and forget).
          if (learningEngine) {
            void (async () => {
              try {
                await learningEngine.ingestConversation(
                  [...history, { role: 'user' as const, content: userText }],
                  projectId ?? undefined,
                );
                learningEngine.applyFeedbackSignals(
                  [...history, { role: 'user' as const, content: userText }],
                  projectId ?? undefined,
                );
                learningEngine.persistToolStats();
              } catch { /* learning must never break a turn */ }
            })();
          }
          return { ok: true, answer: response.answer };
        }
        return {
          ok: false,
          error: response.diagnostics[0]?.message ?? `agent_${response.status}`,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    listProjects: () => (researchRepository?.listProjects() ?? []).map((p) => ({ id: p.id, title: p.title })),
    getModelName: () => currentConfig?.model ?? 'unknown',
    supportsVision: () => currentConfig?.vision === true,
  });
  return weChatBotService;
}

function setupIPC(): void {
  let evalSuiteRunning = false;

  // ── Store ───────────────────────────────────────────────
  ipcMain.handle('store:ready', () => store !== null);

  // METIS-OPT-4: the renderer waits for full startup before hydrating, so the
  // window can appear before heavy initialization finishes.
  ipcMain.handle('startup:status', () => ({ ready: startupReady, storeReady: store !== null }));

  ipcMain.handle('setup:probe', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSettingsProviderProbeRequest(rawRequest);
      if (!decoded.ok) return decodeSetupProbeResponse(null);
      const req = decoded.value;

      // Build legacy SetupInput by resolving the key per keyMode
      let resolvedApiKey: string;
      if (req.keyMode === 'saved') {
        if (!currentConfig?.apiKey) {
          return { version: SETUP_RUNTIME_CONTRACT_VERSION, operationId: req.operationId, success: false, recovery: createSetupRecovery('setup_secure_storage_unavailable') } satisfies SetupProbeResponse;
        }
        resolvedApiKey = currentConfig.apiKey;
      } else {
        resolvedApiKey = req.newApiKey!;
      }

      const legacyRequest = {
        version: req.version,
        operationId: req.operationId,
        input: { baseUrl: req.baseUrl, apiKey: resolvedApiKey, model: req.model },
      };

      if (!firstRunSetup) return decodeSetupProbeResponse(null);
      return await firstRunSetup.probe(legacyRequest, { owner: setupOwnerFor(event) }, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('setup:progress', progress);
      });
    } catch {
      return decodeSetupProbeResponse(null);
    }
  });

  ipcMain.handle('setup:save', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSetupSaveRequest(rawRequest);
      if (!request.ok || !firstRunSetup) return decodeSetupSaveResponse(null);
      const result = await firstRunSetup.save(request.value, { owner: setupOwnerFor(event) }, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('setup:progress', progress);
      });
      // First-run setup remains a secure bootstrap path. Once it succeeds, make
      // the same runtime configuration visible as the first encrypted profile.
      if (result.success && providerProfileStore && currentConfig) {
        await providerProfileStore.ensureActiveFromConfig(currentConfig);
      }
      return result;
    } catch {
      return decodeSetupSaveResponse(null);
    }
  });

  ipcMain.handle('setup:restore', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSetupRestoreRequest(rawRequest);
      if (!request.ok || !firstRunSetup) return decodeSetupRestoreResponse(null);
      return await firstRunSetup.restore(request.value);
    } catch {
      return decodeSetupRestoreResponse(null);
    }
  });

  ipcMain.handle('setup:abort', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSetupAbortRequest(rawRequest);
      if (!request.ok || !firstRunSetup) {
        return {
          version: SETUP_RUNTIME_CONTRACT_VERSION,
          operationId: 'setup-recovery',
          success: false,
          code: 'setup_operation_not_found',
        };
      }
      return firstRunSetup.abort(request.value);
    } catch {
      return {
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId: 'setup-recovery',
        success: false,
        code: 'setup_operation_not_found',
      };
    }
  });

  // Persistent six-object research workspace. Every channel authorizes the
  // current main frame, decodes one bounded request and returns presentation
  // DTOs only; persistence records never cross IPC.
  ipcMain.handle('research:crud', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchCrudRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleCrud(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:link', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchLinkRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleLink(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:review', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchReviewRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleReview(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:restore', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchRestoreRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleRestore(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:version', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchArtifactVersionRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleVersion(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:checkpoint', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchCheckpointRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleCheckpoint(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:decision', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchDecisionRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleDecision(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:snapshot', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchSnapshotRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.getSnapshot(request.projectId) ?? createResearchSnapshotRecovery(),
    present: (result) => result,
    recover: createResearchSnapshotRecovery,
  }));

  ipcMain.handle('research:mediaAttach', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeResearchMediaAttachRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: (request, event) => researchMedia?.attach(request, executionOwnerFor(event))
      ?? createResearchMediaAttachFailure(),
    present: decodeResearchMediaAttachResult,
    recover: createResearchMediaAttachFailure,
  }));

  ipcMain.handle('research:mediaPurge', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeResearchMediaPurgeRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: (request) => researchMedia?.purge(request) ?? createResearchMediaPurgeFailure(),
    present: decodeResearchMediaPurgeResult,
    recover: createResearchMediaPurgeFailure,
  }));

  // ── Current Affairs Export ─────────────────────────────────
  ipcMain.handle('ca:research', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsResearchRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsResearchResponse(null);
      const { version: _v, operationId, ...rest } = req.data;
      void _v;
      const owner = String(event.sender.id);
      const result = await caRuntime.research(owner, rest);
      return decodeCurrentAffairsResearchResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsResearchResponse(null); }
  });

  ipcMain.handle('ca:approve', async (event, rawRequest: unknown) => {
    try {
      const invokingWindow = requireRendererMainFrame(event);
      const req = CurrentAffairsApproveRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsApproveResponse(null);
      const { version: _v, operationId, ...rest } = req.data;
      void _v;
      const owner = String(event.sender.id);
      caOwnerWindows.set(owner, invokingWindow);
      const result = await caRuntime.approve(owner, rest);
      return decodeCurrentAffairsApproveResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsApproveResponse(null); }
  });

  ipcMain.handle('ca:export', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsExportRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsExportResponse(null);
      const { version: _v, operationId, ...rest } = req.data;
      void _v;
      const owner = String(event.sender.id);
      const result = await caRuntime.export(owner, rest);
      return decodeCurrentAffairsExportResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsExportResponse(null); }
  });

  ipcMain.handle('ca:cancel', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsCancelRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsCancelResponse(null);
      const { version: _v, operationId } = req.data;
      void _v;
      const owner = String(event.sender.id);
      let result: ReturnType<typeof caRuntime.cancel>;
      if (req.data.action === 'revoke_approval') {
        result = caRuntime.cancel(owner, {
          action: 'revoke_approval', projectId: req.data.projectId, workflowId: req.data.workflowId,
          receiptId: req.data.receiptId, receiptNonce: req.data.receiptNonce,
          contentDigest: req.data.contentDigest, sourceSnapshotDigest: req.data.sourceSnapshotDigest,
          profileId: req.data.profileId, manifestVersion: req.data.manifestVersion,
        });
      } else {
        result = caRuntime.cancel(owner, { action: 'discard_draft', projectId: req.data.projectId, workflowId: req.data.workflowId });
      }
      return decodeCurrentAffairsCancelResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsCancelResponse(null); }
  });

  ipcMain.handle('ca:list-sources', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsListSourcesRequestSchema.safeParse(rawRequest);
      if (!req.success || !researchRepository) return decodeCurrentAffairsListSourcesResponse(null);
      const { projectId } = req.data;
      const now = Date.now();
      const maxSourceAgeDays = 365;
      const srcList = researchRepository.listSources?.(projectId) ?? [];
      const sources = srcList
        .filter(s => s.deletedAt === null) // strict null check, not truthiness
        .filter(s => (s.projectId ?? '') === projectId)
        .map(s => {
          try {
            const adapted = adaptSource(s);
            const base = {
              sourceId: s.id, projectId: s.projectId ?? '', title: s.title,
              kind: adapted?.kind ?? null,
              authors: s.authors ?? [],
              url: sanitizeListUrl(s.externalUrl ?? adapted?.url ?? null),
              contentDigest: s.sourceVersionHash ?? null,
              correctionState: adapted?.correctionState ?? null,
              updatedAt: s.updatedAt,
              publishedAt: adapted?.publishedAt ?? null,
              fetchedAt: adapted?.fetchedAt ?? s.createdAt,
              deleted: false,
            };
            // Main-derived authoritative eligibility (renderer must not recreate)
            const hasHash = !!(base.contentDigest && /^[a-f0-9]{64}$/i.test(base.contentDigest));
            const validKind = adapted !== null && base.kind !== null;
            const cleanCorrection = base.correctionState === 'clean' || base.correctionState === 'corrected';
            const notRetracted = base.correctionState !== 'retracted';
            const fresh = base.fetchedAt !== null && (now - base.fetchedAt) / 86400000 <= maxSourceAgeDays;
            const eligible = hasHash && validKind && cleanCorrection && notRetracted && fresh;

            let reviewStatus: string;
            let reason: string;
            if (!adapted) { reviewStatus = 'untagged'; reason = '缺少 current-affairs:* 标签'; }
            else if (!hasHash) { reviewStatus = 'no_digest'; reason = '缺少 contentDigest'; }
            else if (base.correctionState === 'retracted') { reviewStatus = 'retracted'; reason = '已 retracted'; }
            else if (!cleanCorrection) { reviewStatus = `pending_${base.correctionState}`; reason = `待审核 (${base.correctionState})`; }
            else if (!fresh) { reviewStatus = 'stale'; reason = `来源超过 ${maxSourceAgeDays} 天`; }
            else { reviewStatus = base.correctionState ?? 'clean'; reason = ''; }

            return { ...base, eligible, reviewStatus, reason };
          } catch {
            return null;
          }
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      return { ok: true as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sources };
    } catch { return decodeCurrentAffairsListSourcesResponse(null); }
  });

  ipcMain.handle('ca:review-source', async (event, rawRequest: unknown) => {
    const invokingWindow = requireRendererMainFrame(event);
    const req = SourceReviewRequestSchema.safeParse(rawRequest);
    if (!req.success || !researchRepository) return decodeSourceReviewResponse(null);
    try {
      // Verify hash is valid (no magic wildcard)
      if (!/^[a-f0-9]{64}$/i.test(req.data.expectedSourceVersionHash)) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'hash_mismatch' as const };
      }
      const reviewedBy = String(event.sender.id);

      // Native confirmation with canonical repo fields — must have invoking window
      if (!invokingWindow || invokingWindow.isDestroyed()) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
      }
      const src = researchRepository.getSource(req.data.sourceId);
      if (!src || src.deletedAt !== null) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: src ? 'deleted' as const : 'source_not_found' as const };
      }
      try {
        const canonicalTitle = src.title;
        const canonicalHash = src.sourceVersionHash ?? '(none)';
        const canonicalTime = new Date(src.updatedAt).toISOString();
        const { response } = await dialog.showMessageBox(invokingWindow, {
          type: 'question', title: 'Review Source',
          message: `Review "${canonicalTitle}" as ${req.data.caKind}?`,
          detail: `Canonical hash: ${canonicalHash}\nUpdated: ${canonicalTime}\nCorrection state: ${req.data.correctionState}`,
          buttons: ['Confirm Review', 'Cancel'], defaultId: 1,
        });
        if (response !== 0) {
          return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
        }
      } catch {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
      }

      const result = researchRepository.reviewCurrentAffairsSource(
        req.data.sourceId,
        {
          projectId: req.data.projectId,
          sourceVersionHash: req.data.expectedSourceVersionHash,
          updatedAt: req.data.expectedUpdatedAt,
        },
        {
          caKind: req.data.caKind,
          correctionState: req.data.correctionState,
          reviewedBy,
          note: req.data.note ?? '',
        },
      );
      if (!result.ok) {
        const codeMap: Record<string, 'source_not_found' | 'cross_project' | 'deleted' | 'hash_mismatch' | 'timestamp_mismatch' | 'review_failed'> = {
          not_found: 'source_not_found',
          source_deleted: 'deleted',
          project_mismatch: 'cross_project',
          hash_mismatch: 'hash_mismatch',
          stale: 'timestamp_mismatch',
        };
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: codeMap[result.code] ?? 'review_failed' };
      }
      // Re-read to get metadata.caReviewDigest (FIX498 authoritative) — NEVER fallback
      const reread = researchRepository.getSource(req.data.sourceId);
      const metadata = (reread?.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.caReviewDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(metadata.caReviewDigest)) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
      }
      return { ok: true as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, reviewed: true as const, correctionState: req.data.correctionState, reviewDigest: metadata.caReviewDigest };
    } catch { return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const }; }
  });

  // ── Session ─────────────────────────────────────────────
  ipcMain.handle('session:create', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionCreateRequest(rawRequest);
      if (!decoded.ok || !store) return decodeSessionMutationResult(null);
      store.createSession(decoded.value.sessionId, undefined, decoded.value.projectId);
      return decodeSessionMutationResult({ success: true, code: 'created' });
    } catch {
      return decodeSessionMutationResult(null);
    }
  });

  ipcMain.handle('session:list', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionListRequest(rawRequest);
      if (!decoded.ok || !store) return createSessionListRecovery();
      return decodeLegacySessionList(store.listSessions());
    } catch {
      return createSessionListRecovery();
    }
  });

  ipcMain.handle('session:delete', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionDeleteRequest(rawRequest);
      if (!decoded.ok || !store) return decodeSessionMutationResult(null);
      if (!store.getSession(decoded.value.sessionId)) {
        return decodeSessionMutationResult({ success: false, code: 'not_found' });
      }
      store.deleteSession(decoded.value.sessionId);
      return decodeSessionMutationResult({ success: true, code: 'deleted' });
    } catch {
      return decodeSessionMutationResult(null);
    }
  });

  ipcMain.handle('session:update', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionUpdateRequest(rawRequest);
      if (!decoded.ok || !store) return decodeSessionMutationResult(null);
      if (!store.getSession(decoded.value.sessionId)) {
        return decodeSessionMutationResult({ success: false, code: 'not_found' });
      }
      store.updateSession(decoded.value.sessionId, {
        metadata: decoded.value.patch,
      });
      return decodeSessionMutationResult({ success: true, code: 'updated' });
    } catch {
      return decodeSessionMutationResult(null);
    }
  });

  // ── Artifacts ───────────────────────────────────────────
  ipcMain.handle('artifact:create', (event, rawRecord: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const decoded = decodeArtifactCreateRequest(rawRecord);
      if (!decoded.ok || !store) return decodeArtifactMutationResult(null);
      const source = decoded.value.sourceCapabilityId
        ? fileCapabilities.resolve({
            capabilityId: decoded.value.sourceCapabilityId,
            operation: 'read',
            maxBytes: 1,
          }, owner)
        : undefined;
      if (source && !source.ok) return decodeArtifactMutationResult({ success: false, code: 'rejected' });
      const createdAt = Date.now();
      store.createArtifact({
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
  ipcMain.handle('artifact:list', (event, rawSessionId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const sessionId = RuntimeIdSchema.parse(rawSessionId);
      const items = (store?.listArtifacts(sessionId) ?? []).map((item) => {
        const issued = item.path
          ? fileCapabilities.issue({
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
  ipcMain.handle('artifact:get-content', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeArtifactContentRequest(rawRequest);
      if (!decoded.ok || !store) return decodeArtifactContentResponse(null);
      const artifact = store.getArtifactContent(
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
  ipcMain.handle('artifact:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = RuntimeIdSchema.parse(rawId);
      if (!store) return decodeArtifactMutationResult(null);
      store.deleteArtifact(id);
      return decodeArtifactMutationResult({ success: true, code: 'deleted' });
    } catch {
      return decodeArtifactMutationResult(null);
    }
  });

  // ── Project artifact management (research_artifacts, project-scoped) ──
  ipcMain.handle('artifact:listByProject', (event, rawProjectId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
      if (!projectId || !researchRepository) return { items: [] };
      const repository = researchRepository;
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

  ipcMain.handle('artifact:updateReviewStatus', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { artifactId?: unknown; toStatus?: unknown; reason?: unknown };
      const artifactId = typeof request?.artifactId === 'string' ? request.artifactId : '';
      const toStatus = typeof request?.toStatus === 'string' ? request.toStatus : '';
      const reason = typeof request?.reason === 'string' ? request.reason : '';
      const allowed = new Set(['draft', 'pending', 'partial', 'verified', 'stale']);
      if (!artifactId || !allowed.has(toStatus) || !researchRepository) {
        return { ok: false, error: 'invalid_request' };
      }
      const updated = researchRepository.updateArtifactReviewStatus(artifactId, toStatus, reason || 'manual');
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'update_failed' };
    }
  });

  ipcMain.handle('artifact:listVersions', (event, rawArtifactId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const artifactId = typeof rawArtifactId === 'string' ? rawArtifactId : '';
      if (!artifactId || !researchRepository) return { versions: [] };
      const versions = researchRepository.listArtifactVersions(artifactId).map((record) => ({
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

  ipcMain.handle('artifact:restoreVersion', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { artifactId?: unknown; version?: unknown };
      const artifactId = typeof request?.artifactId === 'string' ? request.artifactId : '';
      const version = typeof request?.version === 'number' ? request.version : 0;
      if (!artifactId || version < 1 || !researchRepository) return { ok: false, error: 'invalid_request' };
      const restored = researchRepository.restoreArtifactVersion(artifactId, version);
      return restored ? { ok: true, version: restored.version } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'restore_failed' };
    }
  });

  // ── Messages ────────────────────────────────────────────
  ipcMain.handle('messages:get', (event, rawSessionId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const sessionId = RuntimeIdSchema.parse(rawSessionId);
      const rows = (store?.getMessages(sessionId) ?? []).map(({ role, content }) => ({
        role,
        content,
      }));
      return decodeStoredHistory(rows);
    } catch {
      return decodeStoredHistory(null);
    }
  });

  ipcMain.handle('messages:append', (event, rawSessionId: unknown, rawRole: unknown, rawContent: unknown) => {
    try {
      requireRendererMainFrame(event);
      const sessionId = RuntimeIdSchema.parse(rawSessionId);
      const decoded = decodeStoredHistoryEntry({ role: rawRole, content: rawContent });
      if (decoded.kind === 'recovery' || !store) return -1;
      return store.appendMessage(sessionId, rawRole as string, rawContent as string);
    } catch {
      return -1;
    }
  });

  // ── Eval Suite Execution (real) ─────────────────────────
  ipcMain.handle('eval:runSuite', async (event, rawRequest: unknown) => {
    let window: BrowserWindow;
    try {
      window = requireRendererMainFrame(event);
    } catch {
      return createEvalRunFailure();
    }
    const request = decodeEvalRunRequest(rawRequest);
    if (!request || !agentLoop) return createEvalRunFailure();
    if (evalSuiteRunning) return createEvalRunFailure('eval_already_running');

    const consent = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Run diagnostic evaluation',
      message: 'This diagnostic suite will call the configured model and may use controlled research tools.',
      detail: 'It can consume provider quota. Results are diagnostic evidence, not a product release approval.',
      buttons: ['Run evaluation', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (consent.response !== 0) {
      return decodeEvalRunResult({ status: 'cancelled', code: 'eval_user_cancelled' });
    }
    evalSuiteRunning = true;

    // Pre-defined eval tasks that exercise core engine capabilities
    const tasks: EvalTaskSpec[] = [
      ...RESEARCH_CAPABILITY_TASKS,
      {
        id: 'basic-completion',
        prompt: 'Respond with exactly the word "hello" and nothing else.',
        maxTurns: 3,
        requirements: ['hello'],
      },
      {
        id: 'tool-use-reasoning',
        prompt: 'Use the read_file tool to read a file, then summarize what you found.',
        maxTurns: 5,
        allowedTools: ['read_file'],
      },
      {
        id: 'constraint-check',
        prompt: 'Say "done" without using any tools.',
        maxTurns: 3,
        forbiddenTools: ['read_file', 'write_file', 'execute_command'],
        requirements: ['done'],
      },
    ];

    try {
      const runner = new EvalRunner(agentLoop);
      const suiteResult = await runner.runSuite(tasks, { suite: 'metis-core', model: provider?.capabilities().model ?? 'unknown', profile: request.profile });
      const summary = suiteSummary(suiteResult);
      const gate = evaluateGate(suiteResult, request.profile);

      // Persist the run
      store?.saveEvalRun({
        id: `eval-${Date.now()}`,
        suiteName: suiteResult.metadata.suite,
        status: gate.passed ? 'passed' : 'failed',
        successRate: summary.successRate,
        taskCount: summary.taskCount,
        passedCount: summary.passed,
        resultsJson: JSON.stringify(suiteResult.results),
        createdAt: suiteResult.metadata.timestamp,
      });

      return decodeEvalRunResult({
        status: 'completed',
        summary: {
          taskCount: summary.taskCount,
          passed: summary.passed,
          failed: summary.failed,
          successRate: summary.successRate,
        },
        gate: {
          passed: gate.passed,
          profile: request.profile,
          failureCount: gate.failures.length,
          failedTaskIds: gate.failedTasks,
        },
        results: suiteResult.results.map((r) => ({
          taskId: r.taskId,
          success: r.success,
          status: r.success ? 'passed' : r.status === 'cancelled' ? 'cancelled' : 'failed',
          turnsUsed: r.turnsUsed,
          toolCalls: r.toolCalls,
          latencyMs: r.latencyMs,
          toolFailures: r.toolFailures,
          qualityFailures: r.qualityFailures,
          issueCount: r.errors.length,
        })),
      });
    } catch {
      return createEvalRunFailure('eval_execution_failed');
    } finally {
      evalSuiteRunning = false;
    }
  });

  // ── LaTeX Compile ───────────────────────────────────────
  ipcMain.handle('latex:compile', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: (rawArgs) => {
      const request = decodeLatexCompileRequest({
        source: rawArgs[0],
        bibliography: rawArgs[1],
      });
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request, event): Promise<LatexCompileResponse> => {
      const result = await compileLatexLocal(request.source, request.bibliography);
      const issues = (result.errors ?? []).slice(0, 500).map((issue) => ({
        line: Number.isInteger(issue.line) && issue.line >= 0 ? issue.line : 0,
        severity: issue.severity,
        code: issue.severity === 'error'
          ? 'latex_compile_error' as const
          : 'latex_compile_warning' as const,
      }));
      if (result.status === 'success' && result.pdfPath) {
        const issued = fileCapabilities.issue({
          path: result.pdfPath,
          kind: 'file',
          mime: 'application/pdf',
          operations: ['file', 'folder', 'read', 'extract'],
        }, executionOwnerFor(event));
        if (issued.success) {
          return decodeLatexCompileResponse({ status: 'success', pdf: issued.capability, issues });
        }
      }
      if (result.status === 'noCompiler') {
        return decodeLatexCompileResponse({
          status: 'noCompiler',
          code: 'latex_compiler_unavailable',
          issues,
        });
      }
      return decodeLatexCompileResponse({
        status: 'error',
        code: 'latex_compile_unavailable',
        issues,
      });
    },
    present: (result) => result,
    recover: createLatexCompileRecovery,
  }));

  ipcMain.handle('fileCapability:use', createFileCapabilityUseHandler({
    getMainWindow,
    getRendererEntryUrl,
    registry: fileCapabilities,
  }));

  // ── Shell ───────────────────────────────────────────────
  ipcMain.handle('fileCapability:select', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeFileCapabilitySelectionRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: async (request, event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) return createFileCapabilityFailure();
      const selectingSkillDirectory = request.purpose === 'personalization-skill-directory';
      const filters = selectingSkillDirectory
        ? undefined
        : request.purpose === 'analysis-dataset'
        ? [
            { name: 'Research data', extensions: ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls', 'sav', 'dta'] },
            { name: 'All files', extensions: ['*'] },
          ]
        : request.purpose === 'personalization-skill-package'
          ? [
              { name: 'Metis skill packages', extensions: ['zip'] },
              { name: 'All files', extensions: ['*'] },
            ]
          : request.purpose === 'funding-template'
            ? [
                { name: 'Funding application templates', extensions: ['pdf', 'docx'] },
              ]
        : [
            { name: 'Research files', extensions: ['pdf', 'docx', 'txt', 'md', 'tex', 'csv', 'json', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav'] },
            { name: 'All files', extensions: ['*'] },
          ];
      const selected = await dialog.showOpenDialog(window, selectingSkillDirectory
        ? { properties: ['openDirectory'] }
        : { properties: ['openFile'], filters });
      const selectedPath = selected.canceled ? undefined : selected.filePaths[0];
      if (!selectedPath) return createFileCapabilityFailure();
      const issued = fileCapabilities.issue({
        path: selectedPath,
        kind: selectingSkillDirectory ? 'folder' : 'file',
        mime: selectingSkillDirectory ? 'inode/directory' : mimeForLocalFile(selectedPath),
        operations: selectingSkillDirectory
          ? ['folder']
          : request.purpose === 'personalization-skill-package'
            ? ['file']
            : ['file', 'folder', 'read', 'extract'],
        purpose: request.purpose,
      }, executionOwnerFor(event));
      return issued.success ? issued : createFileCapabilityFailure();
    },
    present: decodeFileCapabilitySelectionResult,
    recover: createFileCapabilityFailure,
  }));

  ipcMain.handle('fileCapability:import', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeFileCapabilityImportRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: async (request, event) => {
      if (request.purpose === 'personalization-skill-directory') {
        return createFileCapabilityFailure();
      }
      await fs.promises.mkdir(IMPORTS_DIR, { recursive: true });
      const token = randomUUID();
      const finalPath = path.join(IMPORTS_DIR, `${token}-${request.displayName}`);
      const temporaryPath = `${finalPath}.partial`;
      try {
        if (
          path.extname(request.displayName).toLowerCase() === '.pdf'
          && Buffer.from(request.data.subarray(0, 5)).toString('ascii') !== '%PDF-'
        ) {
          return createFileCapabilityFailure();
        }
        await fs.promises.writeFile(temporaryPath, request.data, { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(temporaryPath, finalPath);
        const issued = fileCapabilities.issue({
          path: finalPath,
          kind: 'file',
          mime: mimeForLocalFile(finalPath),
          displayName: request.displayName,
          operations: ['file', 'folder', 'read', 'extract'],
          purpose: request.purpose,
        }, executionOwnerFor(event));
        if (issued.success) return issued;
        await fs.promises.rm(finalPath, { force: true });
        return createFileCapabilityFailure();
      } catch {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        return createFileCapabilityFailure();
      }
    },
    present: decodeFileCapabilitySelectionResult,
    recover: createFileCapabilityFailure,
  }));

  ipcMain.handle('export:selectDestination', async (event) => {
    try {
      const window = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
      });
      const directory = selected.canceled ? undefined : selected.filePaths[0];
      if (!directory) return createFileCapabilityFailure();
      const issued = fileCapabilities.issue({
        path: directory,
        kind: 'folder',
        mime: 'inode/directory',
        operations: ['folder'],
        displayName: path.basename(directory) || 'Export destination',
      }, executionOwnerFor(event));
      return issued.success ? issued : createFileCapabilityFailure();
    } catch {
      return createFileCapabilityFailure();
    }
  });

  ipcMain.handle('export:preview', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const decodedRequest = decodeExportRequest(rawRequest);
      const repository = researchRepository;
      const media = researchMedia;
      const receipts = citationTruthReceipts;
      if (!decodedRequest.ok || !repository || !media || !receipts) return createExportFailure();
      const request = decodedRequest.value;
      const destination = fileCapabilities.resolve({
        capabilityId: request.destinationCapabilityId,
        operation: 'folder',
      }, owner);
      if (!destination.ok) {
        return createExportFailure({ code: 'export_destination_unavailable', severity: 'error' });
      }
      const snapshot = repository.snapshotProject(request.projectId);
      if (!snapshot) {
        return createExportFailure({ code: 'export_snapshot_unavailable', severity: 'error' });
      }
      const binding = resolveTrustedArtifactExportBinding(
        snapshot,
        request.artifactId,
        request.artifactVersion,
      );
      if (!binding) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const artifactImages = await media.loadArtifactMedia(snapshot, binding);
      if (!artifactImages) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const selectedVersion = snapshot.artifactVersions.find((candidate) => (
        candidate.artifactId === binding.artifactId
        && candidate.version === binding.artifactVersion
      ));
      const selectedManifest = selectedVersion
        ? ArtifactManifestSchema.safeParse(selectedVersion.manifest)
        : null;
      const releaseTrust = selectedVersion && selectedManifest?.success
        ? await verifyArtifactForExport(
            repository,
            receipts,
            selectedManifest.data,
            selectedVersion.content,
          )
        : null;
      if (!releaseTrust) {
        return createExportFailure({ code: 'export_gate_blocked', severity: 'error' });
      }
      const trustedRequest = {
        ...request,
        artifactManifestDigest: binding.artifactManifestDigest,
      };
      const built = buildResearchExport(
        trustedRequest,
        buildExportSnapshot(snapshot, binding, artifactImages, releaseTrust),
      );
      if (!built.ok) return built.failure;
      const preview = secureExports.preview(built.plan);
      if (!preview.success) return preview;
      const now = Date.now();
      for (const [id, item] of exportPreviews) {
        if (item.expiresAt <= now) exportPreviews.delete(id);
      }
      if (exportPreviews.size >= 32) {
        const oldest = exportPreviews.keys().next().value as string | undefined;
        if (oldest) exportPreviews.delete(oldest);
      }
      exportPreviews.set(request.exportId, {
        request,
        plan: built.plan,
        expiresAt: now + 5 * 60_000,
      });
      return decodeExportResult(preview);
    } catch {
      return createExportFailure();
    }
  });

  ipcMain.handle('export:execute', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const decodedRequest = decodeExportRequest(rawRequest);
      if (!decodedRequest.ok) return createExportFailure();
      const request = decodedRequest.value;
      const preview = exportPreviews.get(request.exportId);
      exportPreviews.delete(request.exportId);
      if (
        !preview
        || preview.expiresAt <= Date.now()
        || JSON.stringify(preview.request) !== JSON.stringify(request)
      ) {
        return createExportFailure({ code: 'export_invalid_request', severity: 'error' });
      }
      const repository = researchRepository;
      const media = researchMedia;
      const receipts = citationTruthReceipts;
      if (!repository || !media || !receipts) {
        return createExportFailure({ code: 'export_snapshot_unavailable', severity: 'error' });
      }
      const currentSnapshot = repository.snapshotProject(request.projectId);
      if (!currentSnapshot) {
        return createExportFailure({ code: 'export_snapshot_unavailable', severity: 'error' });
      }
      const currentBinding = resolveTrustedArtifactExportBinding(
        currentSnapshot,
        request.artifactId,
        request.artifactVersion,
      );
      if (
        !currentBinding
        || currentBinding.artifactManifestDigest !== preview.plan.artifactManifestDigest
      ) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const currentImages = await media.loadArtifactMedia(currentSnapshot, currentBinding);
      if (!currentImages) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const currentVersion = currentSnapshot.artifactVersions.find((candidate) => (
        candidate.artifactId === currentBinding.artifactId
        && candidate.version === currentBinding.artifactVersion
      ));
      const currentManifest = currentVersion
        ? ArtifactManifestSchema.safeParse(currentVersion.manifest)
        : null;
      const currentTrust = currentVersion && currentManifest?.success
        ? await verifyArtifactForExport(
            repository,
            receipts,
            currentManifest.data,
            currentVersion.content,
          )
        : null;
      if (!currentTrust) {
        return createExportFailure({ code: 'export_gate_blocked', severity: 'error' });
      }
      const currentBuild = buildResearchExport({
        ...request,
        artifactManifestDigest: currentBinding.artifactManifestDigest,
      }, buildExportSnapshot(currentSnapshot, currentBinding, currentImages, currentTrust));
      if (!currentBuild.ok) return currentBuild.failure;
      const destination = fileCapabilities.resolve({
        capabilityId: request.destinationCapabilityId,
        operation: 'folder',
      }, owner);
      if (!destination.ok) {
        return createExportFailure({ code: 'export_destination_unavailable', severity: 'error' });
      }
      const result = await secureExports.write(currentBuild.plan, {
        resolvedDirectory: destination.resolvedPath,
      });
      return decodeExportResult(result.publicResult);
    } catch {
      return createExportFailure({ code: 'export_write_failed', severity: 'error' });
    }
  });

  ipcMain.handle('shell:openExternal', createSecureExternalOpenHandler({
    authorize: requireRendererMainFrame,
    openExternal: (url) => shell.openExternal(url),
  }));

  // ── Settings ────────────────────────────────────────────
  ipcMain.handle('settings:get', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return createSettingsViewRecovery();
    }
    if (!currentConfig && layoutAcceptanceToken) {
      // Layout acceptance runs against a disposable credential-free profile.
      // It needs the normal project shell, but it must not mint a provider or
      // read a real API key. This fixed view is reachable only when the main
      // process was explicitly launched with the acceptance token.
      return decodeSettingsView({
        configured: true,
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'layout-acceptance-model',
        hasApiKey: true,
        needsReauth: false,
        theme: currentTheme,
        providerVision: loadProviderVision(),
        providerMaxContextTokens: loadProviderMaxContextTokens(),
        setupSkipped: true,
      });
    }
    if (!currentConfig) {
      return decodeSettingsView({
        configured: false,
        hasApiKey: false,
        needsReauth: false,
        theme: currentTheme,
        providerVision: loadProviderVision(),
        providerMaxContextTokens: loadProviderMaxContextTokens(),
        setupSkipped: loadSetupSkipped(),
      });
    }
    return decodeSettingsView({
      configured: true,
      baseUrl: currentConfig.baseUrl,
      model: currentConfig.model,
      hasApiKey: !!currentConfig.apiKey,
      needsReauth: !currentConfig.apiKey,
      theme: currentTheme,
      providerVision: loadProviderVision(),
      providerMaxContextTokens: loadProviderMaxContextTokens(),
      setupSkipped: loadSetupSkipped(),
    });
  });

  // ── First-run setup skip persistence ─────────────────────
  ipcMain.handle('settings:markSetupSkipped', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    return { ok: saveSetupSkipped() };
  });

  // ── Update check ─────────────────────────────────────────
  ipcMain.handle('update:check', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { hasUpdate: false, currentVersion: app.getVersion(), error: 'unauthorized_renderer' };
    }
    if (!updateChecker) updateChecker = new UpdateCheckerService();
    return updateChecker.check(app.getVersion());
  });

  // ── Auto update control ──────────────────────────────────
  ipcMain.handle('update:status', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { error: 'unauthorized_renderer' };
    }
    return { ...lastUpdateEvent, currentVersion: app.getVersion() };
  });
  ipcMain.handle('update:download', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { error: 'unauthorized_renderer' };
    }
    await autoUpdaterService?.download();
    return lastUpdateEvent;
  });
  ipcMain.handle('update:install', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { error: 'unauthorized_renderer' };
    }
    autoUpdaterService?.quitAndInstall();
    return { installing: true };
  });

  // ── Backup management ──────────────────────────────────────
  ipcMain.handle('backup:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!backupService) return { backups: [] };
      return { backups: backupService.listBackups().map((p) => ({ path: p, name: path.basename(p) })) };
    } catch {
      return { backups: [] };
    }
  });

  ipcMain.handle('backup:restore', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { backupPath?: string };
      if (!backupService || !request?.backupPath) return { ok: false, error: 'backup_unavailable' };
      return backupService.restoreFrom(request.backupPath);
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── Complete project archive (METIS-F10) ───────────────────
  ipcMain.handle('project:export', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { projectId?: string; destPath?: string };
      if (!store || !researchRepository || !request?.projectId) {
        return { ok: false, error: 'project_export_unavailable' };
      }
      fs.mkdirSync(EXPORTS_DIR, { recursive: true });
      const destPath = request.destPath
        ?? path.join(EXPORTS_DIR, `${request.projectId}-${new Date().toISOString().replace(/[:.]/g, '-')}${PROJECT_ARCHIVE_EXT}`);
      return await exportProjectArchive({
        db: store.raw,
        projectId: request.projectId,
        destPath,
        appVersion: app.getVersion(),
      });
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('project:import', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { archivePath?: string; projectId?: string; overwrite?: boolean };
      if (!store || !request?.archivePath) return { ok: false, error: 'archive_path_required' };
      fs.mkdirSync(IMPORTS_DIR, { recursive: true });
      return await importProjectArchive({
        db: store.raw,
        archivePath: request.archivePath,
        projectId: request.projectId,
        overwrite: request.overwrite,
        filesDir: IMPORTS_DIR,
      });
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('project:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!researchRepository) return { success: true, projects: [] };
      const projects = researchRepository.listProjects().map((p) => ({
        id: p.id,
        title: p.title,
        updatedAt: p.updatedAt,
        archivedAt: p.archivedAt,
      }));
      return { success: true, projects };
    } catch {
      return { success: true, projects: [] };
    }
  });

  // ── O13: 项目级 provider/model 覆盖 ───────────────────────
  // 覆盖存于 projects.metadata.providerOverride；读取经 zod 校验，损坏数据
  // 一律视为无覆盖。写入只允许 contract 定义的字段。
  ipcMain.handle('project:getProviderOverride', (event, rawProjectId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!researchRepository || typeof rawProjectId !== 'string' || !rawProjectId) {
        return { ok: false as const, code: 'invalid_request' as const };
      }
      const override = researchRepository.getProjectProviderOverride(rawProjectId);
      return { ok: true as const, override };
    } catch {
      return { ok: false as const, code: 'invalid_request' as const };
    }
  });

  ipcMain.handle('project:setProviderOverride', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { projectId?: unknown; override?: unknown };
      if (!researchRepository || typeof request?.projectId !== 'string' || !request.projectId) {
        return { ok: false as const, code: 'invalid_request' as const };
      }
      // override 为 null 表示清除；否则必须通过 contract 校验。
      if (request.override === null) {
        const cleared = researchRepository.setProjectProviderOverride(request.projectId, null);
        return cleared ? { ok: true as const } : { ok: false as const, code: 'not_found' as const };
      }
      const parsed = ProjectProviderOverrideSchema.safeParse(request.override);
      if (!parsed.success || !decodeProjectProviderOverride(parsed.data)) {
        return { ok: false as const, code: 'invalid_request' as const };
      }
      // 引用的 profile 必须真实存在，防止写入悬空覆盖。
      if (parsed.data.providerProfileId) {
        const listed = providerProfileStore?.list();
        const exists = listed?.ok === true && listed.value.profiles.some((p) => p.id === parsed.data.providerProfileId);
        if (!exists) return { ok: false as const, code: 'not_found' as const };
      }
      const saved = researchRepository.setProjectProviderOverride(request.projectId, parsed.data);
      return saved ? { ok: true as const } : { ok: false as const, code: 'not_found' as const };
    } catch {
      return { ok: false as const, code: 'invalid_request' as const };
    }
  });

  ipcMain.handle('project:pickArchive', async (event) => {
    try {
      const win = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{
          name: 'Metis Project Archive',
          extensions: [PROJECT_ARCHIVE_EXT.slice(1), ...PROJECT_ARCHIVE_LEGACY_EXTS.map((ext) => ext.slice(1))],
        }],
      });
      return { canceled: selected.canceled, path: selected.canceled ? undefined : selected.filePaths[0] };
    } catch {
      return { canceled: true, path: undefined };
    }
  });

  // ── Storage location (user-configurable data directory) ──────
  ipcMain.handle('storage:getLocation', (event) => {
    try {
      requireRendererMainFrame(event);
      return {
        ok: true,
        dataDir: DATA_DIR,
        defaultDir: DEFAULT_DATA_DIR,
        usingDefault: path.resolve(DATA_DIR) === path.resolve(DEFAULT_DATA_DIR),
      };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('storage:chooseLocation', async (event) => {
    try {
      const win = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Metis data directory',
      });
      return { canceled: selected.canceled, path: selected.canceled ? undefined : selected.filePaths[0] };
    } catch {
      return { canceled: true, path: undefined };
    }
  });

  ipcMain.handle('storage:setLocation', (event, rawTarget: unknown) => {
    try {
      requireRendererMainFrame(event);
      const target = typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.trim() : '';
      if (!target) return { ok: false, error: 'location_invalid_path' };
      const current = DATA_DIR;
      if (path.resolve(target) === path.resolve(current)) {
        return { ok: true, restarting: false, dataDir: current };
      }
      const validation = validateTargetLocation(target, USER_DATA_DIR);
      if (!validation.ok) return { ok: false, error: `location_${validation.reason}` };
      const written = writeLocationPointer(USER_DATA_DIR, {
        version: LOCATION_POINTER_VERSION,
        dataDir: target,
        pendingMigrateFrom: current,
      });
      if (!written) return { ok: false, error: 'location_pointer_write_failed' };
      // Relaunch so the migration runs before any data handle is opened.
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 200);
      return { ok: true, restarting: true, dataDir: target };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('storage:openFolder', async (event) => {
    try {
      requireRendererMainFrame(event);
      const errorMessage = await shell.openPath(DATA_DIR);
      return { ok: !errorMessage, error: errorMessage || undefined };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── Research browser (embedded WebContentsView) ──────────────
  ipcMain.handle('browser:show', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds) return { ok: false, error: 'browser_invalid_bounds' };
      // 与协同对话视图互斥：同一时间只显示一个嵌入视图。
      collabService?.hide();
      service.show(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:hide', (event) => {
    try {
      requireRendererMainFrame(event);
      browserService?.hide();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:setBounds', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds || !browserService) return { ok: false, error: 'browser_invalid_bounds' };
      browserService.setBounds(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:navigate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const url = typeof raw === 'string' ? raw : '';
      return await service.navigate(url);
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:back', (event) => { try { requireRendererMainFrame(event); browserService?.goBack(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  ipcMain.handle('browser:forward', (event) => { try { requireRendererMainFrame(event); browserService?.goForward(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  ipcMain.handle('browser:reload', (event) => { try { requireRendererMainFrame(event); browserService?.reload(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  ipcMain.handle('browser:stop', (event) => { try { requireRendererMainFrame(event); browserService?.stop(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });

  ipcMain.handle('browser:focusRenderer', (event) => {
    try {
      requireRendererMainFrame(event);
      event.sender.focus();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── 协同对话（第三方 AI 网页版 WebContentsView） ─────────────
  ipcMain.handle('collab:show', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureCollabService();
      if (!service) return { ok: false, error: 'collab_unavailable' };
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds) return { ok: false, error: 'collab_invalid_bounds' };
      // 与研究浏览器视图互斥：同一时间只显示一个嵌入视图。
      browserService?.hide();
      service.show(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('collab:hide', (event) => {
    try {
      requireRendererMainFrame(event);
      collabService?.hide();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('collab:setBounds', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds || !collabService) return { ok: false, error: 'collab_invalid_bounds' };
      collabService.setBounds(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('collab:navigate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureCollabService();
      if (!service) return { ok: false, error: 'collab_unavailable' };
      const url = typeof raw === 'string' ? raw : '';
      return await service.navigate(url);
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── 内置文献检索（NCPSSD 中文 + OpenAlex 英文，LIT-SEARCH-01） ──
  ipcMain.handle('literature:search', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (typeof rawRequest !== 'object' || rawRequest === null) {
        return { ok: false, code: 'literature_invalid_request', recovery: 'retry_with_valid_query' };
      }
      const request = rawRequest as { query?: unknown; sources?: unknown; page?: unknown; pageSize?: unknown; coreOnly?: unknown };
      const sources = Array.isArray(request.sources)
        ? request.sources.filter((source): source is 'ncpssd' | 'openalex' => source === 'ncpssd' || source === 'openalex')
        : [];
      return await literatureSearchService.search({
        query: typeof request.query === 'string' ? request.query : '',
        sources,
        page: typeof request.page === 'number' ? request.page : 1,
        pageSize: typeof request.pageSize === 'number' ? request.pageSize : 10,
        coreOnly: request.coreOnly !== false,
      });
    } catch {
      return { ok: false, code: 'literature_source_unavailable', recovery: 'retry_later_or_change_source' };
    }
  });

  ipcMain.handle('browser:state', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      return service ? { ok: true, state: service.getState() } : { ok: false, error: 'browser_unavailable' };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:click', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const { x, y } = (raw as { x?: number; y?: number }) ?? {};
      if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, error: 'browser_invalid_point' };
      service.click(x, y);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:type', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const text = typeof raw === 'string' ? raw.slice(0, 4000) : '';
      if (!text) return { ok: false, error: 'browser_invalid_text' };
      service.type(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:key', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const keyCode = typeof raw === 'string' ? raw : '';
      if (!keyCode) return { ok: false, error: 'browser_invalid_key' };
      service.key(keyCode);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:scroll', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const { deltaX, deltaY } = (raw as { deltaX?: number; deltaY?: number }) ?? {};
      service.scroll(Number(deltaX) || 0, Number(deltaY) || 0);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:screenshot', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.screenshot();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:extract', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.extract();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:collect', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.collect();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:listDownloads', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return { ok: true, downloads: service.listPendingDownloads() };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:acceptDownload', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const request = (raw as { id?: string; projectId?: string | null }) ?? {};
      if (!request.id) return { ok: false, error: 'download_not_found' };
      // 项目自定义目录优先（批2）：PDF 归档到 projectDir/pdfs。
      let projectDir: string | null = null;
      try {
        if (request.projectId && researchRepository) {
          const project = researchRepository.getProject(request.projectId, false);
          projectDir = (project?.metadata as { projectDir?: string } | undefined)?.projectDir ?? null;
        }
      } catch { /* 目录读取失败回退默认 */ }
      const outcome = await service.acceptDownload({ id: request.id, projectId: request.projectId ?? null, projectDir });
      // PDF 归档成功后自动入队全文抽取（T2：AI 可读全文的入口）。
      if (outcome.ok && outcome.paperId && outcome.savedPath) {
        jobQueueService.enqueueExtract(outcome.paperId, outcome.savedPath);
      }
      return outcome;
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:cancelDownload', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = typeof raw === 'string' ? raw : '';
      if (!id || !browserService) return { ok: false, error: 'download_not_found' };
      browserService.cancelDownload(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });


  // ── WeChat Bot (METIS-WX-1, iLink protocol — same as ZCode) ──
  ipcMain.handle('wechat:getStatus', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      return service ? { ok: true, status: service.getStatus() } : { ok: false, error: 'wechat_unavailable' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('wechat:beginLogin', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      if (!service) return { ok: false, error: 'wechat_unavailable' };
      return await service.beginLogin();
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('wechat:pollLogin', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      if (!service) return { ok: false, phase: 'error', error: 'wechat_unavailable' };
      return await service.pollLogin();
    } catch {
      return { ok: false, phase: 'error', error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('wechat:submitVerifyCode', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      const request = rawRequest as { code?: string };
      if (!service || !request?.code) return { ok: false, error: 'wechat_unavailable' };
      service.submitVerifyCode(request.code);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('wechat:logout', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      if (!service) return { ok: false, error: 'wechat_unavailable' };
      await service.logout();
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('wechat:sendTest', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      const request = rawRequest as { text?: string };
      if (!service || !request?.text?.trim()) return { ok: false, error: 'wechat_unavailable' };
      return await service.sendTestMessage(request.text);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('wechat:setProject', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      const request = rawRequest as { projectId?: string };
      if (!service || !request?.projectId) return { ok: false, error: 'wechat_unavailable' };
      service.setActiveProject(request.projectId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  // ── OfficeCli (Word/PPT/Excel via external officecli binary) ──
  ipcMain.handle('officecli:status', (event) => {
    try {
      requireRendererMainFrame(event);
      return getOfficeCliService().detect();
    } catch {
      return { available: false, binary: '', error: 'unauthorized_renderer' };
    }
  });

  // Create a fresh document under the app data dir and return its path. The
  // renderer never chooses filesystem locations directly.
  ipcMain.handle('officecli:newDocument', async (event, rawExt: unknown, rawProjectId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const ext = typeof rawExt === 'string' ? rawExt : 'docx';
      const allowed = new Set(['docx', 'pptx', 'xlsx']);
      if (!allowed.has(ext)) return { success: false, error: 'unsupported_format' };
      const projectId = typeof rawProjectId === 'string' && rawProjectId ? rawProjectId : null;
      const docsRoot = path.join(DATA_DIR, 'office-docs', projectId ?? 'global');
      fs.mkdirSync(docsRoot, { recursive: true });
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const filePath = path.join(docsRoot, `doc-${stamp}.${ext}`);
      const created = await getOfficeCliService().create(filePath);
      if (!created.success) return { success: false, error: created.error ?? 'create_failed' };
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? 'create_failed' };
    }
  });

  ipcMain.handle('officecli:exec', async (event, rawArgs: unknown) => {
    try {
      requireRendererMainFrame(event);
      const args = Array.isArray(rawArgs) ? rawArgs.filter((a): a is string => typeof a === 'string') : [];
      return await getOfficeCliService().exec(args);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:create', async (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().create(filePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:open', async (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'file_not_found' };
      return await getOfficeCliService().open(filePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:add', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; parent?: unknown; type?: unknown; props?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const parent = typeof request?.parent === 'string' ? request.parent : '/';
      const type = typeof request?.type === 'string' ? request.type : 'paragraph';
      const props = (request?.props && typeof request.props === 'object' ? request.props : {}) as Record<string, string>;
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().add(filePath, parent, type, props);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:set', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; path?: unknown; props?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const nodePath = typeof request?.path === 'string' ? request.path : '/';
      const props = (request?.props && typeof request.props === 'object' ? request.props : {}) as Record<string, string>;
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().set(filePath, nodePath, props);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:query', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; selector?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const selector = typeof request?.selector === 'string' ? request.selector : '';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().query(filePath, selector);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:get', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; path?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const nodePath = typeof request?.path === 'string' ? request.path : '/';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().get(filePath, nodePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:remove', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; path?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const nodePath = typeof request?.path === 'string' ? request.path : '/';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().remove(filePath, nodePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:renderHtml', async (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().renderHtml(filePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:outline', async (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().outline(filePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:startWatch', async (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().startWatch(filePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:stopWatch', async (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().stopWatch(filePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:close', async (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().close(filePath);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('officecli:revealFile', (event, rawFilePath: unknown) => {
    try {
      requireRendererMainFrame(event);
      const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
      if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'file_not_found' };
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  // ── PPT-specific operations ──
  // Add a slide with title + content in one call.
  ipcMain.handle('officecli:addSlide', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; layout?: unknown; title?: unknown; text?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const layout = typeof request?.layout === 'string' ? request.layout : 'Title and Content';
      const props: Record<string, string> = { layout };
      if (typeof request?.title === 'string' && request.title) props.title = request.title;
      if (typeof request?.text === 'string' && request.text) props.text = request.text;
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().add(filePath, '/', 'slide', props);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  // Add a shape with non-overlap enforcement: queries existing shapes on the
  // target slide, computes a safe position, then adds the shape.
  ipcMain.handle('officecli:addShapeNoOverlap', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; slidePath?: unknown; text?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const slidePath = typeof request?.slidePath === 'string' ? request.slidePath : '/slide[1]';
      if (!filePath) return { success: false, error: 'invalid_path' };
      const service = getOfficeCliService();
      // Query existing shapes on the slide.
      const query = await service.query(filePath, `${slidePath} shape`);
      const existingShapes = (Array.isArray(query.data) ? query.data : []) as Array<Record<string, string>>;
      const proposed = {
        x: typeof request?.x === 'string' ? parseFloat(request.x) || 72 : 72,
        y: typeof request?.y === 'string' ? parseFloat(request.y) || 72 : 72,
        w: typeof request?.w === 'string' ? parseFloat(request.w) || 200 : 200,
        h: typeof request?.h === 'string' ? parseFloat(request.h) || 100 : 100,
      };
      const safe = findNonOverlappingPosition(existingShapes, proposed);
      // pt → cm for officecli (1cm ≈ 28.35pt).
      const props: Record<string, string> = {
        x: `${(safe.x / 28.35).toFixed(1)}cm`,
        y: `${(safe.y / 28.35).toFixed(1)}cm`,
        w: `${(proposed.w / 28.35).toFixed(1)}cm`,
        h: `${(proposed.h / 28.35).toFixed(1)}cm`,
      };
      if (typeof request?.text === 'string' && request.text) props.text = request.text;
      return await service.add(filePath, slidePath, 'shape', props);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  // Set theme colors/fonts at the presentation level.
  ipcMain.handle('officecli:setTheme', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { filePath?: unknown; props?: unknown };
      const filePath = typeof request?.filePath === 'string' ? request.filePath : '';
      const props = (request?.props && typeof request.props === 'object' ? request.props : {}) as Record<string, string>;
      if (!filePath) return { success: false, error: 'invalid_path' };
      return await getOfficeCliService().set(filePath, '/presentation', props);
    } catch {
      return { success: false, error: 'unauthorized_renderer' };
    }
  });

  // ── Flashcards (SQLite-backed via memory store) ──────────
  ipcMain.handle('flashcard:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return { cards: [] };
      const entries = store.getMemoryByCategory('flashcard');
      return { cards: entries.map((e) => { try { return JSON.parse(e.value); } catch { return null; } }).filter(Boolean) };
    } catch {
      return { cards: [] };
    }
  });

  ipcMain.handle('flashcard:save', (event, rawCard: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return { ok: false };
      const card = rawCard as { id?: unknown; front?: unknown; back?: unknown; dueAt?: unknown; intervalDays?: unknown; createdAt?: unknown };
      if (typeof card?.id !== 'string') return { ok: false };
      store.setMemory(`flashcard:${card.id}`, JSON.stringify(card), 'flashcard');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('flashcard:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return { ok: false };
      const id = typeof rawId === 'string' ? rawId : '';
      if (!id) return { ok: false };
      store.deleteMemory?.(`flashcard:${id}`);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // ── Zotero import ────────────────────────────────────────
  ipcMain.handle('zotero:import', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, imported: 0, merged: 0, skipped: 0, error: 'unauthorized_renderer', items: [] };
    }
    if (!store) return { ok: false, imported: 0, merged: 0, skipped: 0, error: 'store_unavailable', items: [] };
    const request = rawRequest as { libraryType?: unknown; libraryId?: unknown; query?: unknown; maxItems?: unknown; projectId?: unknown };
    const libraryType = request.libraryType === 'personal' || request.libraryType === 'group' ? request.libraryType : undefined;
    const libraryId = typeof request.libraryId === 'string' ? request.libraryId.trim() : '';
    if (!libraryType || !libraryId || libraryId.length > 128 || !/^[0-9]+$/u.test(libraryId)) {
      return { ok: false, imported: 0, merged: 0, skipped: 0, error: 'invalid_library_identity', items: [] };
    }
    const projectId = typeof request.projectId === 'string' && request.projectId.length > 0 ? request.projectId : undefined;
    if (projectId && researchRepository && !researchRepository.listProjects().some((p) => p.id === projectId)) {
      return { ok: false, imported: 0, merged: 0, skipped: 0, error: 'project_not_found', items: [] };
    }
    zoteroImportTargetProjectId = projectId;
    if (!zoteroImportService) {
      zoteroImportService = new ZoteroImportService({
        store,
        apiKeyResolver: () => personalizationSecretVault?.resolve('{{secret:ZOTERO_API_KEY}}') ?? undefined,
        linkToProject: (paper) => {
          if (zoteroImportTargetProjectId) linkPaperToProjectSource(paper, zoteroImportTargetProjectId);
        },
      });
    }
    return zoteroImportService.import({
      libraryType,
      libraryId,
      query: typeof request.query === 'string' ? request.query : undefined,
      maxItems: typeof request.maxItems === 'number' ? request.maxItems : 20,
      projectId,
    });
  });

  // Secure Zotero connection probe: the main process resolves the vault key and
  // contacts the Zotero API itself. The renderer never receives the key.
  ipcMain.handle('zotero:probe', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    const request = rawRequest as { libraryType?: unknown; libraryId?: unknown };
    const libraryType = request.libraryType === 'personal' || request.libraryType === 'group' ? request.libraryType : undefined;
    const libraryId = typeof request.libraryId === 'string' ? request.libraryId.trim() : '';
    if (!libraryType || !libraryId || !/^[0-9]{1,128}$/u.test(libraryId)) {
      return { ok: false, error: 'invalid_library_identity' };
    }
    const apiKey = personalizationSecretVault?.resolve('{{secret:ZOTERO_API_KEY}}');
    if (!apiKey) return { ok: false, error: 'zotero_not_configured' };
    try {
      const { searchZoteroLibrary } = await import('../engine/research/ZoteroClient.js');
      const result = await searchZoteroLibrary({
        apiKey,
        libraryType,
        libraryId,
        query: '',
        start: 0,
        maxResults: 1,
      });
      return { ok: true, totalResults: result.totalResults };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'zotero_probe_failed' };
    }
  });

  ipcMain.handle('settings:set', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSettingsUpdateRequest(rawRequest);
      if (!request) return createSettingsMutationFailure('secure_setup_required');

      const vision = request.providerVision ?? loadProviderVision();
      const maxContext = request.providerMaxContextTokens ?? loadProviderMaxContextTokens();
      const ok = saveSettings(request.theme, vision, maxContext);
      if (!ok) return createSettingsMutationFailure('settings_update_unavailable');
      currentTheme = request.theme;
      if (currentConfig) currentConfig.maxContextTokens = maxContext > 0 ? maxContext : undefined;
      return decodeSettingsMutationResult({ success: true, code: 'settings_saved' });
    } catch {
      return createSettingsMutationFailure();
    }
  });

  // ── Secure named provider profiles ────────────────────────
  // API keys are encrypted in the main-process-only profile store. Every
  // response is projected through a strict public DTO; neither plaintext nor
  // ciphertext can reach the renderer.
  ipcMain.handle('providerProfiles:list', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileListRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: (request) => ({ request, result: providerProfileStore?.list() ?? { ok: false as const, code: 'runtime_unavailable' as const } }),
    present: ({ request, result }) => {
      if (!result.ok) return providerProfileListFailure(request.operationId, result);
      return {
        ok: true as const,
        contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
        operationId: request.operationId,
        revision: result.value.revision,
        profiles: result.value.profiles,
      };
    },
    recover: () => createProviderProfileListRecovery(),
  }));

  ipcMain.handle('providerProfiles:save', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileSaveRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore || !store) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const before = providerProfileStore.list();
      if (!before.ok) return { request, result: before };
      const previousProfile = request.id ? before.value.profiles.find((profile) => profile.id === request.id) : undefined;
      const previousConfig = previousProfile ? providerProfileStore.configFor(previousProfile.id) : undefined;
      if (previousConfig && !previousConfig.ok) return { request, result: previousConfig };
      const candidateConfig = providerProfileStore.configForSave(request);
      if (!candidateConfig.ok) return { request, result: candidateConfig };

      let candidate: PreparedSetupRuntime;
      try {
        candidate = prepareProviderRuntime(providerProfileRuntimeContext(candidateConfig.value, 'save'));
      } catch {
        return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
      }

      const saved = await providerProfileStore.save(request);
      if (!saved.ok) {
        await candidate.discard();
        return { request, result: saved };
      }
      if (!saved.value.profile.isActive) {
        await candidate.discard();
        return { request, result: saved };
      }
      try {
        await candidate.commitAndAbortPrevious();
        return { request, result: saved };
      } catch {
        await candidate.discard();
        // The profile record is rolled back only if no concurrent revision
        // superseded it. Runtime and disk therefore remain one transaction.
        const rolledBack = await providerProfileStore.restoreAfterFailedSave({
          id: previousProfile?.id ?? null,
          name: previousProfile?.name ?? '',
          config: previousConfig?.ok ? previousConfig.value : null,
          activeId: before.value.profiles.find((profile) => profile.isActive)?.id ?? null,
        }, saved.value.revision);
        return {
          request,
          result: rolledBack.ok
            ? { ok: false as const, code: 'runtime_rebuild_failed' as const }
            : { ok: false as const, code: 'io_error' as const },
        };
      }
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'saved', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  ipcMain.handle('providerProfiles:switch', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileSwitchRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore || !store) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const config = providerProfileStore.configFor(request.id);
      if (!config.ok) return { request, result: config };
      try {
        const candidate = prepareProviderRuntime(providerProfileRuntimeContext(config.value, 'restore'));
        const persisted = await providerProfileStore.activate(request);
        if (!persisted.ok) {
          await candidate.discard();
          return { request, result: persisted };
        }
        await candidate.commitAndAbortPrevious();
        return { request, result: persisted };
      } catch {
        return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
      }
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'switched', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  ipcMain.handle('providerProfiles:delete', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileDeleteRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const listed = providerProfileStore.list();
      const targetWasActive = listed.ok && listed.value.profiles.some((profile) => profile.id === request.id && profile.isActive);
      const result = await providerProfileStore.delete(request);
      if (result.ok && targetWasActive && result.value.activeId) {
        const replacement = providerProfileStore.configFor(result.value.activeId);
        if (!replacement.ok) return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
        try {
          const candidate = prepareProviderRuntime(providerProfileRuntimeContext(replacement.value, 'restore'));
          await candidate.commitAndAbortPrevious();
        } catch {
          return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
        }
      }
      return { request, result };
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'deleted', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  ipcMain.handle('providerProfiles:reset', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileResetRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const result = await providerProfileStore.reset(request.expectedRevision);
      if (result.ok) deactivateProviderRuntime('provider_profiles_reset');
      return { request, result };
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'reset', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  // ── Agent Chat (streaming mode) ─────────────────────────
  ipcMain.handle('agent:chat', async (
    event,
    rawSessionId: unknown,
    rawMessages: unknown,
    rawSkillId?: unknown,
    rawOptions?: unknown,
  ) => {
    const requestId = `chat_${++requestCounter}`;
    try {
      requireRendererMainFrame(event);
    } catch {
      return createChatTurnErrorResponse(requestId, 'error', 'unauthorized_renderer');
    }
    if (!agentLoop || !provider || !store) {
      console.error('[Main] agent chat is unavailable');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_not_initialized');
    }
    const requestRuntimeGeneration = runtimeGeneration;
    const requestAgentLoop = agentLoop;
    const requestProvider = provider;
    const requestConfig = currentConfig ? { ...currentConfig } : null;

    const request = AgentChatRequestSchema.safeParse({
      version: CHAT_RUNTIME_CONTRACT_VERSION,
      turnId: requestId,
      sessionId: rawSessionId,
      messages: rawMessages,
      skillId: rawSkillId,
      scenarioId: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { scenarioId?: unknown }).scenarioId
        : undefined,
      projectId: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { projectId?: unknown }).projectId
        : undefined,
      mode: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { mode?: unknown }).mode
        : undefined,
    });
    if (!request.success) {
      return createChatTurnErrorResponse(requestId, 'error', 'invalid_chat_request');
    }
    const { sessionId, messages, skillId, scenarioId, projectId, mode } = request.data;

    // Resolve skill prompt if skillId provided
    let skillPrompt: string | undefined;

    // 研究阶段上下文（T5/T27）：AI 感知项目当前阶段与上次进展，回答贴合阶段。
    try {
      if (projectId && researchRepository) {
        const project = researchRepository.getProject(projectId, false);
        const stage = (project?.metadata as { stage?: string } | undefined)?.stage;
        const brief = new ResearchJournalService(researchRepository, goalEngine, store).buildResumeBrief(projectId);
        const stageBlock: string[] = [];
        if (stage) stageBlock.push(`[研究阶段] ${stage}（选题topic/文献literature/设计design/数据data/分析analysis/写作writing/投稿submission/修订revision；请按该阶段调整协助方式）`);
        if (brief && brief.lastActivityAt) stageBlock.push(`[上次进展] ${brief.summaryText}`);
        if (stageBlock.length > 0) {
          skillPrompt = [stageBlock.join('\n'), skillPrompt].filter(Boolean).join('\n\n');
        }
      }
    } catch { /* 阶段上下文必须不破坏对话 */ }

    if (skillId && skillRegistry) {
      const skill = skillRegistry.get(skillId);
      if (skill) {
        skillPrompt = skill.systemPrompt;
      }
    }

    let allowedTools: string[] | undefined;
    let maxTurns: number | undefined;
    let taskContractHash: string | undefined;
    let promptStackHash: string | undefined;
    let fullAccess: import('../engine/runtime/PersonalizationRuntimeContract.js').FullAccessPolicy | undefined;
    let resolvedManifest: import('../engine/runtime/PersonalizationRuntimeContract.js').ResolvedRunManifest | undefined;
    let resolvedSystemPrompt: string | undefined;
    if (personalizationRuntime && scenarioId) {
      const effectiveProjectId = projectId ?? 'global';
      let projectRulesId: string | undefined;
      let projectRule: import('../engine/runtime/PersonalizationRuntimeContract.js').MetisRulesDefinition | undefined;
      if (effectiveProjectId !== 'global') {
        const workspaceManager = ensureWorkspaceManager(effectiveProjectId);
        if (!workspaceManager) {
          return createChatTurnErrorResponse(requestId, 'error', 'personalization_resolution_failed');
        }
        const projection = projectMetisRulesFromWorkspace(
          { ...workspaceManager.read(), projectId: effectiveProjectId },
          effectiveProjectId,
        );
        if (!projection.ok) {
          return createChatTurnErrorResponse(requestId, 'error', 'personalization_resolution_failed');
        }
        projectRulesId = projection.projectRulesId;
        projectRule = projection.definition;
      }
      const resolved = personalizationRuntime.resolveForAgent({
        contractVersion: 1,
        sessionId: sessionId.replace(/:/gu, '-'),
        projectId: effectiveProjectId,
        scenarioId,
        projectRulesId,
      }, projectRule);
      if (!resolved?.ok) {
        return createChatTurnErrorResponse(requestId, 'error', 'personalization_resolution_failed');
      }
      skillPrompt = [resolved.systemPrompt, skillPrompt].filter(Boolean).join('\n\n');
      allowedTools = resolved.manifest.allowedTools;
      maxTurns = resolved.manifest.maxTurns;
      taskContractHash = resolved.manifest.manifestDigest;
      promptStackHash = resolved.manifest.manifestDigest;
      fullAccess = resolved.manifest.fullAccess;
      resolvedManifest = resolved.manifest;
      resolvedSystemPrompt = resolved.systemPrompt;
    } else if (scenarioId) {
      return createChatTurnErrorResponse(requestId, 'error', 'personalization_unavailable');
    }

    const fundingToolScope = {
      ownerId: FUNDING_LOCAL_OWNER_ID,
      projectId: projectId ?? 'global',
      ownerWebContentsId: event.sender.id,
    };
    const scopeInstruction = allowedTools?.some((tool) => tool.startsWith('funding_template_'))
      ? [
          'Funding-template tools are read-only and bound by Electron main to this run scope.',
          `Use ownerId=${fundingToolScope.ownerId} and projectId=${fundingToolScope.projectId} exactly; never infer or replace them.`,
        ].join('\n')
      : undefined;
    const scenarioCompilation = compileScenarioExecutionManifest(resolvedManifest, {
      executionInstructions: scopeInstruction ? [scopeInstruction] : [],
    });
    if (!scenarioCompilation.ok) {
      return createChatTurnErrorResponse(requestId, 'error', scenarioCompilation.code);
    }
    resolvedManifest = scenarioCompilation.manifest;
    if (resolvedManifest) {
      taskContractHash = resolvedManifest.manifestDigest;
      promptStackHash = resolvedManifest.manifestDigest;
    }
    if (scenarioCompilation.useCoordinator
      && (!resolvedManifest || !resolvedSystemPrompt || !personalizationRepository)) {
      return createChatTurnErrorResponse(requestId, 'error', 'scenario_workflow_unavailable');
    }

    if (activeChatRuns.has(sessionId) || hasCompareRunForSession(sessionId)) {
      return createChatTurnErrorResponse(requestId, 'error', 'agent_run_active');
    }
    const activeRun: ActiveChatRun = {
      ownerWebContentsId: event.sender.id,
      controller: new AbortController(),
      nextSequence: 0,
    };
    liveSteeringQueue.clear(sessionId);
    activeChatRuns.set(sessionId, activeRun);
    activeFundingToolScopes.set(sessionId, fundingToolScope);
    if (scopeInstruction) {
      skillPrompt = [skillPrompt, scopeInstruction].filter(Boolean).join('\n\n');
      resolvedSystemPrompt = [resolvedSystemPrompt, scopeInstruction].filter(Boolean).join('\n\n');
    }

    // Inject the project memory context (key decisions, project memory, user
    // preferences) so the agent carries cross-session continuity. Previously
    // MemoryManager.recordKeyDecision was wired but buildMemoryContext was not
    // consumed by any prompt — decisions were recorded but never fed back.
    try {
      // METIS-F12: scope the injected memory to the active project when known.
      const memoryContext = memoryManager?.buildMemoryContext(projectId);
      if (memoryContext && memoryContext.trim()) {
        skillPrompt = [skillPrompt, memoryContext].filter(Boolean).join('\n\n');
        resolvedSystemPrompt = [resolvedSystemPrompt, memoryContext].filter(Boolean).join('\n\n');
      }
      // Autonomous learning (B + C): behavior preferences learned from user
      // feedback and tool reliability stats derived from history.
      const learningContext = learningEngine?.buildLearningContext(projectId);
      if (learningContext && learningContext.trim()) {
        skillPrompt = [skillPrompt, learningContext].filter(Boolean).join('\n\n');
        resolvedSystemPrompt = [resolvedSystemPrompt, learningContext].filter(Boolean).join('\n\n');
      }
    } catch {
      // Memory injection must never break a chat turn.
    }

    let mcpToolRun: import('./PersonalizationMcpToolBridge.js').PersonalizationMcpToolRun | undefined;
    try {
      let runAgentLoop = requestAgentLoop;
      const availableTools = new Set(builtinToolNames());
      if (resolvedManifest?.mcpIds.length) {
        if (!personalizationMcpBridge) {
          return createChatTurnErrorResponse(requestId, 'error', 'personalization_mcp_unavailable');
        }
        const prepared = await personalizationMcpBridge.prepare({
          manifest: resolvedManifest,
          owner: managedMcpOwnerFor(event),
          sessionId: resolvedManifest.sessionId,
          projectId: resolvedManifest.projectId,
          reservedToolNames: [...availableTools],
          signal: activeRun.controller.signal,
        });
        if (!prepared.ok) {
          return createChatTurnErrorResponse(requestId, 'error', `personalization_mcp_${prepared.code}`);
        }
        mcpToolRun = prepared.run;
        for (const name of mcpToolRun.toolNames) availableTools.add(name);
        runAgentLoop = createAgentLoop(
          requestProvider,
          new ToolRegistry(),
          approvalStore ?? undefined,
          mcpToolRun.registrations,
        ).agentLoop;
      }
      if (resolvedManifest?.allowedTools.some((tool) => !availableTools.has(tool))) {
        return createChatTurnErrorResponse(requestId, 'error', 'personalization_tool_unavailable');
      }
      const preferredAgentLoops = new Map<string, AgentLoop>();
      const agentLoopForModel = (modelPreference: string): AgentLoop => {
        const model = modelPreference.trim();
        if (!model || model === requestProvider.model || !requestConfig) return runAgentLoop;
        const existing = preferredAgentLoops.get(model);
        if (existing) return existing;
        const preferredProvider = createProvider({ ...requestConfig, model });
        const preferredLoop = createAgentLoop(
          preferredProvider,
          new ToolRegistry(),
          approvalStore ?? undefined,
          mcpToolRun?.registrations ?? [],
        ).agentLoop;
        preferredAgentLoops.set(model, preferredLoop);
        return preferredLoop;
      };
      // Stream the model's tokens (and reasoning, when the model emits it) to
      // the requesting renderer. Registered on the loop that actually runs so
      // MCP-expanded loops stream too; unregistered when the turn settles.
      const forwardModelStream = (
        ctx: import('../engine/core/HookBus.js').HookContext,
      ): import('../engine/core/HookBus.js').HookContext => {
        const payload = ctx as unknown as {
          sessionId?: unknown; content?: unknown; reasoning?: unknown; isFinished?: unknown;
        };
        try {
          if (event.sender.isDestroyed()) return ctx;
          event.sender.send('chat:stream-chunk', {
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : sessionId,
            content: typeof payload.content === 'string' ? payload.content : '',
            reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
            isFinished: payload.isFinished === true,
          });
        } catch { /* stream forwarding must never break the turn */ }
        return ctx;
      };
      runAgentLoop.registerHook('model.stream_chunk', forwardModelStream, { name: 'chat-stream-forward' });
      try {
        const response = scenarioCompilation.useCoordinator && resolvedManifest && resolvedSystemPrompt && personalizationRepository
          ? await runPersistedScenarioWorkflow({
              agentLoop: runAgentLoop,
              agentLoopForModel,
              store,
              repository: personalizationRepository,
              sessionId,
              messages,
              requestId,
              manifest: resolvedManifest,
              mode,
              signal: activeRun.controller.signal,
              liveSteering: liveSteeringQueue,
              projectId: resolvedManifest.projectId ?? projectId,
              isCurrentRuntime: () => runtimeGeneration === requestRuntimeGeneration,
            })
          : await runPersistedChatTurn({
              agentLoop: runAgentLoop,
              store,
              sessionId,
              messages,
              requestId,
              skillPrompt,
              allowedTools,
              maxTurns,
              taskContractHash,
              promptStackHash,
              fullAccess,
              signal: activeRun.controller.signal,
              liveSteering: liveSteeringQueue,
              options: { mode },
              projectId,
              isCurrentRuntime: () => runtimeGeneration === requestRuntimeGeneration,
            });

        return response;
      } finally {
        runAgentLoop.unregisterHook('model.stream_chunk', 'chat-stream-forward');
      }
    } catch {
      console.error('[Main] agent chat failed');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_chat_failed');
    } finally {
      await mcpToolRun?.close();
      // Autonomous learning after each turn (never blocks the response):
      // A — extract durable knowledge into memory; B — persist feedback
      // signals as behavior preferences; C — flush tool reliability stats.
      if (learningEngine) {
        void (async () => {
          try {
            await learningEngine.ingestConversation(messages, projectId);
            learningEngine.applyFeedbackSignals(messages, projectId);
            learningEngine.persistToolStats();
          } catch { /* learning must never break a chat turn */ }
        })();
      }
      if (activeChatRuns.get(sessionId) === activeRun) {
        activeChatRuns.delete(sessionId);
        liveSteeringQueue.clear(sessionId);
      }
      activeFundingToolScopes.delete(sessionId);
    }
  });

  // ── O15: 多模型同会话对比（指定 profile 的临时回合） ─────────
  // 渲染端在「多模型对比」模式下对选中的每个 profile 并行调用一次本处理器；
  // 这里用 ProviderProfileStore.configFor(profileId) 解密出完整配置，构建
  // 临时 provider + AgentLoop 跑一轮。与 agent:chat 的差异：
  //   - 不在主进程落库（对比的 N 个并行调用若各自落库会把用户消息写 N 遍，
  //     持久化由渲染端统一做一次）；
  //   - 不参与 scenario / 个性化清单 / MCP 工具扩展（对比的目标是同一提示下
  //     不同模型的原始回答，变量越少越公平）；
  //   - 流式分片额外带 profileId，渲染端按模型路由到各自的气泡。
  ipcMain.handle('agent:chatWithProfile', async (
    event,
    rawProfileId: unknown,
    rawSessionId: unknown,
    rawMessages: unknown,
    rawSkillId?: unknown,
    rawOptions?: unknown,
  ) => {
    const requestId = `chatcmp_${++requestCounter}`;
    try {
      requireRendererMainFrame(event);
    } catch {
      return createChatTurnErrorResponse(requestId, 'error', 'unauthorized_renderer');
    }
    if (!providerProfileStore || !store) {
      console.error('[Main] profile chat is unavailable');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_not_initialized');
    }
    const profileIdParsed = ProviderProfileIdSchema.safeParse(rawProfileId);
    if (!profileIdParsed.success) {
      return createChatTurnErrorResponse(requestId, 'error', 'invalid_chat_request');
    }
    const profileId = profileIdParsed.data;

    const request = AgentChatRequestSchema.safeParse({
      version: CHAT_RUNTIME_CONTRACT_VERSION,
      turnId: requestId,
      sessionId: rawSessionId,
      messages: rawMessages,
      skillId: rawSkillId,
      projectId: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { projectId?: unknown }).projectId
        : undefined,
      mode: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { mode?: unknown }).mode
        : undefined,
    });
    if (!request.success) {
      return createChatTurnErrorResponse(requestId, 'error', 'invalid_chat_request');
    }
    const { sessionId, messages, skillId, projectId } = request.data;

    // 与正常回合同会话互斥；同一 profile 的重复并发也要拦住。
    if (activeChatRuns.has(sessionId)) {
      return createChatTurnErrorResponse(requestId, 'error', 'agent_run_active');
    }
    const runKey = `${sessionId}::${profileId}`;
    if (activeCompareRuns.has(runKey)) {
      return createChatTurnErrorResponse(requestId, 'error', 'agent_run_active');
    }

    const configResult = providerProfileStore.configFor(profileId);
    if (!configResult.ok || !configResult.value.apiKey) {
      return createChatTurnErrorResponse(requestId, 'error', 'profile_unavailable');
    }
    const profileConfig = configResult.value;

    // 与正常聊天一致：指定了 skill 时注入其系统提示。
    let skillPrompt: string | undefined;
    if (skillId && skillRegistry) {
      const skill = skillRegistry.get(skillId);
      if (skill) {
        skillPrompt = skill.systemPrompt;
      }
    }

    const compareRun = { ownerWebContentsId: event.sender.id, controller: new AbortController() };
    activeCompareRuns.set(runKey, compareRun);
    try {
      const compareProvider = createProvider(profileConfig);
      const compareLoop = createAgentLoop(
        compareProvider,
        buildRuntimeRegistry(),
        approvalStore ?? undefined,
        [],
        profileConfig,
      ).agentLoop;
      // 流式转发：与正常回合同一个通道，但额外带 profileId 供渲染端按模型
      // 分气泡；转发失败绝不能打断回合。
      const forwardCompareStream = (
        ctx: import('../engine/core/HookBus.js').HookContext,
      ): import('../engine/core/HookBus.js').HookContext => {
        const payload = ctx as unknown as {
          sessionId?: unknown; content?: unknown; reasoning?: unknown; isFinished?: unknown;
        };
        try {
          if (event.sender.isDestroyed()) return ctx;
          event.sender.send('chat:stream-chunk', {
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : sessionId,
            content: typeof payload.content === 'string' ? payload.content : '',
            reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
            isFinished: payload.isFinished === true,
            profileId,
          });
        } catch { /* stream forwarding must never break the turn */ }
        return ctx;
      };
      compareLoop.registerHook('model.stream_chunk', forwardCompareStream, { name: 'chat-compare-stream-forward' });
      try {
        return await runEphemeralChatTurn({
          agentLoop: compareLoop,
          sessionId,
          messages,
          requestId,
          skillPrompt,
          signal: compareRun.controller.signal,
          projectId,
        });
      } finally {
        compareLoop.unregisterHook('model.stream_chunk', 'chat-compare-stream-forward');
      }
    } catch {
      console.error('[Main] profile chat failed');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_chat_failed');
    } finally {
      if (activeCompareRuns.get(runKey) === compareRun) {
        activeCompareRuns.delete(runKey);
      }
    }
  });

  ipcMain.handle('agent:control', (event, rawRequest: unknown) => {
    let operationId = 'control-recovery';
    try {
      requireRendererMainFrame(event);
      if (typeof rawRequest === 'object' && rawRequest !== null) {
        const candidate = (rawRequest as { operationId?: unknown }).operationId;
        if (typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(candidate)) {
          operationId = candidate;
        }
      }
      const request = AgentControlRequestSchema.safeParse(rawRequest);
      if (!request.success) {
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'invalid_request',
        }, operationId);
      }
      operationId = request.data.operationId;
      const run = activeChatRuns.get(request.data.sessionId);
      if (!run) {
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'no_active_run',
        }, operationId);
      }
      if (run.ownerWebContentsId !== event.sender.id) {
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'owner_mismatch',
        }, operationId);
      }
      const sequence = run.nextSequence + 1;
      try {
        liveSteeringQueue.enqueue(request.data.action === 'instruction'
          ? {
              type: 'instruction',
              id: `steer-${randomUUID()}`,
              sessionId: request.data.sessionId,
              sequence,
              createdAt: Date.now(),
              content: request.data.content,
            }
          : {
              type: 'interrupt',
              id: `interrupt-${randomUUID()}`,
              sessionId: request.data.sessionId,
              sequence,
              createdAt: Date.now(),
              reason: request.data.reason,
            });
      } catch {
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'queue_unavailable',
        }, operationId);
      }
      run.nextSequence = sequence;
      if (request.data.action === 'instruction') {
        try {
          store?.appendMessage(request.data.sessionId, 'user', request.data.content);
        } catch (error) {
          console.error('[Main] live steering persistence failed', error);
        }
      } else {
        run.controller.abort();
      }
      return decodeAgentControlResponse({
        ok: true,
        contractVersion: LIVE_STEERING_CONTRACT_VERSION,
        operationId,
        action: request.data.action,
        sequence,
      }, operationId);
    } catch {
      return decodeAgentControlResponse({
        ok: false,
        contractVersion: LIVE_STEERING_CONTRACT_VERSION,
        operationId,
        code: 'queue_unavailable',
      }, operationId);
    }
  });

  // ── Acceptance ───────────────────────────────────────────
  ipcMain.handle('acceptance:environment', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== mainWindow || window.isDestroyed()) {
      throw new Error('Layout acceptance environment request did not originate from the main window');
    }
    if (!event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Layout acceptance environment request did not originate from the main frame');
    }
    if (
      layoutAcceptanceToken &&
      !isExpectedLayoutAcceptanceFrame(event.senderFrame.url, layoutAcceptanceEntryPath)
    ) {
      throw new Error('Layout acceptance environment request did not originate from the current dist entry');
    }
    return getLayoutAcceptanceMetadata();
  });

  if (layoutAcceptanceToken) {
    layoutAcceptanceWindowControlEnabled = true;
    ipcMain.handle('acceptance:window:setSize', async (event, rawRequest: unknown) => {
      const window = requireLayoutAcceptanceMainFrame(event);
      const request = parseLayoutAcceptanceWindowRequest(rawRequest);

      if (window.isMaximized() || window.isFullScreen()) {
        window.restore();
      }
      if (request.mode === 'content') {
        await setAcceptanceContentSize(
          window,
          request.width,
          request.height,
        );
      } else {
        await waitForNativeWindowResize(window, () => {
          window.setSize(request.width, request.height, false);
        });
      }

      const outerBounds = window.getBounds();
      const contentBounds = window.getContentBounds();
      const display = screen.getDisplayMatching(outerBounds);
      return {
        mode: request.mode,
        requested: {
          width: request.width,
          height: request.height,
        },
        outerBounds,
        contentBounds,
        zoomFactor: window.webContents.getZoomFactor(),
        display: {
          id: String(display.id),
          scaleFactor: display.scaleFactor,
          bounds: display.bounds,
          workArea: display.workArea,
        },
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen(),
      };
    });
    ipcMain.handle('acceptance:window:release', (event) => {
      requireLayoutAcceptanceMainFrame(event);
      layoutAcceptanceWindowControlEnabled = false;
      ipcMain.removeHandler('acceptance:window:setSize');
      ipcMain.removeHandler('acceptance:window:release');
      return { released: true };
    });
  }

  // ── Agent Status ────────────────────────────────────────
  ipcMain.handle('agent:status', () => {
    if (!provider) {
      return { provider: 'not_configured' };
    }
    const caps = provider.capabilities();
    return {
      provider: 'ready',
      model: caps.model,
      streaming: caps.streaming,
      nativeToolCalling: caps.nativeToolCalling,
      maxContextTokens: caps.maxContextTokens,
      maxOutputTokens: caps.maxOutputTokens,
      agentLoopReady: agentLoop !== null,
    };
  });

  // ── Papers ──────────────────────────────────────────────
  ipcMain.handle('paper:list', (event) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      return decodeLibraryPaperList((store?.getPapers() ?? []).map((paper) => presentPaper(paper, owner)));
    } catch {
      return [];
    }
  });
  ipcMain.handle('paper:attachPdf', async (event, rawRequest: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const request = decodePaperIdRequest(rawRequest);
      if (!request.ok || !store) return createPaperAttachmentFailure();
      const paper = store.getPapers().find((item) => item.id === request.value.paperId);
      if (!paper) return createPaperAttachmentFailure();
      const selected = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      const filePath = selected.canceled ? undefined : selected.filePaths[0];
      if (!filePath || !(await isPdfFile(filePath))) return createPaperAttachmentFailure();
      store.savePaper({ ...paper, pdfPath: filePath, pdfText: '' });
      const issued = fileCapabilities.issue({
        path: filePath,
        kind: 'file',
        mime: 'application/pdf',
        operations: ['file', 'read', 'extract'],
      }, owner);
      return issued.success
        ? decodePaperAttachmentResult({ success: true, pdfCapability: issued.capability })
        : createPaperAttachmentFailure();
    } catch {
      return createPaperAttachmentFailure();
    }
  });
  ipcMain.handle('paper:detachPdf', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodePaperIdRequest(rawRequest);
      if (!request.ok || !store) return createPaperMutationFailure();
      const paper = store.getPapers().find((item) => item.id === request.value.paperId);
      if (!paper) return createPaperMutationFailure();
      store.savePaper({ ...paper, pdfPath: undefined, pdfText: '' });
      return decodePaperMutationResult({ success: true, code: 'detached' });
    } catch {
      return createPaperMutationFailure();
    }
  });
  ipcMain.handle('paper:save', (event, rawPaper: unknown) => {
    try {
      requireRendererMainFrame(event);
      const paper = decodeLibraryPaperSaveRequest(rawPaper);
      if (!store || !paper) return createLibraryMutationFailure();
      const existing = store.getPapers().find((item) => item.id === paper.id);
      store.savePaper({
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue,
        abstract: paper.abstract,
        ...(paper.doi === undefined ? {} : { doi: paper.doi }),
        ...(paper.arxivId === undefined ? {} : { arxivId: paper.arxivId }),
        ...(existing?.pdfPath === undefined ? {} : { pdfPath: existing.pdfPath }),
        ...(paper.pdfUrl === undefined ? {} : { pdfUrl: paper.pdfUrl }),
        ...(paper.pdfText === undefined ? {} : { pdfText: paper.pdfText }),
        ...(paper.citationCount === undefined ? {} : { citationCount: paper.citationCount }),
        tags: paper.tags,
        notes: paper.notes,
        readStatus: paper.readStatus,
        rating: paper.rating,
        ...(existing?.projectId === undefined ? {} : { projectId: existing.projectId }),
        addedAt: paper.addedAt,
      });
      return decodeLibraryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('paper:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeLibraryDeleteRequest({ id: rawId });
      if (!request || !store) return createLibraryMutationFailure();
      store.deletePaper(request.id);
      return decodeLibraryMutationResult({ success: true, code: 'deleted' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('paper:linkToProject', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { paperId?: unknown; projectId?: unknown; link?: unknown };
      const paperId = typeof request?.paperId === 'string' ? request.paperId : '';
      if (!paperId || !store) return { ok: false, error: 'invalid_request' };
      const paper = store.getPapers().find((item) => item.id === paperId);
      if (!paper) return { ok: false, error: 'not_found' };
      const projectId = typeof request?.projectId === 'string' ? request.projectId : '';
      if (!projectId) return { ok: false, error: 'invalid_request' };
      const link = request?.link !== false;
      if (!link) {
        if (!researchRepository) return { ok: false, error: 'repository_unavailable' };
        const removed = researchRepository.unlinkLibraryPaperFromProject(paperId, projectId);
        return removed ? { ok: true } : { ok: false, error: 'not_linked' };
      }
      const linked = linkPaperToProjectSource({
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue,
        doi: paper.doi,
        arxivId: paper.arxivId,
      }, projectId);
      return linked ? { ok: true } : { ok: false, error: 'project_not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('paper:downloadPdf', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const request = decodePaperIdRequest(rawRequest);
      if (!request.ok || !store) return createPaperDownloadFailure();
      const paper = store.getPapers().find((item) => item.id === request.value.paperId);
      if (!paper) return createPaperDownloadFailure();
      const title = paper.title
        // eslint-disable-next-line no-control-regex -- filesystem display names must reject control characters
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 180) || 'paper';

      // O3: multi-source PDF fallback. Collect ordered candidates
      // (Unpaywall → arXiv → existing pdfUrl) and try each until one succeeds.
      const candidates = await collectPdfCandidates({
        doi: paper.doi || undefined,
        arxivId: paper.arxivId || undefined,
        pdfUrl: paper.pdfUrl || undefined,
      });
      if (candidates.length === 0) return createPaperDownloadFailure();

      let downloaded: { ok: true; resolvedPath: string; publicResult: { displayName: string; byteLength: number; sha256: string } } | { ok: false } = { ok: false };
      // O3: transparent per-source attempt log (JabRef Event Log style).
      const attemptLog: Array<{ url: string; ok: boolean }> = [];
      for (const candidateUrl of candidates) {
        const attempt = await secureDownloads.download({
          mode: 'clean-url' as const,
          url: candidateUrl,
          resource: 'pdf',
          maxBytes: 128 * 1024 * 1024,
          timeoutMs: 60_000,
          maxRedirects: 4,
        }, {
          directory: PAPERS_DIR,
          displayName: `${title}.pdf`,
        });
        attemptLog.push({ url: candidateUrl, ok: attempt.ok });
        if (attempt.ok) {
          downloaded = attempt;
          break;
        }
      }
      if (!downloaded.ok) {
        // Surface which sources were tried so the user can diagnose (e.g. an
        // anti-leech rejection on one origin but not another).
        console.warn(`[paper:downloadPdf] all ${attemptLog.length} source(s) failed for ${paper.id}:`,
          attemptLog.map((a) => `${a.url} → ${a.ok ? 'ok' : 'failed'}`).join('; '));
        return createPaperDownloadFailure();
      }
      store.savePaper({ ...paper, pdfPath: downloaded.resolvedPath, pdfText: '' });
      const issued = fileCapabilities.issue({
        path: downloaded.resolvedPath,
        kind: 'file',
        mime: 'application/pdf',
        displayName: downloaded.publicResult.displayName,
        operations: ['file', 'read', 'extract'],
      }, owner);
      if (!issued.success) return createPaperDownloadFailure();
      return decodePaperDownloadResult({
        success: true,
        code: 'paper_download_complete',
        pdfCapability: issued.capability,
        displayName: downloaded.publicResult.displayName,
        byteLength: downloaded.publicResult.byteLength,
        sha256: downloaded.publicResult.sha256,
      });
    } catch {
      return createPaperDownloadFailure();
    }
  });

  // O4: re-match a collected paper's metadata from a user-supplied DOI or title.
  // Used by the "补全元数据" affordance when collection yielded no DOI/PDF.
  ipcMain.handle('paper:reconcile', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { paperId?: string; doi?: string; title?: string };
      if (!request || typeof request !== 'object' || !request.paperId || !store) {
        return { ok: false, error: 'invalid_request' };
      }
      const paper = store.getPapers().find((item) => item.id === request.paperId);
      if (!paper) return { ok: false, error: 'paper_not_found' };

      const doiInput = (request.doi ?? '').trim().replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:\s*/i, '');
      const titleInput = (request.title ?? '').trim();

      let resolvedDoi: string | undefined;
      if (doiInput && /^10\./.test(doiInput)) {
        resolvedDoi = doiInput;
      } else if (titleInput.length >= 5) {
        // Search CrossRef by title and accept a high-overlap match.
        const { works } = await searchWorks({ query: titleInput, limit: 3 });
        const target = new Set(titleInput.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
        for (const w of works) {
          const cand = new Set(w.title.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
          let overlap = 0;
          for (const tok of target) if (cand.has(tok)) overlap++;
          if (overlap / Math.max(1, Math.min(target.size, cand.size)) >= 0.6 && w.doi) {
            resolvedDoi = w.doi;
            break;
          }
        }
      }
      if (!resolvedDoi) return { ok: false, error: 'no_match' };

      const meta = await resolveDoi(resolvedDoi);
      const merged = {
        ...paper,
        doi: resolvedDoi,
        title: meta?.title?.trim() || paper.title,
        authors: meta?.authors?.length ? meta.authors : paper.authors,
        year: meta?.year ?? paper.year,
        venue: meta?.venue ?? paper.venue,
        abstract: meta?.abstract ?? paper.abstract,
      };
      store.savePaper(merged);
      return {
        ok: true,
        paper: {
          title: merged.title,
          authors: merged.authors,
          year: merged.year,
          venue: merged.venue,
          doi: merged.doi,
          abstract: merged.abstract,
        },
      };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  });

  // ── Collections ─────────────────────────────────────────
  ipcMain.handle('collection:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return decodeLibraryCollectionList(store?.getCollections() ?? []);
    } catch {
      return [];
    }
  });
  ipcMain.handle('collection:save', (event, rawCollection: unknown) => {
    try {
      requireRendererMainFrame(event);
      const collection = decodeLibraryCollection(rawCollection);
      if (!collection || !store) return createLibraryMutationFailure();
      store.saveCollection(collection);
      return decodeLibraryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('collection:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeLibraryDeleteRequest({ id: rawId });
      if (!request || !store) return createLibraryMutationFailure();
      store.deleteCollection(request.id);
      return decodeLibraryMutationResult({ success: true, code: 'deleted' });
    } catch {
      return createLibraryMutationFailure();
    }
  });

  // ── Notes ───────────────────────────────────────────────
  ipcMain.handle('note:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return decodeLibraryNoteList(store?.getNotes() ?? []);
    } catch {
      return [];
    }
  });
  ipcMain.handle('note:save', (event, rawNote: unknown) => {
    try {
      requireRendererMainFrame(event);
      const note = decodeLibraryNote(rawNote);
      if (!note || !store) return createLibraryMutationFailure();
      store.saveNote({
        id: note.id,
        scope: note.scope,
        projectId: note.projectId,
        title: note.title,
        content: note.content,
        tags: note.tags,
        linkedPaperIds: note.linkedPaperIds,
        linkedNoteIds: note.linkedNoteIds,
        updatedAt: note.updatedAt,
      });
      return decodeLibraryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('note:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeLibraryDeleteRequest({ id: rawId });
      if (!request || !store) return createLibraryMutationFailure();
      store.deleteNote(request.id);
      return decodeLibraryMutationResult({ success: true, code: 'deleted' });
    } catch {
      return createLibraryMutationFailure();
    }
  });

  // ── Experiments metadata CRUD (GLM-102: safe DTO, no path leak) ──
  ipcMain.handle('experiment:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return decodeExperimentListResult(undefined);
      return decodeExperimentListResult({
        success: true,
        experiments: decodeExperimentList(store.getExperimentMetadata()),
      });
    } catch {
      return decodeExperimentListResult(undefined);
    }
  });
  ipcMain.handle('experiment:save', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = decodeExperimentSave(raw);
      if (!req) return decodeExperimentMutationResult({
        success: false,
        code: 'experiment_metadata_invalid',
      });
      if (!store) return decodeExperimentMutationResult(undefined);
      store.saveExperimentMetadata(req);
      return decodeExperimentMutationResult({ success: true, code: 'saved' });
    } catch {
      return decodeExperimentMutationResult(undefined);
    }
  });
  ipcMain.handle('experiment:delete', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = decodeExperimentDelete(raw);
      if (!id) return decodeExperimentMutationResult({
        success: false,
        code: 'experiment_metadata_invalid',
      });
      if (!store) return decodeExperimentMutationResult(undefined);
      store.deleteExperimentMetadata(id);
      return decodeExperimentMutationResult({ success: true, code: 'deleted' });
    } catch {
      return decodeExperimentMutationResult(undefined);
    }
  });

  // ── Experiments secure execution (GLM-102: service-backed IPC) ──
  ipcMain.handle('experiment:attachScript', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter) return { status: 'rejected', code: 'experiment_script_unavailable' };
      return experimentScriptAdapter.ipc.attachScript(owner, rawRequest);
    } catch {
      return { status: 'rejected', code: 'experiment_script_unavailable' };
    }
  });

  ipcMain.handle('experiment:requestRunGrant', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter) return { status: 'rejected', code: 'experiment_grant_unavailable' };
      return experimentScriptAdapter.ipc.requestRunGrant(owner, rawRequest);
    } catch {
      return { status: 'rejected', code: 'experiment_grant_unavailable' };
    }
  });

  ipcMain.handle('experiment:run', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter) return { status: 'rejected', exitCode: null, metrics: {} };
      const request = decodeExperimentRunRequest(rawRequest);
      if (!request) return { status: 'rejected', exitCode: null, metrics: {} };
      const result = decodeExperimentRunResult(
        await experimentScriptAdapter.ipc.run(owner, request),
      );
      if (store && !['rejected', 'runtime_unavailable'].includes(result.status)) {
        const status = result.status === 'completed'
          ? 'completed'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
        store.updateExperimentRunState(request.experimentId, status, result.metrics);
      }
      return result;
    } catch {
      return { status: 'rejected', exitCode: null, metrics: {} };
    }
  });

  ipcMain.handle('experiment:cancel', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter) return false;
      return experimentScriptAdapter.ipc.cancel(owner, rawRequest);
    } catch {
      return false;
    }
  });

  // ── Experiment run history + output ──────────────────────
  ipcMain.handle('experiment:listRuns', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { experimentId?: string; limit?: number };
      if (!experimentScriptAdapter) return { runs: [] };
      const runs = experimentScriptAdapter.repository.getRunsForExperiment(
        String(request?.experimentId ?? ''),
        typeof request?.limit === 'number' ? request.limit : 50,
      );
      return {
        runs: runs.map((r) => ({
          runId: r.runId, experimentId: r.experimentId, status: r.status,
          exitCode: r.exitCode, metrics: r.metrics, startedAt: r.startedAt,
          finishedAt: r.finishedAt, hasOutput: Boolean(r.stdoutLogPath),
        })),
      };
    } catch {
      return { runs: [] };
    }
  });

  ipcMain.handle('experiment:getRunOutput', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { experimentId?: string; runId?: string };
      if (!experimentScriptAdapter) return { output: '', truncated: false };
      const runs = experimentScriptAdapter.repository.getRunsForExperiment(String(request?.experimentId ?? ''), 200);
      const run = runs.find((r) => r.runId === request?.runId);
      if (!run?.stdoutLogPath) return { output: '', truncated: false };
      const MAX_BYTES = 16 * 1024;
      const stat = fs.statSync(run.stdoutLogPath);
      const start = Math.max(0, stat.size - MAX_BYTES);
      const fd = fs.openSync(run.stdoutLogPath, 'r');
      const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      text = text.replace(/[A-Z]:\\[^\s\n]+/gi, '[path]').replace(/\/home\/[^\s\n]+/g, '[path]');
      return { output: text, truncated: stat.size > MAX_BYTES };
    } catch {
      return { output: '', truncated: false };
    }
  });

  // ── Bulk Load ───────────────────────────────────────────
  // Papers ship without pdfText (the largest field) so startup hydration stays
  // fast even for large libraries; full details load on demand via
  // data:loadPaperDetail. All renderer consumers already treat pdfText as
  // optional (?? '' / conditional rendering).
  ipcMain.handle('data:loadAll', (event) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const data = store?.getAllData() ?? { papers: [], notes: [], experiments: [], collections: [] };
      return {
        papers: data.papers.map((paper) => {
          const { pdfText: _pdfText, ...summary } = paper;
          void _pdfText;
          return presentPaper(summary, owner);
        }),
        notes: data.notes,
        experiments: decodeExperimentList(store?.getExperimentMetadata() ?? []),
        collections: data.collections,
      };
    } catch {
      return { papers: [], notes: [], experiments: [], collections: [] };
    }
  });

  ipcMain.handle('data:loadPaperDetail', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { paperId?: string };
      const paper = request?.paperId ? store?.getPaper(request.paperId) : undefined;
      if (!paper) return { found: false };
      const owner = executionOwnerFor(event);
      return { found: true, paper: presentPaper(paper, owner) };
    } catch {
      return { found: false };
    }
  });

  // ── Full-text paper search ──────────────────────────────
  // The renderer only ever receives lightweight summaries (pdfText is stripped
  // from loadAll), so paper-body search runs here and the full text never
  // leaves the main process. Returns capped results with a match snippet.
  ipcMain.handle('papers:searchFullText', (event, rawQuery: unknown, rawLimit: unknown) => {
    try {
      requireRendererMainFrame(event);
      const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
      const limit = typeof rawLimit === 'number'
        ? Math.max(1, Math.min(50, Math.floor(rawLimit)))
        : 20;
      if (query.length < 2) return { results: [] };
      if (!store) return { results: [] };
      // Prefer FTS5 index when available (10-100x faster on large libraries);
      // fall back to SQL LIKE otherwise.
      let rows: Array<{ id: string; title: string; abstract: string | null; pdf_text: string | null }>;
      const ftsAvailable = store.raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'papers_fts'",
      ).get();
      if (ftsAvailable) {
        // Rebuild the index before searching (contentless FTS5 — no triggers).
        store.reindexPapersFts();
        // FTS5: wrap each term in quotes for exact phrase matching.
        const ftsQuery = query.split(/\s+/).filter(Boolean).map((term) => `"${term}"`).join(' ');
        rows = store.raw.prepare(`
          SELECT p.id, p.title, p.abstract, p.pdf_text FROM papers p
          JOIN papers_fts ON papers_fts.rowid = p.rowid
          WHERE papers_fts MATCH ?
          ORDER BY p.added_at DESC LIMIT ?
        `).all(ftsQuery, limit + 1) as typeof rows;
      } else {
        const pattern = `%${query}%`;
        rows = store.raw.prepare(`
          SELECT id, title, abstract, pdf_text FROM papers
          WHERE title LIKE ? OR abstract LIKE ? OR pdf_text LIKE ?
          ORDER BY added_at DESC LIMIT ?
        `).all(pattern, pattern, pattern, limit + 1) as typeof rows;
      }
      const results: Array<{ id: string; title: string; snippet: string }> = [];
      for (const row of rows) {
        if (results.length >= limit) break;
        const raw = [row.title, row.abstract ?? '', row.pdf_text ?? ''].join('\n');
        const index = raw.toLowerCase().indexOf(query);
        if (index === -1) continue;
        const start = Math.max(0, index - 60);
        const end = Math.min(raw.length, index + query.length + 80);
        let snippet = raw.slice(start, end).replace(/\s+/g, ' ').trim();
        if (start > 0) snippet = `…${snippet}`;
        if (end < raw.length) snippet = `${snippet}…`;
        results.push({ id: row.id, title: row.title, snippet });
      }
      return { results, hasMore: rows.length > limit };
    } catch {
      return { results: [] };
    }
  });

  // ── AI explanation of a selected PDF passage ─────────────
  // One-shot Q&A (no agent loop, no tools, no persistence): the PDF reader
  // asks the provider to explain / translate / summarize a selection, then
  // the user may save the result as an annotation via the normal evidence flow.
  ipcMain.handle('papers:aiExplain', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { passage?: unknown; paperTitle?: unknown; action?: unknown };
      const passage = typeof request?.passage === 'string' ? request.passage.trim() : '';
      const action = request?.action === 'translate' || request?.action === 'summarize'
        ? request.action
        : 'explain';
      const paperTitle = typeof request?.paperTitle === 'string' ? request.paperTitle : '';
      if (!passage || passage.length > 6000) return { ok: false, error: 'invalid_passage' };
      if (!provider) return { ok: false, error: 'provider_unavailable' };
      const systemPrompts: Record<string, string> = {
        explain: '你是一名科研阅读助手。用中文简明解释用户选中的论文片段：说明它的含义、要点和在研究中的作用。直接回答，不要重复原文。',
        translate: '你是一名学术翻译。把用户选中的论文片段完整准确地翻译成中文，保留专业术语。只输出译文。',
        summarize: '你是一名科研阅读助手。用中文概括用户选中的论文片段的核心内容（1-3 句）。只输出概括。',
      };
      const response = await provider.complete([
        { role: 'system', content: systemPrompts[action]! },
        { role: 'user', content: paperTitle ? `论文标题：${paperTitle}\n\n片段：\n${passage}` : passage },
      ], undefined, { temperature: 0.3 });
      return { ok: true, text: response.content };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? 'unknown' };
    }
  });

  // ── AI literature synthesis / comparison over multiple papers ──
  // Packs selected papers (title/authors/year/venue/abstract) into one prompt
  // and asks for a structured literature review or a comparison analysis.
  ipcMain.handle('papers:aiSynthesis', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as {
        mode?: unknown;
        papers?: unknown;
      };
      const mode = request?.mode === 'compare' || request?.mode === 'report' ? request.mode : 'synthesis';
      const papersInput = Array.isArray(request?.papers) ? request.papers : [];
      const papers = papersInput
        .slice(0, 10)
        .map((raw) => {
          const item = raw as Record<string, unknown>;
          return {
            title: typeof item.title === 'string' ? item.title : '',
            authors: Array.isArray(item.authors) ? item.authors.filter((a): a is string => typeof a === 'string').slice(0, 5) : [],
            year: typeof item.year === 'number' ? item.year : 0,
            venue: typeof item.venue === 'string' ? item.venue : '',
            abstract: typeof item.abstract === 'string' ? item.abstract.slice(0, 1500) : '',
          };
        })
        .filter((p) => p.title);
      if (papers.length < 2) return { ok: false, error: 'need_at_least_two_papers' };
      if (!provider) return { ok: false, error: 'provider_unavailable' };
      const paperBlocks = papers.map((p, i) => [
        `[${i + 1}] ${p.title}`,
        `作者：${p.authors.join(', ') || '未知'}；年份：${p.year || '未知'}；来源：${p.venue || '未知'}`,
        p.abstract ? `摘要：${p.abstract}` : '',
      ].filter(Boolean).join('\n')).join('\n\n');
      const systemPrompt = mode === 'compare'
        ? '你是一名学术分析助手。对用户选中的多篇论文做结构化对比分析：研究问题、方法、数据、结论、创新点逐一对比，最后指出各自的优势与局限。用中文、Markdown 表格或小标题组织。'
        : mode === 'report'
          ? '你是一名科研阅读助手。用户本周读完了以下论文，请生成一份中文阅读报告：归纳本周阅读的主题脉络、各篇论文的核心贡献、以及建议的后续阅读方向。结构清晰，用 Markdown。'
          : '你是一名学术写作助手。基于用户选中的多篇论文，生成一段中文文献综述草稿：按主题聚类、梳理方法演进、指出共识与分歧、最后点出研究空白。引用格式用（作者, 年份）。直接输出综述正文。';
      const response = await provider.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `以下是选中的 ${papers.length} 篇论文：\n\n${paperBlocks}` },
      ], undefined, { temperature: 0.4 });
      return { ok: true, text: response.content };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? 'unknown' };
    }
  });

  // ── AI polish of a selected LaTeX passage ────────────────
  // One-shot polish/rewrite/expand for the LaTeX editor selection. Keeps
  // LaTeX commands intact and returns only the rewritten text.
  ipcMain.handle('latex:aiPolish', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { text?: unknown; action?: unknown };
      const text = typeof request?.text === 'string' ? request.text.trim() : '';
      const action = request?.action === 'rewrite' || request?.action === 'expand'
        ? request.action
        : 'polish';
      if (!text || text.length > 6000) return { ok: false, error: 'invalid_text' };
      if (!provider) return { ok: false, error: 'provider_unavailable' };
      const systemPrompts: Record<string, string> = {
        polish: '你是一名学术论文润色助手。润色用户给出的段落：改进语法、用词、流畅度与学术表达，保持原意与 LaTeX 命令（如 \\cite、\\ref、环境）不变。只输出润色后的文本。',
        rewrite: '你是一名学术写作助手。重写用户给出的段落，使其更简洁清晰，保持原意与 LaTeX 命令不变。只输出重写后的文本。',
        expand: '你是一名学术写作助手。扩写用户给出的段落，补充论据与细节，保持学术语气与 LaTeX 命令不变。只输出扩写后的文本。',
      };
      const response = await provider.complete([
        { role: 'system', content: systemPrompts[action]! },
        { role: 'user', content: text },
      ], undefined, { temperature: 0.3 });
      return { ok: true, text: response.content };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? 'unknown' };
    }
  });

  // ── AI Office document edit ──────────────────────────────
  // Translate a natural-language instruction into a JSON plan of OfficeCli
  // operations (add/set/remove). Distinct from aiSynthesis (which is for
  // paper literature reviews) so the prompts and contracts stay clean.
  ipcMain.handle('officecli:aiEdit', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { instruction?: unknown; docType?: unknown };
      const instruction = typeof request?.instruction === 'string' ? request.instruction.trim() : '';
      const docType = typeof request?.docType === 'string' ? request.docType : 'docx';
      if (!instruction || instruction.length > 2000) return { ok: false, plan: [], error: 'invalid_instruction' };
      if (!provider) return { ok: false, plan: [], error: 'provider_unavailable' };
      const kindLabel = docType === 'pptx' ? 'PowerPoint' : docType === 'xlsx' ? 'Excel' : 'Word';
      const systemPrompt = [
        `你操作 OfficeCli 编辑${kindLabel}文档。将用户的指令翻译为一组 JSON 操作。`,
        '每个操作是以下之一：',
        '{"op":"add","parent":"/body","type":"paragraph","props":{"text":"..."}}',
        '{"op":"add","parent":"/body","type":"table","props":{"rows":"2","cols":"2"}}',
        docType === 'pptx' ? '{"op":"add","parent":"/","type":"slide","props":{"layout":"Title and Content","title":"...","text":"..."}}' : '',
        '{"op":"set","path":"/body/p[1]","props":{"text":"...","bold":"true","size":"14","font.ea":"宋体","align":"center"}}',
        '可用属性：text, bold, italic, underline, strike, color(hex), size(pt), font.ea, font.latin, align(left/center/right/justify/distribute), lineSpacing, spaceBefore, spaceAfter, firstLineIndent, style(Heading1/2/3/Normal), listStyle(bullet/ordered)',
        'PPT 主题色：set /presentation props theme.color.accent1=#RRGGBB',
        'PPT 字体：set /presentation props theme.font.major.eastAsia=宋体',
        '只输出 JSON 数组，不要输出其他文字或解释。',
      ].filter(Boolean).join('\n');
      const response = await provider.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `用户指令：${instruction}` },
      ], undefined, { temperature: 0.3 });
      // Extract the JSON array from the response.
      const match = response.content.match(/\[[\s\S]*\]/);
      const plan = match ? JSON.parse(match[0]) : [];
      return { ok: true, plan };
    } catch (err) {
      return { ok: false, plan: [], error: (err as Error)?.message ?? 'unknown' };
    }
  });

  // ── Memory ──────────────────────────────────────────────
  ipcMain.handle('memory:getProject', (event) => {
    try {
      requireRendererMainFrame(event);
      return decodeProjectMemoryContent(memoryManager?.loadProjectMemory() ?? '');
    } catch {
      return '';
    }
  });
  ipcMain.handle('memory:setProject', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeProjectMemoryWriteRequest(rawRequest);
      if (!request || !memoryManager) return createProjectMemoryMutationFailure();
      memoryManager.saveProjectMemory(request.content);
      return decodeProjectMemoryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createProjectMemoryMutationFailure();
    }
  });

  // O12: white-box visibility into the AI's automatic memories (key_decision /
  // preference / fact). Lets the user see, audit, and delete what the engine
  // remembered — closing the black-box gap vs LobeChat's editable memory.
  ipcMain.handle('memory:listByCategory', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { category?: string; projectId?: string };
      const category = typeof request?.category === 'string' ? request.category : '';
      const projectId = typeof request?.projectId === 'string' ? request.projectId : undefined;
      if (!category || !memoryManager) return [];
      return memoryManager.getByCategory(category, projectId).map((entry) => ({
        key: entry.key,
        value: entry.value,
        category: entry.category,
        updatedAt: entry.updatedAt,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('memory:deleteByKey', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { key?: string; projectId?: string };
      const key = typeof request?.key === 'string' ? request.key : '';
      const projectId = typeof request?.projectId === 'string' ? request.projectId : undefined;
      if (!key || !memoryManager) return { ok: false, error: 'invalid_request' };
      memoryManager.delete(key, projectId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  });

  // ── Project Metis.md (CAS-protected; legacy AGENTS.md migration) ──
  // Manager registry keyed by strictly-validated projectId.
  // On startup: scan existing projects from DATA_DIR/projects/.
  const workspaceAgentsByProject = new Map<string, WorkspaceAgentsManager>();
  function ensureWorkspaceManager(projectId: string): WorkspaceAgentsManager | null {
    // Always re-validate against the repository on every call.
    // Projects can be deleted between get/set invocations — cached managers
    // for deleted or missing projects must be evicted immediately.
    if (!researchRepository) return null;
    const entity = researchRepository.getProject(projectId);
    if (!entity || entity.deletedAt) {
      workspaceAgentsByProject.delete(projectId);
      return null;
    }
    const existing = workspaceAgentsByProject.get(projectId);
    if (existing) return existing;
    const mgr = new WorkspaceAgentsManager(DATA_DIR, projectId);
    workspaceAgentsByProject.set(projectId, mgr);
    return mgr;
  }
  // Scan for existing projects at startup
  try {
    const projectsRoot = path.join(DATA_DIR, 'projects');
    if (fs.existsSync(projectsRoot)) {
      for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.name)) {
          ensureWorkspaceManager(entry.name);
        }
      }
    }
  } catch { /* non-critical — will discover projects on first access */ }

  ipcMain.handle('workspace:agents:get', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeWorkspaceAgentsGetRequest(rawRequest);
      if (!decoded) return { exists: false, content: '', version: 0, contentHash: '', projectId: '' };
      // Always re-validate through ensureWorkspaceManager — must not
      // bypass the repository check via a stale cache hit.
      const mgr = ensureWorkspaceManager(decoded.projectId);
      if (!mgr) return { exists: false, content: '', version: 0, contentHash: '', projectId: decoded.projectId };
      return { ...mgr.read(), projectId: decoded.projectId };
    } catch {
      return { exists: false, content: '', version: 0, contentHash: '', projectId: '' };
    }
  });
  ipcMain.handle('workspace:agents:set', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeWorkspaceAgentsWriteRequest(rawRequest);
      if (!decoded) return { success: false, code: 'content_invalid' };
      const mgr = ensureWorkspaceManager(decoded.projectId);
      if (!mgr) return { success: false, code: 'project_not_found' as const };
      return mgr.write(decoded.content, decoded.expectedVersion);
    } catch {
      return { success: false, code: 'io_error' };
    }
  });
  // ── Goal Engine ─────────────────────────────────────────
  ipcMain.handle('goal:create', (event, rawDescription: unknown, rawContext?: unknown, rawProjectId?: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalCreateResponse(null);
      const request = GoalCreateRequestSchema.parse({
        description: rawDescription,
        context: rawContext,
        projectId: typeof rawProjectId === 'string' ? rawProjectId : undefined,
      });
      const goal = goalEngine.createGoal(request.description, request.context, request.projectId);
      broadcastGoalChanged(event.sender, goal);
      return decodeGoalCreateResponse({
        success: true,
        goalId: goal.id,
        status: goal.status,
      });
    } catch {
      return decodeGoalCreateResponse(null);
    }
  });
  ipcMain.handle('goal:get', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalSummaryResponse(null);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const goal = goalEngine.getGoal(goalId);
      return goal
        ? decodeGoalSummaryResponse({ success: true, goal: presentGoalSummary(goal, goalCheckpointSummary(goal.id)) })
        : decodeGoalSummaryResponse(null);
    } catch {
      return decodeGoalSummaryResponse(null);
    }
  });
  // O17: 工作流可视化——返回 goal 的 WorkflowDefinition（契约化截断）与最新
  // run 的步骤状态，供渲染端 WorkflowGraph 只读渲染 DAG 节点图。
  ipcMain.handle('goal:getWorkflow', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return createGoalWorkflowRecovery();
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const view = goalEngine.getWorkflowView(goalId);
      if (!view) return createGoalWorkflowRecovery();
      return decodeGoalWorkflowResponse(presentGoalWorkflow(goalId, view));
    } catch {
      return createGoalWorkflowRecovery();
    }
  });
  ipcMain.handle('goal:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalListResponse(null);
      return decodeGoalListResponse({
        success: true,
        goals: goalEngine.listGoals().map((goal) => presentGoalSummary(goal, goalCheckpointSummary(goal.id))),
      });
    } catch {
      return decodeGoalListResponse(null);
    }
  });
  ipcMain.handle('goal:generatePlan', async (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalPlanResponse(null);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const result = await goalEngine.generatePlan(goalId);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return presentGoalPlan(goalId, result.workflow);
    } catch {
      return decodeGoalPlanResponse(null);
    }
  });
  ipcMain.handle('goal:refinePlan', async (event, rawGoalId: unknown, rawFeedback: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalPlanResponse(null);
      const request = GoalRefineRequestSchema.parse({
        goalId: rawGoalId,
        feedback: rawFeedback,
      });
      const result = await goalEngine.refinePlan(request.goalId, request.feedback);
      const goal = goalEngine.getGoal(request.goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return presentGoalPlan(request.goalId, result.workflow);
    } catch {
      return decodeGoalPlanResponse(null);
    }
  });
  ipcMain.handle('goal:updatePlan', async (event, rawGoalId: unknown, rawWorkflow: unknown) => {
    try {
      requireRendererMainFrame(event);
      const goalId = RuntimeIdSchema.parse(rawGoalId);
      // O17: the renderer builds a WorkflowDefinition-shaped object; decode it
      // leniently (structure is validated by GoalPlanner.validatePlan below).
      if (!goalEngine || typeof rawWorkflow !== 'object' || rawWorkflow === null) {
        return { valid: false, errors: ['goal_plan_update_unavailable'], warnings: [] };
      }
      const workflow = rawWorkflow as WorkflowDefinition;
      const result = goalEngine.updatePlan(goalId, workflow);
      if (result.valid) {
        const goal = goalEngine.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return { valid: result.valid, errors: result.errors, warnings: result.warnings };
    } catch {
      return { valid: false, errors: ['goal_plan_update_unavailable'], warnings: [] };
    }
  });
  ipcMain.handle('goal:execute', async (event, rawGoalId: unknown) => {
    let goalId: string;
    try {
      requireRendererMainFrame(event);
      goalId = RuntimeIdSchema.parse(rawGoalId);
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
    if (!goalEngine) return { success: false, code: 'goal_execution_unavailable' };
    let sequence = 0;
    const sendGoalEvent = (channel: string, payload: unknown) => {
      const decoded = decodeGoalLiveEvent(payload);
      if (decoded.ok) event.sender.send(channel, decoded.value);
    };
    const hooks: WorkflowHooks = {
      onStepStart: (step) => {
        sendGoalEvent('goal:step:start', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-start',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
        });
      },
      onStepComplete: (step) => {
        sendGoalEvent('goal:step:complete', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-complete',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
          output: '',
        });
      },
      onStepFailed: (step) => {
        sendGoalEvent('goal:step:failed', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-failed',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
          error: 'goal_step_failed',
        });
      },
      onProgress: (completed, total) => {
        sendGoalEvent('goal:progress', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'progress',
          goalId,
          sequence: sequence++,
          completed,
          total,
          currentStep: 'Research step',
        });
      },
    };
    try {
      // O13: 解析项目级 provider 覆盖（无覆盖时返回全局绑定）。
      const executeTarget = goalEngine.getGoal(goalId);
      const executionOptions = executeTarget ? resolveGoalExecutionOptions(executeTarget) : undefined;
      await goalEngine.executeGoal(goalId, hooks, executionOptions);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return { success: true };
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  ipcMain.handle('goal:pause', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine) return { success: false };
      goalEngine.cancelGoal(goalId);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('goal:resume', async (event, rawGoalId: unknown, rawFromStepId?: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const fromStepId = rawFromStepId === undefined
        ? undefined
        : RuntimeIdSchema.parse(rawFromStepId);
      if (!goalEngine) return { success: false, code: 'goal_execution_unavailable' };
      // O13/O14: resume 同样解析项目级 provider 覆盖；fromStepId 省略时
      // 由 GoalEngine 从 checkpoint 推导恢复点。
      const resumeTarget = goalEngine.getGoal(goalId);
      const executionOptions = resumeTarget ? resolveGoalExecutionOptions(resumeTarget) : undefined;
      await goalEngine.resumeGoal(goalId, fromStepId, undefined, executionOptions);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return { success: true };
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  // O7: human decision on an escalated step (retry / skip / stop).
  ipcMain.handle('goal:resolveStepDecision', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: string; action?: string };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const action = request?.action;
      if (!goalId || (action !== 'retry' && action !== 'skip' && action !== 'stop') || !goalEngine) {
        return { success: false, code: 'invalid_request' };
      }
      const goal = goalEngine.getGoal(goalId);
      const executionOptions = goal ? resolveGoalExecutionOptions(goal) : undefined;
      await goalEngine.resolveStepDecision(goalId, action, undefined, executionOptions);
      const updated = goalEngine.getGoal(goalId);
      if (updated) broadcastGoalChanged(event.sender, updated);
      return { success: true };
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  ipcMain.handle('goal:cancel', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine) return { success: false };
      goalEngine.cancelGoal(goalId);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('goal:getProgress', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return undefined;
    }
    return undefined;
  });
  ipcMain.handle('goal:archive', async (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine) return { success: false };
      await goalEngine.archiveGoal(goalId);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('goal:listArchives', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return [];
    }
    return [];
  });

  // ── Kanban status/priority transitions ──────────────────
  ipcMain.handle('goal:updateStatus', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: unknown; status?: unknown };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const status = typeof request?.status === 'string' ? request.status : '';
      const valid = new Set(['draft', 'planning', 'ready', 'running', 'paused', 'completed', 'failed']);
      if (!goalId || !valid.has(status) || !goalEngine) return { ok: false, error: 'invalid_request' };
      const updated = goalEngine.setStatus(goalId, status as Goal['status']);
      if (updated) {
        const goal = goalEngine.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('goal:updatePriority', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: unknown; priority?: unknown };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const priority = typeof request?.priority === 'string' ? request.priority : '';
      const valid = new Set(['low', 'medium', 'high', 'urgent']);
      if (!goalId || !valid.has(priority) || !goalEngine) return { ok: false, error: 'invalid_request' };
      const updated = goalEngine.setPriority(goalId, priority as Goal['priority']);
      if (updated) {
        const goal = goalEngine.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('goal:delete', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const goalId = typeof rawGoalId === 'string' ? rawGoalId : '';
      if (!goalId || !goalEngine) return { ok: false, error: 'invalid_request' };
      const goal = goalEngine.getGoal(goalId);
      const deleted = goalEngine.deleteGoal(goalId);
      if (deleted && goal) {
        // Deletion is presented to open cards as a cancellation so chat cards
        // never dangle; the board reloads and the card disappears.
        broadcastGoalChanged(event.sender, goal, 'cancelled');
      }
      return deleted ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  // ── Autonomous Research Engine ─────────────────────────
  // Full-autonomy loop (idea → experiment → analysis → paper) with live event
  // streaming and live-steering pause/interrupt. Mirrors the goal IPC shape.

  /**
   * Start (or resume) an autonomous run and stream every bus event to the
   * requesting renderer. `goal` null means "resume from checkpoint". The run
   * is fire-and-forget; the session id is returned to the caller immediately.
   */
  function spawnAutonomousRun(
    sender: Electron.WebContents,
    sessionId: string,
    goal: string | null,
    projectId?: string,
    strategy?: ResearchStrategy,
    structure?: PaperStructureTemplate,
  ): void {
    let sequence = 0;
    // One subscription per run: forward every bus event to the renderer after
    // schema validation. Unsubscribed when the run resolves.
    const unsubscribe = researchEventBus!.subscribe((evt) => {
      if (projectId && researchRepository) {
        try { applyAutonomousResearchEvent(researchRepository, projectId, evt); } catch { /* UI streaming must continue */ }
      }
      if (sender.isDestroyed()) return;
      const livePayload = toLivePayload(evt, sessionId, sequence++);
      const decoded = decodeAutonomousLiveEvent(livePayload);
      if (decoded) {
        const channel = channelForEvent(evt);
        if (channel) sender.send(channel, decoded);
      }
    });
    void (async () => {
      try {
        if (goal !== null) {
          if (strategy) {
            await autonomousEngine!.runWithStrategy(goal, sessionId, strategy, { projectId, structure });
          } else {
            await autonomousEngine!.run(goal, sessionId, projectId);
          }
        } else {
          await autonomousEngine!.resume(sessionId);
        }
      } catch (err) {
        console.error('[Main] autonomous run failed:', err);
        researchEventBus?.emit({
          type: 'engine-failed',
          sessionId,
          reason: `自主科研运行发生未预期异常：${err instanceof Error ? err.message : String(err)}`.slice(0, 20_000),
          completedPhases: 0,
          recoverable: true,
        });
      } finally {
        unsubscribe();
        if (activeAutonomousSessionId === sessionId) activeAutonomousSessionId = null;
      }
    })();
  }

  ipcMain.handle(AUTONOMOUS_CHANNELS.start, async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    const request = decodeAutonomousStartRequest(rawRequest);
    if (!request) return { ok: false, error: 'invalid_request' };
    if (!autonomousEngine || !researchEventBus) return { ok: false, error: 'engine_unavailable' };
    if (activeAutonomousSessionId) return { ok: false, error: 'session_active' };

    // Strategy-driven runs execute the user-defined research workflow instead
    // of the default four-stage pipeline.
    let strategy: ResearchStrategy | undefined;
    let structure: PaperStructureTemplate | undefined;
    if (request.strategyId) {
      if (!strategyStore() || !store) return { ok: false, error: 'strategy_unavailable' };
      strategy = strategyStore()!.getStrategy(request.strategyId);
      if (!strategy) return { ok: false, error: 'strategy_not_found' };
    }
    if (request.structureId) {
      if (!strategyStore() || !store) return { ok: false, error: 'structure_unavailable' };
      structure = strategyStore()!.getStructure(request.structureId);
      if (!structure) return { ok: false, error: 'structure_not_found' };
    }

    const sessionId = request.sessionId ?? `auto_${Date.now().toString(36)}`;
    if (!researchRepository) return { ok: false, error: 'research_repository_unavailable' };
    if (researchRepository.getRun(sessionId, true)) return { ok: false, error: 'session_exists' };
    let resolvedProjectId: string;
    try {
      const resolution = ensureAutonomousResearchProject(researchRepository, {
        goal: request.goal,
        requestedProjectId: request.projectId,
      });
      if (!resolution) {
        return { ok: false, error: request.projectId ? 'project_not_found' : 'project_creation_failed' };
      }
      resolvedProjectId = resolution.projectId;
      beginAutonomousResearchRun(researchRepository, {
        sessionId,
        projectId: resolvedProjectId,
        goal: request.goal,
      });
    } catch {
      return { ok: false, error: 'project_creation_failed' };
    }
    activeAutonomousSessionId = sessionId;
    spawnAutonomousRun(event.sender, sessionId, request.goal, resolvedProjectId, strategy, structure);

    return { ok: true, sessionId, projectId: resolvedProjectId };
  });

  // ── Research strategy & paper structure management ─────────
  ipcMain.handle('strategy:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!strategyStore() || !store) return { ok: false, strategies: [] };
      return { ok: true, strategies: strategyStore()!.listStrategies() };
    } catch {
      return { ok: false, strategies: [] };
    }
  });
  ipcMain.handle('strategy:save', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeStrategySaveRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.saveStrategy({ ...request.strategy, updatedAt: Date.now() });
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('strategy:delete', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeStrategyDeleteRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.deleteStrategy(request.strategyId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('strategy:setDefault', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeStrategySetDefaultRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      const strategy = strategyStore()!.getStrategy(request.strategyId);
      if (!strategy) return { ok: false, error: 'not_found' };
      for (const existing of strategyStore()!.listStrategies()) {
        if (existing.id === strategy.id) continue;
        strategyStore()!.saveStrategy({ ...existing, isDefault: false, updatedAt: Date.now() });
      }
      strategyStore()!.saveStrategy({ ...strategy, isDefault: true, updatedAt: Date.now() });
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('structure:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!strategyStore() || !store) return { ok: false, templates: [] };
      return { ok: true, templates: strategyStore()!.listStructures() };
    } catch {
      return { ok: false, templates: [] };
    }
  });
  ipcMain.handle('structure:save', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodePaperStructureSaveRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.saveStructure({ ...request.template, updatedAt: Date.now() });
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('structure:delete', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodePaperStructureDeleteRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.deleteStructure(request.templateId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle(AUTONOMOUS_CHANNELS.control, async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeAutonomousControlRequest(rawRequest);
      if (!request) return { ok: false, code: 'invalid_request' };
      if (!autonomousEngine || !researchEventBus) {
        return { ok: false, code: 'invalid_request' };
      }
      if (request.action === 'interrupt') {
        const stopped = autonomousEngine.interrupt(request.sessionId, request.reason ?? 'user_interrupt');
        return { ok: stopped, code: stopped ? 'applied' : 'no_active_session' };
      }
      if (request.action === 'pause') {
        // Real cooperative pause: mark the session so the loop stops at the
        // next phase boundary, and nudge the live-steering queue so a running
        // phase can also stop at its next step boundary.
        const paused = autonomousEngine.pause(request.sessionId);
        if (!paused) return { ok: false, code: 'no_active_session' };
        try {
          liveSteeringQueue.enqueue({
            type: 'interrupt',
            id: `auto_interrupt_${Date.now()}`,
            sessionId: request.sessionId,
            sequence: Date.now(),
            createdAt: Date.now(),
            reason: request.reason ?? 'user_pause',
          });
        } catch { /* steering nudge is best-effort */ }
        return { ok: true, code: 'applied' };
      }
      if (request.action === 'resume') {
        // Resume a paused session from its persisted checkpoint. A paused
        // session is no longer in memory (activeAutonomousSessionId is null),
        // so this branch intentionally bypasses the active-session guard.
        if (activeAutonomousSessionId) return { ok: false, code: 'no_active_session' };
        const checkpoint = autonomousEngine.loadCheckpoint(request.sessionId);
        if (!checkpoint) return { ok: false, code: 'not_found' };
        activeAutonomousSessionId = request.sessionId;
        spawnAutonomousRun(event.sender, request.sessionId, null, checkpoint.projectId);
        return { ok: true, code: 'applied' };
      }
      return { ok: false, code: 'invalid_request' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });

  ipcMain.handle(AUTONOMOUS_CHANNELS.listSessions, (event) => {
    try {
      requireRendererMainFrame(event);
      if (!autonomousEngine || !store) return { sessions: [] };
      // Checkpoints are stored as memory rows under the autonomous_checkpoint category.
      const rows = store.getMemoryByCategory('autonomous_checkpoint');
      return {
        sessions: rows.map((r) => {
          try {
            const data = JSON.parse(r.value) as Record<string, unknown>;
            const sessionId = r.key.replace('autonomous:session:', '');
            const goal = typeof data.goal === 'string' ? data.goal : '';
            if (!sessionId || !goal) return null;
            const run = researchRepository?.getRun(sessionId, true);
            if (run && (run.status === 'completed' || run.status === 'cancelled')) return null;
            return {
              sessionId,
              goal,
              projectId: typeof data.projectId === 'string' ? data.projectId : run?.projectId,
              executions: typeof data.executions === 'number' ? data.executions : 0,
              completedPhases: Array.isArray(data.history) ? data.history.length : 0,
              savedAt: typeof data.savedAt === 'number' ? data.savedAt : r.updatedAt,
              state: data.state === 'running' ? 'running' : 'paused',
              failureReason: typeof data.failureReason === 'string' ? data.failureReason : undefined,
            };
          } catch { return null; }
        }).filter((session): session is NonNullable<typeof session> => session !== null),
      };
    } catch {
      return { sessions: [] };
    }
  });

  ipcMain.handle(AUTONOMOUS_CHANNELS.resumeSession, async (event, rawSessionId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId : '';
      if (!sessionId || !autonomousEngine || !researchEventBus) return { ok: false, error: 'invalid_request' };
      const checkpoint = autonomousEngine.loadCheckpoint(sessionId);
      if (!checkpoint) return { ok: false, error: 'no_checkpoint' };
      if (activeAutonomousSessionId) return { ok: false, error: 'session_active' };
      // Real mid-loop resume from the persisted checkpoint (completed phases
      // are not re-executed).
      activeAutonomousSessionId = sessionId;
      spawnAutonomousRun(event.sender, sessionId, null, checkpoint.projectId);
      return { ok: true, goal: checkpoint.goal };
    } catch {
      return { ok: false, error: 'invalid_request' };
    }
  });

  // ── Skills ──────────────────────────────────────────────
  ipcMain.handle('skill:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return skillRegistry?.list().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        allowedTools: skill.allowedTools ?? [],
        maxTurns: skill.maxTurns,
      })) ?? [];
    } catch {
      return [];
    }
  });
  ipcMain.handle('skill:get', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const skill = skillRegistry?.get(RuntimeIdSchema.parse(rawId));
      return skill ? {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category: skill.category,
      } : undefined;
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('skill:setActive', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!skillRegistry) return { success: false, error: 'skill_registry_unavailable' };
      if (rawId === null) {
        skillRegistry.clearActiveSkillPrompt();
        return { success: true, active: null };
      }
      const id = RuntimeIdSchema.parse(rawId);
      const skill = skillRegistry.get(id);
      if (!skill) return { success: false, error: 'skill_unavailable' };
      skillRegistry.setActiveSkillPrompt(skill.systemPrompt);
      return { success: true, active: id };
    } catch {
      return { success: false, error: 'skill_unavailable' };
    }
  });
  ipcMain.handle('skill:getActive', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!skillRegistry) return { active: null };
      const prompt = skillRegistry.getActiveSkillPrompt();
      return { active: prompt ? 'active' : null };
    } catch {
      return { active: null };
    }
  });

  // Generate a reusable skill from a selected conversation. The AI distills the
  // conversation into a structured skill, which is then registered into the
  // live SkillRegistry AND persisted so it survives restarts.
  ipcMain.handle('skill:generateFromConversation', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    if (!skillExtractor || !skillRegistry) {
      return { ok: false, error: 'skill_engine_unavailable' };
    }
    const request = rawRequest as { messages?: unknown; userIntent?: unknown };
    const rawMessages = Array.isArray(request?.messages) ? request.messages : [];
    // Coerce to ChatMessage-like shape (role + content only).
    const messages = rawMessages
      .filter((m): m is { role: string; content: string } =>
        typeof m === 'object' && m !== null && typeof (m as { content?: unknown }).content === 'string')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    if (messages.length === 0) return { ok: false, error: 'no_messages' };

    const userIntent = typeof request?.userIntent === 'string' ? request.userIntent : undefined;
    const knownTools = builtinToolNames();

    const extracted = await skillExtractor.extract({ messages, userIntent, knownTools });
    if (!extracted) return { ok: false, error: 'conversation_too_short' };

    // Install into the live registry (unregister first if id exists, so
    // re-generating a skill updates it in place).
    installSkill(extracted);

    return {
      ok: true,
      skill: {
        id: extracted.id,
        name: extracted.name,
        description: extracted.description,
        systemPrompt: extracted.systemPrompt,
        allowedTools: extracted.allowedTools,
        maxTurns: extracted.maxTurns,
        rationale: extracted.rationale,
      },
    };
  });

  ipcMain.handle('skill:deleteCustom', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = typeof rawId === 'string' ? rawId : '';
      if (!id || !skillRegistry || !store) return { ok: false, error: 'invalid' };
      skillRegistry.unregister(id);
      // Remove from persisted custom skills.
      const custom = loadCustomSkills();
      const filtered = custom.filter((s) => s.id !== id);
      if (filtered.length !== custom.length) {
        store.setMemory(CUSTOM_SKILLS_MEMORY_KEY, JSON.stringify(filtered), 'custom_skills');
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'delete_failed' };
    }
  });

  // ── MCP Servers ─────────────────────────────────────────
  ipcMain.handle('fundingTemplate:invoke', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const repository = fundingTemplateRepository;
      const service = fundingTemplateService;
      if (!repository || !service || !researchRepository) {
        return decodeFundingTemplateRuntimeResponse(null);
      }
      const owner = executionOwnerFor(event);
      const ipc = new FundingTemplateIpcService({
        repository,
        service,
        projectExists: (projectId) => Boolean(researchRepository?.getProject(projectId)),
        consumeFundingFile: (capabilityId) => {
          const resolved = fileCapabilities.consume(
            { capabilityId, operation: 'file' },
            owner,
            'funding-template',
          );
          return resolved.ok
            ? { filePath: resolved.resolvedPath, trustedRoot: path.dirname(resolved.resolvedPath) }
            : null;
        },
      });
      return decodeFundingTemplateRuntimeResponse(
        await ipc.handle(FUNDING_LOCAL_OWNER_ID, rawRequest),
      );
    } catch {
      return decodeFundingTemplateRuntimeResponse(null);
    }
  });

  ipcMain.handle('personalization:list', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.list(rawRequest) ?? { ok: false, code: 'unavailable' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  ipcMain.handle('personalization:get', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.get(rawRequest) ?? { ok: true, definition: null };
    } catch {
      return { ok: true, definition: null };
    }
  });
  ipcMain.handle('personalization:save', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.save(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  ipcMain.handle('personalization:archive', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.archive(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  ipcMain.handle('personalization:fork', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.fork(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  ipcMain.handle('personalization:restore', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.restore(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });

  ipcMain.handle('personalization:versions', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.versions(rawRequest) ?? { ok: true as const, versions: [] };
    } catch {
      return { ok: true as const, versions: [] };
    }
  });
  ipcMain.handle('personalization:resolve', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.resolve(rawRequest) ?? {
        ok: false,
        code: 'definition_corrupt',
        issues: ['Personalization persistence is unavailable'],
      };
    } catch {
      return { ok: false, code: 'definition_corrupt', issues: ['Invalid personalization request'] };
    }
  });

  // ── AI 辅助创建场景：描述需求 → 生成场景 + 智能体 + 工作流 ──
  const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
  function parseAiScenarioGeneration(answer: string): {
    scenario: { name: string; description: string; triggerPhrases: string[]; deliverable: string };
    agents: Array<{ name: string; role: string; systemPrompt: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
    workflow: Array<{ name: string; description: string; agent: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
    rules: string;
    paperStructure: Array<{ title: string; instruction: string }> | null;
  } | null {
    const cleaned = answer.replace(/```(?:json)?/gu, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const scenario = isRecord(parsed.scenario) ? parsed.scenario : null;
    const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
    const workflow = Array.isArray(parsed.workflow) ? parsed.workflow : [];
    if (!scenario || agents.length === 0 || agents.length > 4 || workflow.length > 12) return null;
    const str = (value: unknown, maximum: number): string => (
      typeof value === 'string' ? value.trim().slice(0, maximum) : ''
    );
    const strList = (value: unknown): string[] => (
      Array.isArray(value)
        ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean).slice(0, 64)
        : []
    );
    const turns = (value: unknown): number => (
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(100, Math.max(1, Math.floor(value)))
        : 12
    );
    const normalizedAgents = agents
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        name: str(item.name, 30),
        role: str(item.role, 100),
        systemPrompt: str(item.systemPrompt, 600),
        skillIds: strList(item.skillIds),
        toolIds: strList(item.toolIds),
        mcpIds: strList(item.mcpIds),
        maxTurns: turns(item.maxTurns),
      }))
      .filter((item) => item.name)
      .slice(0, 4);
    if (normalizedAgents.length === 0) return null;
    const agentNames = new Set(normalizedAgents.map((item) => item.name));
    const normalizedWorkflow = workflow
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        name: str(item.name, 100),
        description: str(item.description, 150),
        agent: str(item.agent, 30),
        skillIds: strList(item.skillIds),
        toolIds: strList(item.toolIds),
        mcpIds: strList(item.mcpIds),
        maxTurns: turns(item.maxTurns),
      }))
      .filter((step) => step.name && agentNames.has(step.agent))
      .slice(0, 12);
    const rules = typeof parsed.rules === 'string' ? parsed.rules.trim().slice(0, 1500) : '';
    const rawStructure = Array.isArray(parsed.paperStructure) ? parsed.paperStructure : [];
    const paperStructure = rawStructure
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        title: str(item.title, 80),
        instruction: str(item.instruction, 250) || str(item.style, 120),
      }))
      .filter((section) => section.title)
      .slice(0, 16);
    return {
      scenario: {
        name: str(scenario.name, 40) || (normalizedAgents[0]?.name ?? '研究场景'),
        description: str(scenario.description, 200),
        triggerPhrases: strList(scenario.triggerPhrases).slice(0, 12),
        deliverable: str(scenario.deliverable, 200),
      },
      agents: normalizedAgents,
      workflow: normalizedWorkflow,
      rules,
      paperStructure: paperStructure.length > 0 ? paperStructure : null,
    };
  }

  ipcMain.handle('personalization:aiGenerateScenario', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const description = typeof rawRequest.description === 'string' ? rawRequest.description.trim() : '';
      if (description.length < 2 || description.length > 2000) {
        return { ok: false, code: 'invalid_request' };
      }
      const rawDefinitions = Array.isArray(rawRequest.definitions) ? rawRequest.definitions : [];
      const definitions = rawDefinitions
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id : '',
          kind: typeof item.kind === 'string' ? item.kind : 'unknown',
          name: typeof item.name === 'string' ? item.name : '',
          description: typeof item.description === 'string' ? item.description : '',
        }))
        .filter((item) => item.id && item.name)
        .slice(0, 500);
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const catalog = definitions.length > 0
        ? definitions.map((d) => `- ${d.kind}「${d.name}」 id=${d.id}${d.description ? `：${d.description}` : ''}`).join('\n')
        : '（暂无现有定义）';
      const systemPrompt = [
        '你是一个人文社科研究场景设计助手。用户用一句话描述他想要的研究场景，你需要输出一个可直接落地的场景设计。',
        '要求：',
        '1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。',
        '2. JSON 结构：',
        '   { "scenario": { "name": "场景名称(不超过40字)", "description": "场景说明(不超过200字)", "triggerPhrases": ["触发词1","触发词2"], "deliverable": "最终交付物描述(可选，不超过200字)" },',
        '     "agents": [ { "name": "智能体名称(不超过30字)", "role": "角色", "systemPrompt": "系统指令(不超过600字)", "skillIds": ["已有技能id"], "toolIds": ["工具id"], "mcpIds": ["已有MCP id"], "maxTurns": 12 } ],',
        '     "workflow": [ { "name": "步骤名称", "description": "步骤说明(不超过150字)", "agent": "智能体名称(必须是 agents 中的名称)", "skillIds": [], "toolIds": [], "mcpIds": [], "maxTurns": 12 } ],',
        '     "rules": "场景记忆 Metis.md 文档（Markdown，不超过1500字）：写明该场景的研究目标、资料与证据边界、输出规范与工作习惯，供场景内智能体遵守",',
        '     "paperStructure": [ { "title": "章节标题(如：引言)", "instruction": "该章节写作指引与文风要求(不超过250字)" } ] }',
        '3. agents 数量 1-2 个；workflow 步骤 2-6 个，按执行顺序排列。',
        '4. paperStructure 必须覆盖：引言 + 2-4 个主体章节 + 结论；每个章节给出针对性写作指引（该写什么、怎么论证、文风如何）。',
        '5. skillIds/mcpIds 只能从下面“现有定义清单”中选择，没有合适的不填。toolIds 可参考：read_file、write_file、search_web、summarize_text、compare_items、list_sources、extract_evidence、link_evidence、draft_claim、save_artifact。',
        '6. systemPrompt 用中文，写明该智能体在这个场景中的职责、行为边界与输出要求。',
        `现有定义清单：\n${catalog}`,
      ].join('\n');
      const answer = await runEphemeralChatTurn({
        agentLoop,
        sessionId: `ai-scenario-${Date.now().toString(36)}`,
        messages: [{ role: 'user', content: `用户需求：${description}` }],
        requestId: `ai_gen_${++requestCounter}`,
        skillPrompt: systemPrompt,
      });
      if (answer.status !== 'completed' || !answer.answer.trim()) {
        return { ok: false, code: 'generation_failed', message: answer.diagnostics?.[0]?.code ?? answer.status };
      }
      const parsed = parseAiScenarioGeneration(answer.answer);
      if (!parsed) return { ok: false, code: 'parse_failed' };
      return { ok: true, ...parsed };
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  // ── 论文结构模板识别：粘贴模板（如国社科申请书）→ AI 解析为逐节写作指引 ──
  ipcMain.handle('personalization:parsePaperTemplate', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const text = typeof rawRequest.text === 'string' ? rawRequest.text.trim() : '';
      if (text.length < 10 || text.length > 20_000) {
        return { ok: false, code: 'invalid_request' };
      }
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const systemPrompt = [
        '你是论文结构模板解析助手。用户粘贴一份研究模板（如国家社科基金申请书、论文写作规范、学位论文结构），你需要把它解析为可编辑的章节结构。',
        '要求：',
        '1. 只输出一个 JSON 对象：{ "sections": [ { "title": "章节标题", "instruction": "该章节的写作指引：写什么内容、如何论证、文风要求（不超过250字）" } ] }。',
        '2. 章节按模板出现的顺序排列；模板中未明确列出的必要章节（如引言、结论）应补充进去。',
        '3. 章节数量 3-12 个；instruction 用中文，具体到该章节的写作任务与质量要求。',
        '4. 不要输出任何解释、前后缀或 Markdown 代码围栏。',
      ].join('\n');
      const answer = await runEphemeralChatTurn({
        agentLoop,
        sessionId: `ai-template-${Date.now().toString(36)}`,
        messages: [{ role: 'user', content: `模板内容：\n${text}` }],
        requestId: `ai_tpl_${++requestCounter}`,
        skillPrompt: systemPrompt,
      });
      if (answer.status !== 'completed' || !answer.answer.trim()) {
        return { ok: false, code: 'generation_failed', message: answer.diagnostics?.[0]?.code ?? answer.status };
      }
      const cleaned = answer.answer.replace(/```(?:json)?/gu, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end <= start) return { ok: false, code: 'parse_failed' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return { ok: false, code: 'parse_failed' };
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.sections)) return { ok: false, code: 'parse_failed' };
      const str = (value: unknown, maximum: number): string => (
        typeof value === 'string' ? value.trim().slice(0, maximum) : ''
      );
      const sections = parsed.sections
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          title: str(item.title, 80),
          instruction: str(item.instruction, 250) || str(item.style, 120),
        }))
        .filter((section) => section.title)
        .slice(0, 16);
      if (sections.length < 3) return { ok: false, code: 'parse_failed' };
      return { ok: true, sections };
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  ipcMain.handle('personalization:extension:apply', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const publicRequest = PersonalizationExtensionIpcRequestSchema.safeParse(rawRequest);
      if (!publicRequest.success || !personalizationExtensions) {
        return decodePersonalizationExtensionResponse(null);
      }
      const request = bindPersonalizationExtensionRequest(publicRequest.data, event);
      if (!request) return decodePersonalizationExtensionResponse(null);
      const owner = executionOwnerFor(event);
      if (request.mode === 'mcp_requirements' && request.runProbe) {
        if (!personalizationGeneratedMcpActivation) return decodePersonalizationExtensionResponse(null);
        const prepared = await personalizationExtensions.prepareGeneratedMcp(request);
        if (!prepared.ok) return decodePersonalizationExtensionResponse(prepared.response);
        const activated = await personalizationGeneratedMcpActivation.activate({
          operationId: request.evidenceContext.operationId,
          expectedRevision: request.expectedRevision,
          pendingDefinition: prepared.definition,
          installation: prepared.installation,
          evidenceContext: { ...request.evidenceContext, owner },
        });
        if (!activated.ok) {
          return decodePersonalizationExtensionResponse({
            ok: false,
            mode: 'mcp_requirements',
            code: 'mcp_builder_failed',
            detailCode: activated.code,
            compensated: activated.compensated,
          });
        }
        return decodePersonalizationExtensionResponse({
          ok: true,
          mode: 'mcp_requirements',
          definition: activated.definition,
          evidence: activated.evidence,
          skillInstallation: null,
          mcpInstallation: activated.installation,
        });
      }
      const result = await personalizationExtensions.apply(request, {
        resolveLocalSkillSource: (capabilityId) => {
          const resolution = fileCapabilities.consumeMatching(capabilityId, owner, [
            {
              purpose: 'personalization-skill-package',
              kind: 'file',
              operation: 'file',
            },
            {
              purpose: 'personalization-skill-directory',
              kind: 'folder',
              operation: 'folder',
            },
          ]);
          return resolution.ok ? resolution.resolvedPath : undefined;
        },
      });
      return decodePersonalizationExtensionResponse(result);
    } catch {
      return decodePersonalizationExtensionResponse(null);
    }
  });

  ipcMain.handle('personalization:mcp:activate', async (event, rawRequest: unknown) => {
    const publicRequest = McpActivationIpcRequestSchema.safeParse(rawRequest);
    try {
      requireRendererMainFrame(event);
      if (!publicRequest.success || !personalizationMcpActivation) {
        return decodeMcpActivationResponse(null);
      }
      const request = bindMcpActivationRequest(publicRequest.data, event);
      if (!request) return decodeMcpActivationResponse(null);
      return decodeMcpActivationResponse(
        await personalizationMcpActivation.activate(request),
      );
    } catch {
      return decodeMcpActivationResponse(null);
    }
  });

  ipcMain.handle('personalization:bundle:export', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationBundleExportIpcRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : '00000000-0000-4000-8000-000000000000';
    try {
      const invokingWindow = requireRendererMainFrame(event);
      if (!parsed.success) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'invalid_request' });
      if (!personalizationBundles || !personalizationRepository || !personalizationBundleSkillAssets) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'service_unavailable' });
      }
      const exported = await personalizationBundles.exportBundle({
        rootDefinitionIds: parsed.data.rootDefinitionIds,
        assetMode: 'include_files',
        createdBy: 'Local Metis user',
      }, { get: (id) => personalizationRepository?.get(id, true) }, personalizationBundleSkillAssets);
      const selected = await dialog.showSaveDialog(invokingWindow, {
        title: 'Export Metis personalization bundle',
        defaultPath: `metis-personalization-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'Metis personalization bundle', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (selected.canceled || !selected.filePath) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'cancelled' });
      }
      try { writePersonalizationBundleFile(selected.filePath, exported.bytes); } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'write_failed' });
      }
      return PersonalizationBundleIpcResponseSchema.parse({
        ok: true,
        operationId,
        action: 'exported',
        bundleDigest: exported.bundle.manifest.bundleDigest,
        definitionCount: exported.bundle.manifest.definitions.length,
      });
    } catch {
      return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'export_failed' });
    }
  });

  ipcMain.handle('personalization:bundle:import', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationBundleImportIpcRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : '00000000-0000-4000-8000-000000000000';
    try {
      const invokingWindow = requireRendererMainFrame(event);
      if (!parsed.success) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'invalid_request' });
      if (!personalizationBundleCoordinator) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'service_unavailable' });
      }
      const selected = await dialog.showOpenDialog(invokingWindow, {
        title: 'Import Metis personalization bundle',
        properties: ['openFile'],
        filters: [{ name: 'Metis personalization bundle', extensions: ['json'] }],
      });
      const source = selected.canceled ? undefined : selected.filePaths[0];
      if (!source) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'cancelled' });
      let bytes: Uint8Array;
      try { bytes = readPersonalizationBundleFile(source); } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'read_failed' });
      }
      const imported = await personalizationBundleCoordinator.importBundle(bytes);
      if (!imported.ok) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
      let definitionCount: number;
      try {
        definitionCount = PersonalizationBundleSchema.parse(
          JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown,
        ).manifest.definitions.length;
      } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
      }
      return PersonalizationBundleIpcResponseSchema.parse({
        ok: true,
        operationId,
        action: 'imported',
        bundleDigest: imported.bundleDigest,
        definitionCount,
      });
    } catch {
      return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
    }
  });

  ipcMain.handle('personalization:secrets:list', (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretListRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretListResponse(null, operationId);
      if (!personalizationSecretVault) {
        return decodePersonalizationSecretListResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretListResponse(
        personalizationSecretVault.list(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretListResponse(null, operationId);
    }
  });

  ipcMain.handle('personalization:secrets:set', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretSetRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretSetResponse(null, operationId);
      if (!personalizationSecretVault) {
        return decodePersonalizationSecretSetResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretSetResponse(
        await personalizationSecretVault.set(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretSetResponse(null, operationId);
    }
  });

  ipcMain.handle('personalization:secrets:remove', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretRemoveRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretRemoveResponse(null, operationId);
      if (!personalizationSecretVault) {
        return decodePersonalizationSecretRemoveResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretRemoveResponse(
        await personalizationSecretVault.remove(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretRemoveResponse(null, operationId);
    }
  });

  ipcMain.handle('mcp:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return mcpManager?.getStatus().map(({ id, name, connected, toolCount }) => ({
        id,
        name,
        connected,
        toolCount,
      })) ?? [];
    } catch {
      return [];
    }
  });
  ipcMain.handle('mcp:add', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      // Fixed response below.
    }
    return { success: false, code: 'managed_mcp_required' };
  });
  ipcMain.handle('mcp:remove', async (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = RuntimeIdSchema.parse(rawId);
      if (!mcpManager) return { success: false };
      await mcpManager.removeServer(id);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('mcp:toggle', async (event, rawId: unknown, rawEnabled: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = RuntimeIdSchema.parse(rawId);
      if (!mcpManager || typeof rawEnabled !== 'boolean') return { success: false };
      if (rawEnabled) return { success: false, code: 'execution_consent_required' };
      const status = await mcpManager.toggleServer(id, false);
      return { success: true, ...status };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('mcp:test', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      // Fixed response below.
    }
    return { success: false, code: 'managed_mcp_required' };
  });

  // ── HITL Approval ───────────────────────────────────────
  // Track pending approval resolvers by request id
  const approvalResolvers = new Map<string, (approved: boolean) => void>();

  const approvalTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  ipcMain.handle('hitl:approval:respond', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeApprovalResponseRequest(rawRequest);
      if (!request) return createApprovalMutationFailure();
      const resolve = approvalResolvers.get(request.requestId);
      if (!resolve) return createApprovalMutationFailure();
      resolve(request.decision === 'approve');
      approvalResolvers.delete(request.requestId);
      const timeout = approvalTimeouts.get(request.requestId);
      if (timeout) clearTimeout(timeout);
      approvalTimeouts.delete(request.requestId);
      return decodeApprovalMutationResult({ success: true });
    } catch {
      return createApprovalMutationFailure();
    }
  });

  // Set up approval handler that sends requests to renderer via IPC
  if (approvalStore) {
    approvalStore.setHandler(async (request) => {
      return new Promise((resolve) => {
        const win = mainWindow;
        if (!win) {
          resolve(false);
          return;
        }
        approvalResolvers.set(request.id, resolve);
        const presented = ApprovalRequestViewSchema.safeParse({
          requestId: request.id,
          action: presentApprovalAction(request.toolName),
          createdAt: request.createdAt,
        });
        if (!presented.success) {
          approvalResolvers.delete(request.id);
          resolve(false);
          return;
        }
        win.webContents.send('hitl:approval:required', presented.data);
        // Timeout after 5 minutes to prevent hanging
        const timeoutId = setTimeout(() => {
          if (approvalResolvers.has(request.id)) {
            approvalResolvers.delete(request.id);
            approvalTimeouts.delete(request.id);
            resolve(false);
          }
        }, 300_000);
        approvalTimeouts.set(request.id, timeoutId);
      });
    });
  }

  ipcMain.handle('hitl:rules:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!approvalStore) return [];
      return decodeApprovalRuleViews(approvalStore.getRules().map((rule) => ({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        enabled: rule.enabled,
      })));
    } catch {
      return [];
    }
  });

  ipcMain.handle('hitl:rules:toggle', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeApprovalRuleToggleRequest(rawRequest);
      if (!request || !approvalStore) return createApprovalMutationFailure();
      return approvalStore.setRuleEnabled(request.ruleId, request.enabled)
        ? decodeApprovalMutationResult({ success: true })
        : createApprovalMutationFailure();
    } catch {
      return createApprovalMutationFailure();
    }
  });

  ipcMain.handle('hitl:approvals:pending', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!approvalStore) return [];
      return approvalStore.getPending().flatMap((request) => {
        const presented = ApprovalRequestViewSchema.safeParse({
          requestId: request.id,
          action: presentApprovalAction(request.toolName),
          createdAt: request.createdAt,
        });
        return presented.success ? [presented.data] : [];
      });
    } catch {
      return [];
    }
  });

  // Legacy dialog:selectScript removed (GLM-102). Script selection is now
  // handled entirely by experiment:attachScript through secure adapter path.

  // ── Terminal (node-pty) ────────────────────────────────
  ipcMain.handle('terminal:requestGrant', async (event) => {
    try {
      const window = requireRendererMainFrame(event);
      if (!executionCapabilities) return createTerminalFailure();
      const consent = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Open controlled terminal',
        message: 'The terminal can run commands in the Metis managed workspace.',
        detail: 'Only continue if you intend to use an interactive shell. The renderer cannot choose the executable, environment, or working directory.',
        buttons: ['Open terminal', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (consent.response !== 0) return createTerminalFailure();
      const executablePath = process.platform === 'win32'
        ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : '/bin/bash';
      const issued = executionCapabilities.issue({
        operation: 'terminal-session',
        lifetime: 'session',
        owner: executionOwnerFor(event),
        userConsentAt: Date.now(),
        executablePath,
        fixedArgs: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['--noprofile', '--norc'],
        cwd: TERMINAL_WORKSPACE_DIR,
      });
      return issued.success
        ? decodeTerminalGrantResult({
            success: true,
            code: 'terminal_grant_issued',
            grant: issued.grant,
          })
        : createTerminalFailure();
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:create', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalCreateRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.executionGrantId,
        operation: 'terminal-session',
        action: 'execute',
      }, owner);
      if (!authorized.ok || authorized.action !== 'execute') return createTerminalFailure();
      const terminalId = nextTerminalId();
      const terminal = pty.spawn(authorized.plan.executablePath, authorized.plan.args, {
        name: 'xterm-256color',
        cols: request.data.cols,
        rows: request.data.rows,
        cwd: authorized.plan.cwd,
        env: authorized.plan.env,
      });
      const session: ActiveTerminalSession = {
        terminal,
        grantId: authorized.grant.grantId,
        owner,
        sequence: 0,
        killed: false,
      };
      activeTerminals.set(terminalId, session);

      terminal.onData((rawData: string) => {
        const current = activeTerminals.get(terminalId);
        const window = mainWindow;
        if (!current || !window || window.isDestroyed() || window.webContents.id !== owner.webContentsId) return;
        const data = rawData.replaceAll('\u0000', '');
        for (let offset = 0; offset < data.length; offset += TERMINAL_RUNTIME_LIMITS.eventChars) {
          const eventPayload = TerminalDataEventSchema.safeParse({
            terminalId,
            sequence: current.sequence++,
            data: data.slice(offset, offset + TERMINAL_RUNTIME_LIMITS.eventChars),
          });
          if (eventPayload.success) window.webContents.send('terminal:data', eventPayload.data);
        }
      });

      terminal.onExit(({ exitCode }: { exitCode: number }) => {
        const current = activeTerminals.get(terminalId);
        activeTerminals.delete(terminalId);
        executionCapabilities?.revoke(authorized.grant.grantId);
        const window = mainWindow;
        if (!current || !window || window.isDestroyed() || window.webContents.id !== owner.webContentsId) return;
        const eventPayload = TerminalExitEventSchema.safeParse({
          terminalId,
          sequence: current.sequence++,
          exitCode,
          reason: current.killed ? 'killed' : 'exit',
        });
        if (eventPayload.success) window.webContents.send('terminal:exit', eventPayload.data);
      });

      return decodeTerminalCreateResult({
        success: true,
        code: 'terminal_session_created',
        terminalId,
        sessionAccessGrantId: authorized.grant.grantId,
      });
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:write', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalWriteRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const session = activeTerminals.get(request.data.terminalId);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.sessionAccessGrantId,
        operation: 'terminal-session',
        action: 'session-access',
      }, owner);
      if (!session || !authorized.ok || authorized.action !== 'session-access' || session.grantId !== request.data.sessionAccessGrantId) {
        return createTerminalFailure();
      }
      session.terminal.write(request.data.data);
      return decodeTerminalOperationResult({ success: true, code: 'terminal_operation_complete' });
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:resize', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalResizeRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const session = activeTerminals.get(request.data.terminalId);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.sessionAccessGrantId,
        operation: 'terminal-session',
        action: 'session-access',
      }, owner);
      if (!session || !authorized.ok || authorized.action !== 'session-access' || session.grantId !== request.data.sessionAccessGrantId) {
        return createTerminalFailure();
      }
      session.terminal.resize(request.data.cols, request.data.rows);
      return decodeTerminalOperationResult({ success: true, code: 'terminal_operation_complete' });
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:kill', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalKillRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const session = activeTerminals.get(request.data.terminalId);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.sessionAccessGrantId,
        operation: 'terminal-session',
        action: 'session-access',
      }, owner);
      if (!session || !authorized.ok || authorized.action !== 'session-access' || session.grantId !== request.data.sessionAccessGrantId) {
        return createTerminalFailure();
      }
      session.killed = true;
      session.terminal.kill();
      return decodeTerminalOperationResult({ success: true, code: 'terminal_operation_complete' });
    } catch {
      return createTerminalFailure();
    }
  });
}

// ─── App Lifecycle ────────────────────────────────────────────


function parseBrowserBounds(raw: unknown): BrowserBounds | null {
  const r = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  if (!r) return null;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

// Enforce a single application instance per userData directory. Without this,
// launching the app again opens a second instance that contends for the same
// disk cache (producing "Unable to move the cache: access denied") and the
// same SQLite database (risking concurrent-write corruption). The second
// instance exits immediately; the first instance window is restored/focused.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.show();
  }
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;

  // Serve the production renderer bundle over metis-app:// (ESM modules cannot
  // load from file:// under Chromium's null-origin CORS rules). Every request
  // is confined to the dist/ directory.
  const distRoot = path.join(__dirname, '../../dist');
  // Module scripts require an exact JavaScript MIME type — net.fetch over
  // file:// does not guarantee one, so responses are built explicitly.
  const webMimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };
  protocol.handle('metis-app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const resolved = path.resolve(distRoot, `.${pathname}`);
    if (!resolved.startsWith(distRoot + path.sep) && resolved !== distRoot) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    const mime = webMimeTypes[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    return new Response(fs.readFileSync(resolved), { headers: { 'Content-Type': mime } });
  });

  // Ensure data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TERMINAL_WORKSPACE_DIR, { recursive: true });
  executionCapabilities = new ExecutionCapabilityRegistry({
    allowedCwdRoots: [DATA_DIR],
    allowedEnvironmentKeys: ['ELECTRON_RUN_AS_NODE'],
  });

  // Initialize secure storage with Electron's safeStorage (must be after app.whenReady).
  // Provider profiles never use the generic in-memory fallback: the store below
  // accepts only the explicitly OS-protected adapter.
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    initSecureStorage(safeStorage);
  } else {
    console.warn('[Main] Electron safeStorage not available — provider profiles remain unavailable.');
  }
  providerProfileStorage = createFirstRunSecureStorage(safeStorage);
  try {
    providerProfileStore = new ProviderProfileStore(DATA_DIR, providerProfileStorage);
  } catch {
    providerProfileStore = null;
    providerProfileStorage = null;
  }
  // Background auto-update (unsigned NSIS builds update fine when
  // verifyUpdateCodeSignature is false). Non-fatal: failures only emit an
  // error event and never block startup.
  try {
    autoUpdaterService = new AutoUpdaterService();
    autoUpdaterService.on('event', (event: { type: string; version?: string; percent?: number; message?: string }) => {
      lastUpdateEvent = event;
    });
    autoUpdaterService.init();
  } catch {
    autoUpdaterService = null;
  }
  const citationTruthSecret = loadOrCreateCitationTruthSecret(DATA_DIR, safeStorage);
  citationTruthReceipts = citationTruthSecret
    ? new CitationTruthReceiptService(citationTruthSecret)
    : null;
  evidenceEnvelopes = citationTruthSecret
    ? new EvidenceEnvelopeService(citationTruthSecret)
    : null;
  try {
    personalizationSecretVault = new PersonalizationSecretVault(DATA_DIR, safeStorage);
  } catch (error) {
    personalizationSecretVault = null;
    console.warn('[Main] Personalization secret vault unavailable:', (error as Error)?.message);
  }

  // Load or create Current Affairs receipt signing secret
  caReceiptSecret = loadOrCreateCurrentAffairsReceiptSecret(DATA_DIR, safeStorage);

  // Initialize CA Runtime Service (DI wiring)
  // Validate + create artifact root under trusted DATA_DIR (fail-closed, no recursive traversal)
  const caArtifactRoot = path.join(DATA_DIR, 'ca-artifacts');
  if (!fs.existsSync(DATA_DIR)) throw new Error('[Main] DATA_DIR missing — cannot create CA artifact root');
  const dataDirStat = fs.lstatSync(DATA_DIR);
  if (dataDirStat.isSymbolicLink()) throw new Error('[Main] DATA_DIR is a symlink — rejecting');
  if (!fs.existsSync(caArtifactRoot)) {
    fs.mkdirSync(caArtifactRoot); // non-recursive: parent must exist
  }
  const artifactRootStat = fs.lstatSync(caArtifactRoot);
  if (artifactRootStat.isSymbolicLink()) throw new Error('[Main] CA artifact root is a symlink — rejecting');
  if (!artifactRootStat.isDirectory()) throw new Error('[Main] CA artifact root is not a directory — rejecting');

  const sharedGetSource = (id: string) => { try { const repo = researchRepository; if (!repo) return undefined; const src = repo.getSource(id); const adapted = src ? adaptSource(src) : undefined; return adapted ?? undefined; } catch { return undefined; } };
  const caApprovalStore = new CurrentAffairsApprovalStore({ now: () => Date.now(), signingSecret: caReceiptSecret ?? undefined });
  const caArtifactService = new CurrentAffairsArtifactService(caArtifactRoot);
  const caSessionState = new CurrentAffairsSessionState({ now: () => Date.now() });
  const caRepoService = new CurrentAffairsRepositoryService({
    getSource: sharedGetSource,
    now: () => Date.now(),
  });
  const { CurrentAffairsRuntimeService } = await import('./CurrentAffairsRuntimeService.js');
  caRuntime = new CurrentAffairsRuntimeService({
    repository: caRepoService, approvalStore: caApprovalStore, artifactService: caArtifactService,
    sessionState: caSessionState, receiptSecret: caReceiptSecret,
    now: () => Date.now(),
    getSource: sharedGetSource,
    confirmApproval: async (ctx) => {
      const win = caOwnerWindows.get(ctx.ownerSessionId);
      if (!win || win.isDestroyed()) { caOwnerWindows.delete(ctx.ownerSessionId); return false; }
      // Full Access removes per-action permission prompts. This callback still
      // fail-closes on owner/window loss; the runtime performs repository and
      // digest re-verification both before and after this automatic checkpoint,
      // then issues the same signed, replay-protected receipt as before.
      return true;
    },
  });
  if (!citationTruthReceipts) {
    console.warn('[Main] Citation truth key unavailable; verified deliverables and formal export are disabled.');
  }
  if (!evidenceEnvelopes) {
    console.warn('[Main] Evidence-envelope signer unavailable; third-party Skill and MCP results are disabled.');
  }

  // Initialize persistence (graceful degradation if native module fails)
  try {
    store = new PersistenceStore(DB_PATH);
    setSharedStore(store);
    jobQueueService.attachStore(store);
    literatureWatch.attachStore(store);
    literatureWatch.start();
    autoWorkspace.attach(null, store);
    // T33：如用户从云端暂存了恢复备份，现在应用（旧库自动另存）。
    if (cloudSync.applyStagedRestoreIfNeeded()) {
      store.close();
      store = new PersistenceStore(DB_PATH);
      setSharedStore(store);
      jobQueueService.attachStore(store);
      literatureWatch.attachStore(store);
      autoWorkspace.attach(null, store);
    }
    // Rolling automatic backups: snapshot on startup, then every 6 hours.
    // Failures are non-fatal and only logged — backups must never block the app.
    try {
      backupService = new BackupService(store, path.join(DATA_DIR, 'backups'), DB_PATH);
      void backupService.runBackup().catch(() => { /* best-effort */ });
      backupTimer = setInterval(() => {
        void backupService?.runBackup().catch(() => { /* best-effort */ });
      }, 6 * 60 * 60 * 1000);
    } catch {
      backupService = null;
    }
    // Persistent RAG index: load previously persisted documents so the
    // in-memory TF-IDF index survives restarts, then index the current library.
    try {
      void (async () => {
        const { getRagEngine } = await import('../engine/research/RagEngine.js');
        const engine = getRagEngine();
        const ragPath = path.join(DATA_DIR, 'manifest', 'rag-index.json');
        try {
          const persisted = fs.existsSync(ragPath) ? fs.readFileSync(ragPath, 'utf8') : '';
          if (persisted) engine.loadSerializedDocuments(persisted);
        } catch {
          // Corrupt or missing index is non-fatal; rebuild from the library.
        }
        const papers = (store?.getPapers() ?? []) as Parameters<typeof engine.indexPapersWithFullText>[0];
        if (papers.length > 0) engine.indexPapersWithFullText(papers);
        try {
          fs.mkdirSync(path.dirname(ragPath), { recursive: true });
          fs.writeFileSync(ragPath, engine.serializeDocuments(), 'utf8');
        } catch {
          // Persistence is best-effort; the in-memory index still works.
        }
      })();
    } catch {
      // RAG init must never block startup.
    }
    try {
      fundingTemplateRepository = new FundingTemplateRepository(DATA_DIR);
      fundingTemplateService = new FundingTemplateService(fundingTemplateRepository);
      const candidateFundingTemplateTools = new FundingTemplateToolService(fundingTemplateRepository, {
        resolveScope: (context) => {
          const scope = activeFundingToolScopes.get(context.sessionId);
          return scope ? { ownerId: scope.ownerId, projectId: scope.projectId } : null;
        },
      });
      const auditedToolIds = auditFundingTemplateToolRegistration(candidateFundingTemplateTools);
      if (!isFundingTemplateBuiltinDraftReady(auditedToolIds)) {
        throw new Error('Funding template ToolRegistry audit did not register both required tools');
      }
      fundingTemplateTools = candidateFundingTemplateTools;
    } catch (error) {
      fundingTemplateRepository = null;
      fundingTemplateService = null;
      fundingTemplateTools = null;
      console.warn('[Main] Funding template services unavailable:', (error as Error)?.message);
    }
    personalizationRepository = new PersonalizationRepository(store.raw, citationTruthSecret ?? undefined);
    personalizationRuntime = new PersonalizationRuntimeService(
      personalizationRepository,
      citationTruthSecret ?? undefined,
    );
    try {
      personalizationBundles = new PersonalizationBundleService(path.join(DATA_DIR, 'personalization-bundles'));
      personalizationBundleSink = new PersonalizationBundleRepositorySink(personalizationRepository);
    } catch (error) {
      personalizationBundles = null;
      personalizationBundleSink = null;
      console.warn('[Main] Personalization bundle service unavailable:', (error as Error)?.message);
    }
    // ── Personalization extension services ──────────────────────────
    // Each capability gets its own fault boundary so one failure never
    // degrades unrelated personalization services (pattern used elsewhere).
    const skillRoot = path.join(DATA_DIR, 'personalization-skills');
    const mcpRoot = path.join(DATA_DIR, 'personalization-mcp');
    try {
      personalizationSkills = new PersonalizationSkillInstaller(skillRoot);
    } catch (error) {
      personalizationSkills = null;
      console.warn('[Main] Personalization skill installer unavailable:', (error as Error)?.message);
    }
    try {
      personalizationMcp = new PersonalizationMcpInstaller(mcpRoot);
    } catch (error) {
      personalizationMcp = null;
      console.warn('[Main] Personalization MCP installer unavailable:', (error as Error)?.message);
    }
    // MCP builder needs a live provider and evidence signing; kept isolated
    // from the installers above so a provider gap cannot disable them.
    const extensionEvidence = evidenceEnvelopes;
    let mcpBuilder: McpBuilderService | null = null;
    let mcpProbeRunner: PersonalizationMcpProbeRunner | null = null;
    try {
      if (!extensionEvidence) throw new Error('Evidence signing is unavailable');
      if (!personalizationMcp) throw new Error('MCP installer is unavailable');
      mcpBuilder = new McpBuilderService(personalizationMcp, {
        createSpecification: async (input) => {
          const activeProvider = provider;
          if (!activeProvider) throw new Error('Provider is unavailable');
          const response = await activeProvider.complete([
            {
              role: 'system',
              content: [
                'Return one JSON object only. Do not use Markdown fences.',
                'Convert the requirement into the Metis MCP Builder DSL.',
                'The root keys must be exactly: contractVersion, packageId, version, name, description, tools, environment.',
                'Only echo, constant_json, and http_json implementations are allowed. Never include credentials; use environment secret references.',
                `The packageId must be exactly ${input.requestedPackageId}.`,
              ].join('\n'),
            },
            { role: 'user', content: input.requirement },
          ], undefined, { temperature: 0, response_format: { type: 'json_object' } });
          const raw = JSON.parse(response.content) as unknown;
          return McpBuilderSpecificationSchema.parse(raw);
        },
      });
      mcpProbeRunner = new PersonalizationMcpProbeRunner({
        resolve: (reference, context) => personalizationSecretVault?.resolve(reference, context),
      });
    } catch (error) {
      mcpBuilder = null;
      mcpProbeRunner = null;
      console.warn('[Main] Personalization MCP builder unavailable:', (error as Error)?.message);
    }
    // Activation + generated activation recovery (each recovery is verified).
    if (personalizationMcp && extensionEvidence && mcpProbeRunner) {
      try {
        const activation = new PersonalizationMcpActivationService(mcpRoot, {
          installer: personalizationMcp,
          runner: mcpProbeRunner,
          store: personalizationRepository,
          evidence: extensionEvidence,
        });
        const recovered = await activation.recoverPending();
        if (!recovered.ok) throw new Error('Pending MCP activation recovery did not complete');
        const generatedActivation = new GeneratedMcpActivationCoordinator(mcpRoot, {
          installer: personalizationMcp,
          store: personalizationRepository,
          activator: activation,
        });
        const generatedRecovered = await generatedActivation.recoverPending();
        if (!generatedRecovered.ok) throw new Error('Pending generated MCP activation recovery did not complete');
        personalizationMcpActivation = activation;
        personalizationGeneratedMcpActivation = generatedActivation;
      } catch (error) {
        personalizationMcpActivation = null;
        personalizationGeneratedMcpActivation = null;
        console.warn('[Main] Personalization MCP activation unavailable:', (error as Error)?.message);
      }
    }
    // Extension service needs every port; skipped (not cascaded) if any is missing.
    if (personalizationSkills && personalizationMcp && mcpBuilder && extensionEvidence) {
      try {
        personalizationExtensions = new PersonalizationExtensionService({
          definitions: {
            get: (id) => personalizationRepository?.get(id, true),
            save: (request) => personalizationRepository?.save(request) ?? { ok: false, code: 'io_error' },
          },
          evidence: extensionEvidence,
          skills: personalizationSkills,
          mcp: personalizationMcp,
          mcpBuilder,
          mcpProbeRunner: mcpProbeRunner ?? undefined,
          mcpCompensator: new FilesystemMcpInstallationCompensator(mcpRoot),
        });
      } catch (error) {
        personalizationExtensions = null;
        console.warn('[Main] Personalization extension service unavailable:', (error as Error)?.message);
      }
    }
    // Portable bundle coordinator (needs bundles sink + skill installer).
    try {
      if (!personalizationBundles || !personalizationBundleSink || !personalizationSkills) {
        throw new Error('Base personalization bundle services are unavailable');
      }
      const bundleAssetRoot = path.join(DATA_DIR, 'personalization-bundles');
      const rehydrationStagingRoot = path.join(DATA_DIR, 'personalization-bundle-skill-staging');
      const receiptRoot = path.join(DATA_DIR, 'personalization-bundle-receipts');
      const skillRehydrator = new PersonalizationBundleSkillRehydrationService(
        bundleAssetRoot,
        rehydrationStagingRoot,
        personalizationSkills,
      );
      personalizationBundleSkillAssets = new PersonalizationBundleSkillAssetSource(
        personalizationRepository,
        personalizationSkills,
      );
      personalizationBundleCoordinator = new PersonalizationBundleImportCoordinator({
        bundleService: personalizationBundles,
        definitionSink: personalizationBundleSink,
        skillRehydrator,
        skillCompensator: personalizationSkills,
        bundleAssetRoot,
        receiptRoot,
      });
    } catch (error) {
      personalizationBundleCoordinator = null;
      personalizationBundleSkillAssets = null;
      console.warn('[Main] Portable personalization bundles unavailable:', (error as Error)?.message);
    }
    // Managed MCP runtime + tool bridge.
    if (personalizationMcp && extensionEvidence) {
      try {
        personalizationMcpRuntime = new ManagedPersonalizationMcpRuntime(
          personalizationMcp,
          { resolve: (reference, context) => personalizationSecretVault?.resolve(reference, context) },
          extensionEvidence,
          {
            runtimeSnapshotRoot: path.join(DATA_DIR, 'personalization-mcp-runtime'),
            recoverStaleSnapshots: true,
          },
        );
        personalizationMcpBridge = new PersonalizationMcpToolBridge({
          runtime: personalizationMcpRuntime,
          definitions: personalizationRepository,
          descriptors: personalizationMcp,
          evidenceSink: {
            record: (envelope) => extensionEvidence.verify(envelope)
              && Boolean(personalizationRepository?.recordEvidenceEnvelope(envelope)),
          },
        });
      } catch (error) {
        personalizationMcpRuntime = null;
        personalizationMcpBridge = null;
        console.warn('[Main] Personalization MCP runtime unavailable:', (error as Error)?.message);
      }
    }
    researchRepository = new ResearchRepository(store.raw, (manifest, content) => {
      if (!researchRepository || !citationTruthReceipts) {
        return { receiptVerified: false, profileEnforced: false };
      }
      return verifyArtifactForPersistence(
        researchRepository,
        citationTruthReceipts,
        manifest,
        content,
      );
    });
    researchMedia = new ResearchMediaService({
      repository: researchRepository,
      fileCapabilities,
      managedRoot: RESEARCH_MEDIA_DIR,
    });
    autoWorkspace.attach(researchRepository, null);
    researchRuntime = new ResearchRuntimeService(
      researchRepository,
      researchMedia,
      citationTruthReceipts ?? undefined,
    );
    // Initialize experiment script adapter (GLM-102)
    try {
      experimentScriptAdapter = createExperimentScriptAdapter({
        db: store.raw,
        resourcesPath: process.resourcesPath,
        processSecret: EXPERIMENT_SESSION_SECRET,
      });
      console.log('[Main] ExperimentScriptAdapter initialized.');
    } catch (err: unknown) {
      experimentScriptAdapter = null;
      console.warn('[Main] ExperimentScriptAdapter failed:', (err as Error)?.message);
    }
    console.log('[Main] PersistenceStore initialized.');
    // Resume a previously bound WeChat bot (polling starts only if bound).
    try {
      ensureWeChatBot?.()?.start();
    } catch (err: unknown) {
      console.warn('[Main] WeChat bot resume failed:', (err as Error)?.message);
    }
  } catch (err: unknown) {
    personalizationRepository = null;
    personalizationRuntime = null;
    personalizationSkills = null;
    personalizationMcp = null;
    personalizationMcpRuntime = null;
    personalizationMcpBridge = null;
    personalizationMcpActivation = null;
    personalizationGeneratedMcpActivation = null;
    personalizationExtensions = null;
    personalizationBundles = null;
    personalizationBundleSink = null;
    personalizationBundleCoordinator = null;
    personalizationBundleSkillAssets = null;
    fundingTemplateRepository = null;
    fundingTemplateService = null;
    fundingTemplateTools = null;
    researchRepository = null;
    researchRuntime = null;
    researchMedia = null;
    console.warn('[Main] PersistenceStore failed to load (SQLite native module not available). Running without persistence.');
    console.warn('[Main] Error:', (err as Error)?.message);
    // store remains null — IPC handlers check for null
  }

  // Initialize memory manager
  if (store) {
    memoryManager = new MemoryManager(store, DATA_DIR);
  }

  // Initialize MCP manager (before agent so tools can be registered)
  if (store) {
    mcpManager = new MCPManager(store, new ToolRegistry());
  }

  // Initialize skill registry with default skills + reload any custom skills
  // the user generated in a previous session (persisted in the memory store).
  skillRegistry = registerDefaultSkills();
  skillExtractor = new SkillExtractor(provider ?? undefined);
  loadAndInstallCustomSkills();



  // Setup IPC before loading the renderer, then create the initial window.
  setupIPC();
  // METIS-OPT-4: show the window immediately; heavy personalization
  // initialization below continues in the background. The renderer waits on
  // store:ready before hydrating, so early UI never sees a half-initialized
  // main process.
  createWindow();

  // Restore the OS-protected first-run configuration and atomically prepare the
  // provider runtime before the renderer loads. Legacy configuration remains a
  // migration fallback only when no new setup envelope is ready.
  let setupRestored = false;
  try {
    firstRunSetup = new FirstRunSetupService({
      configPath: SETUP_CONFIG_PATH,
      secureStorage: createFirstRunSecureStorage(safeStorage),
      probeTransport: new OpenAISetupProbeTransport(),
      runtimeRebuilder: {
        prepare: async (context) => prepareProviderRuntime(context),
      },
    });
    const restored = await firstRunSetup.restore({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: 'startup-restore',
    });
    setupRestored = restored.state === 'ready';
  } catch {
    firstRunSetup?.dispose();
    firstRunSetup = null;
  }
  currentTheme = loadTheme();
  if (!setupRestored) initProviderAndAgent();

  // The profile envelope becomes the authoritative multi-model source after a
  // successful migration. A failure intentionally leaves the existing setup
  // runtime untouched and exposes only a fixed unavailable state to the UI.
  if (providerProfileStore) {
    const initialized = await providerProfileStore.initialize(currentConfig);
    if (!initialized.ok) {
      providerProfileStore = null;
      providerProfileStorage = null;
    } else {
      const profiles = providerProfileStore.list();
      const active = profiles.ok ? profiles.value.profiles.find((profile) => profile.isActive) : undefined;
      if (!active) {
        // A safe envelope with no active profile is an explicit user reset;
        // never resurrect a legacy setup configuration on restart.
        deactivateProviderRuntime('provider_profiles_unconfigured');
      } else {
        const activeConfig = providerProfileStore.configFor(active.id);
        if (activeConfig.ok) {
          try {
            const candidate = prepareProviderRuntime(providerProfileRuntimeContext(activeConfig.value, 'restore'));
            await candidate.commitAndAbortPrevious();
          } catch {
            // The profile file remains authoritative; an unusable active profile
            // does not silently fall back to an older configuration source.
            deactivateProviderRuntime('provider_profile_restore_failed');
          }
        } else {
          deactivateProviderRuntime('provider_profile_restore_failed');
        }
      }
    }
  }
  startupReady = true;

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  fileCapabilities.clear();
  exportPreviews.clear();
  for (const session of activeTerminals.values()) {
    session.killed = true;
    session.terminal.kill();
  }
  activeTerminals.clear();
  executionCapabilities?.clear();
  experimentScriptAdapter?.dispose();
  firstRunSetup?.dispose();
  firstRunSetup = null;
  mcpManager?.disconnectAll().catch(() => {});
  void personalizationMcpRuntime?.shutdownAll();
  store?.close();
  store = null;
  researchRepository = null;
  researchRuntime = null;
  researchMedia = null;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  if (weChatBotService) {
    void weChatBotService.stop().catch(() => {});
    weChatBotService = null;
  }
  // Tear down any running OfficeCli watch servers so no orphans linger.
  getOfficeCliService().shutdown();
  fileCapabilities.clear();
  exportPreviews.clear();
  for (const session of activeTerminals.values()) {
    session.killed = true;
    session.terminal.kill();
  }
  activeTerminals.clear();
  executionCapabilities?.clear();
  experimentScriptAdapter?.dispose();
  firstRunSetup?.dispose();
  firstRunSetup = null;
  mcpManager?.disconnectAll().catch(() => {});
  void personalizationMcpRuntime?.shutdownAll();
  store?.close();
  store = null;
  researchRepository = null;
  researchRuntime = null;
  researchMedia = null;
});

