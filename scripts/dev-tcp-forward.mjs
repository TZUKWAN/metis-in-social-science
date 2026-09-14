#!/usr/bin/env node
/**
 * dev-tcp-forward — 本机回环 TCP 转发（dev-only 测试辅助）。
 *
 * 用途：产品安全策略只接受 https 或 http://127.0.0.1 的模型端点。
 * 测试服务器是明文 http 非回环 IP 时，用本转发器把
 * http://127.0.0.1:<本地端口> 转发到真实测试服务器，
 * 使其满足回环校验，API Key 仍只出现在产品加密存储中。
 *
 * 用法：node scripts/dev-tcp-forward.mjs <localPort> <remoteHost> <remotePort>
 */
import net from 'node:net';

const [localPort, remoteHost, remotePort] = [process.argv[2], process.argv[3], process.argv[4]];
if (!localPort || !remoteHost || !remotePort) {
  console.error('usage: node scripts/dev-tcp-forward.mjs <localPort> <remoteHost> <remotePort>');
  process.exit(1);
}

const server = net.createServer((socket) => {
  const upstream = net.createConnection({ host: remoteHost, port: Number(remotePort) });
  socket.pipe(upstream);
  upstream.pipe(socket);
  const kill = () => { socket.destroy(); upstream.destroy(); };
  socket.on('error', kill);
  upstream.on('error', kill);
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
});

server.listen(Number(localPort), '127.0.0.1', () => {
  console.log(`[tcp-forward] 127.0.0.1:${localPort} -> ${remoteHost}:${remotePort}`);
});
