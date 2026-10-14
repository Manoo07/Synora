import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { vaults, vaultMembers, wrappedVaultKeys, devices, files, fileVersions, changeEvents } from "../db/schema.js";
import { requireAccountAuth, requireAuth, requireVaultAccess } from "../auth/middleware.js";
import { forbidden } from "../lib/errors.js";

export const vaultRoutes = new Hono<AppEnv>();
// Account-level auth for everything by default; routes that need an
// active device (create, device management, normal key fetch) layer
// `requireAuth` on top. Recovery endpoints deliberately stay at the
// lighter account-only level - see auth/middleware.ts.
vaultRoutes.use("*", requireAccountAuth);

const createVaultSchema = z.object({
  // The vault key itself never reaches the server — only this device's
  // wrapped copy of it, encrypted client-side under the device's own
  // public key. See protocol-spec.md §2.
  wrappedVaultKey: z.string().min(1),
  // Optional: a second wrapping of the same vault key under a one-time
  // recovery key, shown to the user once and never stored by us. Lets a
  // future device recover vault access with no other trusted device
  // around. See protocol-spec.md §2 "Recovery is a product decision".
  wrappedRecoveryKey: z.string().min(1).optional(),
});

vaultRoutes.post("/", requireAuth, async (c) => {
  const body = createVaultSchema.parse(await c.req.json());
  const userId = c.var.userId;
  const deviceId = c.var.deviceId;

  const vault = await c.env.DB.transaction(async (tx) => {
    // The creating device is the primary by default - see
    // vaults.primaryDeviceId in schema.ts. Any device on the vault can
    // reassign it later via PUT /:vaultId/primary-device.
    const [vault] = await tx.insert(vaults).values({ ownerId: userId, primaryDeviceId: deviceId }).returning();
    await tx.insert(vaultMembers).values({ vaultId: vault!.id, userId, role: "owner" });
    await tx.insert(wrappedVaultKeys).values({
      vaultId: vault!.id,
      holderType: "device",
      holderId: deviceId,
      keyEpoch: vault!.keyEpoch,
      wrappedKey: body.wrappedVaultKey,
    });
    if (body.wrappedRecoveryKey) {
      await tx.insert(wrappedVaultKeys).values({
        vaultId: vault!.id,
        holderType: "recovery",
        holderId: "recovery",
        keyEpoch: vault!.keyEpoch,
        wrappedKey: body.wrappedRecoveryKey,
      });
    }
    return vault!;
  });

  return c.json({ id: vault.id, keyEpoch: vault.keyEpoch, createdAt: vault.createdAt }, 201);
});

// Account-level only: a device recovering vault access needs to discover
// which vault to recover before it has any device-level standing there.
vaultRoutes.get("/", async (c) => {
  const userId = c.var.userId;
  // Carries enough to tell two vaults apart. An account can easily end
  // up with several - creating one on a device that meant to recover
  // into an existing one is a single mis-click - and an id alone gives
  // someone no way to see which holds their notes. Confirmed live: a
  // device sat attached to a one-file vault reporting itself fully
  // synced while 877 changes waited in another.
  //
  // Counts and sizes only: the server already stores these as metadata
  // and still cannot read a name, path or byte of content.
  const rows = await c.env.DB.select({
    vault: vaults,
    fileCount: sql<string>`(
      select count(*) from ${files}
      where ${files.vaultId} = ${vaults.id} and ${files.deletedAt} is null
    )`,
    sizeBytes: sql<string>`(
      select coalesce(sum(fv.size_bytes), 0) from ${files} f
      join ${fileVersions} fv on fv.id = f.current_version_id
      where f.vault_id = ${vaults.id} and f.deleted_at is null
    )`,
    lastChangeAt: sql<string | null>`(
      select max(ce.created_at) from ${changeEvents} ce where ce.vault_id = ${vaults.id}
    )`,
  })
    .from(vaultMembers)
    .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
    .where(eq(vaultMembers.userId, userId));

  return c.json(
    rows.map((r) => ({
      ...r.vault,
      fileCount: Number(r.fileCount),
      sizeBytes: Number(r.sizeBytes),
      lastChangeAt: r.lastChangeAt,
    })),
  );
});

