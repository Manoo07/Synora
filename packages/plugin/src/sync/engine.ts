import { sha256 } from "@noble/hashes/sha256";
import { SynoraApiClient, ApiError } from "../api/client.js";
import { encryptEnvelope, decryptEnvelope, encodeEnvelope, decodeEnvelope } from "../crypto/envelope.js";
import { encodeManifest, decodeManifest } from "../crypto/manifest.js";
import { SyncQueue, type PendingOp } from "./queue.js";
import { LocalStateStore } from "./local-state.js";
import { WriteSuppressor, DELETION_MARK } from "./suppressor.js";
import { mergeText } from "./merge.js";

export interface VaultAdapter {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TEXT_EXTENSIONS = [".md", ".markdown", ".txt"];
function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

// Notes and attachments get separate encryption contexts, which feed
// into both the derived key and the envelope's authenticated data. The
// point is domain separation: a nonce-reuse or key-derivation bug in
// one kind of content cannot be combined with ciphertext of the other.
//
// Safe to change for new writes only - every envelope stores the
// context it was sealed with and decrypts under that, so blobs written
// before this keep working untouched.
function contextFor(path: string): "file-content" | "attachment" {
  return isTextPath(path) ? "file-content" : "attachment";
}

function conflictPath(path: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dot = path.lastIndexOf(".");
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? "" : path.slice(dot);
  return `${stem} (conflict ${ts})${ext}`;
}

// How many uploads overlap, and the size above which one runs alone.
// Four 25MB attachments in flight is 100MB of buffers held at once.
const UPLOAD_CONCURRENCY = 4;
const LARGE_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface FlushProgress {
  doneCount: number;
  totalCount: number;
  doneBytes: number;
  totalBytes: number;
}

// Runs `fn` over `items`, at most `limit` at a time. Workers pull from
// a shared cursor rather than being handed fixed slices, so one slow
// upload cannot leave the others idle behind it.
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

export interface SyncEngineDeps {
  api: SynoraApiClient;
  vaultId: string;
  vaultKey: Uint8Array;
  vault: VaultAdapter;
  queue: SyncQueue;
  state: LocalStateStore;
  suppressor: WriteSuppressor;
}

export class SyncEngine {
  constructor(private deps: SyncEngineDeps) {}

  // Used for an initial vault scan: whether this path has already been
  // seen (synced before, or already queued), so the scan can skip it
  // instead of re-enqueueing every file on every run.
  async isTracked(path: string): Promise<boolean> {
    return (await this.deps.state.getByPath(path)) !== undefined;
  }

  // Number of local edits/creates not yet uploaded. Zero means this
  // device has nothing outstanding to push - the UI's "fully synced"
  // signal (not the same thing as "nothing left to pull"; see
  // SynoraApiClient.status for the remote side of that).
  async pendingUploadCount(): Promise<number> {
    return (await this.deps.queue.list()).length;
  }

  // Rebuilds a queued operation's encrypted payload from the file still
  // on disk. Only the envelope was lost - the content it was made from
  // is right there in the vault - so this is recoverable without
  // involving the person at all.
  //
  // Deliberately returns the bytes instead of writing them back to the
  // queue: this runs inside the concurrent upload phase, and the queue
  // is read-modify-write over one file, so a write here could clobber a
  // sibling's. The caller records the new hash and size in a map that
  // the sequential commit phase reads.
  private async rebuildPayload(
    op: PendingOp,
    rebuilt: Map<string, { ciphertextHash: string; sizeBytes: number }>,
  ): Promise<Uint8Array | undefined> {
    const { vault, vaultKey, vaultId } = this.deps;
    try {
      // A delete carries no content, so it needs nothing from disk.
      const content = op.operation === "deleted" ? new Uint8Array(0) : await vault.read(op.logicalPath);
      const manifestBytes = encodeManifest({
        fileId: op.fileId ?? "",
        logicalPath: op.logicalPath,
        content,
      });
      const envelope = encodeEnvelope(
        encryptEnvelope(vaultKey, vaultId, op.fileId ?? op.logicalPath, contextFor(op.logicalPath), manifestBytes),
      );
      rebuilt.set(op.idempotencyKey, {
        ciphertextHash: toHex(sha256(envelope)),
        sizeBytes: envelope.byteLength,
      });
      console.warn(`Synora: rebuilt the queued payload for "${op.logicalPath}" from the file on disk`);
      return envelope;
    } catch {
      // The file is genuinely gone - nothing left to send.
      return undefined;
    }
  }

