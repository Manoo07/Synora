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

// The two things every vault-scoped sync request needs to know - that
// the calling device is still active, and that it belongs to this vault
// - in a single round trip instead of requireAuth's device lookup plus
// requireVaultAccess's membership lookup.
//
// This matters because of volume, not elegance: the idle sync loop makes
// two authenticated requests every interval per device, so those two
// queries were most of the database traffic the whole system generated,
// whether or not anything had actually changed.
//
// Deliberately NOT folded into requireVaultAccess below: the recovery
// endpoints call that one without an active device on purpose, and
// requiring one there would make recovery impossible by definition.
export async function requireActiveDeviceVaultAccess(
  c: { env: AppEnv["Bindings"]; var: AppEnv["Variables"] },
  vaultId: string,
) {
  // Driven from `devices` with the membership left-joined on, so a
  // missing row on either side stays distinguishable: an inactive device
  // is a 401 (re-authenticate) while a non-member is a 403 (this device
  // needs the vault key), and the plugin branches on exactly that.
  const [row] = await c.env.DB.select({
    deviceStatus: devices.status,
    memberUserId: vaultMembers.userId,
  })
    .from(devices)
    .leftJoin(vaultMembers, and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, c.var.userId)))
    .where(eq(devices.id, c.var.deviceId))
    .limit(1);

  if (!row || row.deviceStatus !== "active") throw unauthorized("Device is not active");
  if (!row.memberUserId) throw forbidden("Not a member of this vault");
}

// Call after requireAuth, inside a route that has {vaultId} in its path.
export async function requireVaultAccess(c: { env: AppEnv["Bindings"]; var: AppEnv["Variables"] }, vaultId: string) {
  const [membership] = await c.env.DB.select()
    .from(vaultMembers)
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, c.var.userId)))
    .limit(1);
  if (!membership) throw forbidden("Not a member of this vault");
  return membership;
}
