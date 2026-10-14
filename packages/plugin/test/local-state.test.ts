import { describe, expect, it } from "vitest";
import { LocalStateStore } from "../src/sync/local-state.js";
import { InMemoryKeyValueStore } from "../src/sync/storage.js";

describe("LocalStateStore", () => {
  it("clear() resets the cursor and the file records together", async () => {
    const state = new LocalStateStore(new InMemoryKeyValueStore());
    await state.upsert({ fileId: "f1", logicalPath: "note.md", currentVersionId: "v1", contentHash: "h" });
    await state.setLastAppliedSequence(877);

    await state.clear();

    // Both matter. A surviving cursor makes the device ask a different
    // vault for changes after a sequence it has not reached, so it
    // concludes there is nothing to download and sits empty; surviving
    // records make it treat that vault's files as already synced.
    expect(await state.getLastAppliedSequence()).toBe(0);
    expect(await state.getByPath("note.md")).toBeUndefined();
  });
});
