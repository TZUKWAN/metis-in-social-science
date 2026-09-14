/**
 * Terminal bridge — 受控终端授权/生命周期 + 数据/退出事件订阅
 * （从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';
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
} from '../../engine/runtime/TerminalRuntimeContract.js';

export const terminalBridge = {
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
