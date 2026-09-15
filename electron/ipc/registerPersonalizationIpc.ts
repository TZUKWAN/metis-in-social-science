/**
 * Personalization domain IPC registrar — 从 main.ts 迁出（2026-09-15 解耦）。
 *
 * 覆盖 23 个 `personalization:*` 通道：
 * - 定义库 CRUD/回收站/完整性/版本/解析（13 个，全部委托 PersonalizationRuntimeService）
 * - AI 生成（aiGenerateScenario / aiGenerateAgent / parsePaperTemplate，走
 *   runEphemeralChatTurn + 关停准入 trackEphemeralOperation）
 * - 能力扩展激活（extension:apply / mcp:activate，绑定调用方身份证据）
 * - 捆绑包导入导出（bundle:export / bundle:import，经系统文件对话框）
 * - Secret Vault 投影（secrets:list / set / remove，绝不回显明文）
 *
 * 全部服务经 DomainIpcContext 注入（provider 重启/重建后自动取当前实例）。
 */
import { dialog } from 'electron';
import {
  PersonalizationBundleExportIpcRequestSchema,
  PersonalizationBundleImportIpcRequestSchema,
  PersonalizationBundleIpcResponseSchema,
  PersonalizationBundleSchema,
} from '../../engine/runtime/PersonalizationBundleContract.js';
import {
  McpActivationIpcRequestSchema,
  decodeMcpActivationResponse,
} from '../../engine/runtime/McpActivationContract.js';
import {
  PersonalizationExtensionIpcRequestSchema,
  decodePersonalizationExtensionResponse,
} from '../../engine/runtime/PersonalizationExtensionContract.js';
import {
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretSetRequestSchema,
  decodePersonalizationSecretListResponse,
  decodePersonalizationSecretRemoveResponse,
  decodePersonalizationSecretSetResponse,
} from '../../engine/runtime/PersonalizationSecretContract.js';
import { trackEphemeralOperation } from '../RuntimeShutdownCoordinator.js';
import { runEphemeralChatTurn } from '../ChatTurnService.js';
import { executionOwnerFor } from '../FileCapabilityHandler.js';
import {
  bindMcpActivationRequest,
  bindPersonalizationExtensionRequest,
  readPersonalizationBundleFile,
  writePersonalizationBundleFile,
} from './personalizationIpcBinding.js';
import type { DomainIpcContext } from './DomainIpcContext.js';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

