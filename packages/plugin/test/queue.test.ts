import { describe, expect, it } from "vitest";
import { SyncQueue, type PendingOp } from "../src/sync/queue.js";
import { InMemoryKeyValueStore } from "../src/sync/storage.js";

function makeOp(idempotencyKey: string): PendingOp {
  return {
    idempotencyKey,
    logicalPath: "note.md",
    operation: "created",
    envelopeBase64: "",
    ciphertextHash: "hash",
    sizeBytes: 0,
    enqueuedAt: Date.now(),
  };
}

describe("SyncQueue", () => {
  it("persists enqueued ops across store reads (durability)", async () => {
    const store = new InMemoryKeyValueStore();
    const queue = new SyncQueue(store);
    await queue.enqueue(makeOp("op-1"));

    const reloaded = new SyncQueue(store);
    expect((await reloaded.list()).map((op) => op.idempotencyKey)).toEqual(["op-1"]);
  });

  it("removes only the targeted op, preserving FIFO order of the rest", async () => {
    const queue = new SyncQueue(new InMemoryKeyValueStore());
    await queue.enqueue(makeOp("op-1"));
    await queue.enqueue(makeOp("op-2"));
    await queue.enqueue(makeOp("op-3"));

    await queue.remove("op-2");

    expect((await queue.list()).map((op) => op.idempotencyKey)).toEqual(["op-1", "op-3"]);
  });

  it("replace swaps an op in place without disturbing order", async () => {
    const queue = new SyncQueue(new InMemoryKeyValueStore());
    await queue.enqueue(makeOp("op-1"));
    await queue.enqueue(makeOp("op-2"));

    await queue.replace("op-1", { ...makeOp("op-1"), logicalPath: "renamed.md" });

    const ops = await queue.list();
    expect(ops.map((op) => op.idempotencyKey)).toEqual(["op-1", "op-2"]);
    expect(ops[0]!.logicalPath).toBe("renamed.md");
  });
});
