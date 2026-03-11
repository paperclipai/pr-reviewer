/** Unified async DB interface — shared between Node and Workers */
export interface DbClient {
  run(sql: string, params?: any[]): Promise<void>;
  get<T = any>(sql: string, params?: any[]): Promise<T | null>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
