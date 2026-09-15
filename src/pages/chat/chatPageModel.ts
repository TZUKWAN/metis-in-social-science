/**
 * ChatPage 纯模型层 — 从 ChatPage.tsx 迁出（2026-09-15 解耦）。
 *
 * 只放与 React 生命周期无关的类型、映射器、归并器与启发式：
 * - ChatMessage：对话消息的渲染契约（其余文件经 `import type { ChatMessage }
 *   from '../../pages/ChatPage'` 消费的类型由 ChatPage 再导出，路径不变）。
 * - goal 卡片映射 / 执行信封归并 / 状态转换 / 右栏成果聚合等纯函数。
 * 无副作用、不触碰 store；组件内的状态编排留在 ChatPage 与各 flow 模块。
 */
import type { AgentActivityEvent, AgentActivityStatus } from '../../components/AgentActivityTimeline';
import {
  createAssistantMessageParts,
  normalizeAssistantEvent,
  reduceAssistantMessageParts,
  type AssistantMessageParts,
  type LegacyAssistantToolCall,
} from '../../lib/assistantMessagePartsReducer';
import type { GoalCardData } from '../../components/GoalCardInline';
import type { AgentExecutionEvent, GoalSnapshot } from '../../../engine/runtime/ChatRuntimeContract';
import type { FileCapabilityDescriptor } from '../../../engine/runtime/FileCapabilityContract';

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'goal';

export interface ChatMessage {
  /** Stable render id, assigned when the message enters state (React key). */
  id?: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  /** Legacy role=tool boundary; rendered through the same canonical tool-part shape. */
  toolCall?: LegacyAssistantToolCall;
  /**
   * Public execution information returned by the existing AgentResponse
   * contract. It is deliberately separate from final answer content so an
   * assistant message can present a compact execution timeline first.
   */
  run?: {
    status: AgentActivityStatus;
    events: AgentActivityEvent[];
    parts?: AssistantMessageParts;
    turnId?: string;
    historyIncomplete?: boolean;
  };
  goalCard?: GoalCardData;
  /** True while model tokens are still streaming into this message. */
  streaming?: boolean;
  /** Wall-clock start of the generating turn (for the elapsed timer). */
  startedAt?: number;
  /** Total generation time once the turn settles. */
  durationMs?: number;
  /** Reasoning/thinking tokens streamed by the model, if any. */
  reasoning?: string;
  /**
   * O8: citations for the answer. Each entry links a piece of the answer to a
   * concrete source (library paper / DOI / URL) so the user can trace the claim.
   */
  citations?: import('../../../engine/core/Citation.js').Citation[];
  /**
   * O16: message branch/fork. When a user regenerates an answer, the previous
   * answer is kept as an inactive sibling branch rather than deleted, letting
   * the user flip between alternative takes. forkId groups siblings; activeFork
   * marks which sibling is currently displayed.
   */
  forkId?: string;
  /** Zero-based index of this sibling within its fork group. */
  forkIndex?: number;
  /** Total siblings in the fork group (including this one). */
  forkCount?: number;
  /** True when this sibling is the currently displayed one in its group. */
  forkActive?: boolean;
  /**
   * O15: 多模型对比标记——该回答来自哪个 provider profile（展示用标签，
   * 如 "Kimi · kimi-k2"）。仅对比模式下由渲染端打上；普通回答不带此字段。
   */
  modelLabel?: string;
  /**
   * O15: 对比轮次分组 id。同一轮多模型对比的各模型回答共享它，渲染时
   * 并排展示。仅对比模式打上。
   */
  compareGroup?: string;
  /**
   * UX-CHAT-002: 回合失败/中断/取消时留下的未完成草稿标记。流式占位消息在
   * 非成功结算时保留部分内容并打上此标记；空内容则直接删除。
   */
  incomplete?: boolean;
}

export function toGoalCardData(goal: GoalSnapshot): GoalCardData | null {
  if (goal.phase === 'unknown') return null;
  const stepStatuses: GoalCardData['stepStatuses'] = {};
  for (const [stepId, status] of Object.entries(goal.stepStatuses)) {
    if (status.status === 'unknown') return null;
    stepStatuses[stepId] = {
      stepId: status.stepId,
      stepName: status.stepName,
      status: status.status,
      output: status.output,
    };
  }
  return {
    ...goal,
    phase: goal.phase,
    stepStatuses,
  };
}

/**
 * Map a persisted goal status (source of truth on the engine side) to the
 * inline card phase. Used when a goal card is opened from the board or when
 * a board move broadcasts goal:changed.
 */
