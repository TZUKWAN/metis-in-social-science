/**
 * Capability bridge — MCP Servers / Skills / HITL Approval + 个人化扩展、
 * MCP 激活、场景包导入导出、密钥读写、Funding Template 运行时入口
 * （从 preload.ts 迁出，2026-09-15 拆分）。
 * 纯移动：方法体、通道字符串与 preload.ts 原实现逐字一致。
 */
import { ipcRenderer } from 'electron';
import {
  createApprovalMutationFailure,
  decodeApprovalMutationResult,
  decodeApprovalRequestView,
  decodeApprovalRuleToggleRequest,
  decodeApprovalRuleViews,
  decodeApprovalResponseRequest,
  type ApprovalRequestView,
} from '../../engine/runtime/ApprovalRuntimeContract.js';
import {
  PersonalizationExtensionIpcRequestSchema,
  decodePersonalizationExtensionResponse,
  type PersonalizationExtensionIpcRequest,
} from '../../engine/runtime/PersonalizationExtensionContract.js';
import {
  McpActivationIpcRequestSchema,
  decodeMcpActivationResponse,
  type McpActivationIpcRequest,
} from '../../engine/runtime/McpActivationContract.js';
import {
  PersonalizationBundleExportIpcRequestSchema,
  PersonalizationBundleImportIpcRequestSchema,
  decodePersonalizationBundleIpcResponse,
  type PersonalizationBundleExportIpcRequest,
  type PersonalizationBundleImportIpcRequest,
} from '../../engine/runtime/PersonalizationBundleContract.js';
import {
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretSetRequestSchema,
  decodePersonalizationSecretListResponse,
  decodePersonalizationSecretRemoveResponse,
  decodePersonalizationSecretSetResponse,
  type PersonalizationSecretListRequest,
  type PersonalizationSecretRemoveRequest,
  type PersonalizationSecretSetRequest,
} from '../../engine/runtime/PersonalizationSecretContract.js';
import {
  FundingTemplateIpcRequestSchema,
  decodeFundingTemplateRuntimeResponse,
  type FundingTemplateIpcRequest,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';

export const capabilityBridge = {
  // ── MCP Servers ────────────────────────────────────────
  listMCPServers: () => ipcRenderer.invoke('mcp:list'),
  addMCPServer: (_config: { id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }) =>
    (void _config, Promise.resolve({ success: false, code: 'managed_mcp_required' })),
  removeMCPServer: (id: string) => ipcRenderer.invoke('mcp:remove', id),
  toggleMCPServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggle', id, enabled),
  testMCPServer: (_config: { command: string; args: string[]; env: Record<string, string> }) =>
    (void _config, Promise.resolve({ success: false, code: 'managed_mcp_required' })),

  // ── Skills ─────────────────────────────────────────────
  listSkills: () => ipcRenderer.invoke('skill:list'),
  getSkill: (id: string) => ipcRenderer.invoke('skill:get', id),
  setActiveSkill: (id: string | null) => ipcRenderer.invoke('skill:setActive', id),
  getActiveSkill: () => ipcRenderer.invoke('skill:getActive'),
  generateSkillFromConversation: async (request: { messages: Array<{ role: string; content: string }>; userIntent?: string }) =>
    ipcRenderer.invoke('skill:generateFromConversation', request) as Promise<{
      ok: boolean;
      error?: string;
      skill?: { id: string; name: string; description: string; systemPrompt: string; allowedTools: string[]; maxTurns: number; rationale: string };
    }>,
  deleteCustomSkill: (id: string) => ipcRenderer.invoke('skill:deleteCustom', id) as Promise<{ ok: boolean; error?: string }>,

  // ── HITL Approval ──────────────────────────────────────
  applyPersonalizationExtension: async (rawRequest: PersonalizationExtensionIpcRequest) => {
    const request = PersonalizationExtensionIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationExtensionResponse(null);
    return decodePersonalizationExtensionResponse(
      await ipcRenderer.invoke('personalization:extension:apply', request.data),
    );
  },

  activatePersonalizationMcp: async (rawRequest: McpActivationIpcRequest) => {
    const request = McpActivationIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeMcpActivationResponse(null);
    return decodeMcpActivationResponse(
      await ipcRenderer.invoke('personalization:mcp:activate', request.data),
    );
  },

  exportPersonalizationBundle: async (rawRequest: PersonalizationBundleExportIpcRequest) => {
    const request = PersonalizationBundleExportIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationBundleIpcResponse(null);
    return decodePersonalizationBundleIpcResponse(
      await ipcRenderer.invoke('personalization:bundle:export', request.data),
    );
  },
  importPersonalizationBundle: async (rawRequest: PersonalizationBundleImportIpcRequest) => {
    const request = PersonalizationBundleImportIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationBundleIpcResponse(null);
    return decodePersonalizationBundleIpcResponse(
      await ipcRenderer.invoke('personalization:bundle:import', request.data),
    );
  },
  listPersonalizationSecrets: async (rawRequest: PersonalizationSecretListRequest) => {
    const request = PersonalizationSecretListRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretListResponse(null);
    return decodePersonalizationSecretListResponse(
      await ipcRenderer.invoke('personalization:secrets:list', request.data),
      request.data.operationId,
    );
  },
  setPersonalizationSecret: async (rawRequest: PersonalizationSecretSetRequest) => {
    const request = PersonalizationSecretSetRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretSetResponse(null);
    return decodePersonalizationSecretSetResponse(
      await ipcRenderer.invoke('personalization:secrets:set', request.data),
      request.data.operationId,
    );
  },
  removePersonalizationSecret: async (rawRequest: PersonalizationSecretRemoveRequest) => {
    const request = PersonalizationSecretRemoveRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretRemoveResponse(null);
    return decodePersonalizationSecretRemoveResponse(
      await ipcRenderer.invoke('personalization:secrets:remove', request.data),
      request.data.operationId,
    );
  },
  fundingTemplate: async (rawRequest: FundingTemplateIpcRequest) => {
    const request = FundingTemplateIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeFundingTemplateRuntimeResponse(null);
    return decodeFundingTemplateRuntimeResponse(
      await ipcRenderer.invoke('fundingTemplate:invoke', request.data),
    );
  },

  onApprovalRequired: (callback: (request: ApprovalRequestView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, rawRequest: unknown) => {
      const request = decodeApprovalRequestView(rawRequest);
      if (request) callback(request);
    };
    ipcRenderer.on('hitl:approval:required', handler);
    return () => { ipcRenderer.removeListener('hitl:approval:required', handler); };
  },
  respondApproval: async (requestId: string, approved: boolean) => {
    const request = decodeApprovalResponseRequest({
      requestId,
      decision: approved ? 'approve' : 'reject',
    });
    if (!request) return createApprovalMutationFailure();
    return decodeApprovalMutationResult(await ipcRenderer.invoke('hitl:approval:respond', request));
  },
  getPendingApprovals: async () => {
    const raw = await ipcRenderer.invoke('hitl:approvals:pending') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const request = decodeApprovalRequestView(item);
      return request ? [request] : [];
    });
  },
  listHITLRules: async () => decodeApprovalRuleViews(await ipcRenderer.invoke('hitl:rules:list')),
  toggleHITLRule: async (ruleId: string, enabled: boolean) => {
    const request = decodeApprovalRuleToggleRequest({ ruleId, enabled });
    if (!request) return createApprovalMutationFailure();
    return decodeApprovalMutationResult(await ipcRenderer.invoke('hitl:rules:toggle', request));
  },
};
