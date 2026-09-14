/**
 * Office bridge — Skill Studio 生成/试跑 + Metis Office prompt profiles + 项目默认场景
 * + 阶段检测（从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';

export const officeBridge = {
  skillStudioGenerate: async (request: { experience: string; source: 'from_scratch' | 'from_experience' | 'from_files' | 'from_session' }) => (
    ipcRenderer.invoke('skillStudio:generate', request) as Promise<{ ok: boolean; code?: string; message?: string; skill?: Record<string, unknown> }>
  ),
  skillStudioTestRun: async (request: { systemPrompt: string; allowedTools: string[]; message: string }) => (
    ipcRenderer.invoke('skillStudio:testRun', request) as Promise<{ ok: boolean; status?: string; answer?: string; message?: string }>
  ),
  officePromptCapabilities: async () => (
    ipcRenderer.invoke('officePrompt:capabilities') as Promise<Array<{ kind: string; label: string; profileCount: number; defaultProfileId: string | null; aiEnabled: boolean }>>
  ),
  officePromptProfiles: async (officeKind: string) => (
    ipcRenderer.invoke('officePrompt:profiles', { officeKind }) as Promise<Array<{ id: string; officeKind: string; name: string; description: string; builtin: boolean; slots: Record<string, string>; deletedAt: number | null; createdAt: number; updatedAt: number }>>
  ),
  officePromptCreateProfile: async (request: { officeKind: string; name: string; description?: string; fromProfileId?: string }) => (
    ipcRenderer.invoke('officePrompt:createProfile', request) as Promise<{ ok: boolean; code?: string; profile?: Record<string, unknown> }>
  ),
  officePromptUpdateProfile: async (request: { profileId: string; name?: string; description?: string }) => (
    ipcRenderer.invoke('officePrompt:updateProfile', request) as Promise<Record<string, unknown> | null>
  ),
  officePromptDeleteProfile: async (profileId: string) => (
    ipcRenderer.invoke('officePrompt:deleteProfile', { profileId }) as Promise<boolean>
  ),
  officePromptDeletedProfiles: async (officeKind: string) =>
    ipcRenderer.invoke('officePrompt:deletedProfiles', { officeKind }) as Promise<Array<Record<string, unknown>>>,
  officePromptRestoreProfile: async (profileId: string) => (
    ipcRenderer.invoke('officePrompt:restoreProfile', { profileId }) as Promise<Record<string, unknown> | null>
  ),
  officePromptGetGlobal: async (request: { officeKind: string; outcomeId?: string | null }) =>
    ipcRenderer.invoke('officePrompt:getGlobal', request) as Promise<string | null>,
  officePromptSetGlobal: async (request: { profileId: string; content: string }) =>
    ipcRenderer.invoke('officePrompt:setGlobal', request) as Promise<Record<string, unknown> | null>,
  officePromptSetSlot: async (request: { profileId: string; slotId: string; content: string }) => (
    ipcRenderer.invoke('officePrompt:setSlot', request) as Promise<{ ok: boolean; code?: string }>
  ),
  officePromptSetDefault: async (request: { officeKind: string; profileId: string }) => (
    ipcRenderer.invoke('officePrompt:setDefault', request) as Promise<{ ok: boolean; code?: string }>
  ),
  officePromptGetBinding: async (outcomeId: string) =>
    ipcRenderer.invoke('officePrompt:getBinding', { outcomeId }) as Promise<string | null>,
  officePromptBindOutcome: async (request: { outcomeId: string; profileId: string | null }) => (
    ipcRenderer.invoke('officePrompt:bindOutcome', request) as Promise<{ ok: boolean }>
  ),
  officePromptResolveSlot: async (request: { officeKind: string; outcomeId?: string | null; slotId: string }) => (
    ipcRenderer.invoke('officePrompt:resolveSlot', request) as Promise<{ content: string | null }>
  ),

  getDefaultScenario: async (projectId: string) => (
    ipcRenderer.invoke('projects:getDefaultScenario', { projectId }) as Promise<{ scenarioId: string | null }>
  ),
  setDefaultScenario: async (projectId: string, scenarioId: string | null) => (
    ipcRenderer.invoke('projects:setDefaultScenario', { projectId, scenarioId }) as Promise<{ ok: boolean }>
  ),
  detectStage: async (projectId: string) => ipcRenderer.invoke('research:detectStage', projectId) as Promise<{ stage: string; rationale: string[] } | null>,
};