export function goalStatusToCardPhase(status: string): GoalCardData['phase'] {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'running': return 'executing';
    case 'paused': return 'paused';
    default: return 'plan_ready';
  }
}

export function reduceExecutionEnvelope(
  state: AssistantMessageParts,
  payload: AgentExecutionEvent,
  replayed = false,
): AssistantMessageParts {
  const event = {
    ...payload.event,
    eventId: payload.eventId,
    sequence: payload.sequence,
  } as AgentActivityEvent;
  return reduceAssistantMessageParts(state, normalizeAssistantEvent(event, replayed));
}

export function partsFromExecutionEnvelopes(
  envelopes: readonly AgentExecutionEvent[],
  replayed = false,
): AssistantMessageParts {
  return envelopes.reduce(
    (state, payload) => reduceExecutionEnvelope(state, payload, replayed),
    createAssistantMessageParts(),
  );
}

export function isAgentRunStatus(value: unknown): value is AgentActivityStatus {
  return value === 'completed'
    || value === 'interrupted'
    || value === 'cancelled'
    || value === 'error'
    || value === 'context_exhausted'
    || value === 'max_turns_reached'
    || value === 'unknown'
    || value === 'running';
}

export function chatPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export type ArtifactItemType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'md' | 'latex' | 'other';
export type RightPanelTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export function toRightPanelTaskStatus(status: string): RightPanelTaskStatus {
  return status === 'running' || status === 'completed' || status === 'failed'
    ? status
    : 'pending';
}

export interface ArtifactItem {
  id: string;
  name: string;
  type: ArtifactItemType;
  sourceCapability?: FileCapabilityDescriptor;
  size?: string;
  createdAt: number;
  contentAvailable: boolean;
}
export const validArtifactTypes: ArtifactItemType[] = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'latex', 'other'];
export const SCENARIO_CATALOG_MAX_ATTEMPTS = 2;
export const SCENARIO_CATALOG_RETRY_DELAY_MS = 150;
export const AGENT_EXECUTION_TURN_BUFFER_LIMIT = 64;

/** Timestamp helper (avoids Date.now() in render). */
export function now(): number {
  return Date.now();
}

export function isLikelyGoalFeedback(content: string): boolean {
  const patterns = [
    /\b(change|modify|update|fix|adjust|instead|rather|redo|add|remove|include|exclude|also)\b/i,
    /(修改|更改|调整|换成|不要|重做|再试|加上|去掉|还有|换成)/,
  ];
  return patterns.some(p => p.test(content));
}

/** 右栏聚合的成果投影（项目正式成果 + 会话产物去重后的统一条目）。 */
export interface RightPanelArtifactEntry {
  id: string;
  name: string;
  type: ArtifactItemType;
  createdAt: number;
  contentAvailable: boolean;
  /** 同名逻辑成果的历史版本数（>1 时展示「N 个版本」）。 */
  size?: string;
}

/**
 * 全局对话体验重构（T3）：按逻辑成果聚合——同名（含轮次后缀规整）只保留
 * 最新一条，轮次计数进 size 标注（历史版本在成果页 VersionPanel 保留，
 * 不破坏真实版本历史，仅改善 Presentation）。
 */
export function aggregateRightPanelArtifacts(
  projectOutcomes: ReadonlyArray<{ id: string; title: string; type: ArtifactItemType; updatedAt: number }>,
  artifacts: readonly ArtifactItem[],
): RightPanelArtifactEntry[] {
  const normalizeName = (name: string) => name.replace(/[(（]第\s*\d+\s*轮[)）]/gu, '').replace(/\s*v\d+$/iu, '').trim();
  const merged = [
    ...projectOutcomes.map((outcome) => ({
      id: `outcome:${outcome.id}`,
      name: outcome.title,
      type: outcome.type,
      createdAt: outcome.updatedAt,
      contentAvailable: true,
    })),
    ...artifacts.filter((artifact) => !projectOutcomes.some((outcome) => outcome.title === artifact.name)),
  ];
  const byName = new Map<string, { id: string; name: string; type: ArtifactItemType; createdAt: number; contentAvailable: boolean; versions: number }>();
  for (const item of merged) {
    const key = normalizeName(item.name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...item, versions: 1 });
      continue;
    }
    existing.versions += 1;
    if (item.createdAt > existing.createdAt) {
      existing.id = item.id;
      existing.name = item.name;
      existing.type = item.type;
      existing.createdAt = item.createdAt;
      existing.contentAvailable = item.contentAvailable;
    }
  }
  return [...byName.values()]
    .map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      createdAt: item.createdAt,
      contentAvailable: item.contentAvailable,
      size: item.versions > 1 ? `${item.versions} 个版本` : undefined,
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}