// --- Device enrollment, scoped to a vault -------------------------------

const enrollDeviceSchema = z.object({
  deviceId: z.string().uuid(),
  wrappedVaultKey: z.string().min(1),
  keyEpoch: z.number().int().positive(),
});

vaultRoutes.post("/:vaultId/devices", requireAuth, async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const body = enrollDeviceSchema.parse(await c.req.json());

  const [targetDevice] = await c.env.DB.select().from(devices).where(eq(devices.id, body.deviceId)).limit(1);
  if (!targetDevice || targetDevice.userId !== c.var.userId) {
    throw forbidden("Can only enroll your own devices");
  }

  await c.env.DB.transaction(async (tx) => {
    await tx.update(devices).set({ status: "active" }).where(eq(devices.id, body.deviceId));
    await tx
      .insert(wrappedVaultKeys)
      .values({
        vaultId,
        holderType: "device",
        holderId: body.deviceId,
        keyEpoch: body.keyEpoch,
        wrappedKey: body.wrappedVaultKey,
      })
      .onConflictDoUpdate({
        target: [wrappedVaultKeys.vaultId, wrappedVaultKeys.holderType, wrappedVaultKeys.holderId, wrappedVaultKeys.keyEpoch],
        set: { wrappedKey: body.wrappedVaultKey },
      });
  });

  return c.json({ status: "enrolled", deviceId: body.deviceId });
});

vaultRoutes.get("/:vaultId/devices", requireAuth, async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  // wrappedVaultKeys.holderId is `text` (it also holds the literal
  // string "recovery" for the recovery-key row), while devices.id is a
  // real `uuid` column - Postgres has no `uuid = text` operator, so the
  // join needs an explicit cast on one side.
  const rows = await c.env.DB.select({ device: devices })
    .from(wrappedVaultKeys)
    .innerJoin(devices, sql`${devices.id}::text = ${wrappedVaultKeys.holderId}`)
    .where(eq(wrappedVaultKeys.vaultId, vaultId));
  // Also surface devices for this user that are pending enrollment (no
  // wrapped key row yet) so a trusted device can see what needs approving.
  const pending = await c.env.DB.select()
    .from(devices)
    .where(eq(devices.userId, c.var.userId));
  const enrolledIds = new Set(rows.map((r) => r.device.id));
  const pendingOnly = pending.filter((d) => d.status === "pending" && !enrolledIds.has(d.id));
  return c.json({
    enrolled: rows.map((r) => r.device),
    pending: pendingOnly,
  });
});

vaultRoutes.delete("/:vaultId/devices/:deviceId", requireAuth, async (c) => {
  const vaultId = c.req.param("vaultId");
  const deviceId = c.req.param("deviceId");
  await requireVaultAccess(c, vaultId);

  await c.env.DB.transaction(async (tx) => {
    await tx
      .delete(wrappedVaultKeys)
      .where(and(eq(wrappedVaultKeys.vaultId, vaultId), eq(wrappedVaultKeys.holderId, deviceId)));
    await tx.update(devices).set({ status: "revoked" }).where(eq(devices.id, deviceId));
  });

  return c.json({ status: "revoked", deviceId });
});

// Lets the authenticated device fetch its own wrapped vault key after
// another device has enrolled it.
vaultRoutes.get("/:vaultId/wrapped-key", requireAuth, async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const rows = await c.env.DB.select()
    .from(wrappedVaultKeys)
    .where(
      and(
        eq(wrappedVaultKeys.vaultId, vaultId),
        eq(wrappedVaultKeys.holderType, "device"),
        eq(wrappedVaultKeys.holderId, c.var.deviceId),
      ),
    );
  const row = rows.sort((a, b) => b.keyEpoch - a.keyEpoch)[0];
  if (!row) throw forbidden("No wrapped key available for this device yet");
  return c.json({ wrappedKey: row.wrappedKey, keyEpoch: row.keyEpoch });
});

