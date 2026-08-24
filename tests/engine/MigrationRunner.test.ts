/**
 * METIS-402 — Migration runner tests.
 *
 * Covers: ordered versioned application; idempotency (re-run skips applied); transaction
 * rollback on a failing migration; backup creation; non-destruction (failed migration does
 * not corrupt the original DB); empty/old/corrupt DB handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MigrationRunner, METIS_MIGRATIONS, type Migration } from '../../engine/persistence/MigrationRunner.js';

function makeMigrations(): Migration[] {
  return [
    { version: 1, description: 'create t1', up: (db) => db.exec('CREATE TABLE t1 (id INTEGER)') },
    { version: 2, description: 'create t2', up: (db) => db.exec('CREATE TABLE t2 (id INTEGER)') },
    { version: 3, description: 'create t3', up: (db) => db.exec('CREATE TABLE t3 (id INTEGER)') },
  ];
}

describe('METIS-402 MigrationRunner — versioned application', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mig-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('applies migrations in order from an empty DB', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, makeMigrations());
    const r = runner.run();
    expect(r.fromVersion).toBe(0);
    expect(r.toVersion).toBe(3);
    expect(r.appliedVersions).toEqual([1, 2, 3]);
    expect(r.failed).toBeUndefined();
    db.close();
  });

  it('is idempotent: re-running applies nothing', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, makeMigrations());
    runner.run();
    const r2 = runner.run();
    expect(r2.appliedVersions).toEqual([]);
    expect(r2.fromVersion).toBe(3);
    expect(r2.toVersion).toBe(3);
    db.close();
  });

  it('records applied versions in schema_migrations', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, makeMigrations());
    runner.run();
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    db.close();
  });
});

describe('METIS-402 MigrationRunner — transaction + rollback on failure', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mig-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a failing migration rolls back its own changes and stops (earlier migrations persist)', () => {
    const db = new Database(dbPath);
    const failing: Migration[] = [
      { version: 1, description: 'ok1', up: (db) => db.exec('CREATE TABLE t1 (id INTEGER)') },
      {
        version: 2,
        description: 'fails',
        up: (db) => {
          db.exec('CREATE TABLE t2 (id INTEGER)');
          throw new Error('deliberate failure');
        },
      },
      { version: 3, description: 'ok3 (should NOT run)', up: (db) => db.exec('CREATE TABLE t3 (id INTEGER)') },
    ];
    const runner = new MigrationRunner(db, dbPath, failing);
    const r = runner.run();
    expect(r.failed?.version).toBe(2);
    expect(r.failed?.error).toMatch(/deliberate failure/);
    // t1 applied (version 1 succeeded), t2 rolled back, t3 never ran
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='t1'").get()).toBeDefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='t2'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='t3'").get()).toBeUndefined();
    db.close();
  });

  it('creates a backup before running', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE preexisting (x INTEGER)');
    db.close();
    const db2 = new Database(dbPath);
    const runner = new MigrationRunner(db2, dbPath, makeMigrations());
    const r = runner.run();
    expect(r.backupPath).toBeTruthy();
    if (r.backupPath) expect(fs.existsSync(r.backupPath)).toBe(true);
    db2.close();
  });

  it('does NOT destroy the original DB when a migration fails (pre-existing data intact)', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE precious (x INTEGER)');
    db.prepare('INSERT INTO precious (x) VALUES (?)').run(42);
    db.close();
    const failing: Migration[] = [
      { version: 1, description: 'fails', up: () => { throw new Error('boom'); } },
    ];
    const db2 = new Database(dbPath);
    const runner = new MigrationRunner(db2, dbPath, failing);
    const r = runner.run();
    expect(r.failed?.version).toBe(1);
    db2.close();
    // reopen and verify precious data is intact
    const db3 = new Database(dbPath);
    const row = db3.prepare('SELECT x FROM precious').get() as { x: number };
    expect(row.x).toBe(42);
    db3.close();
  });
});

describe('METIS-402 MigrationRunner — real Metis migrations', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mig-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('applies METIS_MIGRATIONS to an empty DB and records them', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, METIS_MIGRATIONS);
    const r = runner.run();
    expect(r.toVersion).toBeGreaterThanOrEqual(2);
    expect(r.failed).toBeUndefined();
    // projects table exists after migration
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get()).toBeDefined();
    db.close();
  });

  it('backfills a default project only when legacy papers exist and no project yet (old DB)', () => {
    const db = new Database(dbPath);
    // simulate an OLD db: legacy papers table with data, no projects
    db.exec(`CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT)`);
    db.prepare('INSERT INTO papers (id, title) VALUES (?, ?)').run('p1', 'Legacy');
    db.close();
    const db2 = new Database(dbPath);
    const runner = new MigrationRunner(db2, dbPath, METIS_MIGRATIONS);
    runner.run();
    const proj = db2.prepare('SELECT id, title FROM projects').get() as { id: string; title: string };
    expect(proj.id).toBe('proj-imported-legacy');
    db2.close();
  });

  it('does NOT backfill a default project when no legacy papers exist (empty DB)', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, METIS_MIGRATIONS);
    runner.run();
    const count = (db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  it('is idempotent on real migrations (second run applies nothing)', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, METIS_MIGRATIONS);
    runner.run();
    const r2 = runner.run();
    expect(r2.appliedVersions).toEqual([]);
    db.close();
  });
});