  // Changes this device has not applied yet - the other direction from
  // pendingUploadCount, and the one that was missing.
  //
  // A device that has just attached has an empty upload queue and an
  // entire vault still to come down, so a status built only from
  // uploads reports "all files synced" over an empty vault. That reads
  // as "your notes are gone" rather than "nothing has arrived yet".
  async pendingDownloadCount(): Promise<number> {
    const { api, vaultId, state } = this.deps;
    const [remote, applied] = await Promise.all([api.status(vaultId), state.getLastAppliedSequence()]);
    return Math.max(0, remote.latestSequence - applied);
  }

  // --- Outgoing: local vault event -> encrypted, durably queued op -------

  // A pure rename/move: content is unchanged, only the path differs.
  // state.rename() carries the existing fileId/currentVersionId forward
  // to the new path key *before* handleLocalChange runs, so its own
  // state.getByPath(newPath) lookup finds that record and picks up the
  // right fileId/baseVersionId automatically. Using "renamed" (not
  // "updated") matters: handleLocalChange's no-op guard would otherwise
  // skip the enqueue entirely, since content and its hash are identical -
  // the one thing that actually changed (the path) isn't part of that
  // check.
  async handleLocalRename(oldPath: string, newPath: string, content: Uint8Array): Promise<void> {
    const existing = await this.deps.state.getByPath(oldPath);
    if (existing) await this.deps.state.rename(oldPath, newPath);
    await this.handleLocalChange(newPath, "renamed", content);
  }

  async handleLocalChange(
    path: string,
    operation: "created" | "updated" | "renamed" | "deleted",
    content?: Uint8Array,
  ): Promise<void> {
    const { state, queue, vaultKey, vaultId } = this.deps;
    const existing = await state.getByPath(path);
    // state.upsert() below always writes a *string* fileId, storing "not
    // known yet" as "" rather than leaving it absent (FileRecord.fileId
    // isn't optional) - so a not-yet-synced file's record has fileId ""
    // once this function has run on it once. Without this fallback, a
    // SECOND edit to that same file before the first one flushes would
    // read that "" back out and send it to the server as this op's
    // fileId - the server's zod schema accepts an *absent* fileId but
    // validates a *present* one as a UUID, so "" fails validation with
    // the unhelpful "Invalid uuid" - confirmed live.
    const fileId = existing?.fileId || undefined;
    const bytes = content ?? new Uint8Array(0);
    const contentHash = toHex(sha256(bytes));

    // Nothing actually changed (e.g. a write we applied ourselves slipped
    // past the suppressor, or the file was saved with identical bytes).
    if (existing && existing.contentHash === contentHash && operation === "updated") return;

    const manifestBytes = encodeManifest({ fileId: fileId ?? "", logicalPath: path, content: bytes });
    const envelope = encryptEnvelope(vaultKey, vaultId, fileId ?? path, contextFor(path), manifestBytes);
    const encoded = encodeEnvelope(envelope);
    const ciphertextHash = toHex(sha256(encoded));

    const op: PendingOp = {
      idempotencyKey: crypto.randomUUID(),
      logicalPath: path,
      fileId,
      baseVersionId: existing?.currentVersionId ?? undefined,
      operation,
      ciphertextHash,
      sizeBytes: encoded.byteLength,
      enqueuedAt: Date.now(),
    };
    // If this path already has an unflushed op queued, replace it in
    // place instead of adding a second one. Without this, editing the
    // same document more than once before a sync cycle runs (easily
    // done just by pausing between paragraphs - the sync interval
    // defaults to 30s) queues multiple ops that all carry the *same*
    // baseVersionId, since nothing has actually committed yet to advance
    // it. flush() then commits the first one fine, but every op after it
    // in the queue is now stale relative to that very own commit - the
    // server correctly rejects it as a conflict, and if the overlapping
    // edits touch the same lines (likely, composing one document), the
    // merge isn't clean and it's filed as a conflict copy. Confirmed
    // live: several conflict copies of one document, edited on a single
    // device, no other device involved at all.
    const existingPending = (await queue.list()).find((pending) => pending.logicalPath === path);
    if (existingPending) {
      await queue.replace(existingPending.idempotencyKey, op, encoded);
    } else {
      await queue.enqueue(op, encoded);
    }
    // Optimistically record the content hash now so a rapid second edit to
    // the same path before this op uploads is recognized as a real change
    // (its hash will differ) rather than compared against stale state.
    await state.upsert({
      fileId: fileId ?? "",
      logicalPath: path,
      currentVersionId: existing?.currentVersionId ?? null,
      contentHash,
    });
  }