// --- Primary device (preferences source of truth) -----------------------
//
// Any active device on the vault can claim primary for itself - every
// device here belongs to the same account already, so there's no
// separate owner-only restriction. See routes/sync.ts's /preferences
// endpoints, which gate pushing on whichever device holds this.

vaultRoutes.put("/:vaultId/primary-device", requireAuth, async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  await c.env.DB.update(vaults).set({ primaryDeviceId: c.var.deviceId }).where(eq(vaults.id, vaultId));
  return c.json({ status: "ok", deviceId: c.var.deviceId });
});

vaultRoutes.get("/:vaultId/primary-device", requireAuth, async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const [row] = await c.env.DB.select({ deviceId: devices.id, deviceName: devices.name })
    .from(vaults)
    .innerJoin(devices, eq(devices.id, vaults.primaryDeviceId))
    .where(eq(vaults.id, vaultId))
    .limit(1);
  return c.json(row ?? null);
});

// --- Recovery: regain vault access with no other trusted device --------

// Account-level only (no requireAuth): this is precisely the path a
// not-yet-active device must take, so gating it on an active device
// would make it unusable.
vaultRoutes.get("/:vaultId/recovery-key", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const rows = await c.env.DB.select()
    .from(wrappedVaultKeys)
    .where(and(eq(wrappedVaultKeys.vaultId, vaultId), eq(wrappedVaultKeys.holderType, "recovery")));
  const row = rows.sort((a, b) => b.keyEpoch - a.keyEpoch)[0];
  if (!row) throw forbidden("No recovery key was set up for this vault");
  return c.json({ wrappedKey: row.wrappedKey, keyEpoch: row.keyEpoch });
});

const selfRecoverSchema = z.object({
  wrappedVaultKey: z.string().min(1),
  keyEpoch: z.number().int().positive(),
});

vaultRoutes.post("/:vaultId/devices/self-recover", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const body = selfRecoverSchema.parse(await c.req.json());
  const deviceId = c.var.deviceId;

  const [device] = await c.env.DB.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  // A device someone explicitly revoked staying revoked is the whole
  // point of revocation - it doesn't get a second chance just by knowing
  // the recovery key for its old account. But "active" on its own isn't
  // disqualifying: an account can end up with more than one vault (e.g.
  // a device briefly created its own before ever attempting recovery,
  // confirmed live), and a device already active for a DIFFERENT vault
  // must still be able to self-recover into this one - global
  // active/pending status isn't the same thing as "has this vault."
  if (!device || device.userId !== c.var.userId || device.status === "revoked") {
    throw forbidden("This device is not eligible for self-recovery");
  }
  const [existingGrant] = await c.env.DB.select()
    .from(wrappedVaultKeys)
    .where(
      and(
        eq(wrappedVaultKeys.vaultId, vaultId),
        eq(wrappedVaultKeys.holderType, "device"),
        eq(wrappedVaultKeys.holderId, deviceId),
      ),
    )
    .limit(1);
  if (existingGrant) throw forbidden("This device already has access to this vault");

  await c.env.DB.transaction(async (tx) => {
    await tx.update(devices).set({ status: "active" }).where(eq(devices.id, deviceId));
    await tx
      .insert(wrappedVaultKeys)
      .values({
        vaultId,
        holderType: "device",
        holderId: deviceId,
        keyEpoch: body.keyEpoch,
        wrappedKey: body.wrappedVaultKey,
      })
      .onConflictDoUpdate({
        target: [wrappedVaultKeys.vaultId, wrappedVaultKeys.holderType, wrappedVaultKeys.holderId, wrappedVaultKeys.keyEpoch],
        set: { wrappedKey: body.wrappedVaultKey },
      });
  });

  return c.json({ status: "recovered", deviceId });
});
