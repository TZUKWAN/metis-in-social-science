/**
 * Research workflow bridge — Method library (T4) + Research agenda (T24)
 * + Autonomous profile & batch topics (自主改造 A/B) + Concept graph (T28)
 * （从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';

export const researchWorkflowBridge = {
  // ── Method library (T4): reusable research workflows ──
  listMethods: async () => ipcRenderer.invoke('methods:list') as Promise<Array<{
    id: string;
    name: string;
    description: string;
    params: Record<string, string>;
    steps: Array<{ template: string }>;
    confirmEachStep: boolean;
    sourceProjectId: string | null;
    createdAt: number;
    updatedAt: number;
    runCount: number;
    lastRunAt: number | null;
  }>>,
  createMethod: async (request: { name: string; description?: string; steps: Array<{ template: string }>; confirmEachStep?: boolean; sourceProjectId?: string | null }) =>
    ipcRenderer.invoke('methods:create', request) as Promise<{ id: string } | null>,
  updateMethod: async (request: { id: string; name?: string; description?: string; steps?: Array<{ template: string }>; confirmEachStep?: boolean }) =>
    ipcRenderer.invoke('methods:update', request) as Promise<{ id: string } | null>,
  deleteMethod: async (methodId: string) => ipcRenderer.invoke('methods:delete', methodId) as Promise<boolean>,
  renderMethod: async (methodId: string, params: Record<string, string>) =>
    ipcRenderer.invoke('methods:render', { id: methodId, params }) as Promise<Array<{ instruction: string }> | null>,
  recordMethodRun: async (request: { id: string; projectId: string | null; params: Record<string, string>; outcome: 'applied' | 'cancelled' }) =>
    ipcRenderer.invoke('methods:recordRun', request) as Promise<void>,
  // ── Research agenda (T24) ──
  getAgendaState: async () => ipcRenderer.invoke('agenda:getState') as Promise<{
    queue: Array<{ projectId: string; title: string; runsCompleted: number; maxRuns: number; enqueuedAt: number; autonomous?: boolean; goalPrompt?: string }>;
    autoContinue: boolean;
    cooldownMs: number;
    lastAdvanceAt: number | null;
  }>,
  enqueueAgenda: async (request: { projectId: string; title: string; maxRuns?: number }) =>
    ipcRenderer.invoke('agenda:enqueue', request) as Promise<{ projectId: string } | { error: string }>,
  removeAgenda: async (projectId: string) => ipcRenderer.invoke('agenda:remove', projectId) as Promise<boolean>,
  moveAgenda: async (projectId: string, direction: 'up' | 'down') => ipcRenderer.invoke('agenda:move', { projectId, direction }) as Promise<boolean>,
  setAgendaAutoContinue: async (enabled: boolean) => ipcRenderer.invoke('agenda:setAutoContinue', enabled) as Promise<{ autoContinue: boolean }>,
  reportAgendaCompletion: async (request: { projectId: string; success: boolean }) =>
    ipcRenderer.invoke('agenda:reportCompletion', request) as Promise<{ action: string; projectId: string | null; waitMs?: number; note: string }>,
  decideAgendaNext: async () => ipcRenderer.invoke('agenda:decideNext') as Promise<{ action: string; projectId: string | null; waitMs?: number; note: string }>,
  enqueueAgendaBatch: async (request: { entries: Array<{ key: string; title: string; goalPrompt: string }>; maxRuns?: number }) =>
    ipcRenderer.invoke('agenda:enqueueBatch', request) as Promise<{ added: number }>,
  // ── Autonomous profile & batch topics (自主改造 A/B) ──
  getAutonomousProfile: async () => ipcRenderer.invoke('autonomousProfile:get') as Promise<{
    version: 1;
    defaultPrompt: string;
    defaultBatchSize: number;
    injectUserProfile: boolean;
    constraints: {
      fieldPreference: string;
      methodPreference: 'any' | 'quantitative' | 'qualitative' | 'mixed';
      outputForm: 'any' | 'journal_article' | 'report';
      journalTier: 'any' | 'core' | 'general';
      language: 'zh' | 'en';
      lengthTarget: string;
      customRules: string[];
    };
  }>,
  saveAutonomousProfile: async (request: Record<string, unknown>) => ipcRenderer.invoke('autonomousProfile:save', request) as Promise<{ version: 1 }>,
  getAutonomousHardRules: async () => ipcRenderer.invoke('autonomousProfile:hardRules') as Promise<string[]>,
  generateAutonomousBatch: async (request: { prompt: string; count: number; method?: 'any' | 'quantitative' | 'qualitative' | 'mixed'; output?: 'any' | 'journal_article' | 'report' }) =>
    ipcRenderer.invoke('autonomous:generateBatch', request) as Promise<{
      ok: boolean; error?: string; added?: number; raw?: string;
      topics?: Array<{ title: string; researchQuestion: string; rationale: string }>;
    }>,
  createProjectForAutonomous: async (request: { title: string; researchQuestion?: string }) =>
    ipcRenderer.invoke('autonomous:createProjectFor', request) as Promise<{ ok: boolean; projectId: string | null }>,
  // ── Concept graph (T28) ──
  getConceptGraph: async (projectId: string) => ipcRenderer.invoke('concept:getGraph', projectId) as Promise<{
    nodes: Array<{ id: string; kind: 'source' | 'code' | 'claim'; label: string }>;
    edges: Array<{ from: string; to: string; kind: 'supports' | 'coded' }>;
  } | null>,
};
