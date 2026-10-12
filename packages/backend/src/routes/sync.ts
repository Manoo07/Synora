import { Hono } from "hono";
import { eq, and, gt, sql, desc } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { files, fileVersions, changeEvents, deviceCursors, storageObjects } from "../db/schema.js";
import { requireAuth, requireVaultAccess } from "../auth/middleware.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";

export const syncRoutes = new Hono<AppEnv>();
syncRoutes.use("*", requireAuth);

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

  const bytes = new Uint8Array(await c.req.arrayBuffer());
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
