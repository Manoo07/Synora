import { describe, expect, it } from "vitest";
import { SyncQueue, type PendingOp } from "../src/sync/queue.js";
import { InMemoryKeyValueStore, InMemoryBlobStore } from "../src/sync/storage.js";

function makeOp(idempotencyKey: string): PendingOp {
  return {
    idempotencyKey,
    logicalPath: "note.md",
    operation: "created",
    ciphertextHash: "hash",
    sizeBytes: 0,
    enqueuedAt: Date.now(),
  };
}

const payload = (text: string) => new TextEncoder().encode(text);

describe("SyncQueue", () => {
  it("persists enqueued ops across store reads (durability)", async () => {
    const store = new InMemoryKeyValueStore();
    const blobs = new InMemoryBlobStore();
    const queue = new SyncQueue(store, blobs);
    await queue.enqueue(makeOp("op-1"), payload("one"));

    const reloaded = new SyncQueue(store, blobs);
    expect((await reloaded.list()).map((op) => op.idempotencyKey)).toEqual(["op-1"]);
    expect(new TextDecoder().decode(await reloaded.readPayload("op-1"))).toBe("one");
  });

  it("removes only the targeted op, preserving FIFO order of the rest", async () => {
    const queue = new SyncQueue(new InMemoryKeyValueStore(), new InMemoryBlobStore());
    await queue.enqueue(makeOp("op-1"), payload("one"));
    await queue.enqueue(makeOp("op-2"), payload("two"));
    await queue.enqueue(makeOp("op-3"), payload("three"));

    await queue.remove("op-2");

    expect((await queue.list()).map((op) => op.idempotencyKey)).toEqual(["op-1", "op-3"]);
  });

  it("replace swaps an op in place without disturbing order", async () => {
    const queue = new SyncQueue(new InMemoryKeyValueStore(), new InMemoryBlobStore());
    await queue.enqueue(makeOp("op-1"), payload("one"));
    await queue.enqueue(makeOp("op-2"), payload("two"));

    await queue.replace("op-1", { ...makeOp("op-1"), logicalPath: "renamed.md" }, payload("renamed"));

    const ops = await queue.list();
    expect(ops.map((op) => op.idempotencyKey)).toEqual(["op-1", "op-2"]);
    expect(ops[0]!.logicalPath).toBe("renamed.md");
    expect(new TextDecoder().decode(await queue.readPayload("op-1"))).toBe("renamed");
  });

  it("keeps payloads out of the key-value store, which is rewritten in full on every change", async () => {
    const store = new InMemoryKeyValueStore();
    const blobs = new InMemoryBlobStore();
    const queue = new SyncQueue(store, blobs);

    const big = new Uint8Array(3 * 1024 * 1024).fill(65);
    await queue.enqueue(makeOp("op-1"), big);

    // This is what gets re-serialised to disk on every single queue
    // mutation, so the attachment's bytes must not be anywhere in it.
    const serialised = JSON.stringify(await store.get("pendingOps"));
    expect(serialised.length).toBeLessThan(1000);
    expect((await queue.readPayload("op-1"))!.byteLength).toBe(big.byteLength);
  });

  it("drops a payload when its op is removed, rather than leaking it", async () => {
    const blobs = new InMemoryBlobStore();
    const queue = new SyncQueue(new InMemoryKeyValueStore(), blobs);
    await queue.enqueue(makeOp("op-1"), payload("one"));

    await queue.remove("op-1");

    expect(await blobs.keys()).toEqual([]);
  });

  it("migrates payloads left inline by an older version instead of dropping those edits", async () => {
    const store = new InMemoryKeyValueStore();
    const blobs = new InMemoryBlobStore();
    // Exactly what the previous version persisted: the op with its
    // payload inline. On upgrade this must not look like an op whose
    // payload has vanished, or an un-synced edit is silently lost.
    await store.set("pendingOps", [{ ...makeOp("op-1"), envelopeBase64: btoa("still unsent") }]);

    const queue = new SyncQueue(store, blobs);
    await queue.migrateLegacyPayloads();

    expect(new TextDecoder().decode(await queue.readPayload("op-1"))).toBe("still unsent");
    const stored = await store.get<Array<Record<string, unknown>>>("pendingOps");
    expect(stored![0]!.envelopeBase64).toBeUndefined();
    expect((await queue.list()).map((op) => op.idempotencyKey)).toEqual(["op-1"]);
  });

  it("leaves an already-migrated queue untouched", async () => {
    const store = new InMemoryKeyValueStore();
    const blobs = new InMemoryBlobStore();
    const queue = new SyncQueue(store, blobs);
    await queue.enqueue(makeOp("op-1"), payload("current"));

    await queue.migrateLegacyPayloads();

    expect(new TextDecoder().decode(await queue.readPayload("op-1"))).toBe("current");
  });

  it("prunes payloads orphaned by a crash between the queue's two writes", async () => {
    const blobs = new InMemoryBlobStore();
    const queue = new SyncQueue(new InMemoryKeyValueStore(), blobs);
    await queue.enqueue(makeOp("op-1"), payload("one"));
    // A payload written just before the process died, so its op never
    // reached the queue - nothing would ever reference or delete it.
    await blobs.put("op-orphan", payload("leaked"));

    await queue.pruneOrphanedPayloads();

    expect(await blobs.keys()).toEqual(["op-1"]);
  });
});
