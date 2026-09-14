/**
 * Experiments bridge — GLM-102 安全执行（从 preload.ts 迁出，2026-09-13 拆分）。
 */
import { ipcRenderer } from 'electron';
import {
  ExperimentIdSchema,
  decodeExperimentExecutionGrantRequest,
  decodeExperimentExecutionGrantResult,
  decodeExperimentRunRequest,
  decodeExperimentRunResult,
  decodeExperimentScriptAttachRequest,
  decodeExperimentScriptAttachResult,
} from '../../engine/runtime/ExperimentRuntimeContract.js';


export const experimentBridge = {
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

};
