import type { DbClient } from './types';

/**
 * D1 adapter using native Worker binding — no API token needed.
 * The D1Database type comes from @cloudflare/workers-types.
 */
export class D1BindingClient implements DbClient {
  constructor(private d1: any) {} // D1Database from Workers runtime

  async run(sql: string, params: any[] = []): Promise<void> {
    await this.d1.prepare(sql).bind(...params).run();
  }

  async get<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const result = await this.d1.prepare(sql).bind(...params).first();
    return (result as T) ?? null;
  }

  async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.d1.prepare(sql).bind(...params).all();
    return result.results as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.d1.exec(sql);
  }

  async close(): Promise<void> {
    // No-op — binding lifecycle managed by Workers runtime
  }
}
