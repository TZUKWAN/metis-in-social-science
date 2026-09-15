import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// personalization 域已迁出到独立 registrar（2026-09-15 拆分）：接线断言
// 直接以 registrar 源为宿主（main.ts 不再持有这些 handler）。
const registrarSource = readFileSync(resolve(process.cwd(), 'electron/ipc/registerPersonalizationIpc.ts'), 'utf8');

function handlerSource(channel: string, nextChannel: string): string {
  const start = registrarSource.indexOf(`dom.handle('${channel}'`);
  const end = registrarSource.indexOf(`dom.handle('${nextChannel}'`, start);
  if (start < 0 || end < 0) throw new Error(`Could not isolate ${channel} handler`);
  return registrarSource.slice(start, end);
}

describe('personalization list production wiring', () => {
  it('never converts a missing runtime or handler exception into an authoritative empty catalog', () => {
    const source = handlerSource('personalization:list', 'personalization:trash:list');

    expect(source).toContain("{ ok: false, code: 'unavailable' }");
    expect(source).not.toContain('{ ok: true, definitions: [] }');
    expect(source).toContain('personalizationRuntime()?.list(rawRequest)');
  });
});
