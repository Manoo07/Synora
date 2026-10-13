import { Hono } from "hono";
import { eq, and, ne, sql } from "drizzle-orm";
import type { AppEnv } from "../context.js";
import { users, devices } from "../db/schema.js";
import { requireAccountAuth } from "../auth/middleware.js";
import { notFound } from "../lib/errors.js";

export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use("*", requireAccountAuth);

accountRoutes.get("/usage", async (c) => {
  const [user] = await c.env.DB.select({
    plan: users.plan,
    storageLimitBytes: users.storageLimitBytes,
    storageBytesUsed: users.storageBytesUsed,
    deviceLimit: users.deviceLimit,
  })
    .from(users)
    .where(eq(users.id, c.var.userId))
    .limit(1);
  if (!user) throw notFound("Account not found");

  // Matches the same "revoked devices don't count" rule enforced at
  // login time - see routes/auth.ts.
  const deviceCountRows = await c.env.DB.select({ deviceCount: sql<string>`count(*)` })
    .from(devices)
    .where(and(eq(devices.userId, c.var.userId), ne(devices.status, "revoked")));

  return c.json({
    plan: user.plan,
    usedBytes: user.storageBytesUsed,
    limitBytes: user.storageLimitBytes,
    deviceCount: Number(deviceCountRows[0]?.deviceCount ?? 0),
    deviceLimit: user.deviceLimit,
  });
});
