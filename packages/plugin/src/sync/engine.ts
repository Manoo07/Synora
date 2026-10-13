import { sha256 } from "@noble/hashes/sha256";
import { SynoraApiClient } from "../api/client.js";
import { encryptEnvelope, decryptEnvelope, encodeEnvelope, decodeEnvelope } from "../crypto/envelope.js";
import { encodeManifest, decodeManifest } from "../crypto/manifest.js";
import { SyncQueue, type PendingOp } from "./queue.js";
import { LocalStateStore } from "./local-state.js";
import { WriteSuppressor } from "./suppressor.js";
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

function conflictPath(path: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dot = path.lastIndexOf(".");
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? "" : path.slice(dot);
  return `${stem} (conflict ${ts})${ext}`;
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
    const fileId = existing?.fileId;
    const bytes = content ?? new Uint8Array(0);
    const contentHash = toHex(sha256(bytes));

    // Nothing actually changed (e.g. a write we applied ourselves slipped
    // past the suppressor, or the file was saved with identical bytes).
    if (existing && existing.contentHash === contentHash && operation === "updated") return;

    const manifestBytes = encodeManifest({ fileId: fileId ?? "", logicalPath: path, content: bytes });
    const envelope = encryptEnvelope(vaultKey, vaultId, fileId ?? path, "file-content", manifestBytes);
    const encoded = encodeEnvelope(envelope);
    const ciphertextHash = toHex(sha256(encoded));

    const op: PendingOp = {
      idempotencyKey: crypto.randomUUID(),
      logicalPath: path,
      fileId,
      baseVersionId: existing?.currentVersionId ?? undefined,
      operation,
      envelopeBase64: toBase64(encoded),
      ciphertextHash,
      sizeBytes: encoded.byteLength,
      enqueuedAt: Date.now(),
    };
    await queue.enqueue(op);
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

  async flush(): Promise<void> {
    const { api, vaultId, queue } = this.deps;
    for (const op of await queue.list()) {
      const bytes = fromBase64(op.envelopeBase64);
      const upload = await api.requestUpload(vaultId);
      await api.putBlob(upload.uploadUrl, bytes);

      const result = await api.commit(vaultId, {
        fileId: op.fileId,
        baseVersionId: op.baseVersionId,
        blobKey: upload.uploadId,
        ciphertextHash: op.ciphertextHash,
        sizeBytes: op.sizeBytes,
        operation: op.operation,
        idempotencyKey: op.idempotencyKey,
      });

      if (result.status === "committed") {
        await this.deps.state.upsert({
          fileId: result.fileId,
          logicalPath: op.logicalPath,
          currentVersionId: result.versionId,
          contentHash: (await this.deps.state.getByPath(op.logicalPath))?.contentHash ?? "",
        });
        await queue.remove(op.idempotencyKey);
        continue;
      }

      // Conflict: someone else moved this file forward. Safe default is
      // to preserve both - download the winning remote version into the
      // vault at its normal path, and re-file our pending edit as an
      // explicit conflict copy rather than attempting a blind overwrite.
      await this.resolveConflict(op, result.currentFileId, result.currentVersionId);
    }
  }

  private async resolveConflict(
    op: PendingOp,
    remoteFileId: string,
    remoteVersionId: string | null,
  ): Promise<void> {
    const { api, vaultId, vaultKey, queue, state, vault, suppressor } = this.deps;
    if (!remoteVersionId) {
      await this.fileAsConflictCopy(op);
      return;
    }

    const changes = await api.getChanges(vaultId, 0, 500);
    const remoteChange = changes.changes.find((c) => c.versionId === remoteVersionId);
    if (!remoteChange?.blobKey) {
      await this.fileAsConflictCopy(op);
      return;
    }

    const remoteManifest = decodeManifest(
      decryptEnvelope(vaultKey, decodeEnvelope(await api.getObject(vaultId, remoteChange.blobKey))),
    );
    const localManifest = decodeManifest(decryptEnvelope(vaultKey, decodeEnvelope(fromBase64(op.envelopeBase64))));

    const merged = await this.tryTextMerge(op, changes.changes, remoteManifest.content, localManifest.content);
    if (merged) {
      const hash = toHex(sha256(merged));
      suppressor.markApplied(op.logicalPath, hash);
      await vault.write(op.logicalPath, merged);

      const manifestBytes = encodeManifest({ fileId: remoteFileId, logicalPath: op.logicalPath, content: merged });
      const envelope = encodeEnvelope(encryptEnvelope(vaultKey, vaultId, remoteFileId, "file-content", manifestBytes));
      await queue.remove(op.idempotencyKey);
      await queue.enqueue({
        idempotencyKey: crypto.randomUUID(),
        logicalPath: op.logicalPath,
        fileId: remoteFileId,
        baseVersionId: remoteVersionId,
        operation: "updated",
        envelopeBase64: toBase64(envelope),
        ciphertextHash: toHex(sha256(envelope)),
        sizeBytes: envelope.byteLength,
        enqueuedAt: Date.now(),
      });
      await state.upsert({ fileId: remoteFileId, logicalPath: op.logicalPath, currentVersionId: remoteVersionId, contentHash: hash });
      return;
    }

    // No clean merge (binary content, missing base, or genuinely
    // overlapping edits) - preserve the remote version at its normal path.
    const hash = toHex(sha256(remoteManifest.content));
    suppressor.markApplied(op.logicalPath, hash);
    await vault.write(op.logicalPath, remoteManifest.content);
    await state.upsert({ fileId: remoteFileId, logicalPath: op.logicalPath, currentVersionId: remoteVersionId, contentHash: hash });

    await this.fileAsConflictCopy(op);
  }

  // Attempts a three-way text merge. Returns the merged bytes on a clean
  // (non-conflicting) merge, or undefined if a merge isn't possible or
  // isn't safe - the caller then falls back to preserving both versions.
  private async tryTextMerge(
    op: PendingOp,
    changes: Array<{ versionId: string | null; blobKey: string | null }>,
    remoteContent: Uint8Array,
    localContent: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    if (!isTextPath(op.logicalPath) || !op.baseVersionId) return undefined;
    const { api, vaultId, vaultKey } = this.deps;

    const baseChange = changes.find((c) => c.versionId === op.baseVersionId);
    if (!baseChange?.blobKey) return undefined;

    const baseManifest = decodeManifest(
      decryptEnvelope(vaultKey, decodeEnvelope(await api.getObject(vaultId, baseChange.blobKey))),
    );

    const decoder = new TextDecoder();
    const result = mergeText(decoder.decode(baseManifest.content), decoder.decode(localContent), decoder.decode(remoteContent));
    if (result.hasConflict) return undefined;
    return new TextEncoder().encode(result.lines.join("\n"));
  }

  private async fileAsConflictCopy(op: PendingOp): Promise<void> {
    const { vaultKey, queue, state, vault, suppressor } = this.deps;
    // File our edit as a sibling conflict copy instead of retrying against
    // the (now also stale) base - the user reconciles the two by hand.
    // The queued envelope's plaintext manifest still has the *old* path
    // baked in (it's part of the encrypted payload, not just a queue
    // field), so this re-encrypts a fresh envelope under the new path
    // rather than just renaming the queue entry.
    const ownContent = decodeManifest(decryptEnvelope(vaultKey, decodeEnvelope(fromBase64(op.envelopeBase64)))).content;
    const copyPath = conflictPath(op.logicalPath);
    const copyHash = toHex(sha256(ownContent));
    suppressor.markApplied(copyPath, copyHash);
    await vault.write(copyPath, ownContent);

    const copyManifest = encodeManifest({ fileId: "", logicalPath: copyPath, content: ownContent });
    const copyEnvelope = encodeEnvelope(encryptEnvelope(vaultKey, this.deps.vaultId, copyPath, "file-content", copyManifest));
    await queue.remove(op.idempotencyKey);
    await queue.enqueue({
      idempotencyKey: crypto.randomUUID(),
      logicalPath: copyPath,
      operation: "created",
      envelopeBase64: toBase64(copyEnvelope),
      ciphertextHash: toHex(sha256(copyEnvelope)),
      sizeBytes: copyEnvelope.byteLength,
      enqueuedAt: Date.now(),
    });
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
  async pull(): Promise<{ skipped: string[] }> {
    const { api, vaultId, vaultKey, state, vault, suppressor } = this.deps;
    let since = await state.getLastAppliedSequence();
    const skipped: string[] = [];

    for (;;) {
      const page = await api.getChanges(vaultId, since);
      for (const change of page.changes) {
        try {
          if (change.operation === "deleted") {
            const record = await state.findByFileId(change.fileId);
            if (record) {
              await vault.delete(record.logicalPath);
              await state.remove(record.logicalPath);
            }
          } else if (change.blobKey) {
            const envelopeBytes = await api.getObject(vaultId, change.blobKey);
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
        since = change.sequence;
        await state.setLastAppliedSequence(since);
      }
      if (!page.hasMore) break;
    }

    await api.ack(vaultId, since).catch(() => {
      // Best-effort: the next status check will simply show a larger
      // pending count until an ack succeeds. Not fatal to correctness.
    });

    return { skipped };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