function parseAiScenarioGeneration(answer: string): {
  scenario: { name: string; description: string; triggerPhrases: string[]; deliverable: string };
  agents: Array<{ name: string; role: string; systemPrompt: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
  workflow: Array<{ name: string; description: string; agent: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
  rules: string;
  paperStructure: Array<{ title: string; instruction: string }> | null;
} | null {
  const cleaned = answer.replace(/```(?:json)?/gu, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const scenario = isRecord(parsed.scenario) ? parsed.scenario : null;
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  const workflow = Array.isArray(parsed.workflow) ? parsed.workflow : [];
  if (!scenario || agents.length === 0 || agents.length > 4 || workflow.length > 12) return null;
  const str = (value: unknown, maximum: number): string => (
    typeof value === 'string' ? value.trim().slice(0, maximum) : ''
  );
  const strList = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean).slice(0, 64)
      : []
  );
  const turns = (value: unknown): number => (
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(100, Math.max(1, Math.floor(value)))
      : 12
  );
  const normalizedAgents = agents
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      name: str(item.name, 30),
      role: str(item.role, 100),
      systemPrompt: str(item.systemPrompt, 600),
      skillIds: strList(item.skillIds),
      toolIds: strList(item.toolIds),
      mcpIds: strList(item.mcpIds),
      maxTurns: turns(item.maxTurns),
    }))
    .filter((item) => item.name)
    .slice(0, 4);
  if (normalizedAgents.length === 0) return null;
  const agentNames = new Set(normalizedAgents.map((item) => item.name));
  const normalizedWorkflow = workflow
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      name: str(item.name, 100),
      description: str(item.description, 150),
      agent: str(item.agent, 30),
      skillIds: strList(item.skillIds),
      toolIds: strList(item.toolIds),
      mcpIds: strList(item.mcpIds),
      maxTurns: turns(item.maxTurns),
    }))
    .filter((step) => step.name && agentNames.has(step.agent))
    .slice(0, 12);
  const rules = typeof parsed.rules === 'string' ? parsed.rules.trim().slice(0, 1500) : '';
  const rawStructure = Array.isArray(parsed.paperStructure) ? parsed.paperStructure : [];
  const paperStructure = rawStructure
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      title: str(item.title, 80),
      instruction: str(item.instruction, 250) || str(item.style, 120),
    }))
    .filter((section) => section.title)
    .slice(0, 16);
  return {
    scenario: {
      name: str(scenario.name, 40) || (normalizedAgents[0]?.name ?? '研究场景'),
      description: str(scenario.description, 200),
      triggerPhrases: strList(scenario.triggerPhrases).slice(0, 12),
      deliverable: str(scenario.deliverable, 200),
    },
    agents: normalizedAgents,
    workflow: normalizedWorkflow,
    rules,
    paperStructure: paperStructure.length > 0 ? paperStructure : null,
  };
}

function parseAiAgentGeneration(answer: string): {
  name: string;
  description: string;
  role: string;
  systemPrompt: string;
  maxTurns: number;
} | null {
  const cleaned = answer.replace(/```(?:json)?/gu, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const str = (value: unknown, maximum: number): string => (
    typeof value === 'string' ? value.trim().slice(0, maximum) : ''
  );
  const name = str(parsed.name, 200);
  const role = str(parsed.role, 200);
  const systemPrompt = str(parsed.systemPrompt, 4000);
  if (!name || !role || !systemPrompt) return null;
  const maxTurns = typeof parsed.maxTurns === 'number' && Number.isFinite(parsed.maxTurns)
    ? Math.min(100, Math.max(1, Math.floor(parsed.maxTurns)))
    : 20;
  return { name, description: str(parsed.description, 2000), role, systemPrompt, maxTurns };
}

export function registerPersonalizationIpc(ctx: DomainIpcContext): () => void {
  const dom = ctx.registry.domain('personalization', ['personalization:']);

  // ── 定义库：列表 / 回收站 / 完整性 / 详情 ──
  dom.handle('personalization:list', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.list(rawRequest) ?? { ok: false, code: 'unavailable' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  dom.handle('personalization:trash:list', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.listTrash(rawRequest) ?? { ok: false, code: 'unavailable' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  dom.handle('personalization:integrity:list', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.listIntegrityIssues(rawRequest) ?? { ok: false, code: 'unavailable' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  dom.handle('personalization:integrity:recover', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.recoverIntegrityIssue(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'io_error' };
    }
  });
  dom.handle('personalization:get', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.get(rawRequest) ?? { ok: true, definition: null };
    } catch {
      return { ok: true, definition: null };
    }
  });

  // ── 定义库：保存 / 归档 / 删除 / 派生 / 恢复 / 版本 / 解析 ──
  dom.handle('personalization:save', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.save(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });

  dom.handle('personalization:archive', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.archive(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  dom.handle('personalization:delete', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.deletePermanent(rawRequest, ctx.uninstallSkillAssetsForDefinition)
        ?? { ok: false as const, code: 'io_error' as const };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  dom.handle('personalization:fork', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.fork(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  dom.handle('personalization:restore', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.restore(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  dom.handle('personalization:trash:restore', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.restoreFromTrash(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });

  dom.handle('personalization:versions', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.versions(rawRequest) ?? { ok: true as const, versions: [] };
    } catch {
      return { ok: true as const, versions: [] };
    }
  });
  dom.handle('personalization:resolve', (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      return ctx.personalizationRuntime()?.resolve(rawRequest) ?? {
        ok: false,
        code: 'definition_corrupt',
        issues: ['Personalization persistence is unavailable'],
      };
    } catch {
      return { ok: false, code: 'definition_corrupt', issues: ['Invalid personalization request'] };
    }
  });

  // ── AI 辅助创建场景：描述需求 → 生成场景 + 智能体 + 工作流 ──
  dom.handle('personalization:aiGenerateScenario', async (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const description = typeof rawRequest.description === 'string' ? rawRequest.description.trim() : '';
      if (description.length < 2 || description.length > 2000) {
        return { ok: false, code: 'invalid_request' };
      }
      const rawDefinitions = Array.isArray(rawRequest.definitions) ? rawRequest.definitions : [];
      const definitions = rawDefinitions
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id : '',
          kind: typeof item.kind === 'string' ? item.kind : 'unknown',
          name: typeof item.name === 'string' ? item.name : '',
          description: typeof item.description === 'string' ? item.description : '',
        }))
        .filter((item) => item.id && item.name)
        .slice(0, 500);
      const agentLoop = ctx.agentLoop();
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const catalog = definitions.length > 0
        ? definitions.map((d) => `- ${d.kind}「${d.name}」 id=${d.id}${d.description ? `：${d.description}` : ''}`).join('\n')
        : '（暂无现有定义）';
      const systemPrompt = [
        '你是一个人文社科研究场景设计助手。用户用一句话描述他想要的研究场景，你需要输出一个可直接落地的场景设计。',
        '要求：',
        '1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。',
        '2. JSON 结构：',
        '   { "scenario": { "name": "场景名称(不超过40字)", "description": "场景说明(不超过200字)", "triggerPhrases": ["触发词1","触发词2"], "deliverable": "最终交付物描述(可选，不超过200字)" },',
        '     "agents": [ { "name": "智能体名称(不超过30字)", "role": "角色", "systemPrompt": "系统指令(不超过600字)", "skillIds": ["已有技能id"], "toolIds": ["工具id"], "mcpIds": ["已有MCP id"], "maxTurns": 12 } ],',
        '     "workflow": [ { "name": "步骤名称", "description": "步骤说明(不超过150字)", "agent": "智能体名称(必须是 agents 中的名称)", "skillIds": [], "toolIds": [], "mcpIds": [], "maxTurns": 12 } ],',
        '     "rules": "场景记忆 Metis.md 文档（Markdown，不超过1500字）：写明该场景的研究目标、资料与证据边界、输出规范与工作习惯，供场景内智能体遵守",',
        '     "paperStructure": [ { "title": "章节标题(如：引言)", "instruction": "该章节写作指引与文风要求(不超过250字)" } ] }',
        '3. agents 数量 1-2 个；workflow 步骤 2-6 个，按执行顺序排列。',
        '4. paperStructure 必须覆盖：引言 + 2-4 个主体章节 + 结论；每个章节给出针对性写作指引（该写什么、怎么论证、文风如何）。',
        '5. skillIds/mcpIds 只能从下面“现有定义清单”中选择，没有合适的不填。toolIds 只能使用已注册工具：read_file、write_file、web_search、compare_items、list_sources、extract_evidence、link_evidence、draft_claim、save_artifact。',
        '6. systemPrompt 用中文，写明该智能体在这个场景中的职责、行为边界与输出要求。',
        `现有定义清单：\n${catalog}`,
      ].join('\n');
      const tracked = trackEphemeralOperation(ctx.runtimeShutdown, {
        id: `personalization:aiGenerateScenario:${ctx.nextRequestId()}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `ai-scenario-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: `用户需求：${description}` }],
          requestId: `ai_gen_${ctx.nextRequestId()}`,
          skillPrompt: systemPrompt,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          const diag = answer.diagnostics?.[0];
          return { ok: false, code: 'generation_failed', message: [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status };
        }
        const parsed = parseAiScenarioGeneration(answer.answer);
        if (!parsed) return { ok: false, code: 'parse_failed' };
        return { ok: true, ...parsed };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', message: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  // ── AI 辅助创建智能体：描述需求 → 生成单个智能体定义草稿 ──
  dom.handle('personalization:aiGenerateAgent', async (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const description = typeof rawRequest.description === 'string' ? rawRequest.description.trim() : '';
      if (description.length < 2 || description.length > 2000) {
        return { ok: false, code: 'invalid_request' };
      }
      const agentLoop = ctx.agentLoop();
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const systemPrompt = [
        '你是一个研究智能体设计助手。用户用一句话描述他想要的智能体，你需要输出该智能体的定义草稿。',
        '要求：',
        '1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。',
        '2. JSON 结构：',
        '   { "name": "智能体名称(不超过30字)", "description": "一句话说明(不超过120字)", "role": "角色(不超过40字)", "systemPrompt": "系统指令(600字以内，中文)", "maxTurns": 20 }',
        '3. systemPrompt 写明该智能体的职责、工作步骤、行为边界与输出要求，可直接投入使用。',
        '4. 名称与角色用中文，具体、可辨识（例如「文献综述专家」而非「助手」）。',
      ].join('\n');
      const tracked = trackEphemeralOperation(ctx.runtimeShutdown, {
        id: `personalization:aiGenerateAgent:${ctx.nextRequestId()}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `ai-agent-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: `用户需求：${description}` }],
          requestId: `ai_gen_${ctx.nextRequestId()}`,
          skillPrompt: systemPrompt,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          const diag = answer.diagnostics?.[0];
          return { ok: false, code: 'generation_failed', message: [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status };
        }
        const parsed = parseAiAgentGeneration(answer.answer);
        if (!parsed) return { ok: false, code: 'parse_failed' };
        return { ok: true, agent: parsed };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', message: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  // ── 论文结构模板解析：粘贴模板 → 可编辑章节结构 ──
  dom.handle('personalization:parsePaperTemplate', async (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const text = typeof rawRequest.text === 'string' ? rawRequest.text.trim() : '';
      if (text.length < 10 || text.length > 20_000) {
        return { ok: false, code: 'invalid_request' };
      }
      const agentLoop = ctx.agentLoop();
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const systemPrompt = [
        '你是论文结构模板解析助手。用户粘贴一份研究模板（如国家社科基金申请书、论文写作规范、学位论文结构），你需要把它解析为可编辑的章节结构。',
        '要求：',
        '1. 只输出一个 JSON 对象：{ "sections": [ { "title": "章节标题", "instruction": "该章节的写作指引：写什么内容、如何论证、文风要求（不超过250字）" } ] }。',
        '2. 章节按模板出现的顺序排列；模板中未明确列出的必要章节（如引言、结论）应补充进去。',
        '3. 章节数量 3-12 个；instruction 用中文，具体到该章节的写作任务与质量要求。',
        '4. 不要输出任何解释、前后缀或 Markdown 代码围栏。',
      ].join('\n');
      const tracked = trackEphemeralOperation(ctx.runtimeShutdown, {
        id: `personalization:parsePaperTemplate:${ctx.nextRequestId()}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `ai-template-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: `模板内容：\n${text}` }],
          requestId: `ai_tpl_${ctx.nextRequestId()}`,
          skillPrompt: systemPrompt,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          const diag = answer.diagnostics?.[0];
          return { ok: false, code: 'generation_failed', message: [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status };
        }
        const cleaned = answer.answer.replace(/```(?:json)?/gu, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start < 0 || end <= start) return { ok: false, code: 'parse_failed' };
        let parsed: unknown;
        try {
          parsed = JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return { ok: false, code: 'parse_failed' };
        }
        if (!isRecord(parsed) || !Array.isArray(parsed.sections)) return { ok: false, code: 'parse_failed' };
        const str = (value: unknown, maximum: number): string => (
          typeof value === 'string' ? value.trim().slice(0, maximum) : ''
        );
        const sections = parsed.sections
          .filter((item): item is Record<string, unknown> => isRecord(item))
          .map((item) => ({
            title: str(item.title, 80),
            instruction: str(item.instruction, 250) || str(item.style, 120),
          }))
          .filter((section) => section.title)
          .slice(0, 16);
        if (sections.length < 3) return { ok: false, code: 'parse_failed' };
        return { ok: true, sections };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', message: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  // ── 能力扩展落地（技能目录/技能包/MCP 生成激活）──
  dom.handle('personalization:extension:apply', async (event, rawRequest: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const publicRequest = PersonalizationExtensionIpcRequestSchema.safeParse(rawRequest);
      if (!publicRequest.success || !ctx.personalizationExtensions()) {
        return decodePersonalizationExtensionResponse(null);
      }
      const request = bindPersonalizationExtensionRequest(publicRequest.data, event);
      if (!request) return decodePersonalizationExtensionResponse(null);
      const owner = executionOwnerFor(event);
      const extensions = ctx.personalizationExtensions()!;
      if (request.mode === 'mcp_requirements' && request.runProbe) {
        if (!ctx.personalizationGeneratedMcpActivation()) return decodePersonalizationExtensionResponse(null);
        const prepared = await extensions.prepareGeneratedMcp(request);
        if (!prepared.ok) return decodePersonalizationExtensionResponse(prepared.response);
        const activated = await ctx.personalizationGeneratedMcpActivation()!.activate({
          operationId: request.evidenceContext.operationId,
          expectedRevision: request.expectedRevision,
          pendingDefinition: prepared.definition,
          installation: prepared.installation,
          evidenceContext: { ...request.evidenceContext, owner },
        });
        if (!activated.ok) {
          return decodePersonalizationExtensionResponse({
            ok: false,
            mode: 'mcp_requirements',
            code: 'mcp_builder_failed',
            detailCode: activated.code,
            compensated: activated.compensated,
          });
        }
        return decodePersonalizationExtensionResponse({
          ok: true,
          mode: 'mcp_requirements',
          definition: activated.definition,
          evidence: activated.evidence,
          skillInstallation: null,
          mcpInstallation: activated.installation,
        });
      }
      const result = await extensions.apply(request, {
        resolveLocalSkillSource: (capabilityId) => {
          const resolution = ctx.fileCapabilities().consumeMatching(capabilityId, owner, [
            {
              purpose: 'personalization-skill-package',
              kind: 'file',
              operation: 'file',
            },
            {
              purpose: 'personalization-skill-directory',
              kind: 'folder',
              operation: 'folder',
            },
          ]);
          return resolution.ok ? resolution.resolvedPath : undefined;
        },
        resolveLocalMcpSource: (capabilityId) => {
          const resolution = ctx.fileCapabilities().consumeMatching(capabilityId, owner, [{
            purpose: 'personalization-mcp-directory',
            kind: 'folder',
            operation: 'folder',
          }]);
          return resolution.ok ? resolution.resolvedPath : undefined;
        },
      });
      return decodePersonalizationExtensionResponse(result);
    } catch {
      return decodePersonalizationExtensionResponse(null);
    }
  });

  // ── 受管 MCP 激活（带调用方 generation 证据）──
  dom.handle('personalization:mcp:activate', async (event, rawRequest: unknown) => {
    const publicRequest = McpActivationIpcRequestSchema.safeParse(rawRequest);
    try {
      ctx.requireRendererMainFrame(event);
      if (!publicRequest.success || !ctx.personalizationMcpActivation()) {
        return decodeMcpActivationResponse(null);
      }
      const request = bindMcpActivationRequest(publicRequest.data, event, (webContentsId) => ctx.webContentsGeneration(webContentsId));
      if (!request) return decodeMcpActivationResponse(null);
      return decodeMcpActivationResponse(
        await ctx.personalizationMcpActivation()!.activate(request),
      );
    } catch {
      return decodeMcpActivationResponse(null);
    }
  });

  // ── 捆绑包导出（系统另存对话框 + 临时文件原子发布）──
  dom.handle('personalization:bundle:export', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationBundleExportIpcRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : '00000000-0000-4000-8000-000000000000';
    try {
      const invokingWindow = ctx.requireRendererMainFrame(event);
      if (!parsed.success) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'invalid_request' });
      if (!ctx.personalizationBundles() || !ctx.personalizationRepository() || !ctx.personalizationBundleSkillAssets()) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'service_unavailable' });
      }
      const exported = await ctx.personalizationBundles()!.exportBundle({
        rootDefinitionIds: parsed.data.rootDefinitionIds,
        assetMode: 'include_files',
        createdBy: 'Local Metis user',
      }, { get: (id) => ctx.personalizationRepository()?.get(id, true) }, ctx.personalizationBundleSkillAssets()!);
      const selected = await dialog.showSaveDialog(invokingWindow, {
        title: 'Export Metis personalization bundle',
        defaultPath: `metis-personalization-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'Metis personalization bundle', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (selected.canceled || !selected.filePath) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'cancelled' });
      }
      try { writePersonalizationBundleFile(selected.filePath, exported.bytes); } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'write_failed' });
      }
      return PersonalizationBundleIpcResponseSchema.parse({
        ok: true,
        operationId,
        action: 'exported',
        bundleDigest: exported.bundle.manifest.bundleDigest,
        definitionCount: exported.bundle.manifest.definitions.length,
      });
    } catch {
      return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'export_failed' });
    }
  });

  // ── 捆绑包导入（系统打开对话框 + 大小上限 + 完整性计数）──
  dom.handle('personalization:bundle:import', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationBundleImportIpcRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : '00000000-0000-4000-8000-000000000000';
    try {
      const invokingWindow = ctx.requireRendererMainFrame(event);
      if (!parsed.success) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'invalid_request' });
      if (!ctx.personalizationBundleCoordinator()) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'service_unavailable' });
      }
      const selected = await dialog.showOpenDialog(invokingWindow, {
        title: 'Import Metis personalization bundle',
        properties: ['openFile'],
        filters: [{ name: 'Metis personalization bundle', extensions: ['json'] }],
      });
      const source = selected.canceled ? undefined : selected.filePaths[0];
      if (!source) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'cancelled' });
      let bytes: Uint8Array;
      try { bytes = readPersonalizationBundleFile(source); } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'read_failed' });
      }
      const imported = await ctx.personalizationBundleCoordinator()!.importBundle(bytes);
      if (!imported.ok) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
      let definitionCount: number;
      try {
        definitionCount = PersonalizationBundleSchema.parse(
          JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown,
        ).manifest.definitions.length;
      } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
      }
      return PersonalizationBundleIpcResponseSchema.parse({
        ok: true,
        operationId,
        action: 'imported',
        bundleDigest: imported.bundleDigest,
        definitionCount,
      });
    } catch {
      return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
    }
  });

  // ── Secret Vault 投影（响应经 decode 投影，绝不回显明文）──
  dom.handle('personalization:secrets:list', (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretListRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      ctx.requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretListResponse(null, operationId);
      if (!ctx.personalizationSecretVault()) {
        return decodePersonalizationSecretListResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretListResponse(
        ctx.personalizationSecretVault()!.list(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretListResponse(null, operationId);
    }
  });

  dom.handle('personalization:secrets:set', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretSetRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      ctx.requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretSetResponse(null, operationId);
      if (!ctx.personalizationSecretVault()) {
        return decodePersonalizationSecretSetResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretSetResponse(
        await ctx.personalizationSecretVault()!.set(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretSetResponse(null, operationId);
    }
  });

  dom.handle('personalization:secrets:remove', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretRemoveRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      ctx.requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretRemoveResponse(null, operationId);
      if (!ctx.personalizationSecretVault()) {
        return decodePersonalizationSecretRemoveResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretRemoveResponse(
        await ctx.personalizationSecretVault()!.remove(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretRemoveResponse(null, operationId);
    }
  });

  return () => dom.dispose();
}
