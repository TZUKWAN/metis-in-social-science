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

export function setPendingChatIntent(intent: PendingChatIntent): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // ignore storage errors
  }
}

export function consumePendingChatIntent(): PendingChatIntent | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof (parsed as Record<string, unknown>).message === 'string' &&
      (!('skillId' in parsed) || typeof (parsed as Record<string, unknown>).skillId === 'string') &&
      (!('scenarioId' in parsed) || typeof (parsed as Record<string, unknown>).scenarioId === 'string') &&
      (!('projectId' in parsed) || typeof (parsed as Record<string, unknown>).projectId === 'string') &&
      (!('sessionId' in parsed) || typeof (parsed as Record<string, unknown>).sessionId === 'string') &&
      (!('autoSend' in parsed) || typeof (parsed as Record<string, unknown>).autoSend === 'boolean')
    ) {
      return parsed as PendingChatIntent;
    }
  } catch {
    // ignore parse/storage errors
  }
  return null;
}
