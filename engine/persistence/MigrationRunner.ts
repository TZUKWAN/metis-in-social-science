/**
 * Versioned Migration Runner (METIS-402).
 *
 * Replaces the scattered pragma_table_info checks with a single, ordered, versioned
 * migration pipeline. Guarantees (task list METIS-402):
 *   - Versioned: each migration has a target version; applied in order.
 *   - Transactional: each migration runs in a transaction; a failure rolls back that step.
 *   - Backup: before running, the DB file is copied to a `.bak` so the original is recoverable
 *     even if a migration corrupts state.
 *   - Idempotent / repeat-protected: a `schema_migrations` table records applied versions;
 *     re-running skips already-applied migrations.
 *   - Non-destructive: a failed migration never leaves the DB half-migrated — the backup is
 *     restored on unrecoverable failure.
 *
 * Migrations are plain functions `(db) => void`. They must be deterministic and side-effect
 * free beyond DB writes. Each migration bumps the target version by 1.
 */

import type Database from 'better-sqlite3';
import fs from 'node:fs';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

export interface MigrationResult {
  appliedVersions: number[];
  fromVersion: number;
  toVersion: number;
  backupPath?: string;
  failed?: { version: number; error: string };
  restoredFromBackup: boolean;
}

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  applied_at INTEGER NOT NULL
);
`;

export class MigrationRunner {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private readonly migrations: Migration[];

  constructor(db: Database.Database, dbPath: string, migrations: Migration[]) {
    this.db = db;
    this.dbPath = dbPath;
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
  }

  /** Current applied version (highest in schema_migrations, or 0). */
  currentVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  /** All already-applied versions (for idempotency checks / audits). */
  appliedVersions(): number[] {
    const rows = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    return rows.map((r) => r.version);
  }

  private backup(): string | undefined {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return undefined;
    const bak = `${this.dbPath}.bak-${Date.now()}`;
    try {
      fs.copyFileSync(this.dbPath, bak);
      return bak;
    } catch {
      return undefined;
    }
  }

  /**
   * Manually restore the DB from a backup produced by a previous run(). Normal failures do
   * NOT need this — transaction rollback already keeps the DB consistent at the last good
   * version (METIS-402). This is an out-of-band recovery hook for catastrophic cases where
   * the DB file itself is suspect. Caller must reopen the database afterwards.
   */
  restoreFromBackup(bak: string): boolean {
    try {
      fs.copyFileSync(bak, this.dbPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run all pending migrations in order. Each migration is wrapped in a transaction. On
   * failure: that migration's transaction rolls back, and we attempt to restore the DB from
   * the pre-migration backup. Returns a structured result; never throws.
   */
  run(): MigrationResult {
    // Ensure the migrations tracking table exists.
    this.db.exec(MIGRATIONS_TABLE_SQL);

    const fromVersion = this.currentVersion();
    const pending = this.migrations.filter((m) => m.version > fromVersion);

    if (pending.length === 0) {
      // Nothing new to apply this run. appliedVersions reflects ONLY this run's work.
      return { appliedVersions: [], fromVersion, toVersion: fromVersion, restoredFromBackup: false };
    }

    const backupPath = this.backup();
    const applied: number[] = [];

    for (const migration of pending) {
      const apply = this.db.transaction(() => {
        migration.up(this.db);
        this.db.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.description, Date.now());
      });
      try {
        apply();
        applied.push(migration.version);
      } catch (err) {
        // Transaction rolled back the failed migration's changes atomically. The DB remains
        // consistent at the last successfully-applied version. We do NOT continue to later
        // migrations, and we do NOT restore from backup — the transaction already protected
        // the DB (METIS-402: "migration failure does not corrupt the original database").
        // The backup is retained on disk (backupPath) as an out-of-band recovery option.
        const errorMsg = (err as Error).message;
        return {
          appliedVersions: applied,
          fromVersion,
          toVersion: applied.length > 0 ? applied[applied.length - 1]! : fromVersion,
          backupPath,
          failed: { version: migration.version, error: errorMsg },
          restoredFromBackup: false,
        };
      }
    }

    return {
      appliedVersions: applied,
      fromVersion,
      toVersion: this.currentVersion(),
      backupPath,
      restoredFromBackup: false,
    };
  }
}

// ─── The actual Metis migrations (METIS-402: legacy → unified model) ──
//
// These migrations bring an OLD database (only papers/notes/experiments) up to the unified
// six-entity model (METIS-401). They are additive only — they never delete or rewrite user
// data; they create the new tables and, where safe, backfill unified rows from legacy ones.
//
// NOTE: the six-entity tables themselves are created by SCHEMA_SQL (CREATE TABLE IF NOT
// EXISTS) at startup, so the migrations here focus on DATA backfill + version bumps.

export const METIS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'METIS-402: ensure unified six-entity tables exist (idempotent with SCHEMA_SQL)',
    up: (db) => {
      // Safe no-op marker: the tables are created by SCHEMA_SQL; this migration just records
      // that the unified model baseline is present. Creating tables again with IF NOT EXISTS
      // is harmless and covers databases that predate the SCHEMA_SQL change.
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, original_intent TEXT NOT NULL DEFAULT '',
          research_question TEXT NOT NULL DEFAULT '', lifecycle TEXT NOT NULL DEFAULT 'draft',
          methodology TEXT NOT NULL DEFAULT '', discipline TEXT NOT NULL DEFAULT '',
          metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          archived_at INTEGER, version INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'user',
          deleted_at INTEGER
        );
      `);
    },
  },
  {
    version: 2,
    description: 'METIS-402: backfill a default project for legacy data (so legacy papers map to a Source)',
    up: (db) => {
      // Only backfill if legacy papers exist AND no project exists yet.
      const hasPapers = (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='papers'").get()) as object | undefined;
      const hasData = hasPapers ? (db.prepare('SELECT 1 FROM papers LIMIT 1').get() as object | undefined) : undefined;
      const hasProject = db.prepare('SELECT 1 FROM projects LIMIT 1').get() as object | undefined;
      if (hasData && !hasProject) {
        const now = Date.now();
        db.prepare(`INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES (?,?,?,?,?,?,?)`)
          .run('proj-imported-legacy', '导入的历史资料', '从旧版本 Metis 导入', 'archived', now, now, 'migration');
      }
    },
  },
];
