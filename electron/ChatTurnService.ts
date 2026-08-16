import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { AgentRunResult, ChatMessage } from '../engine/core/types.js';
import { DEFAULT_MAX_TURNS } from '../engine/core/Config.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import type { FullAccessPolicy } from '../engine/runtime/PersonalizationRuntimeContract.js';
import type { LiveSteeringSource } from '../engine/runtime/LiveSteeringContract.js';
import {
  AgentResponseSchema,
  CHAT_RUNTIME_CONTRACT_VERSION,
  RuntimeIdSchema,
  type AgentResponse,
} from '../engine/runtime/ChatRuntimeContract.js';

export type ChatTurnMode = 'send' | 'regenerate';

/**
 * UX-CHAT-001: 普通研究对话的默认轮数上限。直接回答仍在首轮结束；当模型
 * 决定调用工具（如读取当前项目资料）时，允许继续生成基于工具结果的最终
 * 回答，而不是在唯一回合里撞上 max_turns_reached。仍是有界策略：场景
 * manifest 或调用方显式传入的 maxTurns 优先级更高。
 */
export const CHAT_DEFAULT_MAX_TURNS = DEFAULT_MAX_TURNS;

export interface ChatTurnOptions {
  mode?: ChatTurnMode;
}

export type ChatTurnResponse = AgentResponse;

interface RunPersistedChatTurnOptions {
  agentLoop: Pick<AgentLoop, 'run'>;
  store: Pick<
    PersistenceStore,
    'appendMessage' | 'createSession' | 'getSession' | 'truncateMessagesAfterLastUser'
  >;
  sessionId: string;
  messages: ChatMessage[];
  requestId: string;
  skillPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  taskContractHash?: string;
  promptStackHash?: string;
  fullAccess?: FullAccessPolicy;
  signal?: AbortSignal;
  liveSteering?: LiveSteeringSource;
  options?: ChatTurnOptions;
  projectId?: string;
  isCurrentRuntime?: () => boolean;
}

function latestUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message;
  }
  return undefined;
}

function safeTurnId(requestId: string): string {
  const parsed = RuntimeIdSchema.safeParse(requestId);
  return parsed.success ? parsed.data : 'runtime-recovery';
}

export function createChatTurnErrorResponse(
  turnId: string,
  status: AgentResponse['status'],
  code: string,
): AgentResponse {
  return AgentResponseSchema.parse({
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId,
    status,
    answer: '',
    diagnostics: [{ severity: 'error', code }],
    citations: [],
    events: [],
  });
}

export async function runPersistedChatTurn({
  agentLoop,
  store,
  sessionId,
  messages,
  requestId,
  skillPrompt,
  allowedTools,
  maxTurns,
  taskContractHash,
  promptStackHash,
  fullAccess,
  signal,
  liveSteering,
  options,
  projectId,
  isCurrentRuntime,
}: RunPersistedChatTurnOptions): Promise<ChatTurnResponse> {
  const mode = options?.mode ?? 'send';
  const userMessage = latestUserMessage(messages);
  const turnId = safeTurnId(requestId);

  if (!sessionId.trim()) {
    return createChatTurnErrorResponse(turnId, 'error', 'invalid_session');
  }
  if (!userMessage) {
    return createChatTurnErrorResponse(turnId, 'error', 'missing_user_message');
  }

  if (!store.getSession(sessionId)) {
    store.createSession(sessionId);
  }
  if (mode === 'send') {
    store.appendMessage(sessionId, 'user', userMessage.content);
  }

  const result = await agentLoop.run({
    messages,
    maxTurns: maxTurns ?? CHAT_DEFAULT_MAX_TURNS,
    allowedTools,
    sessionId,
    requestId,
    taskContractHash: taskContractHash ?? '',
    promptStackHash: promptStackHash ?? '',
    resumeFromCheckpoint: false,
    skillPrompt,
    fullAccess,
    signal,
    liveSteering,
    projectId,
  });

  if (isCurrentRuntime && !isCurrentRuntime()) {
    return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
  }

  const decoded = presentRunResult(turnId, result);
  if (!decoded) {
    return createChatTurnErrorResponse(turnId, 'error', 'response_contract_error');
  }

  if (decoded.answer) {
    if (isCurrentRuntime && !isCurrentRuntime()) {
      return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
    }
    if (mode === 'regenerate') {
      store.truncateMessagesAfterLastUser(sessionId);
    }
    store.appendMessage(sessionId, 'assistant', decoded.answer);
  }

  return decoded;
}

