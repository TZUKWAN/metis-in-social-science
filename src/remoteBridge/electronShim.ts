/**
 * electronShim — 浏览器远程开发模式下替代 'electron' 模块的垫片（dev-only）。
 *
 * Vite 把 renderer bundle 里的 `import { ipcRenderer, contextBridge } from 'electron'`
 * alias 到这里，于是 electron/preload.ts 的完整逻辑可以原样运行在浏览器中：
 *  - ipcRenderer.invoke → POST http://127.0.0.1:<port>/invoke（真实执行主进程 handler）
 *  - ipcRenderer.on/removeListener/send → 本地事件总线（主进程 SSE 广播）
 *  - contextBridge.exposeInMainWorld → 直接挂到 window（浏览器无 context 隔离，
 *    dev-only 可接受）
 *
 * 端口来源：Vite dev 中间件把主进程打印的实际端口注入到
 * `/metis-remote-bridge-port`（见 vite.config.ts），shim 首次 invoke 前惰性获取。
 */
import type { IpcRendererEvent } from 'electron';

type ListenHandler = (event: IpcRendererEvent, ...args: unknown[]) => void;

interface BridgeMessage {
  t: 'event';
  channel: string;
  payload: unknown;
}

const REMOTE_BRIDGE_ORIGIN = 'http://127.0.0.1';
let cachedPort: number | null = null;
let portRequest: Promise<number> | null = null;
const listeners = new Map<string, Set<ListenHandler>>();
let eventSource: EventSource | null = null;

async function resolvePort(): Promise<number> {
  if (cachedPort !== null) return cachedPort;
  if (!portRequest) {
    portRequest = fetch('/metis-remote-bridge-port', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('remote bridge port unavailable'))))
      .then((data: { port?: number }) => {
        if (typeof data?.port !== 'number') throw new Error('remote bridge port unavailable');
        cachedPort = data.port;
        connectEventStream();
        return cachedPort;
      });
  }
  return portRequest;
}

function emitLocal(channel: string, payload: unknown): void {
  const set = listeners.get(channel);
  if (!set) return;
  const event = { sender: { id: 0 }, senderFrame: null } as unknown as IpcRendererEvent;
  for (const handler of [...set]) {
    try { handler(event, payload); } catch (error) {
      console.error('[remote-bridge] listener failed for', channel, error);
    }
  }
}

function connectEventStream(): void {
  if (eventSource || cachedPort === null) return;
  eventSource = new EventSource(`${REMOTE_BRIDGE_ORIGIN}:${cachedPort}/events`);
  eventSource.onmessage = (message: MessageEvent<string>) => {
    try {
      const frame = JSON.parse(message.data) as BridgeMessage;
      if (frame?.t === 'event' && typeof frame.channel === 'string') {
        emitLocal(frame.channel, frame.payload);
      }
    } catch { /* 忽略无法解析的心跳/注释帧 */ }
  };
  eventSource.onerror = () => {
    // EventSource 自动重连；端口变化（主进程重启）时失效缓存，下次 invoke 重取。
    cachedPort = null;
    portRequest = null;
    eventSource?.close();
    eventSource = null;
  };
}

export const ipcRenderer = {
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const port = await resolvePort();
    const res = await fetch(`${REMOTE_BRIDGE_ORIGIN}:${port}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    const data = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!data.ok) throw new Error(data.error ?? 'remote invoke failed');
    return data.value;
  },
  on: (channel: string, handler: ListenHandler): void => {
    let set = listeners.get(channel);
    if (!set) { set = new Set(); listeners.set(channel, set); }
    set.add(handler);
    connectEventStream();
  },
  once: (channel: string, handler: ListenHandler): void => {
    const wrapped: ListenHandler = (event, ...args) => {
      listeners.get(channel)?.delete(wrapped);
      handler(event, ...args);
    };
    let set = listeners.get(channel);
    if (!set) { set = new Set(); listeners.set(channel, set); }
    set.add(wrapped);
    connectEventStream();
  },
  removeListener: (channel: string, handler: ListenHandler): void => {
    listeners.get(channel)?.delete(handler);
  },
  removeAllListeners: (channel: string): void => {
    listeners.delete(channel);
  },
  send: (channel: string): void => {
    // 主进程不监听渲染端单向消息（METIS 无 ipcMain.on 用法）；如实丢弃。
    console.warn('[remote-bridge] ipcRenderer.send is not supported in remote dev mode:', channel);
  },
};

export const contextBridge = {
  exposeInMainWorld: (key: string, value: unknown): void => {
    (window as unknown as Record<string, unknown>)[key] = value;
  },
};