  // --- Flushing the queue: upload, commit, resolve conflicts -------------

  // Returns the logical paths of any queued edits that failed to sync
  // and were dropped. flush() previously had no per-item error handling
  // at all: one op hitting a non-retryable error (e.g. the "Invalid
  // uuid" case above, or any other malformed-data rejection) threw out
  // of the whole loop, permanently blocking every op queued behind it on
  // every future sync cycle too - the same class of bug pull() had
  // before 0.1.17's skip-and-continue fix, just never applied here.
  // A genuine 4xx means this exact request will never succeed no matter
  // how many times it's retried, so it's dropped from the queue (rather
  // than retried forever) and reported; anything else (network hiccup,
  // 5xx) is left queued to retry next cycle, and the loop still moves on
  // to the next op either way.
  async flush(onProgress?: (progress: FlushProgress) => void): Promise<{ failed: string[] }> {
    const { api, vaultId, queue } = this.deps;
    const failed: string[] = [];
    const ops = await queue.list();
    if (ops.length === 0) return { failed };

    // Uploads run several at a time; commits stay strictly sequential.
    //
    // The split is deliberate. Uploading touches nothing shared - it
    // reads one payload and PUTs it - so it parallelises safely.
    // Committing mutates the queue and the local state store, both of
    // which are read-modify-write over a single JSON blob: run two at
    // once and one's write silently erases the other's, which could
    // drop a queued conflict copy. The slow part is the upload anyway.
    const blobKeys = new Map<string, string>();
    const rebuilt = new Map<string, { ciphertextHash: string; sizeBytes: number }>();
    const payloadMissing: PendingOp[] = [];
    const totalBytes = ops.reduce((sum, op) => sum + op.sizeBytes, 0);
    let doneBytes = 0;
    let doneCount = 0;

    const upload = async (op: PendingOp): Promise<void> => {
      // A missing payload used to mean "drop this edit and tell the
      // person to re-save the file". That is far too harsh: the file is
      // still sitting in the vault, so the envelope can simply be built
      // again from it. Re-derive first, and only give up on an edit
      // whose file has genuinely gone.
      let bytes = await queue.readPayload(op.idempotencyKey);
      if (!bytes) bytes = await this.rebuildPayload(op, rebuilt);
      if (!bytes) {
        payloadMissing.push(op);
      } else {
        try {
          // The key is generated here rather than asked for. The server's
          // old upload-slot endpoint did nothing but return a random id,
          // so it cost a whole extra round trip per file to learn a value
          // this side could just as well pick; the PUT validates that the
          // key belongs to this vault either way.
          const blobKey = `${vaultId}/${crypto.randomUUID()}`;
          await api.putBlobAt(vaultId, blobKey, bytes);
          blobKeys.set(op.idempotencyKey, blobKey);
        } catch (err) {
          // Leave it queued and unuploaded - the commit phase skips it
          // and the next cycle tries again.
          console.error(`Synora: upload failed for "${op.logicalPath}"`, err);
        }
      }
      doneCount++;
      doneBytes += op.sizeBytes;
      onProgress?.({ doneCount, totalCount: ops.length, doneBytes, totalBytes });
    };

    // Big attachments go one at a time: four 25MB uploads in flight
    // means 100MB of buffers held at once, which is a real risk on a
    // phone. Notes are small enough that the round trip dominates, so
    // those are the ones worth overlapping.
    const large = ops.filter((op) => op.sizeBytes > LARGE_UPLOAD_BYTES);
    const small = ops.filter((op) => op.sizeBytes <= LARGE_UPLOAD_BYTES);
    await runWithConcurrency(large, 1, upload);
    await runWithConcurrency(small, UPLOAD_CONCURRENCY, upload);

    for (const op of payloadMissing) {
      // Its payload is gone, so this op can never be sent - retrying it
      // would just block the queue behind it forever.
      console.error(`Synora: dropping "${op.logicalPath}" - its queued payload is missing`);
      await queue.remove(op.idempotencyKey);
      failed.push(op.logicalPath);
    }

    for (const op of ops) {
      const blobKey = blobKeys.get(op.idempotencyKey);
      if (!blobKey) continue; // never uploaded; stays queued for next cycle
      try {
        // No payload read here on purpose. The bytes are already in R2
        // and committing only needs the key, hash and size - and a
        // rebuilt payload was never written back to the queue, so
        // reading one would skip exactly the ops that just recovered.
        const result = await api.commit(vaultId, {
          fileId: op.fileId,
          baseVersionId: op.baseVersionId,
          parentVersionIds: op.parentVersionIds,
          blobKey,
          ciphertextHash: rebuilt.get(op.idempotencyKey)?.ciphertextHash ?? op.ciphertextHash,
          sizeBytes: rebuilt.get(op.idempotencyKey)?.sizeBytes ?? op.sizeBytes,
          operation: op.operation,
          idempotencyKey: op.idempotencyKey,
        });

        if (result.status === "committed") {
          if (op.operation === "deleted") {
            // The file is gone, so keeping a record for its path would
            // leave the next file created there inheriting this one's
            // fileId and base version.
            await this.deps.state.remove(op.logicalPath);
          } else {
            await this.deps.state.upsert({
              fileId: result.fileId,
              logicalPath: op.logicalPath,
              currentVersionId: result.versionId,
              contentHash: (await this.deps.state.getByPath(op.logicalPath))?.contentHash ?? "",
            });
          }
          await queue.remove(op.idempotencyKey);
          continue;
        }

        // Conflict: someone else moved this file forward. Safe default is
        // to preserve both - download the winning remote version into the
        // vault at its normal path, and re-file our pending edit as an
        // explicit conflict copy rather than attempting a blind overwrite.
        // Fetched only here, on the uncommon path, since resolving is
        // the one thing that needs the plaintext side of the edit. A
        // rebuilt payload is not in the queue, so rebuild again rather
        // than abandoning a conflict we are able to resolve.
        const localPayload =
          (await queue.readPayload(op.idempotencyKey)) ?? (await this.rebuildPayload(op, rebuilt));
        if (!localPayload) continue;
        await this.resolveConflict(op, localPayload, result.currentFileId, result.currentVersionId);
      } catch (err) {
        console.error(`Synora: could not sync "${op.logicalPath}"`, err);
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          await queue.remove(op.idempotencyKey);
          failed.push(op.logicalPath);
        }
        // Anything else (network failure, 5xx) is transient - leave it
        // queued to retry next cycle rather than dropping real work.
      }
    }

