/**
 * User-declared max context tokens: settings contract round-trip.
 * A configured maxContextTokens drives the 70% context compression budget
 * in the agent loop (see electron/main.ts createAgentLoop).
 */

import { describe, expect, it } from 'vitest';
import {
  createSettingsViewRecovery,
  decodeSettingsUpdateRequest,
  decodeSettingsView,
} from '../../engine/runtime/SettingsRuntimeContract.js';

describe('settings max context tokens', () => {
  it('recovery view defaults to 0 (auto-detect)', () => {
    const view = createSettingsViewRecovery();
    expect(view.providerMaxContextTokens).toBe(0);
  });

  it('decodeSettingsView accepts a user-declared max context', () => {
    const view = decodeSettingsView({
      configured: true,
      baseUrl: 'https://api.example.com/v1',
      model: 'my-model',
      hasApiKey: true,
      needsReauth: false,
      theme: 'dark',
      weeklyReadingGoal: 5,
      providerVision: false,
      providerMaxContextTokens: 128000,
    });
    expect(view.providerMaxContextTokens).toBe(128000);
  });

  it('decodeSettingsView defaults the field when omitted', () => {
    const view = decodeSettingsView({
      configured: true,
      baseUrl: 'https://api.example.com/v1',
      model: 'my-model',
      hasApiKey: true,
      needsReauth: false,
      theme: 'light',
      weeklyReadingGoal: 5,
      providerVision: false,
    });
    expect(view.providerMaxContextTokens).toBe(0);
  });

  it('decodeSettingsUpdateRequest accepts providerMaxContextTokens', () => {
    const req = decodeSettingsUpdateRequest({
      theme: 'light',
      weeklyReadingGoal: 5,
      providerVision: false,
      providerMaxContextTokens: 64000,
    });
    expect(req?.providerMaxContextTokens).toBe(64000);
  });

  it('rejects out-of-range or fractional values', () => {
    const fractional = decodeSettingsUpdateRequest({
      theme: 'light',
      providerMaxContextTokens: 12.5,
    });
    expect(fractional).toBeUndefined();

    const tooLarge = decodeSettingsUpdateRequest({
      theme: 'light',
      providerMaxContextTokens: 3_000_000,
    });
    expect(tooLarge).toBeUndefined();

    const negative = decodeSettingsUpdateRequest({
      theme: 'light',
      providerMaxContextTokens: -1,
    });
    expect(negative).toBeUndefined();
  });
});
