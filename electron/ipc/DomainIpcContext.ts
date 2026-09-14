/**
 * Dependency-injection surface handed to every domain IPC registrar
 * (Task 3 §4). Registrars must receive everything that used to be module
 * state in `main.ts` through this context, so they stay import-cycle free
 * from `main.ts` and unit-testable without Electron.
 *
 * The interface grows per migrated domain; keep entries grouped by domain.
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import type { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import type { FreeModelService } from '../FreeModelService.js';
import type { TopicService } from '../TopicService.js';
import type { RuntimeShutdownCoordinator } from '../RuntimeShutdownCoordinator.js';
import type { BrowserService } from '../BrowserService.js';
import type { CollabService } from '../CollabService.js';
import type { WeChatBotService } from '../WeChatBotService.js';
import type { ProviderProfileStore } from '../ProviderProfileStore.js';
import type { ExperimentScriptAdapter } from '../ExperimentScriptAdapter.js';
import type { FileCapabilityRegistry } from '../FileCapabilityRegistry.js';
import type { IpcRegistry } from './IpcRegistry.js';

export interface DomainIpcContext {
  /** Process-wide registration ledger (duplicate gate + disposers). */
  registry: IpcRegistry;
  /** Throws unless the invoking sender is the authorized main frame. */
  requireRendererMainFrame(event: IpcMainInvokeEvent): BrowserWindow;
  /** Cooperative shutdown coordinator (admission for long operations). */
  runtimeShutdown: RuntimeShutdownCoordinator;

  // ── AI runtime ────────────────────────────────────────────
  /** Live agent loop, or null before the provider runtime is ready. */
  agentLoop(): AgentLoop | null;
  provider(): OpenAICompatProvider | null;

  // ── Goal domain ───────────────────────────────────────────
  /** Live Goal engine, or null before the runtime is ready. */
  goalEngine(): import('../../engine/goal/GoalEngine.js').GoalEngine | null;
  /** Process-wide monotonic request counter (shutdown ids, dedupe keys). */
  nextRequestId(): number;
  /** Broadcast a goal change to every live window (schema-decoded). */
  broadcastGoalChanged(
    sender: IpcMainInvokeEvent['sender'],
    goal: import('../../engine/goal/GoalPlanner.js').Goal,
    statusOverride?: 'draft' | 'planning' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
  ): void;
  /** O13: resolve project-scoped provider overrides for a goal execution. */
  resolveGoalExecutionOptions(
    goal: { projectId?: string },
  ): import('../../engine/goal/GoalEngine.js').GoalExecutionOptions;

  // ── Persistence ───────────────────────────────────────────
  store(): PersistenceStore | null;
  researchRepository(): ResearchRepository | null;
  providerProfileStore(): ProviderProfileStore | null;

  // ── Topic domain ──────────────────────────────────────────
  ensureTopicService(): TopicService;

  // ── Free-model domain ─────────────────────────────────────
  freeModelService(): FreeModelService | null;

  // ── Experiment domain ─────────────────────────────────────
  experimentScriptAdapter(): ExperimentScriptAdapter | null;

  // ── Artifact / capability domain ──────────────────────────
  /** Process-wide registry; created at module load, never reassigned. */
  fileCapabilities(): FileCapabilityRegistry;

  // ── Host environment ──────────────────────────────────────
  /** Resolved data directory (lazy: it binds after module init). */
  dataDir(): string;
  /** Electron userData directory (storage-location pointer files). */
  userDataDir(): string;
  /** Default data directory (before user relocation). */
  defaultDataDir(): string;

  // ── Backup domain ─────────────────────────────────────────
  backupService(): import('../BackupService.js').BackupService | null;

  // ── WeChat bot domain ─────────────────────────────────────
  ensureWeChatBot(): WeChatBotService | null;

  // ── Outcomes（数据管理子域）──────────────────────────────
  outcomeRepository(): import('../OutcomeRepository.js').OutcomeRepository | null;
  purgeExpiredOutcomeTrash(): void;
  submissionRepository(): import('../SubmissionRepository.js').SubmissionRepository | null;
  // ── Research browser domain ─────────────────────────────
  /** Live browser service instance, or null before first use. */
  browserService(): import('../BrowserService.js').BrowserService | null;
  /** Lazily constructs the embedded research browser service. */
  ensureBrowserService(): import('../BrowserService.js').BrowserService | null;
  /** Background job queue (PDF extraction etc.); present after data dir init. */
  jobQueueService(): import('../JobQueueService.js').JobQueueService | null;

  // ── Collab domain ─────────────────────────────────────────
  browserService(): BrowserService | null;
  collabService(): CollabService | null;
  ensureCollabService(): CollabService | null;
}
