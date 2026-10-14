import { Hono } from "hono";
import { eq, and, gt, sql, desc } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { files, fileVersions, changeEvents, deviceCursors, storageObjects, vaults, users } from "../db/schema.js";
import { requireAuth, requireVaultAccess } from "../auth/middleware.js";
import { badRequest, conflict, forbidden, notFound, payloadTooLarge, quotaExceeded } from "../lib/errors.js";

export const syncRoutes = new Hono<AppEnv>();
syncRoutes.use("*", requireAuth);

// Generous for a notes vault (covers large attachments/PDFs/images) while
// still bounding the worst case of a single upload - uploads are
// authenticated (can't be hit by a totally anonymous attacker), but an
// unbounded per-file size still means one compromised or malicious
// account could run up real R2 storage cost in a single request.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// --- Uploads --------------------------------------------------------------
//
// For the MVP we skip presigned R2 URLs (which need separate R2 API
// credentials) and instead proxy the PUT through this authenticated
// endpoint. "uploadUrl" is a path on this same API, not an R2 URL.

syncRoutes.post("/:vaultId/uploads", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const blobKey = `${vaultId}/${crypto.randomUUID()}`;
  return c.json({ uploadId: blobKey, uploadUrl: `/v1/vaults/${vaultId}/uploads/${encodeURIComponent(blobKey)}` });
});

syncRoutes.put("/:vaultId/uploads/:blobKey", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const blobKey = decodeURIComponent(c.req.param("blobKey"));
  if (!blobKey.startsWith(`${vaultId}/`)) throw badRequest("Blob key does not belong to this vault");

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES) throw payloadTooLarge(`Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`);

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw payloadTooLarge(`Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const ciphertextHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await c.env.BUCKET.put(blobKey, bytes, { customMetadata: { sha256: ciphertextHash } });

  return c.json({ blobKey, sizeBytes: bytes.byteLength, ciphertextHash });
});

// --- Conditional commits ----------------------------------------------
//
// This transaction is the whole protocol: the base-version check,
// sequence allocation, and change-event insertion all happen atomically,
// serialized per vault via a transactional advisory lock so two devices
// racing to commit against the same base version can't both win.
// See protocol-spec.md §5.

const commitSchema = z.object({
  fileId: z.string().uuid().optional(),
  baseVersionId: z.string().uuid().optional(),
  blobKey: z.string().min(1),
  ciphertextHash: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  operation: z.enum(["created", "updated", "renamed", "deleted"]),
  idempotencyKey: z.string().min(1),
  parentVersionIds: z.array(z.string().uuid()).optional().default([]),
  conflictOfFileId: z.string().uuid().optional(),
});

syncRoutes.post("/:vaultId/commits", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const body = commitSchema.parse(await c.req.json());

  const blobHead = await c.env.BUCKET.head(body.blobKey);
  if (!blobHead) throw badRequest("Uploaded blob not found; upload before committing");
  if (blobHead.size !== body.sizeBytes) throw badRequest("sizeBytes does not match uploaded blob");
  if (blobHead.customMetadata?.sha256 !== body.ciphertextHash) {
    throw badRequest("ciphertextHash does not match uploaded blob");
  }

  const result = await c.env.DB.transaction(async (tx) => {
    // Serialize commits for this vault. Released automatically at the end
    // of the transaction (commit or rollback).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${vaultId}))`);

    const [existingEvent] = await tx
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.vaultId, vaultId), eq(changeEvents.idempotencyKey, body.idempotencyKey)))
      .limit(1);
    if (existingEvent) {
      return {
        status: "committed" as const,
        fileId: existingEvent.fileId,
        versionId: existingEvent.versionId!,
        sequence: Number(existingEvent.sequence),
      };
    }

    const [owner] = await tx
      .select({ id: users.id, plan: users.plan, storageLimitBytes: users.storageLimitBytes, storageBytesUsed: users.storageBytesUsed })
      .from(vaults)
      .innerJoin(users, eq(users.id, vaults.ownerId))
      .where(eq(vaults.id, vaultId))
      .limit(1);
    if (!owner) throw notFound("Vault not found");
    if (owner.plan === "free" && owner.storageBytesUsed + body.sizeBytes > owner.storageLimitBytes) {
      throw quotaExceeded(
        `This account's free ${Math.round(owner.storageLimitBytes / (1024 * 1024))}MB storage limit is used up.`,
      );
    }

    let fileId = body.fileId;
    if (fileId) {
      const [file] = await tx.select().from(files).where(and(eq(files.id, fileId), eq(files.vaultId, vaultId))).limit(1);
      if (!file) throw notFound("File not found in this vault");
      if (file.currentVersionId !== (body.baseVersionId ?? null)) {
        return {
          status: "conflict" as const,
          currentFileId: file.id,
          currentVersionId: file.currentVersionId,
        };
      }
    } else {
      const [created] = await tx
        .insert(files)
        .values({ vaultId, conflictOfFileId: body.conflictOfFileId })
        .returning();
      fileId = created!.id;
    }

    const [version] = await tx
      .insert(fileVersions)
      .values({
        fileId,
        parentVersionIds: body.parentVersionIds,
        blobKey: body.blobKey,
        ciphertextHash: body.ciphertextHash,
        sizeBytes: body.sizeBytes,
      })
      .returning();

    await tx
      .update(files)
      .set({
        currentVersionId: version!.id,
        deletedAt: body.operation === "deleted" ? new Date() : null,
      })
      .where(eq(files.id, fileId));

    const [row] = await tx
      .select({ nextSequence: sql<string>`coalesce(max(${changeEvents.sequence}), 0) + 1` })
      .from(changeEvents)
      .where(eq(changeEvents.vaultId, vaultId));
    // postgres.js returns bigint aggregate results as strings to avoid
    // silent precision loss above 2^53; this value is a small counter, so
    // converting back to a number is safe.
    const nextSequence = Number(row!.nextSequence);

    await tx.insert(changeEvents).values({
      vaultId,
      sequence: nextSequence,
      fileId,
      versionId: version!.id,
      operation: body.operation,
      idempotencyKey: body.idempotencyKey,
    });

    await tx.insert(storageObjects).values({
      provider: "r2",
      objectKey: body.blobKey,
      sizeBytes: body.sizeBytes,
      vaultId,
    });

    await tx
      .update(users)
      .set({ storageBytesUsed: sql`${users.storageBytesUsed} + ${body.sizeBytes}` })
      .where(eq(users.id, owner.id));

    return { status: "committed" as const, fileId, versionId: version!.id, sequence: nextSequence };
  });

  if (result.status === "conflict") return c.json(result, 409);
  return c.json(result, 200);
});