    return { failed };
  }

  private async resolveConflict(
    op: PendingOp,
    localPayload: Uint8Array,
    remoteFileId: string,
    remoteVersionId: string | null,
  ): Promise<void> {
    const { api, vaultId, vaultKey, queue, state, vault, suppressor } = this.deps;
    if (!remoteVersionId) {
      await this.fileAsConflictCopy(op, localPayload);
      return;
    }

    const remoteVersion = await this.lookupVersion(remoteVersionId);
    if (!remoteVersion?.blobKey) {
      await this.fileAsConflictCopy(op, localPayload);
      return;
    }

    const localManifest = decodeManifest(decryptEnvelope(vaultKey, decodeEnvelope(localPayload)));

    // The remote version may have moved the file. Both branches below
    // write at *our* path and repoint the local record there, so a copy
    // this device already wrote at the remote's path would be left
    // behind with nothing referencing it - orphaned on disk, and
    // present on this device only, so the vaults never agree again.
    //
    // pull() has always cleaned this up when applying a plain remote
    // rename; resolving a conflict reaches the same situation by a
    // different route and was missing it. Found by the multi-device
    // simulation, where one device ended up holding a file that the
    // device which created it did not.
    const stale = await state.findByFileId(remoteFileId);
    if (stale && stale.logicalPath !== op.logicalPath) {
      suppressor.markApplied(stale.logicalPath, DELETION_MARK);
      await vault.delete(stale.logicalPath);
      await state.remove(stale.logicalPath);
    }

    // Our edit raced a delete made somewhere else.
    //
    // A delete can be redone in a second; writing that someone did not
    // get to sync cannot be recovered once it is gone. So the edit
    // wins: the file comes back carrying our content, committed on top
    // of the tombstone, and that resurrection propagates to the device
    // that deleted it. Merging here instead would be worse than it
    // sounds - the tombstone's payload is empty, so the "merge" is our
    // text against nothing, which ends up writing an empty file over
    // the note and shunting the real content into a conflict copy.
    if (remoteVersion.deletedAt) {
      if (op.operation === "deleted") {
        // Both sides deleted it. Nothing to reconcile and nothing to
        // keep - just stop trying to re-send ours.
        await queue.remove(op.idempotencyKey);
        await state.remove(op.logicalPath);
        return;
      }
      await this.resurrectOverDelete(op, localManifest.content, remoteFileId, remoteVersionId);
      return;
    }

    const remoteManifest = decodeManifest(
      decryptEnvelope(vaultKey, decodeEnvelope(await api.getObject(vaultId, remoteVersion.blobKey))),
    );

    const merged = await this.tryTextMerge(op, remoteManifest.content, localManifest.content);
    if (merged) {
      // The merge is committed at the path the REMOTE version names,
      // not ours.
      //
      // Reaching here means our commit already lost a race, and if the
      // edit that lost was a rename then our path is one the server
      // never accepted. Committing the merge there would quietly
      // perform that rename a second time, on top of the merge - and
      // that commit can lose a race of its own, leaving the file
      // stranded at a path only this device knows about while everyone
      // else converges elsewhere. Adopting the remote's path means
      // there is no second rename to lose.
      //
      // The cost is that a rename which loses a race is dropped while
      // its content is still merged. That is the right way round: the
      // writing survives, and moving the file again is one action.
      const targetPath = remoteManifest.logicalPath;
      const hash = toHex(sha256(merged));
      suppressor.markApplied(targetPath, hash);
      await vault.write(targetPath, merged);

      const manifestBytes = encodeManifest({ fileId: remoteFileId, logicalPath: targetPath, content: merged });
      const envelope = encodeEnvelope(encryptEnvelope(vaultKey, vaultId, remoteFileId, contextFor(targetPath), manifestBytes));
      await queue.remove(op.idempotencyKey);
      await queue.enqueue({
        idempotencyKey: crypto.randomUUID(),
        logicalPath: targetPath,
        fileId: remoteFileId,
        baseVersionId: remoteVersionId,
        // Both sides this merge joins. tryTextMerge only returns
        // content when op.baseVersionId exists, so the local parent is
        // always known here.
        parentVersionIds: [remoteVersionId, op.baseVersionId!],
        operation: "updated",
        ciphertextHash: toHex(sha256(envelope)),
        sizeBytes: envelope.byteLength,
        enqueuedAt: Date.now(),
      }, envelope);
      await state.upsert({ fileId: remoteFileId, logicalPath: targetPath, currentVersionId: remoteVersionId, contentHash: hash });

      // Our losing rename's target is now referenced by nothing.
      if (op.logicalPath !== targetPath) {
        suppressor.markApplied(op.logicalPath, DELETION_MARK);
        await vault.delete(op.logicalPath);
        await state.remove(op.logicalPath);
      }
      return;
    }

    // No clean merge (binary content, missing base, or genuinely
    // overlapping edits) - preserve the remote version at its normal path.
    //
    // That path is the one the remote version names, which is not
    // necessarily ours: if the edit that just lost was a rename, we
    // wanted the file somewhere the server never accepted. Writing the
    // remote content at our path instead - which is what this did -
    // leaves the device permanently disagreeing with the server about
    // where the file lives, and nothing corrects it unless that same
    // file happens to change again later. The comment above was right
    // and the code underneath it was not.
    const remotePath = remoteManifest.logicalPath;
    const hash = toHex(sha256(remoteManifest.content));
    suppressor.markApplied(remotePath, hash);
    await vault.write(remotePath, remoteManifest.content);
    await state.upsert({ fileId: remoteFileId, logicalPath: remotePath, currentVersionId: remoteVersionId, contentHash: hash });

    await this.fileAsConflictCopy(op, localPayload);

    // Our rename lost, so the path we had moved the file to is now
    // neither where the remote version lives nor the conflict copy. Left
    // alone it is an orphan only this device can see.
    if (op.logicalPath !== remotePath) {
      suppressor.markApplied(op.logicalPath, DELETION_MARK);
      await vault.delete(op.logicalPath);
      await state.remove(op.logicalPath);
    }
  }

