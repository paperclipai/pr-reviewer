import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const config = loadConfig();
  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(config.DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);
  return _db;
}

function runMigrations(db: Database.Database): void {
  const schemaPath = path.join(__dirname, 'schema.sql');

  // In dist mode, schema.sql won't be at __dirname. Try both locations.
  let schemaFile: string;
  if (fs.existsSync(schemaPath)) {
    schemaFile = schemaPath;
  } else {
    // Fallback: relative to project root
    schemaFile = path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
  }

  const schema = fs.readFileSync(schemaFile, 'utf-8');
  db.exec(schema);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
