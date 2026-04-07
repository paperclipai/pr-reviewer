import { loadConfig } from '../config';
import { initializeDb } from './bootstrap';
import type { DbClient, BatchStatement } from './types';

export type { DbClient, BatchStatement };

let _db: DbClient | null = null;

/** Allow the Worker entrypoint to inject a pre-configured DB client */
export function setDb(db: DbClient): void {
  _db = db;
}

export async function getDb(): Promise<DbClient> {
  if (_db) return _db;

  const config = loadConfig();

  if (config.DB_BACKEND === 'd1') {
    const { D1Client } = await import('./d1');
    _db = new D1Client(config.D1_ACCOUNT_ID!, config.D1_DATABASE_ID!, config.D1_API_TOKEN!);
  } else {
    const { SqliteClient } = await import('./sqlite');
    _db = new SqliteClient(config.DB_PATH);
  }

  return await initializeDb(_db);
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}
