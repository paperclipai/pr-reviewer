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
  /** Execute statements in order. REST D1 is sequential; callers must not assume atomicity. */
  runBatch(statements: BatchStatement[]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
