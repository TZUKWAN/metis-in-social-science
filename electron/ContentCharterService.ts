import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ContentCharterSchema,
  buildDefaultContentCharter,
  writingCharterPrompt,
  type ContentCharter,
  type CharterWriting,
} from '../engine/content-charter/ContentCharterContract.js';

/**
 * 内容规范（Content Charter）存储与解析：
 *  - CRUD on content_charters 表（global / project 两级作用域）；
 *  - resolveActive(projectId)：项目激活章程 → 全局激活章程 → 内置默认（fail-open 到空规范）；
 *  - 首次启动播种内置默认章程并激活。
 */

type CharterRow = {
  id: string; name: string; scope: string; project_id: string | null;
  definition_json: string; is_active: number; created_at: number; updated_at: number;
};

export class ContentCharterService {
  constructor(private readonly db: Database.Database) {}

  /** 首次启动播种默认章程（幂等）。 */
  ensureDefault(): void {
    const existing = this.db.prepare("SELECT id FROM content_charters WHERE id = 'charter-default'").get();
    if (existing) return;
    const now = Date.now();
    const charter = buildDefaultContentCharter(now);
    this.db.prepare("INSERT INTO content_charters (id,name,scope,project_id,definition_json,is_active,created_at,updated_at) VALUES ('charter-default',?,'global',NULL,?,1,?,?)")
      .run(charter.name, JSON.stringify(charter), now, now);
  }

  list(scope?: 'global' | 'project', projectId?: string | null): ContentCharter[] {
    const rows = (scope
      ? this.db.prepare('SELECT * FROM content_charters WHERE scope = ? ORDER BY updated_at DESC').all(scope)
      : this.db.prepare('SELECT * FROM content_charters ORDER BY updated_at DESC').all()) as CharterRow[];
    return rows
      .filter((row) => scope !== 'project' || !row.project_id || row.project_id === (projectId ?? ''))
      .flatMap((row) => {
        const parsed = ContentCharterSchema.safeParse(JSON.parse(row.definition_json));
        return parsed.success ? [parsed.data] : [];
      });
  }

  get(id: string): ContentCharter | null {
    const row = this.db.prepare('SELECT * FROM content_charters WHERE id = ?').get(id) as CharterRow | undefined;
    if (!row) return null;
    const parsed = ContentCharterSchema.safeParse(JSON.parse(row.definition_json));
    return parsed.success ? parsed.data : null;
  }

  save(charter: ContentCharter): ContentCharter {
    const parsed = ContentCharterSchema.parse(charter);
    const now = Date.now();
    const existing = this.db.prepare('SELECT created_at FROM content_charters WHERE id = ?').get(parsed.id) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? parsed.createdAt ?? now;
    this.db.prepare(`INSERT INTO content_charters (id,name,scope,project_id,definition_json,is_active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, scope=excluded.scope, project_id=excluded.project_id,
        definition_json=excluded.definition_json, updated_at=excluded.updated_at`)
      .run(parsed.id, parsed.name, parsed.scope, parsed.projectId, JSON.stringify(parsed),
        existing ? this.readActive(parsed.id) : 0, createdAt, now);
    return parsed;
  }

  private readActive(id: string): number {
    const row = this.db.prepare('SELECT is_active FROM content_charters WHERE id = ?').get(id) as { is_active: number } | undefined;
    return row?.is_active ?? 0;
  }

  delete(id: string): boolean {
    if (id === 'charter-default') return false;
    const info = this.db.prepare('DELETE FROM content_charters WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** 激活：global 作用域全局唯一；project 作用域每项目唯一。 */
  setActive(id: string, projectId?: string | null): boolean {
    const charter = this.get(id);
    if (!charter) return false;
    const activate = this.db.transaction(() => {
      if (charter.scope === 'global') {
        this.db.prepare("UPDATE content_charters SET is_active = 0 WHERE scope = 'global'").run();
        this.db.prepare('UPDATE content_charters SET is_active = 1 WHERE id = ?').run(id);
      } else {
        const pid = projectId ?? charter.projectId ?? '';
        if (!pid) return;
        this.db.prepare("UPDATE content_charters SET is_active = 0 WHERE scope = 'project' AND project_id = ?").run(pid);
        this.db.prepare('UPDATE content_charters SET is_active = 1, project_id = ? WHERE id = ?').run(pid, id);
      }
    });
    activate();
    return true;
  }

  /** 解析当前生效章程：项目激活 → 全局激活 → null（调用方退化为无规范）。 */
  resolveActive(projectId?: string | null): ContentCharter | null {
    if (projectId) {
      const row = this.db.prepare("SELECT id FROM content_charters WHERE scope = 'project' AND project_id = ? AND is_active = 1").get(projectId) as { id: string } | undefined;
      if (row) return this.get(row.id);
    }
    const globalRow = this.db.prepare("SELECT id FROM content_charters WHERE scope = 'global' AND is_active = 1").get() as { id: string } | undefined;
    if (globalRow) return this.get(globalRow.id);
    return null;
  }

  /** 注入用：返回当前生效章程的写作规范 prompt 段（无规范返回 null）。 */
  resolveWritingPrompt(projectId?: string | null): string | null {
    const charter = this.resolveActive(projectId);
    if (!charter) return null;
    return writingCharterPrompt(charter.writing satisfies CharterWriting as CharterWriting);
  }
}
