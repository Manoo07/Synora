import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SynoraApiClient } from "../src/api/client.js";
import { SyncEngine } from "../src/sync/engine.js";
import { SyncQueue } from "../src/sync/queue.js";
import { LocalStateStore } from "../src/sync/local-state.js";
import { WriteSuppressor, DELETION_MARK } from "../src/sync/suppressor.js";
import { InMemoryKeyValueStore, InMemoryBlobStore } from "../src/sync/storage.js";
import { generateVaultKey } from "../src/crypto/keys.js";
import { MemoryVault } from "./fakes/memory-vault.js";
import { FakeApiServer } from "./fakes/fake-server.js";

const VAULT_ID = "vault-1";
const realFetch = globalThis.fetch;

function buildEngine() {
  const vaultKey = generateVaultKey();
  const api = new SynoraApiClient("http://fake");
  const vault = new MemoryVault();
  const store = new InMemoryKeyValueStore();
  const queue = new SyncQueue(store, new InMemoryBlobStore());
  const engine = new SyncEngine({
    api,
    vaultId: VAULT_ID,
    vaultKey,
    vault,
    queue,
    state: new LocalStateStore(store),
    suppressor: new WriteSuppressor(),
  });
  return { engine, vault, api, vaultKey, queue };
}

describe("SyncEngine", () => {
  beforeEach(() => {
    new FakeApiServer().install(VAULT_ID);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("isTracked distinguishes files the engine has already seen from ones it hasn't", async () => {
    const { engine } = buildEngine();
    expect(await engine.isTracked("note.md")).toBe(false);
    await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("hello"));
    expect(await engine.isTracked("note.md")).toBe(true);
    expect(await engine.isTracked("other.md")).toBe(false);
  });

  it("pendingUploadCount reflects queued-but-not-yet-flushed files", async () => {
    const { engine } = buildEngine();
    expect(await engine.pendingUploadCount()).toBe(0);
    await engine.handleLocalChange("a.md", "created", new TextEncoder().encode("a"));
    await engine.handleLocalChange("b.md", "created", new TextEncoder().encode("b"));
    expect(await engine.pendingUploadCount()).toBe(2);
    await engine.flush();
    expect(await engine.pendingUploadCount()).toBe(0);
  });

  it("uploads a locally created file and the server assigns it a fileId", async () => {
    const { engine } = buildEngine();
    await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("hello"));
    await engine.flush();

    // Queue should be drained after a successful commit.
    const remaining = await (engine as unknown as { deps: { queue: SyncQueue } }).deps.queue.list();
    expect(remaining).toHaveLength(0);
  });

  it("pulling the change feed decrypts and writes the file into a second device's vault", async () => {
    const vaultKey = generateVaultKey();
    const api1 = new SynoraApiClient("http://fake");
    const vaultA = new MemoryVault();
    const storeA = new InMemoryKeyValueStore();
    const engineA = new SyncEngine({
      api: api1,
      vaultId: VAULT_ID,
      vaultKey,
      vault: vaultA,
      queue: new SyncQueue(storeA, new InMemoryBlobStore()),
      state: new LocalStateStore(storeA),
      suppressor: new WriteSuppressor(),
    });

    await engineA.handleLocalChange("Personal/Health.md", "created", new TextEncoder().encode("device A content"));
    await engineA.flush();

    // A second device, sharing the same vault key, pulls the change feed.
    const api2 = new SynoraApiClient("http://fake");
    const vaultB = new MemoryVault();
    const storeB = new InMemoryKeyValueStore();
    const engineB = new SyncEngine({
      api: api2,
      vaultId: VAULT_ID,
      vaultKey,
      vault: vaultB,
      queue: new SyncQueue(storeB, new InMemoryBlobStore()),
      state: new LocalStateStore(storeB),
      suppressor: new WriteSuppressor(),
    });
    await engineB.pull();

    const written = await vaultB.read("Personal/Health.md");
    expect(new TextDecoder().decode(written)).toBe("device A content");
  });

  it("skips a file that fails to write (e.g. illegal filename on this device) without blocking the rest of the pull", async () => {
    const vaultKey = generateVaultKey();
    const api1 = new SynoraApiClient("http://fake");
    const vaultA = new MemoryVault();
    const storeA = new InMemoryKeyValueStore();
    const engineA = new SyncEngine({
      api: api1,
      vaultId: VAULT_ID,
      vaultKey,
      vault: vaultA,
      queue: new SyncQueue(storeA, new InMemoryBlobStore()),
      state: new LocalStateStore(storeA),
      suppressor: new WriteSuppressor(),
    });

    // Device A happily has a file with a colon in the name (legal on
    // its own OS) alongside an ordinary one.
    await engineA.handleLocalChange("Notes/3:45 Meeting.md", "created", new TextEncoder().encode("bad-name content"));
    await engineA.handleLocalChange("Notes/ordinary.md", "created", new TextEncoder().encode("ordinary content"));
    await engineA.flush();

    const api2 = new SynoraApiClient("http://fake");
    const vaultB = new MemoryVault();
    vaultB.failWritesTo.add("Notes/3:45 Meeting.md");
    const storeB = new InMemoryKeyValueStore();
    const engineB = new SyncEngine({
      api: api2,
      vaultId: VAULT_ID,
      vaultKey,
      vault: vaultB,
      queue: new SyncQueue(storeB, new InMemoryBlobStore()),
      state: new LocalStateStore(storeB),
      suppressor: new WriteSuppressor(),
    });

    const result = await engineB.pull();
    expect(result.skipped).toHaveLength(1);
    // The file after the bad one in the feed must still have made it
    // through - this is the actual bug: without per-item handling, one
    // failure used to throw out of the whole loop and take every
    // subsequent change down with it.
    expect(new TextDecoder().decode(await vaultB.read("Notes/ordinary.md"))).toBe("ordinary content");

    // A second pull must not throw or re-report the same failure - the
    // cursor has to have advanced past it, or every future sync cycle
    // would hit the identical error forever.
    const secondResult = await engineB.pull();
    expect(secondResult.skipped).toHaveLength(0);
  });

  it("on a stale commit, preserves the remote version and files the local edit as a conflict copy", async () => {
    const vaultKey = generateVaultKey();
    const makeDeviceEngine = () => {
      const api = new SynoraApiClient("http://fake");
      const vault = new MemoryVault();
      const store = new InMemoryKeyValueStore();
      return {
        engine: new SyncEngine({
          api,
          vaultId: VAULT_ID,
          vaultKey,
          vault,
          queue: new SyncQueue(store, new InMemoryBlobStore()),
          state: new LocalStateStore(store),
          suppressor: new WriteSuppressor(),
        }),
        vault,
      };
    };

    const a = makeDeviceEngine();
    const b = makeDeviceEngine();

    // Both devices start from the same base: create, then sync A to pick
    // up the server-assigned fileId/versionId before B diverges.
    await a.engine.handleLocalChange("note.md", "created", new TextEncoder().encode("base"));
    await a.engine.flush();
    await b.engine.pull();

    // Device A edits and commits first.
    await a.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("device A edit"));
    await a.engine.flush();

    // Device B, still on the base version, edits and tries to commit -
    // the server rejects it as stale.
    await b.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("device B edit"));
    await b.engine.flush();

    expect(new TextDecoder().decode(await b.vault.read("note.md"))).toBe("device A edit");
    const conflictPaths = [...b.vault.files.keys()].filter((p) => p.includes("conflict"));
    expect(conflictPaths).toHaveLength(1);
    expect(new TextDecoder().decode(await b.vault.read(conflictPaths[0]!))).toBe("device B edit");
  });

  it("on a stale commit with disjoint text edits, merges automatically instead of forking a conflict copy", async () => {
    const vaultKey = generateVaultKey();
    const makeDeviceEngine = () => {
      const api = new SynoraApiClient("http://fake");
      const vault = new MemoryVault();
      const store = new InMemoryKeyValueStore();
      return {
        engine: new SyncEngine({
          api,
          vaultId: VAULT_ID,
          vaultKey,
          vault,
          queue: new SyncQueue(store, new InMemoryBlobStore()),
          state: new LocalStateStore(store),
          suppressor: new WriteSuppressor(),
        }),
        vault,
        api,
      };
    };

    const a = makeDeviceEngine();
    const b = makeDeviceEngine();
    const base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";

    await a.engine.handleLocalChange("note.md", "created", new TextEncoder().encode(base));
    await a.engine.flush();
    await b.engine.pull();

    // A edits the first paragraph; B (still on the base version) edits
    // the second. The edits don't overlap, so this should merge cleanly.
    const localA = "# Title\n\nFirst paragraph EDITED BY A.\n\nSecond paragraph.";
    await a.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode(localA));
    await a.engine.flush();

    const localB = "# Title\n\nFirst paragraph.\n\nSecond paragraph EDITED BY B.";
    await b.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode(localB));
    await b.engine.flush();

    const merged = new TextDecoder().decode(await b.vault.read("note.md"));
    expect(merged).toBe("# Title\n\nFirst paragraph EDITED BY A.\n\nSecond paragraph EDITED BY B.");
    expect([...b.vault.files.keys()].some((p) => p.includes("conflict"))).toBe(false);

    // The merge itself should also be committed as a real new version, not
    // just applied locally - flush the merge op and confirm it lands.
    await b.engine.flush();
    const changes = await b.api.getChanges(VAULT_ID, 0, 500);
    expect(changes.changes.at(-1)?.operation).toBe("updated");
  });

  it("syncs a rename without duplicating the file at its old path on another device", async () => {
    const vaultKey = generateVaultKey();
    const makeDeviceEngine = () => {
      const api = new SynoraApiClient("http://fake");
      const vault = new MemoryVault();
      const store = new InMemoryKeyValueStore();
      return {
        engine: new SyncEngine({
          api,
          vaultId: VAULT_ID,
          vaultKey,
          vault,
          queue: new SyncQueue(store, new InMemoryBlobStore()),
          state: new LocalStateStore(store),
          suppressor: new WriteSuppressor(),
        }),
        vault,
      };
    };

    const a = makeDeviceEngine();
    const b = makeDeviceEngine();

    await a.engine.handleLocalChange("Notes/old-name.md", "created", new TextEncoder().encode("hello"));
    await a.engine.flush();
    await b.engine.pull();
    expect(new TextDecoder().decode(await b.vault.read("Notes/old-name.md"))).toBe("hello");

    // Device A renames/moves the file - same fileId, same content, new path.
    await a.engine.handleLocalRename(
      "Notes/old-name.md",
      "Notes/new-name.md",
      new TextEncoder().encode("hello"),
    );
    await a.engine.flush();
    await b.engine.pull();

    expect(new TextDecoder().decode(await b.vault.read("Notes/new-name.md"))).toBe("hello");
    // The whole point: no leftover duplicate at the old path on B.
    expect(b.vault.files.has("Notes/old-name.md")).toBe(false);
  });

  it("coalesces multiple unflushed edits to the same file instead of spuriously conflicting with itself", async () => {
    const { engine, vault, api, queue } = buildEngine();

    await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("v1"));
    await engine.flush(); // establishes a real committed base version

    // Three edits in a row with nothing flushed in between - exactly what
    // happens just by pausing between paragraphs while composing one
    // document (the sync interval defaults to 30s). Before the fix, each
    // of these queued a separate op, all sharing the same now-stale
    // baseVersionId.
    await engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("v2"));
    await engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("v3"));
    await engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("v4"));

    expect(await queue.list()).toHaveLength(1);

    await engine.flush();

    // Fully committed, nothing left pending, and never a real conflict -
    // one device, one file, edited in sequence. (handleLocalChange never
    // writes to the vault itself for local edits - that's Obsidian's job
    // - so this checks the engine's own view: the queue and the server.)
    expect(await queue.list()).toHaveLength(0);
    expect([...vault.files.keys()].some((p) => p.includes("conflict"))).toBe(false);
    const changes = await api.getChanges(VAULT_ID, 0, 500);
    expect(changes.changes).toHaveLength(2);
  });

  it("still merges on a vault whose history has outgrown a single changes page", async () => {
    const vaultKey = generateVaultKey();
    const makeDeviceEngine = () => {
      const api = new SynoraApiClient("http://fake");
      const vault = new MemoryVault();
      const store = new InMemoryKeyValueStore();
      return {
        engine: new SyncEngine({
          api,
          vaultId: VAULT_ID,
          vaultKey,
          vault,
          queue: new SyncQueue(store, new InMemoryBlobStore()),
          state: new LocalStateStore(store),
          suppressor: new WriteSuppressor(),
        }),
        vault,
        api,
      };
    };

    const a = makeDeviceEngine();

    // Push the vault's history past the 500-change page cap that
    // conflict resolution used to scan from sequence 0. Every save is a
    // change event, so a real vault crosses this in days - and once it
    // did, neither the remote version nor the merge base could be found
    // any more and every concurrent edit forked a conflict copy instead
    // of merging.
    for (let i = 0; i < 520; i++) {
      await a.engine.handleLocalChange(`filler-${i}.md`, "created", new TextEncoder().encode(`filler ${i}`));
      await a.engine.flush();
    }

    const b = makeDeviceEngine();
    const base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";
    await a.engine.handleLocalChange("note.md", "created", new TextEncoder().encode(base));
    await a.engine.flush();
    await b.engine.pull();

    const localA = "# Title\n\nFirst paragraph EDITED BY A.\n\nSecond paragraph.";
    await a.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode(localA));
    await a.engine.flush();

    const localB = "# Title\n\nFirst paragraph.\n\nSecond paragraph EDITED BY B.";
    await b.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode(localB));
    await b.engine.flush();

    const merged = new TextDecoder().decode(await b.vault.read("note.md"));
    expect(merged).toBe("# Title\n\nFirst paragraph EDITED BY A.\n\nSecond paragraph EDITED BY B.");
    expect([...b.vault.files.keys()].some((p) => p.includes("conflict"))).toBe(false);
  });

  it("marks a pulled delete as applied so the vault event it fires isn't re-sent", async () => {
    const vaultKey = generateVaultKey();
    const makeDeviceEngine = () => {
      const api = new SynoraApiClient("http://fake");
      const vault = new MemoryVault();
      const store = new InMemoryKeyValueStore();
      const suppressor = new WriteSuppressor();
      return {
        engine: new SyncEngine({
          api,
          vaultId: VAULT_ID,
          vaultKey,
          vault,
          queue: new SyncQueue(store, new InMemoryBlobStore()),
          state: new LocalStateStore(store),
          suppressor,
        }),
        vault,
        suppressor,
      };
    };

    const a = makeDeviceEngine();
    const b = makeDeviceEngine();

    await a.engine.handleLocalChange("note.md", "created", new TextEncoder().encode("hello"));
    await a.engine.flush();
    await b.engine.pull();
    expect(b.vault.files.has("note.md")).toBe(true);

    await a.engine.handleLocalChange("note.md", "deleted");
    await a.engine.flush();
    await b.engine.pull();
    expect(b.vault.files.has("note.md")).toBe(false);

    // Obsidian fires a delete event for the removal the pull just made.
    // That event must be recognised as our own, or it gets committed
    // back as a brand new file (no fileId survives the delete), billing
    // a phantom file, version and blob to the account on every device
    // that receives any delete.
    expect(b.suppressor.shouldSuppress("note.md", DELETION_MARK)).toBe(true);
  });

  it("stops tracking a deleted path so a file recreated there doesn't inherit its identity", async () => {
    const { engine, api } = buildEngine();

    await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("first life"));
    await engine.flush();
    const firstFileId = (await api.getChanges(VAULT_ID, 0)).changes.at(-1)!.fileId;

    await engine.handleLocalChange("note.md", "deleted");
    await engine.flush();

    await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("second life"));
    await engine.flush();

    const changes = (await api.getChanges(VAULT_ID, 0)).changes;
    expect(changes.at(-1)!.operation).toBe("created");
    // Reusing the dead file's id would commit the new file as another
    // version of the one just deleted, resurrecting it rather than
    // creating a file.
    expect(changes.at(-1)!.fileId).not.toBe(firstFileId);
  });

  it("never sends an empty-string fileId for a second edit to a not-yet-synced file", async () => {
    const { engine, queue } = buildEngine();

    // Neither edit has flushed, so the file has no real fileId yet -
    // local state still has to store *something* for "unknown" (it
    // persists "" rather than leaving the field absent), and that stored
    // "" must never leak back out into an outgoing op. The real backend
    // validates a *present* fileId as a UUID, so a leaked "" fails with
    // an opaque "Invalid uuid" - confirmed live.
    await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("v1"));
    await engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("v2"));

    const pending = await queue.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fileId).toBeUndefined();
  });

  it("flush() drops a permanently-invalid op instead of blocking every other queued edit behind it", async () => {
    const { engine, queue, api } = buildEngine();

    // Simulates the real bug's symptom directly - a queued op with a
    // corrupted fileId, as could happen before the fix above. Enqueued
    // first so a real regression (flush() throwing out of the whole
    // loop) would also block the good edit queued right after it.
    await queue.enqueue({
      idempotencyKey: "bad-op",
      logicalPath: "broken.md",
      fileId: "",
      operation: "updated",
      ciphertextHash: "deadbeef",
      sizeBytes: 10,
      enqueuedAt: Date.now(),
    }, new TextEncoder().encode("not a real envelope, but fine for this fake server"));
    await engine.handleLocalChange("ok.md", "created", new TextEncoder().encode("fine"));

    const { failed } = await engine.flush();

    expect(failed).toEqual(["broken.md"]);
    // The bad op is gone (dropped, not stuck retrying forever), and the
    // good one behind it still made it through.
    expect(await queue.list()).toHaveLength(0);
    const changes = await api.getChanges(VAULT_ID, 0, 500);
    expect(changes.changes).toHaveLength(1);
  });
});
