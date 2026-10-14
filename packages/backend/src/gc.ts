import { and, eq, inArray, lt, lte, ne, sql } from "drizzle-orm";
import type { AppBindings } from "./context.js";
import { changeEvents, deviceCursors, devices, fileVersions, files, storageObjects, users, vaults } from "./db/schema.js";

// Reclaims storage that nothing can reach any more.
//
// Every save writes a whole new encrypted copy of the file and nothing
// has ever removed the superseded one, so an account's usage only ever
// climbed - deleting a file made it worse, because the tombstone is
// itself a commit with a blob. Left alone, every vault eventually wedges
// against its quota and sync stops.
//
// This is the one piece of code in the system that deletes user data, so
// the rules it collects under are deliberately narrow. A version is only
// touched when ALL of these hold:
//
//   1. It is not the file's current version. The database does not
//      enforce this - files.current_version_id is a plain column, not a
//      foreign key - so this check is the only thing standing between a
//      bug here and someone's note disappearing.
//   2. A newer change event exists for the same file, and every device
//      has already applied that newer one too. Two separate reasons:
//      a device that has never synced replays the feed from sequence
//      zero to build the vault, so a file's newest event is load-bearing
//      - drop it and that file silently ceases to exist for every future
//      device; and the version at a device's own cursor is the base its
//      pending edits merge against.
//   3. Every non-revoked device on the vault has already acked past it.
//      Nobody can still be waiting to receive it.
//   4. It is older than the retention window, as a backstop against all
//      of the above being wrong.
//
// Anything that fails even one of these is left alone. Being too
// cautious here costs disk; being too eager costs someone their writing.
export const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_VERSIONS_PER_RUN = 500;
const DEFAULT_MAX_VAULTS_PER_RUN = 50;

export interface GcOptions {
  retentionDays?: number;
  maxVersionsPerRun?: number;
  maxVaultsPerRun?: number;
  now?: Date;
  // Report what would be collected without deleting anything. Worth
  // running against real data before the first scheduled run, since
  // everything already past the retention window becomes eligible at
  // once and there is no undo.
  dryRun?: boolean;
}

export interface GcResult {
  vaultsScanned: number;
  versionsCollected: number;
  filesRemoved: number;
  bytesReclaimed: number;
}

// The highest sequence every non-revoked device on this vault has
// confirmed applying. A device with no cursor row has never acked
// anything, but it also rebuilds from zero on its first sync, so it
// constrains nothing beyond rule 2 above. No cursors at all yields 0,
// which collects nothing - the safe direction.
async function minAckedSequence(bindings: AppBindings, vaultId: string): Promise<number> {
  const [row] = await bindings.DB.select({
    lowest: sql<string | null>`min(${deviceCursors.lastSequence})`,
  })
    .from(deviceCursors)
    .innerJoin(devices, eq(devices.id, deviceCursors.deviceId))
    .where(and(eq(deviceCursors.vaultId, vaultId), ne(devices.status, "revoked")));

  return Number(row?.lowest ?? 0);
}

interface Collectable {
  versionId: string;
  sequence: number;
  blobKey: string;
  sizeBytes: number;
}

async function superseded(
  bindings: AppBindings,
  vaultId: string,
  minCursor: number,
  cutoff: Date,
  limit: number,
): Promise<Collectable[]> {
  return bindings.DB.select({
    versionId: fileVersions.id,
    sequence: changeEvents.sequence,
    blobKey: fileVersions.blobKey,
    sizeBytes: fileVersions.sizeBytes,
  })
    .from(changeEvents)
    .innerJoin(fileVersions, eq(fileVersions.id, changeEvents.versionId))
    .innerJoin(files, eq(files.id, changeEvents.fileId))
    .where(
      and(
        eq(changeEvents.vaultId, vaultId),
        lte(changeEvents.sequence, minCursor),
        lt(fileVersions.createdAt, cutoff),
        // Rule 1. IS DISTINCT FROM rather than <>, so a file with no
        // current version recorded still compares correctly instead of
        // the row vanishing on a NULL comparison.
        sql`${files.currentVersionId} is distinct from ${fileVersions.id}`,
        // Rule 2, in the strongest form: a newer event must exist for
        // this file that even the *slowest* device has already applied.
        //
        // Bounding by the cursor is what keeps merge bases alive. The
        // version sitting at a device's own cursor is the base its
        // pending edits were made against, and the three-way merge
        // fetches that version by id to resolve a conflict. Collect it
        // and the merge cannot run, so every conflict on that file
        // becomes a conflict copy instead - no data lost, but it is
        // exactly the silent degradation that made merging stop working
        // once before. One extra version per file is cheap insurance.
        sql`exists (
          select 1 from change_events newer
          where newer.file_id = ${changeEvents.fileId}
            and newer.sequence > ${changeEvents.sequence}
            and newer.sequence <= ${minCursor}
        )`,
      ),
    )
    .orderBy(changeEvents.sequence)
    .limit(limit);
}

// A file that was deleted, whose tombstone every device has already
// seen, can go entirely - row, versions and events. A device syncing
// for the first time after this never learns it existed, which is the
// correct outcome: it has nothing to delete locally.
async function tombstonedFileIds(
  bindings: AppBindings,
  vaultId: string,
  minCursor: number,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const rows = await bindings.DB.select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.vaultId, vaultId),
        sql`${files.deletedAt} is not null`,
        lt(files.deletedAt, cutoff),
        // Every event for this file - including the tombstone itself -
        // must already be behind every device's cursor.
        sql`not exists (
          select 1 from change_events pending
          where pending.file_id = ${files.id}
            and pending.sequence > ${minCursor}
        )`,
      ),
    )
    .limit(limit);

  return rows.map((row) => row.id);
}

