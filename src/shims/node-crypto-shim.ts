/**
 * node:crypto 浏览器垫片（dev-only 远程开发桥）。
 *
 * renderer 打包时 engine 契约模块（如 CurrentAffairsRuntimeContract 的
 * 签名校验）顶层引用 node:crypto 的同步 API。WebCrypto 是异步的，无法
 * 满足同步签名语义，这里用纯 JS 实现 SHA-256/HMAC；random 系列走浏览器
 * 原生 crypto。仅服务远程开发模式，不参与生产链路。
 */

// ── SHA-256（纯 JS，同步）────────────────────────────────────
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function toBytes(data: string | Uint8Array): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data;
}

function sha256Bytes(input: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = input.length * 8;
  const padded = new Uint8Array(((input.length + 9 + 63) & ~63));
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000));
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i]! = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = ((w[i - 15]! >>> 7) | (w[i - 15]! << 25)) ^ ((w[i - 15]! >>> 18) | (w[i - 15]! << 14)) ^ (w[i - 15]! >>> 3);
      const s1 = ((w[i - 2]! >>> 17) | (w[i - 2]! << 15)) ^ ((w[i - 2]! >>> 19) | (w[i - 2]! << 13)) ^ (w[i - 2]! >>> 10);
      w[i]! = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0]! = (h[0]! + a) >>> 0; h[1]! = (h[1]! + b) >>> 0; h[2]! = (h[2]! + c) >>> 0; h[3]! = (h[3]! + d) >>> 0;
    h[4]! = (h[4]! + e) >>> 0; h[5]! = (h[5]! + f) >>> 0; h[6]! = (h[6]! + g) >>> 0; h[7]! = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
    for (let i = 0; i < 8; i += 1) new DataView(out.buffer).setUint32(i * 4, h[i]!);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface HashLike {
  update(data: string | Uint8Array): HashLike;
  digest(encoding?: string): string | Uint8Array;
}

function createHash(algorithm: string): HashLike {
  if (!/sha256/iu.test(algorithm)) throw new Error(`[remote-bridge] hash algorithm not supported in browser shim: ${algorithm}`);
  let data: Uint8Array = new Uint8Array(0);
  return {
    update(chunk) {
      const next = toBytes(chunk);
      const merged = new Uint8Array(data.length + next.length);
      merged.set(data); merged.set(next, data.length);
      data = merged;
      return this;
    },
    digest(encoding) {
      const out = sha256Bytes(data);
      return encoding === 'hex' || encoding === undefined ? toHex(out) : out;
    },
  };
}

function createHmac(algorithm: string, key: string | Uint8Array): HashLike {
  if (!/sha256/iu.test(algorithm)) throw new Error(`[remote-bridge] hmac algorithm not supported in browser shim: ${algorithm}`);
  const keyBytes = toBytes(key);
  const block = new Uint8Array(64);
  const normalized = keyBytes.length > 64 ? sha256Bytes(keyBytes) : keyBytes;
  block.set(normalized);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  let message: Uint8Array = new Uint8Array(0);
  return {
    update(chunk) {
      const next = toBytes(chunk);
      const merged = new Uint8Array(message.length + next.length);
      merged.set(message); merged.set(next, message.length);
      message = merged;
      return this;
    },
    digest(encoding) {
      const innerInput = new Uint8Array(inner.length + message.length);
      innerInput.set(inner); innerInput.set(message, inner.length);
      const innerHash = sha256Bytes(innerInput);
      const outerInput = new Uint8Array(outer.length + innerHash.length);
      outerInput.set(outer); outerInput.set(innerHash, outer.length);
      const mac = sha256Bytes(outerInput);
      return encoding === 'hex' || encoding === undefined ? toHex(mac) : mac;
    },
  };
}

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

function randomUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export { createHash, createHmac, randomBytes, randomUUID };
