/**
 * Settings bridge — Store 就绪状态 / 运行时身份 / Setup 向导（probe/save/
 * restore/abort，含进度事件关联）/ Settings 读写 / 更新与诊断 / 存储位置 /
 * 项目级 provider 覆盖 / ISSN 列表导入（从 preload.ts 迁出，2026-09-15 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 * invokeSetupWithProgress 辅助函数随迁（仅本 bridge 的 setup:probe/setup:save
 * 使用；通过 setup:progress 的 operationId 关联进度事件）。
 */
import { ipcRenderer } from 'electron';
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
} from '../../engine/runtime/SetupRuntimeContract.js';
import {
  createSettingsMutationFailure,
  decodeSettingsMutationResult,
  decodeSettingsUpdateRequest,
  decodeSettingsView,
} from '../../engine/runtime/SettingsRuntimeContract.js';

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

export const settingsBridge = {
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

  // ── Settings ───────────────────────────────────────────
  getSettings: async () => decodeSettingsView(await ipcRenderer.invoke('settings:get')),
  markSetupSkipped: async () => ipcRenderer.invoke('settings:markSetupSkipped') as Promise<{ ok: boolean; error?: string }>,
  checkForUpdates: async () => ipcRenderer.invoke('update:check') as Promise<unknown>,
  getUpdateStatus: async () => ipcRenderer.invoke('update:status') as Promise<unknown>,
  downloadUpdate: async () => ipcRenderer.invoke('update:download') as Promise<unknown>,
  installUpdate: async () => ipcRenderer.invoke('update:install') as Promise<unknown>,
  getHealthReport: async () => ipcRenderer.invoke('diagnostics:healthReport') as Promise<unknown>,
  exportDiagnosticBundle: async () => ipcRenderer.invoke('diagnostics:exportBundle') as Promise<{ ok: boolean; path?: string; sha256?: string; entries?: number; error?: string }>,

  // ── O13: 项目级 provider/model 覆盖 ──
  getProjectProviderOverride: async (projectId: string) =>
    ipcRenderer.invoke('project:getProviderOverride', projectId) as Promise<
      { ok: true; override: import('../../engine/runtime/ProviderProfileContract.js').ProjectProviderOverride | null }
      | { ok: false; code: string }
    >,
  setProjectProviderOverride: async (request: {
    projectId: string;
    override: import('../../engine/runtime/ProviderProfileContract.js').ProjectProviderOverride | null;
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

  importIssnList: async () => ipcRenderer.invoke('settings:importIssnList') as Promise<{ ok: boolean; added: number; totalCandidates?: number; error?: string }>,

  setSettings: async (config: unknown) => {
    const request = decodeSettingsUpdateRequest(config);
    if (!request) return createSettingsMutationFailure('secure_setup_required');
    return decodeSettingsMutationResult(await ipcRenderer.invoke('settings:set', request));
  },
};
