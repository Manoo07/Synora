// A simple fixed-window rate limiter backed by KV. Not perfectly precise
// under concurrent requests (KV writes aren't atomic - two requests in the
// same window can both read the same count and both increment past it),
// but that's an acceptable trade-off here: the goal is bounding abuse
// cost, not exact accounting. Applied to the unauthenticated auth
// endpoints specifically, since those are the only ones a stranger can
// hit at all, and each one does real CPU work (password hashing).
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const bucketKey = `ratelimit:${key}:${bucket}`;
  const current = await kv.get(bucketKey);
  const count = current ? Number(current) : 0;
  if (count >= limit) return false;
  // TTL covers this window plus a margin rather than exactly windowSeconds,
  // so a slightly-late read of a just-expired bucket doesn't resurrect it.
  await kv.put(bucketKey, String(count + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}

export function clientIp(headers: Headers): string {
  // CF-Connecting-IP is set by Cloudflare's edge itself, not forwarded
  // client-controlled input - safe to trust as the real request origin.
  return headers.get("CF-Connecting-IP") ?? "unknown";
}
