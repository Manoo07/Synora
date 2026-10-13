// Cloudflare's native Rate Limiting binding - accurate and low-latency,
// unlike KV (which is eventually-consistent and was confirmed live to let
// a burst of requests straight through a KV-counter-based limiter). The
// binding's own limit/period are fixed at deploy time per wrangler.toml;
// this wrapper just gives it a typed, mockable call shape.
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export async function checkRateLimit(limiter: RateLimiter, key: string): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return success;
}

export function clientIp(headers: Headers): string {
  // CF-Connecting-IP is set by Cloudflare's edge itself, not forwarded
  // client-controlled input - safe to trust as the real request origin.
  return headers.get("CF-Connecting-IP") ?? "unknown";
}
