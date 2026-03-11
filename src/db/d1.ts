import { DbClient } from './client';

interface D1Response {
  success: boolean;
  errors: Array<{ message: string }>;
  result: Array<{
    success: boolean;
    results: any[];
    meta: any;
  }>;
}

export class D1Client implements DbClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(accountId: string, databaseId: string, apiToken: string) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
    this.headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async query(sql: string, params: any[] = []): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/query`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ sql, params }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`D1 API error (${response.status}): ${text}`);
    }

    const data = await response.json() as D1Response;
    if (!data.success) {
      throw new Error(`D1 query error: ${data.errors.map(e => e.message).join(', ')}`);
    }

    return data.result[0]?.results ?? [];
  }

  async run(sql: string, params: any[] = []): Promise<void> {
    await this.query(sql, params);
  }

  async get<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const results = await this.query(sql, params);
    return (results[0] as T) ?? null;
  }

  async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return await this.query(sql, params) as T[];
  }

  async exec(sql: string): Promise<void> {
    // D1 raw endpoint handles multi-statement SQL
    const response = await fetch(`${this.baseUrl}/raw`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ sql }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`D1 exec error (${response.status}): ${text}`);
    }
  }

  async close(): Promise<void> {
    // No-op for HTTP-based client
  }
}
