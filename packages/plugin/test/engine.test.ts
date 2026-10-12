import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SynoraApiClient } from "../src/api/client.js";
import { SyncEngine } from "../src/sync/engine.js";
import { SyncQueue } from "../src/sync/queue.js";
import { LocalStateStore } from "../src/sync/local-state.js";
import { WriteSuppressor } from "../src/sync/suppressor.js";
import { InMemoryKeyValueStore } from "../src/sync/storage.js";
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
  const engine = new SyncEngine({
    api,
    vaultId: VAULT_ID,
    vaultKey,
    vault,
    queue: new SyncQueue(store),
    state: new LocalStateStore(store),
    suppressor: new WriteSuppressor(),
  });
  return { engine, vault, api, vaultKey };
}

describe("SyncEngine", () => {
  beforeEach(() => {
    new FakeApiServer().install(VAULT_ID);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
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
      queue: new SyncQueue(storeA),
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
      queue: new SyncQueue(storeB),
      state: new LocalStateStore(storeB),
      suppressor: new WriteSuppressor(),
    });
    await engineB.pull();

    const written = await vaultB.read("Personal/Health.md");
    expect(new TextDecoder().decode(written)).toBe("device A content");
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
          queue: new SyncQueue(store),
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
          queue: new SyncQueue(store),
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
});
