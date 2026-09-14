/**
 * RemoteDevBridge 单元测试（dev-only 远程开发桥，刘总 2026-09-15 工作流）。
 *
 * 真实行为验证：启动回环 HTTP/SSE 服务 → POST /invoke 调用注册的 handler
 * （虚拟 event 带 trusted sender）→ GET /events 收到主进程 send 广播。
 */
import { describe, expect, it } from 'vitest';
import { RemoteDevBridge, isRemoteBridgeSender } from '../../electron/RemoteBridge/remoteDevBridge.js';

interface FakeIpcMain {
  _handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
}

function startBridge(): Promise<{ bridge: RemoteDevBridge; ipc: FakeIpcMain; port: number }> {
  const ipc: FakeIpcMain = { _handlers: new Map() };
  ipc._handlers.set('test:echo', (event, value: unknown) => {
    // handler 内通过 event.sender.send 推一条事件，模拟主进程主动推送。
    (event as { sender: { send(c: string, p: unknown): void } }).sender.send('test:pushed', { echo: value });
    expect(isRemoteBridgeSender((event as { sender: unknown }).sender)).toBe(true);
    return { echoed: value, senderId: (event as { sender: { id: number } }).sender.id };
  });
  ipc._handlers.set('test:boom', () => {
    throw new Error('handler exploded');
  });
  const bridge = new RemoteDevBridge({ ipcMain: ipc, port: 0 });
  return new Promise((resolve, reject) => {
    bridge.start()
      .then(({ port }) => {
        bridge.captureHandlers();
        resolve({ bridge, ipc, port });
      })
      .catch(reject);
  });
}

describe('RemoteDevBridge (dev-only browser bridge)', () => {
  it('serves health, invokes registered handlers, and streams sender.send events over SSE', async () => {
    const { bridge, port } = await startBridge();
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
      expect(health).toMatchObject({ ok: true, bridge: 'metis-remote-dev' });

      // SSE 订阅先建立，invoke 触发的事件才能被收到。
      const controller = new AbortController();
      const eventPromise = (async () => {
        const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
        expect(res.ok).toBe(true);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const deadline = Date.now() + 5_000;
        let buffer = '';
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const start = buffer.indexOf('data: {');
          if (start >= 0) {
            const line = buffer.slice(start).split('\n')[0]!;
            const frame = JSON.parse(line.slice('data: '.length)) as { t: string; channel: string; payload: unknown };
            if (frame.t === 'event' && frame.channel === 'test:pushed') return frame;
          }
        }
        throw new Error('SSE event not received within timeout');
      })();

      // 给 SSE 建连留一点时间。
      await new Promise((resolve) => setTimeout(resolve, 150));
      const invokeRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'test:echo', args: ['你好'] }),
      }).then((r) => r.json()) as { ok: boolean; value?: { echoed: string; senderId: number } };
      expect(invokeRes.ok).toBe(true);
      expect(invokeRes.value?.echoed).toBe('你好');
      // 虚拟 sender 是固定的受信 id（executionOwnerFor 等会读取）。
      expect(invokeRes.value?.senderId).toBe(902_101);

      const frame = (await eventPromise) as { channel: string; payload: { echo: string } };
      expect(frame.payload.echo).toBe('你好');
      controller.abort();
    } finally {
      bridge.stop();
    }
  });

  it('reports handler errors without crashing the bridge and 404s unknown channels', async () => {
    const { bridge, port } = await startBridge();
    try {
      const boom = await fetch(`http://127.0.0.1:${port}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'test:boom', args: [] }),
      }).then((r) => r.json()) as { ok: boolean; error?: string };
      expect(boom.ok).toBe(false);
      expect(boom.error).toContain('handler exploded');

      const unknown = await fetch(`http://127.0.0.1:${port}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'nope:missing', args: [] }),
      });
      expect(unknown.status).toBe(404);

      // 失败后桥仍然可用。
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
      expect(health.ok).toBe(true);
    } finally {
      bridge.stop();
    }
  });
});
