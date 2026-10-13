// Minimal duck-typed subset of Cloudflare's KVNamespace that the rate
// limiter actually uses. Ignores expirationTtl - tests run fast enough
// that it never matters, and resetDb() doesn't need to touch this since
// it's keyed independently of the Postgres tables it truncates.
export class MemoryKV {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}
