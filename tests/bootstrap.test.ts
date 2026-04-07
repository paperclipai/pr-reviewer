import { describe, expect, test } from 'vitest';

import { initializeDb } from '../src/db/bootstrap';
import type { DbClient } from '../src/db/types';

function createFakeDb() {
  const calls = {
    run: [] as string[],
    exec: [] as string[],
  };

  const db: DbClient = {
    async run(sql: string) {
      calls.run.push(sql);
    },
    async get() {
      return null;
    },
    async all() {
      return [];
    },
    async runBatch() {},
    async exec(sql: string) {
      calls.exec.push(sql);
    },
    async close() {},
  };

  return { db, calls };
}

describe('initializeDb', () => {
  test('boots schema with single-statement runs and memoizes by db instance', async () => {
    const { db, calls } = createFakeDb();

    await initializeDb(db);
    await initializeDb(db);

    expect(calls.exec.length).toBeGreaterThan(10);
    expect(calls.exec[0]).toContain('CREATE TABLE IF NOT EXISTS pull_requests');
    expect(calls.exec.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS github_users'))).toBe(true);
    expect(calls.exec[0].trim().endsWith(';')).toBe(true);
    expect(calls.run.length).toBeGreaterThan(1);
    expect(calls.run.at(-1)).toContain(`INSERT INTO sync_state (key, value) VALUES ('schema_version', ?)`);
  });

  test('skips schema work when the version marker is already present', async () => {
    const { db, calls } = createFakeDb();
    db.get = async () => ({ value: '2' });

    await initializeDb(db);

    expect(calls.exec).toEqual([]);
    expect(calls.run).toEqual([]);
  });
});
