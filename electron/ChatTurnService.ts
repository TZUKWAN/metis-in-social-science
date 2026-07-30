import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { ChatMessage } from '../engine/core/types.js';
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
    maxTurns: maxTurns ?? 1,
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
  });

  if (isCurrentRuntime && !isCurrentRuntime()) {
    return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
  }

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
  if (!decoded.success) {
    return createChatTurnErrorResponse(turnId, 'error', 'response_contract_error');
  }

  if (decoded.data.answer) {
    if (isCurrentRuntime && !isCurrentRuntime()) {
      return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
    }
    if (mode === 'regenerate') {
      store.truncateMessagesAfterLastUser(sessionId);
    }
    store.appendMessage(sessionId, 'assistant', decoded.data.answer);
  }

  return decoded.data;
}
