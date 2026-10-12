import type { MiddlewareHandler } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../context.js";
import { verifyAccessToken } from "./jwt.js";
import { unauthorized, forbidden } from "../lib/errors.js";
import { vaultMembers, devices } from "../db/schema.js";

// Verifies the account (JWT signature + subject), nothing about the
// device behind it. This is deliberately weaker than requireAuth: it's
// what a device recovering vault access via a recovery key must be able
// to pass *before* it's active, to discover its vaults and fetch the
// recovery-wrapped key. See protocol-spec.md §2 "Recovery is a product
// decision" - recovery has to work without any already-trusted device.
export const requireAccountAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw unauthorized("Missing bearer token");
  const token = header.slice("Bearer ".length);

  let claims;
  try {
    claims = await verifyAccessToken(token, c.env.JWT_SECRET);
  } catch {
    throw unauthorized("Invalid or expired token");
  }

  c.set("userId", claims.sub);
  c.set("deviceId", claims.deviceId);
  await next();
};

// The normal gate for sync/device-management endpoints: account AND an
// active device. Recovery endpoints use requireAccountAuth instead, since
// requiring an active device there would make recovery impossible by
// definition.
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  await requireAccountAuth(c, async () => {
    const [device] = await c.env.DB.select().from(devices).where(eq(devices.id, c.var.deviceId)).limit(1);
    if (!device || device.status !== "active") throw unauthorized("Device is not active");
    await next();
  });
};

// Call after requireAuth, inside a route that has {vaultId} in its path.
export async function requireVaultAccess(c: { env: AppEnv["Bindings"]; var: AppEnv["Variables"] }, vaultId: string) {
  const [membership] = await c.env.DB.select()
    .from(vaultMembers)
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, c.var.userId)))
    .limit(1);
  if (!membership) throw forbidden("Not a member of this vault");
  return membership;
}
