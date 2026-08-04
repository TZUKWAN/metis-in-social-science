/**
 * OfficeCliService: command argument construction, JSON parsing, watch URL
 * detection. spawn/spawnSync are mocked so no real binary is needed.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { OfficeCliService } from '../../electron/OfficeCliService.js';

// Mock child_process so tests never invoke the real binary.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

import { spawnSync, spawn } from 'node:child_process';

// Stub fs.existsSync so the Windows fallback path resolves without a real file.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => false), default: { ...actual, existsSync: vi.fn(() => false) } };
});

function makeSpawnChild(stdout = '', stderr = '') {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const child = {
    stdout: { on: (ev: string, cb: (...a: unknown[]) => void) => { handlers.stdout = cb; } },
    stderr: { on: (ev: string, cb: (...a: unknown[]) => void) => { handlers.stderr = cb; } },
    on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb; },
    kill: vi.fn(),
  };
  // Defer emission so the caller can attach handlers first.
  queueMicrotask(() => {
    if (stdout) handlers.stdout?.(stdout);
    if (stderr) handlers.stderr?.(stderr);
    handlers.close?.(0);
  });
  return child;
}

describe('OfficeCliService', () => {
  let service: OfficeCliService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new OfficeCliService();
  });

  it('detects availability via --version', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '1.0.143\n', stderr: '' } as never);
    const result = service.detect();
    expect(result.available).toBe(true);
    expect(result.version).toBe('1.0.143');
  });

  it('reports unavailable when the binary is missing', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'not found' } as never);
    expect(service.detect().available).toBe(false);
  });

  it('exec parses JSON output', async () => {
    vi.mocked(spawn).mockImplementation((() => makeSpawnChild(JSON.stringify({ success: true, data: 'ok' }))) as never);
    const result = await service.exec(['view', 'doc.docx', 'outline']);
    expect(result.success).toBe(true);
    expect(result.data).toBe('ok');
  });

  it('exec reports failure on non-zero exit with no stdout', async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const child = {
      stdout: { on: () => {},
        // emit nothing
      },
      stderr: { on: (_ev: string, cb: (...a: unknown[]) => void) => { handlers.stderr = cb; } },
      on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb; },
      kill: vi.fn(),
    };
    vi.mocked(spawn).mockImplementation((() => child) as never);
    queueMicrotask(() => {
      handlers.stderr?.('boom');
      handlers.close?.(1);
    });
    const result = await service.exec(['bogus']);
    expect(result.success).toBe(false);
  });

  it('add builds --prop key=value arguments', async () => {
    let captured: string[] = [];
    vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
      captured = args;
      return makeSpawnChild(JSON.stringify({ success: true }));
    }) as never);
    await service.add('doc.docx', '/body', 'paragraph', { text: 'hello', style: 'Heading1' });
    expect(captured).toEqual(expect.arrayContaining(['add', 'doc.docx', '/body', '--type', 'paragraph', '--prop', 'text=hello', '--prop', 'style=Heading1', '--json']));
  });

  it('startWatch detects the localhost URL from stdout', async () => {
    const child = makeSpawnChild('Watch: http://localhost:26315\n');
    vi.mocked(spawn).mockImplementation((() => child) as never);
    const result = await service.startWatch('doc.docx');
    expect(result.success).toBe(true);
    expect(result.url).toBe('http://localhost:26315');
    expect(result.port).toBe(26315);
  });

  it('startWatch fails when no URL appears', async () => {
    vi.mocked(spawn).mockImplementation((() => makeSpawnChild('starting...\n')) as never);
    const result = await service.startWatch('doc.docx');
    expect(result.success).toBe(false);
  });
});
