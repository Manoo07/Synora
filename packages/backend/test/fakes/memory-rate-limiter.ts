import type { RateLimiter } from "../../src/auth/rate-limit.js";

// Unlike real Cloudflare KV, this is synchronous and perfectly
// consistent - a fine stand-in for the native Rate Limiting binding in
// tests, which doesn't have KV's eventual-consistency gap that made an
// earlier KV-based limiter attempt a no-op under rapid-fire requests.
export class MemoryRateLimiter implements RateLimiter {
  private counts = new Map<string, number>();

  constructor(private readonly maxCount: number) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { success: count <= this.maxCount };
  }
}
