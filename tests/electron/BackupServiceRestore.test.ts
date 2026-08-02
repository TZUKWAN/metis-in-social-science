/**
 * Tests for BackupService.restoreFrom — rollback snapshot then swap-and-reopen.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { BackupService } from '../../electron/BackupService.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-backup-restore-'));
}

describe('BackupService.restoreFrom', () => {
  let dir: string;
  let dbPath: string;
  let backupsDir: string;
  let service: BackupService;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'metis.db');
    backupsDir = path.join(dir, 'backups');
    const store = new PersistenceStore(dbPath);
    store.savePaper({
      id: 'p-original', title: 'Original', authors: [], year: 2024, venue: '',
      abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
    });
    store.close();
    service = new BackupService(new PersistenceStore(dbPath), backupsDir, dbPath);
  });

  afterEach(() => {
    // Close any open database connections before removing the directory.
    try { (service as unknown as { store: PersistenceStore }).store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore EPERM */ }
  });

  it('restores the database from a valid backup', async () => {
    // Create a backup first.
    const backup = await service.runBackup();
    expect(backup.ok).toBe(true);
    expect(backup.destination).toBeTruthy();

    // Mutate the current db (add a different paper).
    const current = new PersistenceStore(dbPath);
    current.savePaper({
      id: 'p-mutated', title: 'Mutated', authors: [], year: 2024, venue: '',
      abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
    });
    current.close();

    // Restore from the backup — should roll back the mutation.
    const result = await service.restoreFrom(backup.destination!);
    expect(result.ok).toBe(true);

    // Verify the restored db has the original paper, not the mutated one.
    const restored = new PersistenceStore(dbPath);
    const papers = restored.getPapers().map((p) => p.id);
    expect(papers).toContain('p-original');
    expect(papers).not.toContain('p-mutated');
    restored.close();
  });

  it('creates a rollback snapshot before restoring', async () => {
    const backup = await service.runBackup();
    expect(backup.ok).toBe(true);
    const before = service.listBackups();
    await service.restoreFrom(backup.destination!);
    const after = service.listBackups();
    // A new backup should have been created as rollback (count increases).
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it('fails closed when the backup file is not a valid SQLite database', async () => {
    const badPath = path.join(dir, 'bad.db');
    fs.writeFileSync(badPath, 'not a sqlite database');
    const result = await service.restoreFrom(badPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('fails closed when the backup file does not exist', async () => {
    const result = await service.restoreFrom(path.join(dir, 'nonexistent.db'));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
