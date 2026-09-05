/**
 * ExternalReferenceService — 外部模型引用存储（2026-09-05 刘总规格书）。
 *
 * 【零越界】这里只存「外部参考·非证据」条目：与 papers/sources/paper_project_links
 * 证据链物理隔离（独立表）。渲染层展示必须带非证据徽标；ScenarioWorkflow 的
 * 证据装配永远不读本表。
 * 写入路径强制经 Human Confirmation（IPC 层的确认卡），服务层只做净化校验与
 * digest 去重（同 digest + 同 project 的重复引用幂等返回已有条目）。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  normalizeExternalModelReference,
  externalReferenceDigest,
  type ExternalModelReference,
} from '../engine/runtime/ExternalReferenceContract.js';

interface ExternalRefRow {
  id: string; model: string; url: string; quoted_text: string; context_digest: string;
  captured_at: number; project_id: string | null; session_id: string | null; created_at: number;
}

function rowToReference(row: ExternalRefRow): ExternalModelReference {
  return {
    v: 1,
    id: row.id,
    model: row.model,
    url: row.url,
    quotedText: row.quoted_text,
    contextDigest: row.context_digest,
    capturedAt: row.captured_at,
    projectId: row.project_id,
    sessionId: row.session_id,
  };
}

export class ExternalReferenceService {
  constructor(private readonly db: Database.Database) {}

  /** 写入一条外部引用（确认卡通过后才调用）。同 digest 幂等。 */
  add(raw: unknown): { ok: true; reference: ExternalModelReference; duplicate: boolean } | { ok: false; issues: string[] } {
    const parsed = normalizeExternalModelReference(raw);
    if (!parsed.ok) return parsed;
    const reference = parsed.reference;
    const existing = this.db.prepare(
      'SELECT * FROM external_references WHERE context_digest = ? AND COALESCE(project_id, \'\') = COALESCE(?, \'\') ORDER BY captured_at DESC LIMIT 1',
    ).get(reference.contextDigest, reference.projectId) as ExternalRefRow | undefined;
    if (existing) return { ok: true, reference: rowToReference(existing), duplicate: true };
    // 自动 id 仅含时间戳+摘要，同文本跨项目可能撞主键——冲突时加随机尾段。
    let id = reference.id;
    if (this.db.prepare('SELECT 1 FROM external_references WHERE id = ?').get(id)) {
      id = `${id}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO external_references
      (id, model, url, quoted_text, context_digest, captured_at, project_id, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, reference.model, reference.url, reference.quotedText,
        reference.contextDigest, reference.capturedAt, reference.projectId, reference.sessionId, now);
    return { ok: true, reference: { ...reference, id }, duplicate: false };
  }

  list(query: { projectId?: string | null; sessionId?: string | null; limit?: number } = {}): ExternalModelReference[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.projectId !== undefined) {
      clauses.push(query.projectId === null ? "COALESCE(project_id, '') = ''" : 'project_id = ?');
      if (query.projectId !== null) params.push(query.projectId);
    }
    if (query.sessionId !== undefined) {
      clauses.push(query.sessionId === null ? "COALESCE(session_id, '') = ''" : 'session_id = ?');
      if (query.sessionId !== null) params.push(query.sessionId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM external_references ${where} ORDER BY captured_at DESC LIMIT ?`,
    ).all(...params, Math.min(query.limit ?? 100, 500)) as ExternalRefRow[];
    return rows.map(rowToReference);
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM external_references WHERE id = ?').run(id);
    return result.changes === 1;
  }

  digestOf(quotedText: string): string {
    return externalReferenceDigest(quotedText);
  }
}
