/**
 * Document bridge — LaTeX 编译/AI 润色 + 文件能力选择导入 + 研究导出 + 外链打开
 * （从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';
import { inspectExternalNavigationUrl } from '../../engine/security/ExternalNavigation.js';
import {
  createLatexCompileRecovery,
  decodeLatexCompileRequest,
  decodeLatexCompileResponse,
} from '../../engine/runtime/LatexRuntimeContract.js';
import {
  createFileCapabilityFailure,
  decodeFileCapabilityImportRequest,
  decodeFileCapabilitySelectionRequest,
  decodeFileCapabilitySelectionResult,
  decodeFileCapabilityUseRequest,
  decodeFileCapabilityUseResult,
  type FileCapabilityPurpose,
} from '../../engine/runtime/FileCapabilityContract.js';
import {
  createExportFailure,
  decodeExportRequest,
  decodeExportResult,
  type ExportRequest,
} from '../../engine/runtime/ExportRuntimeContract.js';

export const documentBridge = {
  // ── LaTeX ────────────────────────────────────────────────
  compileLatex: async (source: string, bib?: string) => {
    const request = decodeLatexCompileRequest({ source, bibliography: bib });
    if (!request.ok) return createLatexCompileRecovery();
    return decodeLatexCompileResponse(
      await ipcRenderer.invoke('latex:compile', request.value.source, request.value.bibliography),
    );
  },
  aiPolishLatex: async (request: { text: string; action?: 'polish' | 'rewrite' | 'expand' }) => ipcRenderer.invoke('latex:aiPolish', request) as Promise<{ ok: boolean; text?: string; error?: string }>,

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
};