/**
 * 把一次 AgentLoop 运行结果映射为契约化的 AgentResponse。
 * 返回 undefined 表示结果无法通过响应契约（调用方回退 response_contract_error）。
 * 该函数是 runPersistedChatTurn 与 O15 runEphemeralChatTurn 共用的出口，
 * 保证两种路径的状态/诊断口径完全一致。
 */
function presentRunResult(
  turnId: string,
  result: AgentRunResult,
): AgentResponse | undefined {
  const verifiedAnswer = result.status === 'completed'
    && result.finalVerified
    && result.finalText.trim().length > 0;
  const status: AgentResponse['status'] = result.status === 'completed' && !verifiedAnswer
    ? 'error'
    : result.status;
  const diagnostics = status === 'completed' && result.errors.length === 0
    ? []
    : [{
        severity: 'error' as const,
        code: status === 'error' && result.status === 'completed'
          ? 'answer_unverified'
          : `agent_${status}`,
      }];
  const candidate = {
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId,
    status,
    answer: verifiedAnswer ? result.finalText : '',
    diagnostics,
    citations: [],
    events: [],
  };
  const decoded = AgentResponseSchema.safeParse(candidate);
  return decoded.success ? decoded.data : undefined;
}

// ─── O15: 多模型对比的临时（不落库）对话回合 ──────────────────

export interface RunEphemeralChatTurnOptions {
  agentLoop: Pick<AgentLoop, 'run'>;
  sessionId: string;
  messages: ChatMessage[];
  requestId: string;
  skillPrompt?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  projectId?: string;
}

/**
 * O15: 多模型同会话对比使用的临时回合。与 runPersistedChatTurn 的区别是
 * 完全不触碰 PersistenceStore——对比模式下一个用户问题会并行发给 N 个
 * provider profile，若每个 profile 调用都走持久化路径，用户消息与回答会被
 * 重复写入 N 次。对比回合的持久化由渲染端统一负责（用户消息一次 + 每个
 * profile 的回答各一条），主进程这里只负责「用指定 profile 跑一轮并返回
 * 与正常聊天完全同构的 AgentResponse」。
 */
export async function runEphemeralChatTurn({
  agentLoop,
  sessionId,
  messages,
  requestId,
  skillPrompt,
  maxTurns,
  signal,
  projectId,
}: RunEphemeralChatTurnOptions): Promise<ChatTurnResponse> {
  const userMessage = latestUserMessage(messages);
  const turnId = safeTurnId(requestId);

  if (!sessionId.trim()) {
    return createChatTurnErrorResponse(turnId, 'error', 'invalid_session');
  }
  if (!userMessage) {
    return createChatTurnErrorResponse(turnId, 'error', 'missing_user_message');
  }

  const result = await agentLoop.run({
    messages,
    maxTurns: maxTurns ?? CHAT_DEFAULT_MAX_TURNS,
    sessionId,
    requestId,
    taskContractHash: '',
    promptStackHash: '',
    resumeFromCheckpoint: false,
    skillPrompt,
    signal,
    projectId,
  });

  const decoded = presentRunResult(turnId, result);
  if (!decoded) {
    return createChatTurnErrorResponse(turnId, 'error', 'response_contract_error');
  }
  return decoded;
}
