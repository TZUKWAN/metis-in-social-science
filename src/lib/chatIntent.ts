/**
 * Cross-page chat intent helpers.
 *
 * Pages that want to open the Chat page with a specific skill and
 * pre-filled message can write an intent to localStorage; ChatPage
 * consumes it on mount.
 */

export interface PendingChatIntent {
  skillId: string;
  message: string;
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
      'skillId' in parsed &&
      'message' in parsed &&
      typeof (parsed as Record<string, unknown>).skillId === 'string' &&
      typeof (parsed as Record<string, unknown>).message === 'string'
    ) {
      return parsed as PendingChatIntent;
    }
  } catch {
    // ignore parse/storage errors
  }
  return null;
}
