/**
 * RemoteDevBridge — 浏览器远程开发桥（dev-only，刘总 2026-09-15 工作流）。
 *
 * 让 METIS 的 React 界面跑在 Vite dev server + 普通浏览器里，而主进程
 * 功能（全部 IPC handler 与事件推送）仍由 Electron 提供：
 *  - POST /invoke  { channel, args } → 调用真实注册的 ipcMain handler
 *  - GET  /events  → SSE：主进程所有 event.sender.send(...) 原样广播
 *
 * 安全边界（必须诚实）：仅绑定 127.0.0.1 回环；仅 METIS_REMOTE_BRIDGE=1
 * 显式开启；绕过窗口鉴权是因为浏览器连接没有 WebContents——这是设计
 * 决策而非疏漏，绝不能在 packaged 模式默认开启。
 *
 * handler 表来自 Electron ipcMain 的内部 _handlers 快照（dev 工具可接受
 * 私有 API；setupIPC 完成后再启动本服务即可拿到全量通道）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 需要覆盖的 WebContents 表面（以 main.ts 实际用法为准）。 */
export interface IpcEventSenderLike {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  focus(): void;
  mainFrame: unknown;
}

export interface IpcEventFrameLike {
  processId: number;
  routingId: number;
  url: string;
}

export interface VirtualIpcEvent {
  sender: IpcEventSenderLike;
  senderFrame: IpcEventFrameLike;
}

const VIRTUAL_SENDER_ID = 902_101;
const VIRTUAL_PROCESS_ID = 902_102;
const VIRTUAL_ROUTING_ID = 1;

const trustedVirtualSenders = new WeakSet<object>();

/** 主进程里不走 event.sender 的窗口广播（如 broadcastGoalChanged）经此进入 SSE。 */
let globalBroadcaster: ((channel: string, payload: unknown) => void) | null = null;

export function remoteBroadcast(channel: string, payload: unknown): void {
  globalBroadcaster?.(channel, payload);
}

export function isRemoteBridgeSender(sender: unknown): boolean {
  return typeof sender === 'object' && sender !== null && trustedVirtualSenders.has(sender);
}

type InvokeListener = (event: VirtualIpcEvent, ...args: unknown[]) => unknown;

export interface RemoteDevBridgeOptions {
  /** Electron ipcMain（读取内部 _handlers 快照——Electron 未公开的稳定内部）。 */
  ipcMain: object;
  /** 回环端口；0 = 随机可用端口。 */
  port?: number;
}

interface ClientConnection {
  res: ServerResponse;
}

export class RemoteDevBridge {
  private readonly handlers = new Map<string, InvokeListener>();
  private readonly clients = new Set<ClientConnection>();
  private server: ReturnType<typeof createServer> | null = null;
  private cachedHandlers = false;

  constructor(private readonly options: RemoteDevBridgeOptions) {}

  /** 快照当前全部已注册通道（setupIPC 完成后调用一次）。 */
  captureHandlers(): number {
    this.handlers.clear();
    // Electron 内部表：ipcMain.handle 存进 _invokeHandlers（Map）——不同版本曾用 _handlers。
    const candidate = this.options.ipcMain as { _invokeHandlers?: Map<string, InvokeListener>; _handlers?: Map<string, InvokeListener> };
    const internal = candidate._invokeHandlers ?? candidate._handlers;
    if (internal && typeof internal.forEach === 'function') {
      internal.forEach((listener, channel) => {
        this.handlers.set(channel, listener as InvokeListener);
      });
    }
    this.cachedHandlers = true;
    return this.handlers.size;
  }

  private buildVirtualEvent(): VirtualIpcEvent {
    const senderFrame: IpcEventFrameLike = {
      processId: VIRTUAL_PROCESS_ID,
      routingId: VIRTUAL_ROUTING_ID,
      url: 'metis-remote://browser/main',
    };
    const sender: IpcEventSenderLike & { mainFrame: unknown } = {
      id: VIRTUAL_SENDER_ID,
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        this.broadcastEvent(channel, args.length === 1 ? args[0] : args);
      },
      focus: () => { /* 浏览器端自己管理焦点 */ },
      mainFrame: senderFrame,
    };
    trustedVirtualSenders.add(sender);
    return { sender, senderFrame };
  }

  private sseWrite(conn: ClientConnection, payload: unknown): void {
    try {
      conn.res.write(`data: ${JSON.stringify(payload)}${''}\n\n`);
    } catch {
      this.clients.delete(conn);
    }
  }

  private broadcastEvent(channel: string, payload: unknown): void {
    if (this.clients.size === 0) return;
    const frame = JSON.stringify({ t: 'event', channel, payload });
    for (const conn of [...this.clients]) {
      try {
        conn.res.write(`data: ${frame}\n\n`);
      } catch {
        this.clients.delete(conn);
      }
    }
  }

  private async handleInvoke(res: ServerResponse, body: unknown): Promise<void> {
    if (!this.cachedHandlers) this.captureHandlers();
    const request = body as { channel?: unknown; args?: unknown } | null;
    const channel = typeof request?.channel === 'string' ? request.channel : '';
    const args = Array.isArray(request?.args) ? request.args : [];
    const listener = this.handlers.get(channel);
    if (!listener) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `channel_not_registered: ${channel}` }));
      return;
    }
    try {
      const event = this.buildVirtualEvent();
      const value = await listener(event, ...args);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
    } catch (error) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /** 启动回环 HTTP/SSE 服务。resolve 后可从 addressInfo 取实际端口。 */
  start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      if (this.server) return resolve({ port: (this.server.address() as AddressInfo).port });
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (!req.socket.remoteAddress?.replace(/^::ffff:/u, '').startsWith('127.0.0.1')) {
          res.writeHead(403);
          res.end('remote bridge is loopback-only');
          return;
        }
        // 浏览器页面（vite dev server origin）跨源访问回环桥——dev-only 放开 CORS。
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }
        if (req.method === 'GET' && req.url === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          res.write(': connected\n\n');
          const conn: ClientConnection = { res };
          this.clients.add(conn);
          req.on('close', () => this.clients.delete(conn));
          const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
          }, 15_000);
          req.on('close', () => clearInterval(ping));
          return;
        }
        if (req.method === 'POST' && req.url === '/invoke') {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 64 * 1024 * 1024) chunks.push(chunk);
          });
          req.on('end', () => {
            let body: unknown;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
            void this.handleInvoke(res, body);
          });
          return;
        }
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, bridge: 'metis-remote-dev', channels: this.handlers.size }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.on('error', reject);
      globalBroadcaster = (channel, payload) => this.broadcastEvent(channel, payload);
      server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        this.server = server;
        const address = server.address() as AddressInfo;
        resolve({ port: address.port });
      });
    });
  }

  stop(): void {
    globalBroadcaster = null;
    for (const conn of [...this.clients]) {
      try { conn.res.end(); } catch { /* already gone */ }
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.cachedHandlers = false;
  }
}
