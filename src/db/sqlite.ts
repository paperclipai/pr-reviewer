import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DbClient } from './client';

export class SqliteClient implements DbClient {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async run(sql: string, params: any[] = []): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async get<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...params) as T) ?? null;
  }

  async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
