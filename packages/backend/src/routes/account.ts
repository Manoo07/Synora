import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context.js";
import { users } from "../db/schema.js";
import { requireAccountAuth } from "../auth/middleware.js";
import { notFound } from "../lib/errors.js";

export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use("*", requireAccountAuth);

accountRoutes.get("/usage", async (c) => {
  const [user] = await c.env.DB.select({
    plan: users.plan,
    storageLimitBytes: users.storageLimitBytes,
    storageBytesUsed: users.storageBytesUsed,
  })
    .from(users)
    .where(eq(users.id, c.var.userId))
    .limit(1);
  if (!user) throw notFound("Account not found");

  return c.json({
    plan: user.plan,
    usedBytes: user.storageBytesUsed,
    limitBytes: user.storageLimitBytes,
  });
});
