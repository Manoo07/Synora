import { describe, expect, it } from "vitest";
import { AdapterBlobStore } from "../src/sync/blob-store.js";
import { MemoryAdapter } from "./fakes/memory-adapter.js";

const DIR = ".obsidian/plugins/synora-sync/pending";
const bytes = (text: string) => new TextEncoder().encode(text);

describe("AdapterBlobStore", () => {
  it("round-trips a payload as its own file, creating the directory on demand", async () => {
    const adapter = new MemoryAdapter();
    const store = new AdapterBlobStore(adapter, DIR);

    await store.put("op-1", bytes("payload one"));

    expect(adapter.files.has(`${DIR}/op-1`)).toBe(true);
    expect(new TextDecoder().decode(await store.get("op-1"))).toBe("payload one");
  });

  it("reports a missing payload as undefined rather than throwing", async () => {
    const store = new AdapterBlobStore(new MemoryAdapter(), DIR);
    expect(await store.get("never-written")).toBeUndefined();
  });

  it("deletes a payload, and tolerates deleting one that is already gone", async () => {
    const store = new AdapterBlobStore(new MemoryAdapter(), DIR);
    await store.put("op-1", bytes("payload"));

    await store.delete("op-1");
    await store.delete("op-1");

    expect(await store.get("op-1")).toBeUndefined();
    expect(await store.keys()).toEqual([]);
  });

  it("lists keys without their directory prefix, so they match op ids", async () => {
    const store = new AdapterBlobStore(new MemoryAdapter(), DIR);
    await store.put("op-1", bytes("a"));
    await store.put("op-2", bytes("b"));

    expect((await store.keys()).sort()).toEqual(["op-1", "op-2"]);
  });

  it("returns no keys when the directory has never been created", async () => {
    const store = new AdapterBlobStore(new MemoryAdapter(), DIR);
    expect(await store.keys()).toEqual([]);
  });

  it("refuses a key that would write outside its own directory", async () => {
    const store = new AdapterBlobStore(new MemoryAdapter(), DIR);
    // Keys are generated UUIDs, so this is a caller bug rather than
    // untrusted input - but it writes to disk by concatenation, so it
    // must not be able to traverse out regardless.
    await expect(store.put("../../escaped", bytes("nope"))).rejects.toThrow(/Unsafe blob key/);
    await expect(store.get("..")).rejects.toThrow(/Unsafe blob key/);
  });
});