async function collectVault(
  bindings: AppBindings,
  vaultId: string,
  ownerId: string,
  cutoff: Date,
  maxVersions: number,
  dryRun: boolean,
): Promise<{ versionsCollected: number; filesRemoved: number; bytesReclaimed: number }> {
  const minCursor = await minAckedSequence(bindings, vaultId);
  if (minCursor <= 0) return { versionsCollected: 0, filesRemoved: 0, bytesReclaimed: 0 };

  const doomedFiles = await tombstonedFileIds(bindings, vaultId, minCursor, cutoff, maxVersions);
  const stale = await superseded(bindings, vaultId, minCursor, cutoff, maxVersions);

  // Versions belonging to a file being removed outright are handled by
  // that path, so don't also count them here.
  const doomed = new Set(doomedFiles);
  const versionsOfDoomedFiles = doomed.size
    ? await bindings.DB.select({ id: fileVersions.id, blobKey: fileVersions.blobKey, sizeBytes: fileVersions.sizeBytes })
        .from(fileVersions)
        .where(inArray(fileVersions.fileId, doomedFiles))
    : [];

  const doomedVersionIds = new Set(versionsOfDoomedFiles.map((v) => v.id));
  const staleOnly = stale.filter((v) => !doomedVersionIds.has(v.versionId));

  if (staleOnly.length === 0 && doomedFiles.length === 0) {
    return { versionsCollected: 0, filesRemoved: 0, bytesReclaimed: 0 };
  }

  const blobKeys = [...staleOnly.map((v) => v.blobKey), ...versionsOfDoomedFiles.map((v) => v.blobKey)];
  const bytes =
    staleOnly.reduce((sum, v) => sum + v.sizeBytes, 0) +
    versionsOfDoomedFiles.reduce((sum, v) => sum + v.sizeBytes, 0);

  if (dryRun) {
    return {
      versionsCollected: staleOnly.length + versionsOfDoomedFiles.length,
      filesRemoved: doomedFiles.length,
      bytesReclaimed: bytes,
    };
  }

  // Blobs first, rows second. If this half succeeds and the next fails,
  // what is left behind is a row pointing at a blob that is gone - and
  // by rules 1-3 nothing will ever ask for that blob, while the next run
  // retries the row (R2 deletes are idempotent). The reverse order would
  // drop the only record of a blob that still exists, leaking storage
  // that nothing can ever find again.
  for (const key of blobKeys) {
    await bindings.BUCKET.delete(key);
  }

  await bindings.DB.transaction(async (tx) => {
    // Same lock the commit path takes, so this can never interleave with
    // a commit that is busy moving current_version_id.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${vaultId}))`);

    if (staleOnly.length > 0) {
      const sequences = staleOnly.map((v) => v.sequence);
      const versionIds = staleOnly.map((v) => v.versionId);
      // change_events.version_id references file_versions, so the events
      // have to go first or the delete below is rejected.
      await tx.delete(changeEvents).where(and(eq(changeEvents.vaultId, vaultId), inArray(changeEvents.sequence, sequences)));
      await tx.delete(fileVersions).where(inArray(fileVersions.id, versionIds));
    }

    if (doomedFiles.length > 0) {
      await tx.delete(changeEvents).where(and(eq(changeEvents.vaultId, vaultId), inArray(changeEvents.fileId, doomedFiles)));
      await tx.delete(fileVersions).where(inArray(fileVersions.fileId, doomedFiles));
      await tx.delete(files).where(inArray(files.id, doomedFiles));
    }

    if (blobKeys.length > 0) {
      await tx.delete(storageObjects).where(inArray(storageObjects.objectKey, blobKeys));
    }

    // greatest(0, ...) because the running total is maintained by hand on
    // the commit path; if it has ever drifted, GC must not drive it
    // negative and hand out quota that does not exist.
    await tx
      .update(users)
      .set({ storageBytesUsed: sql`greatest(0, ${users.storageBytesUsed} - ${bytes})` })
      .where(eq(users.id, ownerId));
  });

  return {
    versionsCollected: staleOnly.length + versionsOfDoomedFiles.length,
    filesRemoved: doomedFiles.length,
    bytesReclaimed: bytes,
  };
}

export async function collectGarbage(bindings: AppBindings, options: GcOptions = {}): Promise<GcResult> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxVersions = options.maxVersionsPerRun ?? DEFAULT_MAX_VERSIONS_PER_RUN;
  const maxVaults = options.maxVaultsPerRun ?? DEFAULT_MAX_VAULTS_PER_RUN;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const targets = await bindings.DB.select({ id: vaults.id, ownerId: vaults.ownerId }).from(vaults).limit(maxVaults);

  const result: GcResult = { vaultsScanned: 0, versionsCollected: 0, filesRemoved: 0, bytesReclaimed: 0 };
  for (const vault of targets) {
    // One vault's failure must not stop the rest - a run that aborts
    // halfway would otherwise keep aborting on the same vault forever,
    // which is how the sync loops in the plugin used to wedge.
    try {
      const collected = await collectVault(
        bindings,
        vault.id,
        vault.ownerId,
        cutoff,
        maxVersions,
        options.dryRun ?? false,
      );
      result.versionsCollected += collected.versionsCollected;
      result.filesRemoved += collected.filesRemoved;
      result.bytesReclaimed += collected.bytesReclaimed;
    } catch (err) {
      console.error(`GC failed for vault ${vault.id}`, err);
    }
    result.vaultsScanned++;
  }
  return result;
}