// --- Change feed ---------------------------------------------------------

syncRoutes.get("/:vaultId/changes", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const since = Number(c.req.query("since") ?? "0");
  const limit = Math.min(Number(c.req.query("limit") ?? "200"), 500);

  const rows = await c.env.DB.select({
    sequence: changeEvents.sequence,
    fileId: changeEvents.fileId,
    versionId: changeEvents.versionId,
    operation: changeEvents.operation,
    blobKey: fileVersions.blobKey,
    ciphertextHash: fileVersions.ciphertextHash,
    sizeBytes: fileVersions.sizeBytes,
  })
    .from(changeEvents)
    .leftJoin(fileVersions, eq(fileVersions.id, changeEvents.versionId))
    .where(and(eq(changeEvents.vaultId, vaultId), gt(changeEvents.sequence, since)))
    .orderBy(changeEvents.sequence)
    .limit(limit);

  return c.json({ changes: rows, hasMore: rows.length === limit });
});

// Resolves one specific version to its blob. Conflict resolution needs
// the remote version and the local edit's base version to attempt a
// three-way merge, and both are addressed by id - scanning /changes for
// them only works while the whole history still fits in one page, so a
// vault stops being able to merge at all once it outgrows that.
syncRoutes.get("/:vaultId/versions/:versionId", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const versionId = c.req.param("versionId");

  const [row] = await c.env.DB.select({
    versionId: fileVersions.id,
    fileId: fileVersions.fileId,
    blobKey: fileVersions.blobKey,
    ciphertextHash: fileVersions.ciphertextHash,
    sizeBytes: fileVersions.sizeBytes,
  })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(eq(fileVersions.id, versionId), eq(files.vaultId, vaultId)))
    .limit(1);

  if (!row) throw notFound("Version not found");
  return c.json(row);
});

// --- Object download -------------------------------------------------------

syncRoutes.get("/:vaultId/objects/:blobKey", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const blobKey = decodeURIComponent(c.req.param("blobKey"));
  if (!blobKey.startsWith(`${vaultId}/`)) throw badRequest("Blob key does not belong to this vault");

  const object = await c.env.BUCKET.get(blobKey);
  if (!object) throw notFound("Object not found");
  const bytes = await object.arrayBuffer();
  return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
});

// --- Preferences (primary device's theme/plugins/settings bundle) ---------
//
// A single, always-overwritten blob per vault - genuinely simpler than
// the file-commit protocol above (no version history, no conflict
// concept: pushing just replaces whatever was there). Deliberately kept
// separate from /commits rather than threaded through it. See
// protocol-spec.md's design notes are file-sync specific; this is its
// own small, parallel thing.

function preferencesObjectKey(vaultId: string): string {
  return `${vaultId}/preferences`;
}

syncRoutes.get("/:vaultId/preferences/info", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const [row] = await c.env.DB.select()
    .from(storageObjects)
    .where(eq(storageObjects.objectKey, preferencesObjectKey(vaultId)))
    .limit(1);
  if (!row) return c.json({ exists: false });
  return c.json({ exists: true, updatedAt: row.createdAt, sizeBytes: row.sizeBytes });
});

