import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rateLimitCounters } from "../db/schema.js";

// Fixed-window counter per key (e.g. "register:<ip>"), serialized with the
// same pg_advisory_xact_lock technique the commit protocol uses
// (routes/sync.ts) - that's what makes this actually atomic, unlike the
// two prior attempts (a KV counter, then Cloudflare's native rate-limit
// binding) that were both confirmed live to let every request through
// under concurrent load: neither had any atomicity between reading the
// current count and writing the incremented one back.
//
// Returns true if the request is allowed, false if this key is over
// `limit` within the current `windowSeconds` window.
export async function checkRateLimit(db: Db, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

    const now = new Date();
    const windowCutoff = new Date(now.getTime() - windowSeconds * 1000);

    const [existing] = await tx.select().from(rateLimitCounters).where(eq(rateLimitCounters.key, key)).limit(1);

    if (!existing || existing.windowStart < windowCutoff) {
      await tx
        .insert(rateLimitCounters)
        .values({ key, windowStart: now, count: 1 })
        .onConflictDoUpdate({ target: rateLimitCounters.key, set: { windowStart: now, count: 1 } });
      return true;
    }

    if (existing.count >= limit) return false;

    await tx
      .update(rateLimitCounters)
      .set({ count: existing.count + 1 })
      .where(eq(rateLimitCounters.key, key));
    return true;
  });
}
