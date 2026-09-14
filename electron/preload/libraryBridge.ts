/**
 * Library bridge — Papers / Collections / Notes（从 preload.ts 迁出，2026-09-14 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';
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
} from '../../engine/runtime/LibraryRuntimeContract.js';
import {
  createPaperAttachmentFailure,
  createPaperDownloadFailure,
  createPaperMutationFailure,
  decodePaperAttachmentResult,
  decodePaperDownloadResult,
  decodePaperIdRequest,
  decodePaperMutationResult,
} from '../../engine/runtime/PaperRuntimeContract.js';
import {
  decodeExperimentDelete,
  decodeExperimentList,
  decodeExperimentMutationResult,
  decodeExperimentSave,
} from '../../engine/runtime/ExperimentMetadataContract.js';

export const libraryBridge = {
  // ── Papers ─────────────────────────────────────────────
  listPapers: async () => decodeLibraryPaperList(await ipcRenderer.invoke('paper:list')),
  savePaper: async (paper: unknown) => {
    const request = decodeLibraryPaperSaveRequest(paper);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('paper:save', request));
  },
  deletePaper: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('paper:delete', request.id));
  },
  attachPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperAttachmentFailure();
    return decodePaperAttachmentResult(await ipcRenderer.invoke('paper:attachPdf', request.value));
  },
  detachPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperMutationFailure();
    return decodePaperMutationResult(await ipcRenderer.invoke('paper:detachPdf', request.value));
  },
  downloadPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperDownloadFailure();
    return decodePaperDownloadResult(await ipcRenderer.invoke('paper:downloadPdf', request.value));
  },
  reconcilePaper: async (request: { paperId: string; doi?: string; title?: string }) =>
    ipcRenderer.invoke('paper:reconcile', request) as Promise<{
      ok: boolean;
      paper?: { title: string; authors: string[]; year: number; venue: string; doi?: string; abstract?: string };
      error?: string;
    }>,

  // ── Collections ────────────────────────────────────────
  listCollections: async () => decodeLibraryCollectionList(await ipcRenderer.invoke('collection:list')),
  saveCollection: async (collection: unknown) => {
    const request = decodeLibraryCollection(collection);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('collection:save', request));
  },
  deleteCollection: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('collection:delete', request.id));
  },

  // ── Notes ──────────────────────────────────────────────
  listNotes: async () => decodeLibraryNoteList(await ipcRenderer.invoke('note:list')),
  saveNote: async (note: unknown) => {
    const request = decodeLibraryNote(note);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('note:save', request));
  },
  deleteNote: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('note:delete', request.id));
  },

  saveExperiment: async (input: unknown) => {
    const request = decodeExperimentSave(input);
    if (!request) return decodeExperimentMutationResult({
      success: false,
      code: 'experiment_metadata_invalid',
    });
    return decodeExperimentMutationResult(await ipcRenderer.invoke('experiment:save', request));
  },
  deleteExperiment: async (id: string) => {
    const requestId = decodeExperimentDelete({ id });
    if (!requestId) return decodeExperimentMutationResult({
      success: false,
      code: 'experiment_metadata_invalid',
    });
    return decodeExperimentMutationResult(
      await ipcRenderer.invoke('experiment:delete', { id: requestId }),
    );
  },

  loadAllData: async () => {
    const raw = await ipcRenderer.invoke('data:loadAll') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { papers: [], notes: [], experiments: [], collections: [] };
    }
    const data = raw as Record<string, unknown>;
    return {
      papers: Array.isArray(data.papers)
        ? data.papers.flatMap((item) => {
            const parsed = decodeLibraryPaperSaveRequest(item);
            return parsed && !(parsed as Record<string, unknown>).pdfPath && !(parsed as Record<string, unknown>).owner
              ? [parsed]
              : [];
          })
        : [],
      notes: Array.isArray(data.notes) ? data.notes : [],
      experiments: decodeExperimentList(data.experiments),
      collections: Array.isArray(data.collections) ? data.collections : [],
    };
  },
};
