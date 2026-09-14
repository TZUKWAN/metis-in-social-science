/**
 * Backup bridge — 本地滚动备份 + WebDAV 云备份（从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 * 注意：systemBridge 中有一份同通道的 listBackups/restoreBackup 旧拷贝；
 * 主文件 spread 时 backupBridge 必须排在 systemBridge 之后，保持与迁移前
 * 相同的生效实现（原先内联定义同样覆盖 systemBridge 版本）。
 */
import { ipcRenderer } from 'electron';

export const backupBridge = {
  // ── Local rolling backups (task 1 §八：受控恢复，完整重启语义) ──
  listBackups: async () => ipcRenderer.invoke('backup:list') as Promise<{ backups: Array<{ path: string; name: string }> }>,
  restoreBackup: async (backupPath: string) => ipcRenderer.invoke('backup:restore', { backupPath }) as Promise<{ ok: boolean; error?: string; rollback?: string }>,
  // ── WebDAV cloud backup (T33) ──
  getCloudSyncConfig: async () => ipcRenderer.invoke('cloudSync:getConfig') as Promise<{ configured: boolean; url?: string; username?: string }>,
  saveCloudSyncConfig: async (request: { url: string; username: string; password: string }) =>
    ipcRenderer.invoke('cloudSync:saveConfig', request) as Promise<{ ok: boolean }>,
  clearCloudSyncConfig: async () => ipcRenderer.invoke('cloudSync:clearConfig') as Promise<{ ok: boolean }>,
  testCloudSync: async () => ipcRenderer.invoke('cloudSync:test') as Promise<{ ok: boolean; error?: string }>,
  backupToCloud: async () => ipcRenderer.invoke('cloudSync:backup') as Promise<{ ok: boolean; objectName?: string; error?: string }>,
  listCloudBackups: async () => ipcRenderer.invoke('cloudSync:listBackups') as Promise<string[]>,
  stageCloudRestore: async (objectName: string) => ipcRenderer.invoke('cloudSync:stageRestore', objectName) as Promise<{ ok: boolean; error?: string }>,
};
