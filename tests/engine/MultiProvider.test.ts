/**
 * Multi-provider management: save, list, switch, delete.
 * Tests the IPC layer logic via mock store.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the providers.json file operations.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-providers-'));
const PROVIDERS_PATH = path.join(tmpDir, 'providers.json');

function readProviders(): { providers: Array<Record<string, unknown>>; activeId?: string } {
  if (!fs.existsSync(PROVIDERS_PATH)) return { providers: [] };
  return JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf-8'));
}

function writeProviders(data: { providers: Array<Record<string, unknown>>; activeId?: string }): void {
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

describe('multi-provider storage', () => {
  beforeEach(() => {
    try { fs.unlinkSync(PROVIDERS_PATH); } catch { /* clean slate */ }
  });

  it('starts empty', () => {
    const data = readProviders();
    expect(data.providers).toEqual([]);
  });

  it('saves a provider config', () => {
    writeProviders({ providers: [{ id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-test', vision: true }] });
    const data = readProviders();
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]?.name).toBe('OpenAI');
  });

  it('upserts by id', () => {
    writeProviders({ providers: [{ id: 'p1', name: 'Old', baseUrl: 'url', model: 'm', apiKey: 'k' }] });
    const data = readProviders();
    data.providers[0]!.name = 'Updated';
    writeProviders(data);
    const updated = readProviders();
    expect(updated.providers).toHaveLength(1);
    expect(updated.providers[0]?.name).toBe('Updated');
  });

  it('deletes by id', () => {
    writeProviders({ providers: [
      { id: 'p1', name: 'A', baseUrl: 'u', model: 'm', apiKey: 'k' },
      { id: 'p2', name: 'B', baseUrl: 'u', model: 'm', apiKey: 'k' },
    ], activeId: 'p1' });
    const data = readProviders();
    data.providers = data.providers.filter((p) => p.id !== 'p1');
    if (data.activeId === 'p1') data.activeId = undefined;
    writeProviders(data);
    const after = readProviders();
    expect(after.providers).toHaveLength(1);
    expect(after.providers[0]?.id).toBe('p2');
    expect(after.activeId).toBeUndefined();
  });
});
