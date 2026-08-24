/**
 * Cross-page chat intent helpers.
 *
 * Pages that want to open the Chat page with a specific skill and
 * pre-filled message can write an intent to localStorage; ChatPage
 * consumes it on mount.
 */

export interface PendingChatIntent {
  skillId?: string;
  scenarioId?: string;
  projectId?: string;
  sessionId?: string;
  message: string;
  autoSend?: boolean;
}

const KEY = 'metis:pendingChatIntent';

function parsePendingChatIntent(raw: string): PendingChatIntent | null {
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed
    && typeof parsed === 'object'
    && 'message' in parsed
    && typeof (parsed as Record<string, unknown>).message === 'string'
    && (!('skillId' in parsed) || typeof (parsed as Record<string, unknown>).skillId === 'string')
    && (!('scenarioId' in parsed) || typeof (parsed as Record<string, unknown>).scenarioId === 'string')
    && (!('projectId' in parsed) || typeof (parsed as Record<string, unknown>).projectId === 'string')
    && (!('sessionId' in parsed) || typeof (parsed as Record<string, unknown>).sessionId === 'string')
    && (!('autoSend' in parsed) || typeof (parsed as Record<string, unknown>).autoSend === 'boolean')
  ) {
    return parsed as PendingChatIntent;
  }
  return null;
}

export function setPendingChatIntent(intent: PendingChatIntent): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // ignore storage errors
  }
}

export function peekPendingChatIntent(): PendingChatIntent | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parsePendingChatIntent(raw) : null;
  } catch {
    return null;
  }
}

export function clearPendingChatIntent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore storage errors
  }
}

export function consumePendingChatIntent(): PendingChatIntent | null {
  const intent = peekPendingChatIntent();
  clearPendingChatIntent();
  return intent;
}
