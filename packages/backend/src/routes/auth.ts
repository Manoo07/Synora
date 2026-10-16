import { Hono } from "hono";
import { eq, and, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { users, devices } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { issueAccessToken } from "../auth/jwt.js";
import { checkRateLimit } from "../auth/rate-limit.js";
import { badRequest, unauthorized, serviceUnavailable, tooManyRequests, deviceLimitExceeded } from "../lib/errors.js";

export const authRoutes = new Hono<AppEnv>();

// A prior external-counter approach and a platform-native rate-limit feature were
// both tried here and confirmed live to not actually enforce anything
// under concurrent requests - neither had real atomicity between reading
// the current count and writing the incremented one back, so a burst of
// simultaneous requests all read the same stale count and all passed.
// checkRateLimit serializes per key via a Postgres advisory lock (the
// same technique the commit protocol already relies on) - see
// auth/rate-limit.ts.
function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  devicePublicKey: z.string().min(1),
  deviceName: z.string().min(1).default("First device"),
});

// Registration bootstraps the account's first device as trusted — there is
// no other device to approve it against yet. Every subsequent device must
// go through POST /vaults/:vaultId/devices enrollment instead.
authRoutes.post("/register", async (c) => {
  // 5 registrations per IP per 5 minutes - generous for a real new user,
  // tight enough to blunt an automated signup flood.
  if (!(await checkRateLimit(c.env.DB, `register:${clientIp(c)}`, 5, 300))) {
    throw tooManyRequests("Too many registration attempts. Try again in a few minutes.");
  }

  const body = registerSchema.parse(await c.req.json());

  const existing = await c.env.DB.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (existing.length > 0) throw badRequest("Email already registered");

  // Blocks only *new* signups once total usage nears the operator's
  // operator's R2 allowance - never affects existing accounts'
  // syncing. See context.ts GLOBAL_STORAGE_CEILING_BYTES.
  const usageRows = await c.env.DB.select({
    totalUsed: sql<string>`coalesce(sum(${users.storageBytesUsed}), 0)`,
  }).from(users);
  const totalUsed = Number(usageRows[0]?.totalUsed ?? 0);
  if (totalUsed >= c.env.GLOBAL_STORAGE_CEILING_BYTES) {
    throw serviceUnavailable("Synora isn't accepting new accounts right now - check back soon.");
  }

  const passwordHash = await hashPassword(body.password);
  const [user] = await c.env.DB.insert(users).values({ email: body.email, passwordHash }).returning();
  const [device] = await c.env.DB.insert(devices)
    .values({ userId: user!.id, publicKey: body.devicePublicKey, name: body.deviceName, status: "active" })
    .returning();

  const accessToken = await issueAccessToken({ sub: user!.id, deviceId: device!.id }, c.env.JWT_SECRET);
  return c.json({ userId: user!.id, deviceId: device!.id, accessToken }, 201);
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  devicePublicKey: z.string().min(1),
  deviceName: z.string().min(1).default("New device"),
});

authRoutes.post("/login", async (c) => {
  // 10 attempts per IP per minute - enough for a real person mistyping a
  // password, tight enough to blunt credential stuffing / brute force.
  if (!(await checkRateLimit(c.env.DB, `login:${clientIp(c)}`, 10, 60))) {
    throw tooManyRequests("Too many login attempts. Try again in a minute.");
  }

  const body = loginSchema.parse(await c.req.json());

  const [user] = await c.env.DB.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throw unauthorized("Invalid email or password");
  }

  let [device] = await c.env.DB.select()
    .from(devices)
    .where(and(eq(devices.userId, user.id), eq(devices.publicKey, body.devicePublicKey)))
    .limit(1);

  if (!device) {
    // Revoked devices free their slot back up - only active/pending ones
    // count against the plan's device limit.
    const deviceCountRows = await c.env.DB.select({ deviceCount: sql<string>`count(*)` })
      .from(devices)
      .where(and(eq(devices.userId, user.id), ne(devices.status, "revoked")));
    const deviceCount = Number(deviceCountRows[0]?.deviceCount ?? 0);
    if (deviceCount >= user.deviceLimit) {
      throw deviceLimitExceeded(`This account is limited to ${user.deviceLimit} device(s) on its current plan.`);
    }

    // First time we've seen this device's public key for this account.
    // It still gets an account-level token (below) - that's enough to
    // list vaults and attempt recovery, but every sync/device-management
    // endpoint gates on `requireAuth`'s active-device check, so this
    // device can't touch vault content until something activates it:
    // either an existing trusted device enrolling it, or it successfully
    // recovering vault access with the vault's recovery key.
    [device] = await c.env.DB.insert(devices)
      .values({ userId: user.id, publicKey: body.devicePublicKey, name: body.deviceName, status: "pending" })
      .returning();
  } else {
    await c.env.DB.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device!.id));
  }

  const accessToken = await issueAccessToken({ sub: user.id, deviceId: device!.id }, c.env.JWT_SECRET);
  return c.json({ userId: user.id, deviceId: device!.id, accessToken, deviceStatus: device!.status });
});
