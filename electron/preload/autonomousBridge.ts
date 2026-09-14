/**
 * Autonomous research engine bridge（从 preload.ts 迁出，2026-09-13 拆分）。
 */
import { ipcRenderer } from 'electron';
import {
  AUTONOMOUS_CHANNELS,
  AUTONOMOUS_CONTRACT_VERSION,
  decodeAutonomousControlRequest,
  decodeAutonomousLiveEvent,
  decodeAutonomousStartRequest,
  type AutonomousLiveEvent,
} from '../../engine/runtime/AutonomousRuntimeContract.js';

type AutonomousEngineStartedEvent = Extract<AutonomousLiveEvent, { type: 'engine-started' }>;
type AutonomousEngineFailedEvent = Extract<AutonomousLiveEvent, { type: 'engine-failed' }>;
type AutonomousPhaseStartedEvent = Extract<AutonomousLiveEvent, { type: 'phase-started' }>;
type AutonomousStepEvent = Extract<AutonomousLiveEvent, { type: 'step-start' | 'step-complete' | 'step-failed' }>;
type AutonomousReflectionEvent = Extract<AutonomousLiveEvent, { type: 'reflection' }>;
type AutonomousProgressEvent = Extract<AutonomousLiveEvent, { type: 'progress' }>;
type AutonomousEngineCompletedEvent = Extract<AutonomousLiveEvent, { type: 'engine-completed' }>;
type AutonomousEngineInterruptedEvent = Extract<AutonomousLiveEvent, { type: 'engine-interrupted' }>;
type AutonomousEnginePausedEvent = Extract<AutonomousLiveEvent, { type: 'engine-paused' }>;
type AutonomousEngineResumedEvent = Extract<AutonomousLiveEvent, { type: 'engine-resumed' }>;


export const autonomousBridge = {
  // ── Autonomous research engine ───────────────────────────
  autonomousStart: async (request: { goal: string; projectId?: string; sessionId?: string; strategyId?: string; structureId?: string }) => {
    const decoded = decodeAutonomousStartRequest({ version: AUTONOMOUS_CONTRACT_VERSION, ...request });
    if (!decoded) return { ok: false, error: 'invalid_request' };
    return ipcRenderer.invoke(AUTONOMOUS_CHANNELS.start, decoded) as Promise<{ ok: boolean; sessionId?: string; projectId?: string; error?: string }>;
  },
  autonomousControl: async (request: { sessionId: string; action: 'pause' | 'resume' | 'interrupt'; reason?: string }) => {
    const decoded = decodeAutonomousControlRequest({ version: AUTONOMOUS_CONTRACT_VERSION, ...request });
    if (!decoded) return { ok: false, code: 'invalid_request' };
    return ipcRenderer.invoke(AUTONOMOUS_CHANNELS.control, decoded) as Promise<{ ok: boolean; code?: string }>;
  },
  autonomousListSessions: async () => ipcRenderer.invoke(AUTONOMOUS_CHANNELS.listSessions) as Promise<{
    sessions: Array<{
      sessionId: string;
      goal: string;
      projectId?: string;
      executions: number;
      completedPhases: number;
      savedAt: number;
      state: 'running' | 'paused';
      failureReason?: string;
    }>;
  }>,
  onAutonomousEngineStarted: (callback: (data: AutonomousEngineStartedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-started') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineStarted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineStarted, handler); };
  },
  onAutonomousPhaseStarted: (callback: (data: AutonomousPhaseStartedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'phase-started') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.phaseStarted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.phaseStarted, handler); };
  },
  onAutonomousStep: (callback: (data: AutonomousStepEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && (decoded.type === 'step-start' || decoded.type === 'step-complete' || decoded.type === 'step-failed')) callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.stepStart, handler);
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.stepComplete, handler);
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.stepFailed, handler);
    return () => {
      ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.stepStart, handler);
      ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.stepComplete, handler);
      ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.stepFailed, handler);
    };
  },
  onAutonomousReflection: (callback: (data: AutonomousReflectionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'reflection') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.reflection, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.reflection, handler); };
  },
  onAutonomousProgress: (callback: (data: AutonomousProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'progress') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.progress, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.progress, handler); };
  },
  onAutonomousCompleted: (callback: (data: AutonomousEngineCompletedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-completed') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineCompleted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineCompleted, handler); };
  },
  onAutonomousFailed: (callback: (data: AutonomousEngineFailedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const decoded = decodeAutonomousLiveEvent(raw);
      if (decoded && decoded.type === 'engine-failed') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineFailed, handler);
    return () => ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineFailed, handler);
  },
  onAutonomousInterrupted: (callback: (data: AutonomousEngineInterruptedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-interrupted') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineInterrupted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineInterrupted, handler); };
  },
  onAutonomousPaused: (callback: (data: AutonomousEnginePausedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-paused') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.enginePaused, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.enginePaused, handler); };
  },
  onAutonomousResumed: (callback: (data: AutonomousEngineResumedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-resumed') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineResumed, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineResumed, handler); };
  },
  autonomousResumeSession: async (sessionId: string) => {
    return ipcRenderer.invoke(AUTONOMOUS_CHANNELS.resumeSession, sessionId) as Promise<{ ok: boolean; goal?: string; error?: string }>;
  },
  strategyList: async () => ipcRenderer.invoke('strategy:list') as Promise<{ ok: boolean; strategies?: Array<Record<string, unknown>> }>,
  strategySave: async (strategy: Record<string, unknown>) => ipcRenderer.invoke('strategy:save', { strategy }) as Promise<{ ok: boolean; error?: string }>,
  strategyDelete: async (strategyId: string) => ipcRenderer.invoke('strategy:delete', { strategyId }) as Promise<{ ok: boolean; error?: string }>,
  strategySetDefault: async (strategyId: string) => ipcRenderer.invoke('strategy:setDefault', { strategyId }) as Promise<{ ok: boolean; error?: string }>,
  structureList: async () => ipcRenderer.invoke('structure:list') as Promise<{ ok: boolean; templates?: Array<Record<string, unknown>> }>,
  structureSave: async (template: Record<string, unknown>) => ipcRenderer.invoke('structure:save', { template }) as Promise<{ ok: boolean; error?: string }>,
  structureDelete: async (templateId: string) => ipcRenderer.invoke('structure:delete', { templateId }) as Promise<{ ok: boolean; error?: string }>,

};
