/**
 * 2.9 图表自然语言重做（刘总 2026-09）— artifact:regenerate-chart 行为契约。
 *
 * 不是源码扫描：直接在真实 PersistenceStore（临时目录 SQLite）+ 假 provider
 * 上调用 registerArtifactIpc 注册出的 handler，验证：
 *  - 重做结果持久化为「独立原始数据生成物 + 可追溯新版图表生成物」；
 *  - 原图代码块被精确替换，其余内容保持不变；
 *  - 缺原始数据 / provider 失败 / 生成物不存在时拒绝，且绝不落任何新行。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, afterEach, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IpcRegistry } from '../../electron/ipc/IpcRegistry.js';
import { registerArtifactIpc } from '../../electron/ipc/registerArtifactIpc.js';
import type { DomainIpcContext } from '../../electron/ipc/DomainIpcContext.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import type { NormalizedResponse } from '../../engine/core/types.js';

const FENCE = '```';

function fakeIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) { handlers.delete(channel); },
    listenerCount(channel: string) { return handlers.has(channel) ? 1 : 0; },
  };
}

function fakeEvent() {
  return {
    sender: { id: 7, isDestroyed: () => false, send: vi.fn() },
    senderFrame: { processId: 7, routingId: 1 },
  } as unknown as IpcMainInvokeEvent;
}

function providerResponse(content: string): NormalizedResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  };
}

function buildHarness(options: { provider?: ReturnType<typeof vi.fn> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-chart-regen-'));
  const store = new PersistenceStore(path.join(dir, 'metis.db'));
  store.createSession('sess-chart', undefined, undefined);
  store.createArtifact({
    id: 'art-original',
    sessionId: 'sess-chart',
    name: '研究报告.md',
    type: 'md',
    content: `# 报告\n\n${FENCE}mermaid\ngraph TD; A-->B;\n${FENCE}\n\n正文段落。`,
  });
  const ipcMain = fakeIpcMain();
  const ctx = {
    registry: new IpcRegistry({ ipcMain: ipcMain as never }),
    requireRendererMainFrame: () => ({}) as never,
    runtimeShutdown: {} as never,
    agentLoop: () => null,
    provider: () => (options.provider ? { complete: options.provider } : null) as never,
    store: () => store,
    researchRepository: () => null,
    providerProfileStore: () => null,
    ensureTopicService: () => { throw new Error('unused'); },
    freeModelService: () => null,
    experimentScriptAdapter: () => null,
    fileCapabilities: () => ({ resolve: () => undefined, issue: () => undefined }) as never,
    dataDir: () => dir,
    userDataDir: () => dir,
    defaultDataDir: () => dir,
    backupService: () => null,
    ensureWeChatBot: () => null,
    browserService: () => null,
    collabService: () => null,
    ensureCollabService: () => null,
  } as unknown as DomainIpcContext;
  registerArtifactIpc(ctx);
  const invoke = (channel: string, payload: unknown) => (
    ipcMain.handlers.get(channel)!(fakeEvent(), payload)
  );
  return { store, invoke, dir };
}

function tempDirs(): string[] { return []; }

describe('artifact:regenerate-chart — durable chart revision pipeline', () => {
  const cleanup: Array<() => void> = [];
  // Windows 上 SQLite 连接未关时 rmSync 会 EPERM：先 close 再删目录。
  function track(store: PersistenceStore, dir: string) {
    cleanup.push(() => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); void tempDirs; });

  it('persists a dedicated source-data artifact and a traceable revised chart artifact, then returns the new content', async () => {
    const provider = vi.fn(async () => providerResponse(`${FENCE}mermaid\ngraph TD; A-->B-->C;\n${FENCE}`));
    const { store, invoke, dir } = buildHarness({ provider });
    track(store, dir);

    const result = await invoke('artifact:regenerate-chart', {
      sessionId: 'sess-chart',
      artifactId: 'art-original',
      chartSource: 'graph TD; A-->B;',
      chartLanguage: 'mermaid',
      instruction: '把 C 节点接在 B 后面，并加注释',
      sourceData: 'from,to\nA,B\nB,C',
    }) as { success: boolean; artifactId?: string; sourceDataArtifactId?: string; content?: string; name?: string; code?: string };

    expect(result.success).toBe(true);
    expect(result.sourceDataArtifactId).toBeTruthy();
    expect(result.artifactId).toBeTruthy();

    const sourceData = store.getArtifactContent(result.sourceDataArtifactId!, 'sess-chart');
    expect(sourceData?.content).toBe('from,to\nA,B\nB,C');
    const revised = store.getArtifactContent(result.artifactId!, 'sess-chart');
    expect(revised?.content).toContain('graph TD; A-->B-->C;');
    expect(revised?.content).toContain('正文段落。');
    expect(revised?.content).not.toContain('graph TD; A-->B;\n');
    const revisedMetadata = JSON.parse(
      (store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).db
        .prepare('SELECT metadata FROM artifacts WHERE id = ?')
        .get(result.artifactId!)?.metadata as string,
    );
    expect(revisedMetadata.kind).toBe('chart_revision');
    expect(revisedMetadata.sourceDataArtifactId).toBe(result.sourceDataArtifactId);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rejects regeneration without confirmed source data and never persists anything', async () => {
    const provider = vi.fn(async () => providerResponse('ignored'));
    const { store, invoke, dir } = buildHarness({ provider });
    track(store, dir);
    const before = store.listArtifacts('sess-chart').length;

    const result = await invoke('artifact:regenerate-chart', {
      sessionId: 'sess-chart',
      artifactId: 'art-original',
      chartSource: 'graph TD; A-->B;',
      chartLanguage: 'mermaid',
      instruction: '换个配色',
      sourceData: '   ',
    }) as { success: boolean; code?: string };

    expect(result.success).toBe(false);
    expect(result.code).toBe('source_data_required');
    expect(provider).not.toHaveBeenCalled();
    expect(store.listArtifacts('sess-chart')).toHaveLength(before);
  });

  it('reports provider failure honestly and leaves the original artifact untouched', async () => {
    const provider = vi.fn(async () => { throw new Error('upstream 503'); });
    const { store, invoke, dir } = buildHarness({ provider });
    track(store, dir);
    const before = store.listArtifacts('sess-chart').length;

    const result = await invoke('artifact:regenerate-chart', {
      sessionId: 'sess-chart',
      artifactId: 'art-original',
      chartSource: 'graph TD; A-->B;',
      chartLanguage: 'mermaid',
      instruction: '换个配色',
      sourceData: 'A,B\n1,2',
    }) as { success: boolean; code?: string; message?: string };

    expect(result.success).toBe(false);
    expect(result.code).toBe('generation_failed');
    expect(result.message).toContain('503');
    expect(store.listArtifacts('sess-chart')).toHaveLength(before);
    expect(store.getArtifactContent('art-original', 'sess-chart')?.content).toContain('graph TD; A-->B;');
  });

  it('returns not_found for an artifact outside the session', async () => {
    const { store, invoke, dir } = buildHarness();
    track(store, dir);
    const result = await invoke('artifact:regenerate-chart', {
      sessionId: 'sess-other',
      artifactId: 'art-original',
      chartSource: 'x',
      chartLanguage: 'mermaid',
      instruction: '调整',
      sourceData: 'a,b\n1,2',
    }) as { success: boolean; code?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('not_found');
  });
});
