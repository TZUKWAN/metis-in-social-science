/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setPendingChatIntent, consumePendingChatIntent } from '../../src/lib/chatIntent.js';

const KEY = 'metis:pendingChatIntent';

describe('chatIntent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores and consumes a pending chat intent', () => {
    setPendingChatIntent({ skillId: 'paper-review', message: 'Review this paper' });
    const intent = consumePendingChatIntent();
    expect(intent).toEqual({ skillId: 'paper-review', message: 'Review this paper' });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('preserves exact scenario, project, and session ownership fields', () => {
    setPendingChatIntent({
      scenarioId: 'user:scenarios/exact-runtime',
      projectId: 'project-a',
      sessionId: 'session-a',
      message: 'Run the exact scenario',
      autoSend: true,
    });

    expect(consumePendingChatIntent()).toEqual({
      scenarioId: 'user:scenarios/exact-runtime',
      projectId: 'project-a',
      sessionId: 'session-a',
      message: 'Run the exact scenario',
      autoSend: true,
    });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('returns null when there is no intent', () => {
    expect(consumePendingChatIntent()).toBeNull();
  });

  it('returns null and clears invalid stored data', () => {
    localStorage.setItem(KEY, 'not-json');
    expect(consumePendingChatIntent()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    { message: 'bad project', projectId: 42 },
    { message: 'bad session', sessionId: false },
  ])('rejects malformed ownership data: $message', (payload) => {
    localStorage.setItem(KEY, JSON.stringify(payload));
    expect(consumePendingChatIntent()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
