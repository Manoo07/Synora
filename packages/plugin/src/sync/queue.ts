import type { KeyValueStore } from "./storage.js";

// A pending operation holds an already-encrypted envelope (base64, since
// the backing store round-trips through JSON) so a crash between
// "encrypt" and "upload" never loses or re-derives plaintext - we just
// resume the upload from here. See protocol-spec.md §5 and the
// architecture doc's "persist pending operations before relying on
// network success" rule.
export interface PendingOp {
  idempotencyKey: string;
  logicalPath: string;
  fileId?: string;
  baseVersionId?: string;
  operation: "created" | "updated" | "renamed" | "deleted";
  envelopeBase64: string;
  ciphertextHash: string;
  sizeBytes: number;
  enqueuedAt: number;
}

const QUEUE_KEY = "pendingOps";

export class SyncQueue {
  constructor(private store: KeyValueStore) {}

  async list(): Promise<PendingOp[]> {
    return (await this.store.get<PendingOp[]>(QUEUE_KEY)) ?? [];
  }

  async enqueue(op: PendingOp): Promise<void> {
    const ops = await this.list();
    ops.push(op);
    await this.store.set(QUEUE_KEY, ops);
  }

  async remove(idempotencyKey: string): Promise<void> {
    const ops = await this.list();
    await this.store.set(QUEUE_KEY, ops.filter((op) => op.idempotencyKey !== idempotencyKey));
  }

  // Replaces a queued op in place (e.g. after re-deriving its base version
  // following a conflict) without disturbing FIFO order of the others.
  async replace(idempotencyKey: string, next: PendingOp): Promise<void> {
    const ops = await this.list();
    const index = ops.findIndex((op) => op.idempotencyKey === idempotencyKey);
    if (index === -1) throw new Error(`No queued op with key ${idempotencyKey}`);
    ops[index] = next;
    await this.store.set(QUEUE_KEY, ops);
  }
}
