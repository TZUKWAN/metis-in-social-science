/**
 * Current affairs bridge — 时事简报（严格解码）研究/审批/导出/取消/来源审阅/
 * 来源列表（从 preload.ts 迁出，2026-09-15 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';
import {
  CurrentAffairsResearchRequestSchema,
  CurrentAffairsApproveRequestSchema,
  CurrentAffairsExportRequestSchema,
  CurrentAffairsCancelRequestSchema,
  CurrentAffairsListSourcesRequestSchema,
  SourceReviewRequestSchema,
  decodeCurrentAffairsResearchResponse,
  decodeCurrentAffairsApproveResponse,
  decodeCurrentAffairsExportResponse,
  decodeCurrentAffairsCancelResponse,
  decodeCurrentAffairsListSourcesResponse,
  decodeSourceReviewResponse,
  type CurrentAffairsResearchRequest,
  type CurrentAffairsApproveRequest,
  type CurrentAffairsExportRequest,
  type CurrentAffairsCancelRequest,
  type CurrentAffairsListSourcesRequest,
  type SourceReviewRequest,
} from '../../engine/runtime/CurrentAffairsRuntimeContract.js';

export const currentAffairsBridge = {
  // ── Current Affairs (strict decode) ─────────────────────
  currentAffairsResearch: async (raw: CurrentAffairsResearchRequest) => {
    const req = CurrentAffairsResearchRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsResearchResponse(null);
    const result = await ipcRenderer.invoke('ca:research', req.data);
    return decodeCurrentAffairsResearchResponse(result);
  },
  currentAffairsApprove: async (raw: CurrentAffairsApproveRequest) => {
    const req = CurrentAffairsApproveRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsApproveResponse(null);
    const result = await ipcRenderer.invoke('ca:approve', req.data);
    return decodeCurrentAffairsApproveResponse(result);
  },
  currentAffairsExport: async (raw: CurrentAffairsExportRequest) => {
    const req = CurrentAffairsExportRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsExportResponse(null);
    const result = await ipcRenderer.invoke('ca:export', req.data);
    return decodeCurrentAffairsExportResponse(result);
  },
  currentAffairsCancel: async (raw: CurrentAffairsCancelRequest) => {
    const req = CurrentAffairsCancelRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsCancelResponse(null);
    const result = await ipcRenderer.invoke('ca:cancel', req.data);
    return decodeCurrentAffairsCancelResponse(result);
  },
  currentAffairsReviewSource: async (raw: SourceReviewRequest) => {
    const req = SourceReviewRequestSchema.safeParse(raw);
    if (!req.success) return decodeSourceReviewResponse(null);
    return decodeSourceReviewResponse(await ipcRenderer.invoke('ca:review-source', req.data));
  },
  currentAffairsListSources: async (raw: CurrentAffairsListSourcesRequest) => {
    const req = CurrentAffairsListSourcesRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsListSourcesResponse(null);
    return decodeCurrentAffairsListSourcesResponse(await ipcRenderer.invoke('ca:list-sources', req.data));
  },
};