// Only the vault's primary device may push - any active device may fetch
// (GET below). Writes to R2 first, then does the DB bookkeeping: if the
// DB step failed after a successful R2 write, the worst case is an
// orphaned blob (harmless or cheaply reaped later), not a record of
// stored bytes that were never actually written.
syncRoutes.put("/:vaultId/preferences", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);

  const [vault] = await c.env.DB.select({ primaryDeviceId: vaults.primaryDeviceId, ownerId: vaults.ownerId })
    .from(vaults)
    .where(eq(vaults.id, vaultId))
    .limit(1);
  if (!vault) throw notFound("Vault not found");
  if (vault.primaryDeviceId !== c.var.deviceId) {
    throw forbidden("Only this vault's primary device can push preferences");
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES) throw payloadTooLarge(`Preferences exceed the ${MAX_UPLOAD_BYTES} byte limit`);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw payloadTooLarge(`Preferences exceed the ${MAX_UPLOAD_BYTES} byte limit`);

  const objectKey = preferencesObjectKey(vaultId);
  await c.env.BUCKET.put(objectKey, bytes);

  await c.env.DB.transaction(async (tx) => {
    // Serializes concurrent pushes for this vault's preferences blob,
    // same technique as the commit lock above.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${objectKey}))`);

    const [owner] = await tx
      .select({ id: users.id, plan: users.plan, storageLimitBytes: users.storageLimitBytes, storageBytesUsed: users.storageBytesUsed })
      .from(users)
      .where(eq(users.id, vault.ownerId))
      .limit(1);
    if (!owner) throw notFound("Account not found");

    const [existing] = await tx.select().from(storageObjects).where(eq(storageObjects.objectKey, objectKey)).limit(1);
    const previousSize = existing?.sizeBytes ?? 0;
    // Replace semantics: this blob is always overwritten, never
    // accumulated - the quota check and update are against the *net*
    // size delta, not the full new size, so repeatedly pushing the same
    // vault's preferences can't silently inflate the quota forever.
    const projectedUsage = owner.storageBytesUsed - previousSize + bytes.byteLength;
    if (owner.plan === "free" && projectedUsage > owner.storageLimitBytes) {
      throw quotaExceeded(`This account's free ${Math.round(owner.storageLimitBytes / (1024 * 1024))}MB storage limit is used up.`);
    }

    if (existing) await tx.delete(storageObjects).where(eq(storageObjects.objectKey, objectKey));
    await tx.insert(storageObjects).values({ provider: "r2", objectKey, sizeBytes: bytes.byteLength, vaultId });
    await tx
      .update(users)
      .set({ storageBytesUsed: sql`${users.storageBytesUsed} - ${previousSize} + ${bytes.byteLength}` })
      .where(eq(users.id, owner.id));
  });

  return c.json({ status: "ok", sizeBytes: bytes.byteLength });
});

syncRoutes.get("/:vaultId/preferences", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const object = await c.env.BUCKET.get(preferencesObjectKey(vaultId));
  if (!object) throw notFound("No preferences have been shared for this vault yet");
  const bytes = await object.arrayBuffer();
  return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
});

// --- Cursors and status ----------------------------------------------------

const ackSchema = z.object({ lastSequence: z.number().int().nonnegative() });

syncRoutes.post("/:vaultId/acks", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const body = ackSchema.parse(await c.req.json());
  const deviceId = c.var.deviceId;

  await c.env.DB
    .insert(deviceCursors)
    .values({ deviceId, vaultId, lastSequence: body.lastSequence })
    .onConflictDoUpdate({
      target: [deviceCursors.deviceId, deviceCursors.vaultId],
      set: { lastSequence: body.lastSequence, updatedAt: new Date() },
    });

  return c.json({ status: "acked", lastSequence: body.lastSequence });
});

syncRoutes.get("/:vaultId/status", async (c) => {
  const vaultId = c.req.param("vaultId");
  await requireVaultAccess(c, vaultId);
  const deviceId = c.var.deviceId;

  const [latest] = await c.env.DB.select({ sequence: changeEvents.sequence })
    .from(changeEvents)
    .where(eq(changeEvents.vaultId, vaultId))
    .orderBy(desc(changeEvents.sequence))
    .limit(1);

  const [cursor] = await c.env.DB.select()
    .from(deviceCursors)
    .where(and(eq(deviceCursors.deviceId, deviceId), eq(deviceCursors.vaultId, vaultId)))
    .limit(1);

  const latestSequence = latest?.sequence ?? 0;
  const lastAcked = cursor?.lastSequence ?? 0;

  return c.json({
    latestSequence,
    lastAckedSequence: lastAcked,
    pendingCount: Math.max(0, latestSequence - lastAcked),
  });
});
