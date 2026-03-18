/** A single SQL statement with its bound parameters */
export interface BatchStatement {
  sql: string;
  params: any[];
}

/** Unified async DB interface — shared between Node and Workers */
export interface DbClient {
  run(sql: string, params?: any[]): Promise<void>;
  get<T = any>(sql: string, params?: any[]): Promise<T | null>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  /** Execute multiple statements in a single round-trip (D1) or transaction (SQLite) */
  runBatch(statements: BatchStatement[]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
