import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

describe('诊断', () => {
  it('prints resolved db path', () => {
    const DB_PATH = path.join(process.env.APPDATA ?? '', 'metis-workbench', 'metis-data', 'metis.db');
    console.log('APPDATA =', JSON.stringify(process.env.APPDATA));
    console.log('DB_PATH =', DB_PATH);
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) n FROM capability_vault').get() as { n: number };
    console.log('capability_vault rows =', row.n);
    expect(row.n).toBeGreaterThan(0);
    db.close();
  });
});
