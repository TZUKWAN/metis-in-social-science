/**
 * Personalization 域 IPC 绑定与迁移安全文件辅助 — 从 main.ts 迁出
 * （2026-09-15 解耦：extension:apply / mcp:activate / bundle:export / bundle:import）。
 *
 * 职责边界：
 * - bind* 函数把渲染端公开请求按调用方身份（owner + canonical JSON 摘要）
 *   绑定为内部请求，生成 evidenceContext 供激活审计；摘要算法必须保持
 *   `metis:personalization-*-ipc:v1` 域分隔字符串不变，否则历史证据失配。
 * - write/readPersonalizationBundleFile 是跨信任边界的包文件落盘/读取：
 *   只允许全新真实路径（拒绝符号链接与已存在目标），读取校验大小上限与
 *   读取期间文件未被替换。
 *
 * 依赖说明：webContentsGenerations 仍归 main.ts 生命周期所有，经
 * generationOf 注入；executionOwnerFor 复用 FileCapabilityHandler 的实现。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import {
  PersonalizationExtensionApplyRequestSchema,
  type PersonalizationExtensionApplyRequest,
  type PersonalizationExtensionIpcRequest,
} from '../../engine/runtime/PersonalizationExtensionContract.js';
import {
  McpActivationRequestSchema,
  type McpActivationIpcRequest,
  type McpActivationRequest,
} from '../../engine/runtime/McpActivationContract.js';
import { PERSONALIZATION_BUNDLE_LIMITS } from '../../engine/runtime/PersonalizationBundleContract.js';
import { executionOwnerFor } from '../FileCapabilityHandler.js';

export function canonicalPersonalizationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPersonalizationJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalPersonalizationJson(record[key])}`).join(',')}}`;
}

export function bindPersonalizationExtensionRequest(
  request: PersonalizationExtensionIpcRequest,
  event: IpcMainInvokeEvent,
): PersonalizationExtensionApplyRequest | undefined {
  const owner = executionOwnerFor(event);
  const operationId = request.operationId;
  const runManifestDigest = createHash('sha256')
    .update('metis:personalization-extension-ipc:v1\0')
    .update(canonicalPersonalizationJson({ owner, request }))
    .digest('hex');
  const evidenceContext = {
    sessionId: `personalization-${owner.webContentsId}`,
    projectId: 'global',
    operationId,
    runManifestDigest,
    observedAt: Date.now(),
  };
  const { operationId: _operationId, ...withoutOperationId } = request;
  const internal = request.mode === 'mcp_requirements'
    ? { ...withoutOperationId, operationId, evidenceContext }
    : { ...withoutOperationId, evidenceContext };
  void _operationId;
  const parsed = PersonalizationExtensionApplyRequestSchema.safeParse(internal);
  return parsed.success ? parsed.data : undefined;
}

export function bindMcpActivationRequest(
  request: McpActivationIpcRequest,
  event: IpcMainInvokeEvent,
  generationOf: (webContentsId: number) => number,
): McpActivationRequest | undefined {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) throw new Error('Managed MCP owner is unavailable');
  const owner = {
    webContentsId: event.sender.id,
    processId: frame.processId,
    routingId: frame.routingId,
    generation: generationOf(event.sender.id),
  };
  const runManifestDigest = createHash('sha256')
    .update('metis:personalization-mcp-activation-ipc:v1\0')
    .update(canonicalPersonalizationJson({ owner, request }))
    .digest('hex');
  const parsed = McpActivationRequestSchema.safeParse({
    contractVersion: 1,
    definitionId: request.definitionId,
    installationId: request.installationId,
    expectedRevision: request.expectedRevision,
    evidenceContext: {
      sessionId: `personalization-${owner.webContentsId}-${owner.generation}`,
      projectId: 'global',
      operationId: request.operationId,
      runManifestDigest,
      observedAt: Date.now(),
      owner,
    },
  });
  return parsed.success ? parsed.data : undefined;
}

export function writePersonalizationBundleFile(destination: string, bytes: Uint8Array): void {
  const parent = path.dirname(path.resolve(destination));
  const parentStat = fs.lstatSync(parent);
  const parentReal = fs.realpathSync.native(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (process.platform === 'win32' ? parentReal.toLowerCase() !== parent.toLowerCase() : parentReal !== parent)) {
    throw new Error('Unsafe bundle destination');
  }
  if (fs.existsSync(destination)) throw new Error('Bundle destination already exists');
  const temporary = path.join(parent, `.metis-bundle-${randomUUID()}.tmp`);
  let published = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    published = true;
    if (process.platform !== 'win32') {
      const directory = fs.openSync(parent, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (!published && fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function readPersonalizationBundleFile(source: string): Uint8Array {
  const resolved = fs.realpathSync.native(path.resolve(source));
  const lstat = fs.lstatSync(resolved);
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size <= 0
    || lstat.size > PERSONALIZATION_BUNDLE_LIMITS.encodedBytes) {
    throw new Error('Unsafe personalization bundle');
  }
  const fd = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error('Personalization bundle changed while being read');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