  // A version that's genuinely gone just means we can't merge against
  // it and fall back to preserving both sides, so that's not an error.
  private async lookupVersion(versionId: string) {
    try {
      return await this.deps.api.getVersion(this.deps.vaultId, versionId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  // Attempts a three-way text merge. Returns the merged bytes on a clean
  // (non-conflicting) merge, or undefined if a merge isn't possible or
  // isn't safe - the caller then falls back to preserving both versions.
  private async tryTextMerge(
    op: PendingOp,
    remoteContent: Uint8Array,
    localContent: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    if (!isTextPath(op.logicalPath) || !op.baseVersionId) return undefined;
    const { api, vaultId, vaultKey } = this.deps;

    const baseVersion = await this.lookupVersion(op.baseVersionId);
    if (!baseVersion?.blobKey) return undefined;

    const baseManifest = decodeManifest(
      decryptEnvelope(vaultKey, decodeEnvelope(await api.getObject(vaultId, baseVersion.blobKey))),
    );

    const decoder = new TextDecoder();
    const result = mergeText(decoder.decode(baseManifest.content), decoder.decode(localContent), decoder.decode(remoteContent));
    if (result.hasConflict) return undefined;
    return new TextEncoder().encode(result.lines.join("\n"));
  }

  // Re-commits our content on top of the tombstone so the file comes
  // back. The queued op's own envelope cannot be reused: its manifest
  // was sealed with whatever fileId this device knew at the time, and
  // the fileId is part of the envelope's authenticated data, so it has
  // to be re-encrypted against the one the server kept.
  private async resurrectOverDelete(
    op: PendingOp,
    content: Uint8Array,
    remoteFileId: string,
    tombstoneVersionId: string,
  ): Promise<void> {
    const { vaultId, vaultKey, queue, state, vault, suppressor } = this.deps;

    const hash = toHex(sha256(content));
    suppressor.markApplied(op.logicalPath, hash);
    await vault.write(op.logicalPath, content);

    const manifestBytes = encodeManifest({ fileId: remoteFileId, logicalPath: op.logicalPath, content });
    const envelope = encodeEnvelope(encryptEnvelope(vaultKey, vaultId, remoteFileId, contextFor(op.logicalPath), manifestBytes));
    await queue.remove(op.idempotencyKey);
    await queue.enqueue(
      {
        idempotencyKey: crypto.randomUUID(),
        logicalPath: op.logicalPath,
        fileId: remoteFileId,
        baseVersionId: tombstoneVersionId,
        operation: "updated",
        ciphertextHash: toHex(sha256(envelope)),
        sizeBytes: envelope.byteLength,
        enqueuedAt: Date.now(),
      },
      envelope,
    );
    await state.upsert({
      fileId: remoteFileId,
      logicalPath: op.logicalPath,
      currentVersionId: tombstoneVersionId,
      contentHash: hash,
    });
  }

  private async fileAsConflictCopy(op: PendingOp, localPayload: Uint8Array): Promise<void> {
    const { vaultKey, queue, state, vault, suppressor } = this.deps;
    // File our edit as a sibling conflict copy instead of retrying against
    // the (now also stale) base - the user reconciles the two by hand.
    // The queued envelope's plaintext manifest still has the *old* path
    // baked in (it's part of the encrypted payload, not just a queue
    // field), so this re-encrypts a fresh envelope under the new path
    // rather than just renaming the queue entry.
    const ownContent = decodeManifest(decryptEnvelope(vaultKey, decodeEnvelope(localPayload))).content;
    const copyPath = conflictPath(op.logicalPath);
    const copyHash = toHex(sha256(ownContent));
    suppressor.markApplied(copyPath, copyHash);
    await vault.write(copyPath, ownContent);

    const copyManifest = encodeManifest({ fileId: "", logicalPath: copyPath, content: ownContent });
    const copyEnvelope = encodeEnvelope(encryptEnvelope(vaultKey, this.deps.vaultId, copyPath, contextFor(copyPath), copyManifest));
    await queue.remove(op.idempotencyKey);
    await queue.enqueue({
      idempotencyKey: crypto.randomUUID(),
      logicalPath: copyPath,
      operation: "created",
      ciphertextHash: toHex(sha256(copyEnvelope)),
      sizeBytes: copyEnvelope.byteLength,
      enqueuedAt: Date.now(),
    }, copyEnvelope);
    await state.upsert({ fileId: "", logicalPath: copyPath, currentVersionId: null, contentHash: copyHash });
  }

  // --- Incoming: remote change feed -> decrypt, apply, ack ---------------

  // Returns the paths of any changes that failed to apply (e.g. a
  // filename with characters illegal on this device's filesystem - a
  // real, confirmed case: a file created on macOS, where it's a legal
  // name, failed this exact way on a device that rejects it). Without
  // per-item error handling here, one bad file threw out of the whole
  // loop, aborting *every* change after it - and since `since` never
  // advanced past it, the next pull hit the identical error immediately,
  // permanently blocking sync. Now a failure is skipped (with `since`
  // still advancing past it, so it's never retried into the same dead
  // end) rather than taking down everything behind it in the feed.
  async pull(): Promise<{ skipped: string[]; applied: number }> {
    const { api, vaultId, vaultKey, state, vault, suppressor } = this.deps;
    let since = await state.getLastAppliedSequence();
    const startedAt = since;
    const skipped: string[] = [];
    let applied = 0;

    for (;;) {
      const page = await api.getChanges(vaultId, since);
      for (const change of page.changes) {
        try {
          if (change.operation === "deleted") {
            const record = await state.findByFileId(change.fileId);
            if (record) {
              suppressor.markApplied(record.logicalPath, DELETION_MARK);
              await vault.delete(record.logicalPath);
              await state.remove(record.logicalPath);
            }
          } else if (change.blobKey) {
            const envelopeBytes = await api.getObject(vaultId, change.blobKey);
            // Checked against the hash the change feed declared, before
            // anything is decrypted or written.
            //
            // The AEAD tag already catches a blob that was altered, and
            // the envelope's AAD catches one replayed into a different
            // file's slot - but neither catches an *earlier version of
            // this same file* being served in place of the current one.
            // That blob is authentic and bound to the right slot; only
            // its hash differs from the one the feed named. Silently
            // rolling a note back to an older copy is exactly the kind
            // of loss this system exists to prevent.
            if (change.ciphertextHash && toHex(sha256(envelopeBytes)) !== change.ciphertextHash) {
              throw new Error(
                `Downloaded content for ${change.fileId} does not match the hash the server declared - refusing to apply it`,
              );
            }
            const manifest = decodeManifest(decryptEnvelope(vaultKey, decodeEnvelope(envelopeBytes)));
            const hash = toHex(sha256(manifest.content));

            // The file moved (renamed, or bulk-relocated) since this
            // device last saw it - clean up its stale copy at the old
            // path rather than ending up with it duplicated at both.
            // Keyed on comparing paths, not the operation label, so it's
            // correct whether the change was sent as "renamed" or
            // "updated".
            const previous = await state.findByFileId(change.fileId);
            if (previous && previous.logicalPath !== manifest.logicalPath) {
              suppressor.markApplied(previous.logicalPath, DELETION_MARK);
              await vault.delete(previous.logicalPath);
              await state.remove(previous.logicalPath);
            }

            suppressor.markApplied(manifest.logicalPath, hash);
            await vault.write(manifest.logicalPath, manifest.content);
            await state.upsert({
              fileId: change.fileId,
              logicalPath: manifest.logicalPath,
              currentVersionId: change.versionId,
              contentHash: hash,
            });
          }
        } catch (err) {
          console.error(`Synora: could not apply change for "${change.fileId}"`, err);
          skipped.push(change.fileId);
        }
        applied++;
        since = change.sequence;
        await state.setLastAppliedSequence(since);
      }
      if (!page.hasMore) break;
    }

    // Only when the cursor actually moved. An idle vault would otherwise
    // re-send the same sequence number every interval forever, and since
    // each ack is an authenticated write, that was roughly half of all
    // the database traffic this system produced while doing nothing.
    if (since !== startedAt) {
      await api.ack(vaultId, since).catch(() => {
        // Best-effort: the next status check will simply show a larger
        // pending count until an ack succeeds. Not fatal to correctness.
      });
    }

    return { skipped, applied };
  }
}

