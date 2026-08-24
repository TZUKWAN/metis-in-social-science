/**
 * BackupService — rolling automatic snapshots of the research SQLite database.
 *
 * Uses PersistenceStore.backupTo (better-sqlite3 online backup) to write a
 * timestamped copy into a backups/ directory, then trims to the most recent
 * N snapshots. Designed to run once on app startup and on a periodic timer.
 * Failures are non-fatal: a backup error must never block the app from running.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../engine/persistence/PersistenceStore.js';

const DEFAULT_KEEP = 5;

export interface BackupResult {
  ok: boolean;
  destination?: string;
  totalPages?: number;
  error?: string;
}

export class BackupService {
  constructor(
    private store: PersistenceStore,
    private readonly backupsDir: string,
    private readonly dbPath: string,
    private readonly keep = DEFAULT_KEEP,
  ) {
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    } catch {
      // Directory creation is best-effort; runBackup will report the failure.
    }
  }

  /** Run a single rolling backup and trim old snapshots. */
  async runBackup(): Promise<BackupResult> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destination = path.join(this.backupsDir, `metis-${stamp}.db`);
      const meta = await this.store.backupTo(destination);
      this.trimOldBackups();
      return { ok: true, destination: meta.destination, totalPages: meta.totalPages };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  }

  /** List existing backup files, newest first. */
  listBackups(): string[] {
    try {
      return fs.readdirSync(this.backupsDir)
        .filter((f) => /^metis-.+\.db$/u.test(f))
        .sort()
        .reverse()
        .map((f) => path.join(this.backupsDir, f));
    } catch {
      return [];
    }
  }

  /** Keep only the most recent `keep` backup files. */
  private trimOldBackups(): void {
    const files = this.listBackups();
    if (files.length <= this.keep) return;
    for (const stale of files.slice(this.keep)) {
      try { fs.unlinkSync(stale); } catch { /* best-effort */ }
    }
  }

  /**
   * Restore the database from a backup file. Creates a rollback snapshot of
   * the current state first, then swaps the backup into place and reopens the
   * store. Fails closed if the backup cannot be validated or written.
   */
  async restoreFrom(backupPath: string): Promise<BackupResult> {
    try {
      // Validate the backup is a readable SQLite file.
      const check = new Database(backupPath, { readonly: true });
      check.close();

      // Rollback snapshot of the current state.
      const rollback = await this.runBackup();
      if (!rollback.ok) {
        return { ok: false, error: `Rollback snapshot failed: ${rollback.error}` };
      }

      // Close, swap, reopen.
      this.store.close();
      fs.copyFileSync(backupPath, this.dbPath);
      this.store = new PersistenceStore(this.dbPath);
      return { ok: true, destination: backupPath };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  }
}
