type Snapshot = { body: ArrayBuffer; headers: [string, string][]; status: number };
type Entry = Snapshot & { expires: number };
type Result = Snapshot | Response;

interface CacheOptions {
  now?: () => number;
  ttlMs?: number;
  revisionIntervalMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxPending?: number;
}

// These endpoints expose public data. Mutations, capability probes, static
// assets and future routes must explicitly opt in rather than being cached.
const PUBLIC_READ = /^\/api\/(?:prs(?:\/\d+(?:\/(?:comments|similar))?)?|stats|labels|authors|leaderboard|github-users\/[^/]+|search)$/;

/** Per-database, per-isolate read cache; never writes to D1 or external storage. */
export class ReadCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Result>>();
  private bytes = 0;
  private revision: string | null | undefined;
  private checkedAt = -Infinity;
  private checking?: Promise<boolean>;
  private generation = 0;
  private now: () => number;
  private ttl: number;
  private interval: number;
  private maxEntries: number;
  private maxBytes: number;
  private maxEntryBytes: number;
  private maxPending: number;

  constructor(private readRevision: () => Promise<string | null>, options: CacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 5 * 60_000;
    this.interval = options.revisionIntervalMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 64;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.maxEntryBytes = Math.min(options.maxEntryBytes ?? 4 * 1024 * 1024, this.maxBytes);
    this.maxPending = options.maxPending ?? 4;
  }

  private clear(): void {
    this.entries.clear();
    this.bytes = 0;
    this.generation++;
  }

  private async checkRevision(): Promise<boolean> {
    if (this.now() - this.checkedAt < this.interval) return true;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        const revision = await this.readRevision();
        if (revision !== this.revision) this.clear();
        this.revision = revision;
        this.checkedAt = this.now();
        return true;
      } catch {
        // A failed freshness check cannot extend the life of a cached result.
        this.clear();
        return false;
      }
    })();
    try { return await this.checking; } finally { this.checking = undefined; }
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.bytes -= entry.body.byteLength;
  }

  private response(snapshot: Result, state: string): Response {
    if (snapshot instanceof Response) return snapshot;
    const headers = new Headers(snapshot.headers);
    headers.set('X-PR-Cache', state);
    // Keep the freshness contract in this cache, not independent browser caches.
    headers.set('Cache-Control', 'no-store');
    return new Response(snapshot.body.slice(0), { status: snapshot.status, headers });
  }

  private async snapshot(response: Response): Promise<Result> {
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')
        || response.headers.has('set-cookie') || /private|no-store/i.test(response.headers.get('cache-control') ?? '')
        || Number(response.headers.get('content-length')) > this.maxEntryBytes || !response.body) return response;
    // Read a clone up to a fixed limit. If it is too large, return the original
    // stream instead of buffering the rest of a large search/comment response.
    const reader = response.clone().body!.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > this.maxEntryBytes) {
        void reader.cancel();
        return response;
      }
      chunks.push(value);
    }
    void response.body.cancel();
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { body: body.buffer, headers: [...response.headers.entries()], status: response.status };
  }

  async fetch(request: Request, next: () => Promise<Response>): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !PUBLIC_READ.test(url.pathname)
        || request.headers.has('authorization') || request.headers.has('cookie')) return next();
    if (!await this.checkRevision()) return next();

    const key = url.href; // Includes origin, full path and every query parameter.
    const cached = this.entries.get(key);
    if (cached && cached.expires > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return this.response(cached, 'hit');
    }
    if (cached) this.remove(key, cached);

    const generation = this.generation;
    const pendingKey = `${generation}:${key}`;
    const existing = this.pending.get(pendingKey);
    if (existing) {
      const result = await existing;
      // Uncacheable streams belong to the original caller. Cloning them would
      // leave a tee branch buffering arbitrarily large bodies for followers.
      return result instanceof Response ? next() : this.response(result, 'coalesced');
    }
    // Bound in-flight retained responses as well as completed entries.
    if (this.pending.size >= this.maxPending) return next();
    const expires = this.now() + this.ttl;
    const promise = (async () => {
      const response = await next();
      const snapshot = await this.snapshot(response);
      if (!(snapshot instanceof Response) && generation === this.generation && expires > this.now()) {
        for (const [entryKey, entry] of this.entries) {
          if (entry.expires <= this.now()) this.remove(entryKey, entry);
        }
        while (this.entries.size >= this.maxEntries || this.bytes + snapshot.body.byteLength > this.maxBytes) {
          const [entryKey, entry] = this.entries.entries().next().value!;
          this.remove(entryKey, entry);
        }
        this.entries.set(key, { ...snapshot, expires });
        this.bytes += snapshot.body.byteLength;
      }
      return snapshot;
    })();
    this.pending.set(pendingKey, promise);
    try { return this.response(await promise, 'miss'); }
    finally { this.pending.delete(pendingKey); }
  }
}
