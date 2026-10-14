import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SynoraApiClient } from "../src/api/client.js";
import { SyncEngine } from "../src/sync/engine.js";
import { SyncQueue } from "../src/sync/queue.js";
import { LocalStateStore } from "../src/sync/local-state.js";
import { WriteSuppressor, DELETION_MARK } from "../src/sync/suppressor.js";
import { InMemoryKeyValueStore, InMemoryBlobStore } from "../src/sync/storage.js";
import { generateVaultKey } from "../src/crypto/keys.js";
import { encryptEnvelope, encodeEnvelope, decodeEnvelope } from "../src/crypto/envelope.js";
import { encodeManifest } from "../src/crypto/manifest.js";
import { sha256 } from "@noble/hashes/sha256";

const toHexDigest = (bytes: Uint8Array) =>
  Array.from(sha256(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

    // And it records both versions it reconciled (FR-14). Without this
    // the history shows a merge as an ordinary edit, losing any trace
    // of where two lines of work actually rejoined.
    const mergeVersion = await b.api.getVersion(VAULT_ID, changes.changes.at(-1)!.versionId!);
    expect((mergeVersion as unknown as { parentVersionIds: string[] }).parentVersionIds).toHaveLength(2);
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

  it("does not ack an idle pull, which would be a write per device per interval forever", async () => {
    const { engine } = buildEngine();
    const acks: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/acks")) acks.push(input);
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("hello"));
      await engine.flush();

      await engine.pull(); // applies our own change - cursor moves, ack expected
      expect(acks).toHaveLength(1);

      await engine.pull(); // nothing new
      await engine.pull(); // still nothing
      expect(acks).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("restores an edited note when it loses a race against a delete (SR-7)", async () => {
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

    await a.engine.handleLocalChange("note.md", "created", new TextEncoder().encode("original"));
    await a.engine.flush();
    await b.engine.pull();

    // A deletes it. B, which never saw that, has edited it meanwhile.
    await a.engine.handleLocalChange("note.md", "deleted");
    await a.engine.flush();

    await b.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("edited while offline"));
    await b.engine.flush();

    // The writing survives at its real path - not emptied out, and not
    // shunted into a conflict copy, which is what a merge against the
    // tombstone's empty payload used to produce.
    expect(new TextDecoder().decode(await b.vault.read("note.md"))).toBe("edited while offline");
    expect([...b.vault.files.keys()].some((p) => p.includes("conflict"))).toBe(false);

    // And the resurrection reaches the device that deleted it.
    await b.engine.flush();
    await a.engine.pull();
    expect(new TextDecoder().decode(await a.vault.read("note.md"))).toBe("edited while offline");
  });

  it("drops its own delete when the other side already deleted the same file", async () => {
    const vaultKey = generateVaultKey();
    const makeDeviceEngine = () => {
      const api = new SynoraApiClient("http://fake");
      const vault = new MemoryVault();
      const store = new InMemoryKeyValueStore();
      const queue = new SyncQueue(store, new InMemoryBlobStore());
      return {
        engine: new SyncEngine({
          api,
          vaultId: VAULT_ID,
          vaultKey,
          vault,
          queue,
          state: new LocalStateStore(store),
          suppressor: new WriteSuppressor(),
        }),
        queue,
        vault,
      };
    };

    const a = makeDeviceEngine();
    const b = makeDeviceEngine();

    await a.engine.handleLocalChange("note.md", "created", new TextEncoder().encode("doomed"));
    await a.engine.flush();
    await b.engine.pull();

    await a.engine.handleLocalChange("note.md", "deleted");
    await a.engine.flush();
    await b.engine.handleLocalChange("note.md", "deleted");
    await b.engine.flush();

    // Both wanted it gone, so there is nothing to resurrect and nothing
    // left to retry.
    expect(await b.queue.list()).toHaveLength(0);
    expect([...b.vault.files.keys()].some((p) => p.includes("conflict"))).toBe(false);
  });

  it("refuses downloaded content whose hash does not match the change feed (FR-16)", async () => {
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
    await a.engine.handleLocalChange("note.md", "created", new TextEncoder().encode("draft one"));
    await a.engine.flush();
    await a.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("draft two"));
    await a.engine.flush();
    // B is fully caught up before the tampering, so anything that
    // changes on it afterwards came from the change under test.
    await b.engine.pull();
    expect(new TextDecoder().decode(await b.vault.read("note.md"))).toBe("draft two");

    await a.engine.handleLocalChange("note.md", "updated", new TextEncoder().encode("draft three"));
    await a.engine.flush();

    // Serve the file's OWN earlier blob in place of its current one -
    // a rollback, not corruption. Those bytes are genuinely this
    // vault's, encrypt under the right key and carry AAD naming this
    // very file, so the authentication tag and the AAD check both pass
    // happily. Only the hash the change feed declared tells them apart,
    // and without that check the note silently reverts to the old text.
    const feed = await b.api.getChanges(VAULT_ID, 0);
    const oldBlobKey = feed.changes[0]!.blobKey!;
    const currentBlobKey = feed.changes.at(-1)!.blobKey!;
    const stale = await b.api.getObject(VAULT_ID, oldBlobKey);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(`/objects/${encodeURIComponent(currentBlobKey)}`)) {
        return new Response(stale.slice().buffer as ArrayBuffer, { status: 200 });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    let skipped: string[] = [];
    try {
      ({ skipped } = await b.engine.pull());
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(skipped).toHaveLength(1);
    // Crucially still "draft two" and not "draft one": the rollback was
    // refused rather than written over the newer text.
    expect(new TextDecoder().decode(await b.vault.read("note.md"))).toBe("draft two");
  });

  it("seals attachments under their own encryption context, notes under theirs (FR-12)", async () => {
    const { engine, api } = buildEngine();

    await engine.handleLocalChange("note.md", "created", new TextEncoder().encode("# a note"));
    await engine.handleLocalChange("diagram.png", "created", new Uint8Array([137, 80, 78, 71]));
    await engine.flush();

    const changes = await api.getChanges(VAULT_ID, 0);
    const contexts = new Map<string, string>();
    for (const change of changes.changes) {
      const envelope = decodeEnvelope(await api.getObject(VAULT_ID, change.blobKey!));
      contexts.set(envelope.context, change.blobKey!);
    }

    // Separate contexts feed separate derived keys and distinct AAD, so
    // a flaw in how one kind of content is sealed cannot be turned
    // against the other.
    expect([...contexts.keys()].sort()).toEqual(["attachment", "file-content"]);
  });

  it("still reads blobs written before attachments had their own context", async () => {
    const { engine, vault, vaultKey, api } = buildEngine();

    // Exactly what an older build wrote: a binary file sealed as
    // "file-content". The context travels inside the envelope, so this
    // has to keep decrypting untouched after the change above.
    const content = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const manifest = encodeManifest({ fileId: "", logicalPath: "legacy.png", content });
    const legacy = encodeEnvelope(encryptEnvelope(vaultKey, VAULT_ID, "legacy.png", "file-content", manifest));

    const upload = await api.requestUpload(VAULT_ID);
    await api.putBlob(upload.uploadUrl, legacy);
    await api.commit(VAULT_ID, {
      blobKey: upload.uploadId,
      ciphertextHash: toHexDigest(legacy),
      sizeBytes: legacy.byteLength,
      operation: "created",
      idempotencyKey: crypto.randomUUID(),
    });

    await engine.pull();
    expect(new Uint8Array(await vault.read("legacy.png"))).toEqual(content);
  });

  it("reports work still to come down on a device that has not pulled yet", async () => {
    const vaultKey = generateVaultKey();
    const makeDeviceEngine = () => {
      const api = new SynoraApiClient("http://fake");
      const store = new InMemoryKeyValueStore();
      return new SyncEngine({
        api,
        vaultId: VAULT_ID,
        vaultKey,
        vault: new MemoryVault(),
        queue: new SyncQueue(store, new InMemoryBlobStore()),
        state: new LocalStateStore(store),
        suppressor: new WriteSuppressor(),
      });
    };

    const a = makeDeviceEngine();
    await a.handleLocalChange("one.md", "created", new TextEncoder().encode("1"));
    await a.handleLocalChange("two.md", "created", new TextEncoder().encode("2"));
    await a.flush();

    // Freshly attached: nothing queued to upload, a whole vault still
    // to come down. Reporting only the upload queue here is what made
    // the settings panel say "all files synced" over an empty vault.
    const b = makeDeviceEngine();
    expect(await b.pendingUploadCount()).toBe(0);
    expect(await b.pendingDownloadCount()).toBe(2);

    await b.pull();
    expect(await b.pendingDownloadCount()).toBe(0);
  });

  it("uploads without asking the server for a key first, and overlaps them", async () => {
    const { engine } = buildEngine();
    for (let i = 0; i < 8; i++) {
      await engine.handleLocalChange(`note-${i}.md`, "created", new TextEncoder().encode(`body ${i}`));
    }

    const realFetch = globalThis.fetch;
    let slotRequests = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const isUpload = url.includes("/uploads/");
      // The old slot endpoint: a whole round trip whose only product
      // was a random id this side can pick itself.
      if (url.endsWith("/uploads") && (init?.method ?? "GET") === "POST") slotRequests++;
      if (isUpload) {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      try {
        return await realFetch(input as RequestInfo, init);
      } finally {
        if (isUpload) inFlight--;
      }
    }) as typeof fetch;

    try {
      await engine.flush();
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(slotRequests).toBe(0);
    // Small notes, so they go through the concurrent path rather than
    // the one-at-a-time route reserved for big attachments.
    expect(peakInFlight).toBeGreaterThan(1);
  });

  it("reports upload progress so a long backlog can show an ETA", async () => {
    const { engine } = buildEngine();
    for (let i = 0; i < 5; i++) {
      await engine.handleLocalChange(`note-${i}.md`, "created", new TextEncoder().encode(`body ${i}`));
    }

    const seen: Array<{ doneCount: number; totalCount: number }> = [];
    await engine.flush((p) => seen.push({ doneCount: p.doneCount, totalCount: p.totalCount }));

    expect(seen).toHaveLength(5);
    expect(seen.every((p) => p.totalCount === 5)).toBe(true);
    expect(Math.max(...seen.map((p) => p.doneCount))).toBe(5);
  });

  it("rebuilds a lost payload from the file on disk instead of dropping the edit", async () => {
    const vault = new MemoryVault();
    const store = new InMemoryKeyValueStore();
    const blobs = new InMemoryBlobStore();
    const queue = new SyncQueue(store, blobs);
    const engine = new SyncEngine({
      api: new SynoraApiClient("http://fake"),
      vaultId: VAULT_ID,
      vaultKey: generateVaultKey(),
      vault,
      queue,
      state: new LocalStateStore(store),
      suppressor: new WriteSuppressor(),
    });

    const content = new TextEncoder().encode("the real content");
    vault.files.set("note.md", content);
    await engine.handleLocalChange("note.md", "created", content);

    // The file is still in the vault, but the queued envelope is gone -
    // the shape left behind by anything that clears the plugin's own
    // folder. The content was never at risk, so this must not cost the
    // edit or ask the person to re-save anything.
    for (const key of await blobs.keys()) await blobs.delete(key);

    const { failed } = await engine.flush();

    expect(failed).toEqual([]);
    expect(await queue.list()).toHaveLength(0);
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
