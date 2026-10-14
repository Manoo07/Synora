import type { BlobStore, KeyValueStore } from "./storage.js";

// A pending operation's already-encrypted envelope is held by the
// BlobStore, keyed by idempotencyKey, so a crash between "encrypt" and
// "upload" never loses or re-derives plaintext - we just resume the
// upload from there. See protocol-spec.md §5 and the architecture doc's
// "persist pending operations before relying on network success" rule.
//
// Only this metadata goes in the KeyValueStore, which rewrites itself
// in full on every change; the payload is deliberately not part of it.
export interface PendingOp {
  idempotencyKey: string;
  logicalPath: string;
  fileId?: string;
  baseVersionId?: string;
  // Set only on a merge commit, naming both versions it reconciles.
  // baseVersionId is one of them (the remote side, which is what the
  // server's concurrency check compares against); this records the
  // local side too, so the history shows where a merge actually joined.
  parentVersionIds?: string[];
  operation: "created" | "updated" | "renamed" | "deleted";
  ciphertextHash: string;
  sizeBytes: number;
  enqueuedAt: number;
}

// Only ever read, never written: the shape left behind by versions
// that kept payloads inline. See migrateLegacyPayloads.
interface LegacyPendingOp extends PendingOp {
  envelopeBase64?: string;
}

const QUEUE_KEY = "pendingOps";

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class SyncQueue {
  constructor(private store: KeyValueStore, private blobs: BlobStore) {}

  async list(): Promise<PendingOp[]> {
    return (await this.store.get<PendingOp[]>(QUEUE_KEY)) ?? [];
  }

  // Returns undefined when the payload is gone - treat that op as
  // unsendable rather than retrying it forever.
  async readPayload(idempotencyKey: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(idempotencyKey);
  }

  // Payload first: a crash before the metadata lands leaves an orphaned
  // file, which pruneOrphanedPayloads clears. The reverse order would
  // leave a queued op whose payload never existed, which can never be
  // sent and never drains.
  async enqueue(op: PendingOp, payload: Uint8Array): Promise<void> {
    await this.blobs.put(op.idempotencyKey, payload);
    const ops = await this.list();
    ops.push(op);
    await this.store.set(QUEUE_KEY, ops);
  }

  // Metadata first here, for the same reason in reverse.
  async remove(idempotencyKey: string): Promise<void> {
    const ops = await this.list();
    await this.store.set(QUEUE_KEY, ops.filter((op) => op.idempotencyKey !== idempotencyKey));
    await this.blobs.delete(idempotencyKey);
  }

  // Replaces a queued op in place (e.g. after re-deriving its base version
  // following a conflict) without disturbing FIFO order of the others.
  async replace(idempotencyKey: string, next: PendingOp, payload: Uint8Array): Promise<void> {
    const ops = await this.list();
    const index = ops.findIndex((op) => op.idempotencyKey === idempotencyKey);
    if (index === -1) throw new Error(`No queued op with key ${idempotencyKey}`);
    await this.blobs.put(next.idempotencyKey, payload);
    ops[index] = next;
    await this.store.set(QUEUE_KEY, ops);
    if (next.idempotencyKey !== idempotencyKey) await this.blobs.delete(idempotencyKey);
  }

  // Payloads used to be stored inline, in the key-value store, as
  // `envelopeBase64`. Anything still queued from a version before this
  // one has to be moved across, or it would look exactly like an op
  // whose payload has gone missing and be dropped - losing edits that
  // were sitting un-synced at the moment of the upgrade.
  async migrateLegacyPayloads(): Promise<void> {
    const ops = (await this.store.get<LegacyPendingOp[]>(QUEUE_KEY)) ?? [];
    if (!ops.some((op) => typeof op.envelopeBase64 === "string")) return;

    const migrated: PendingOp[] = [];
    for (const op of ops) {
      const { envelopeBase64, ...rest } = op;
      if (typeof envelopeBase64 === "string" && !(await this.blobs.get(op.idempotencyKey))) {
        await this.blobs.put(op.idempotencyKey, fromBase64(envelopeBase64));
      }
      migrated.push(rest);
    }
    await this.store.set(QUEUE_KEY, migrated);
  }

  // Clears payloads left behind by a crash between the two writes above.
  // Without this they are never referenced again and never deleted.
  async pruneOrphanedPayloads(): Promise<void> {
    const live = new Set((await this.list()).map((op) => op.idempotencyKey));
    for (const key of await this.blobs.keys()) {
      if (!live.has(key)) await this.blobs.delete(key);
    }
  }
}
