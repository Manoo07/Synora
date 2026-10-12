import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { users, devices } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { issueAccessToken } from "../auth/jwt.js";
import { badRequest, unauthorized } from "../lib/errors.js";

export const authRoutes = new Hono<AppEnv>();

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
  const body = registerSchema.parse(await c.req.json());

  const existing = await c.env.DB.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (existing.length > 0) throw badRequest("Email already registered");

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
