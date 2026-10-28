import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SynoraApiClient } from "../src/api/client.js";
import { SyncEngine } from "../src/sync/engine.js";
import { SyncQueue } from "../src/sync/queue.js";
import { LocalStateStore } from "../src/sync/local-state.js";
import { WriteSuppressor } from "../src/sync/suppressor.js";
import { InMemoryKeyValueStore, InMemoryBlobStore } from "../src/sync/storage.js";
import { generateVaultKey } from "../src/crypto/keys.js";
import { MemoryVault } from "./fakes/memory-vault.js";
import { FakeApiServer } from "./fakes/fake-server.js";

// Several simulated devices editing one vault at once, with edits made
// while "offline", renames, deletes and dropped connections thrown in.
//
// Every bug this system has shipped was found by hitting it with
// realistic volume rather than by a hand-written case: the merge
// dropping an edit around repeated lines, merging dying once a vault
// outgrew one page of history, collection going quadratic for want of
// an index. None of them had a failing test until after they had
// already reached someone. Example-based tests encode the cases we
// thought of; this encodes the shape of the problem and lets a seed
// find the rest.
//
// Seeded, so a failure reproduces exactly: the seed is printed with it.

const VAULT_ID = "vault-1";
const realFetch = globalThis.fetch;

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Device {
  name: string;
  engine: SyncEngine;
  vault: MemoryVault;
  queue: SyncQueue;
}

function makeDevice(name: string, vaultKey: Uint8Array): Device {
  const store = new InMemoryKeyValueStore();
  const vault = new MemoryVault();
  const queue = new SyncQueue(store, new InMemoryBlobStore());
  const engine = new SyncEngine({
    api: new SynoraApiClient("http://fake"),
    vaultId: VAULT_ID,
    vaultKey,
    vault,
    queue,
    state: new LocalStateStore(store),
    suppressor: new WriteSuppressor(),
  });
  return { name, engine, vault, queue };
}

const text = (s: string) => new TextEncoder().encode(s);
const read = (v: MemoryVault, p: string) => new TextDecoder().decode(v.files.get(p)!);

// A note built from numbered lines. Edits change one line in the middle,
// which is both the commonest real edit and the shape that produced the
// worst bug so far.
function body(file: string, marks: string[]): string {
  return [`# ${file}`, "", ...marks, "", "end"].join("\n");
}

function snapshot(vault: MemoryVault): Map<string, string> {
  return new Map([...vault.files.entries()].map(([p, b]) => [p, new TextDecoder().decode(b)]));
}

// Drives every device to a standstill: flush what it has, pull what it
// does not, repeat until a full round changes nothing anywhere. Sync is
// interleaved rather than one device at a time, because a device that
// always went last would never experience a conflict.
async function settle(devices: Device[], rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of devices) {
      await d.engine.flush();
      await d.engine.pull();
    }
    const pending = await Promise.all(devices.map((d) => d.queue.list()));
    if (pending.every((ops) => ops.length === 0)) {
      // One more pass so the last writer's changes reach everyone.
      for (const d of devices) await d.engine.pull();
      return;
    }
  }
}

describe("multi-device simulation", () => {
  beforeEach(() => {
    new FakeApiServer().install(VAULT_ID);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("converges to one identical vault across devices, over many random histories", async () => {
    // SIM_SEED=n narrows to one history and prints its operations, which
    // is how a failure gets from "some seed broke" to a sequence you can
    // read. Every step is logged in order: who did what, to which file.
    const only = process.env.SIM_SEED ? Number(process.env.SIM_SEED) : null;
    for (let seed = only ?? 0; seed <= (only ?? 399); seed++) {
      new FakeApiServer().install(VAULT_ID);
      const rng = mulberry32(seed * 7919 + 13);
      const vaultKey = generateVaultKey();
      const devices = [makeDevice("A", vaultKey), makeDevice("B", vaultKey), makeDevice("C", vaultKey)];

      const files = ["notes/one.md", "notes/two.md", "daily/log.md"];
      const seeded = devices[0]!;
      for (const f of files) {
        seeded.vault.files.set(f, text(body(f, ["line a", "line b", "line c"])));
        await seeded.engine.handleLocalChange(f, "created", seeded.vault.files.get(f)!);
      }
      await settle(devices);

      // A run of random activity. Each device works on its own local
      // copy and only sometimes syncs - which is what being offline
      // actually looks like from the engine's point of view.
      for (let step = 0; step < 40; step++) {
        const d = devices[Math.floor(rng() * devices.length)]!;
        const file = files[Math.floor(rng() * files.length)]!;
        const roll = rng();

        if (roll < 0.55) {
          // Edit a line in the middle, where merges are hardest.
          const existing = d.vault.files.get(file);
          if (!existing) continue;
          const lines = new TextDecoder().decode(existing).split("\n");
          const idx = 2 + Math.floor(rng() * Math.max(1, lines.length - 4));
          lines[idx] = `${d.name}-${step}`;
          const next = text(lines.join("\n"));
          d.vault.files.set(file, next);
          if (only !== null) console.log(`${step} ${d.name} edit ${file}`);
          await d.engine.handleLocalChange(file, "updated", next);
        } else if (roll < 0.68) {
          const existing = d.vault.files.get(file);
          if (!existing) continue;
          d.vault.files.delete(file);
          if (only !== null) console.log(`${step} ${d.name} delete ${file}`);
          await d.engine.handleLocalChange(file, "deleted");
        } else if (roll < 0.78) {
          const existing = d.vault.files.get(file);
          if (!existing) continue;
          const moved = `moved/${d.name}-${step}.md`;
          d.vault.files.delete(file);
          d.vault.files.set(moved, existing);
          if (only !== null) console.log(`${step} ${d.name} rename ${file} -> ${moved}`);
          await d.engine.handleLocalRename(file, moved, existing);
        } else {
          if (only !== null) console.log(`${step} ${d.name} sync`);
          await d.engine.flush();
          await d.engine.pull();
        }
      }

      await settle(devices);

      const [a, b, c] = devices.map((d) => snapshot(d.vault));
      const keys = (m: Map<string, string>) => [...m.keys()].sort().join("|");
      expect(
        keys(a!) === keys(b!) && keys(b!) === keys(c!),
        `seed ${seed}: devices hold different files\n` +
          devices.map((d, i) => `  ${d.name}: ${keys([a!, b!, c!][i]!)}`).join("\n"),
      ).toBe(true);

      for (const path of a!.keys()) {
        expect(b!.get(path), `seed ${seed}: ${path} differs between A and B`).toBe(a!.get(path));
        expect(c!.get(path), `seed ${seed}: ${path} differs between A and C`).toBe(a!.get(path));
      }
    }
  });

  it("keeps every edit, as the file itself or as a conflict copy", async () => {
    for (let seed = 0; seed < 40; seed++) {
      new FakeApiServer().install(VAULT_ID);
      const rng = mulberry32(seed * 104729 + 7);
      const vaultKey = generateVaultKey();
      const devices = [makeDevice("A", vaultKey), makeDevice("B", vaultKey)];
      const file = "notes/shared.md";

      devices[0]!.vault.files.set(file, text(body(file, ["l1", "l2", "l3", "l4"])));
      await devices[0]!.engine.handleLocalChange(file, "created", devices[0]!.vault.files.get(file)!);
      await settle(devices);

      // Both devices edit while neither is syncing - the offline case.
      const marks: string[] = [];
      for (let step = 0; step < 6; step++) {
        for (const d of devices) {
          const existing = d.vault.files.get(file);
          if (!existing) continue;
          const lines = new TextDecoder().decode(existing).split("\n");
          const mark = `${d.name}-${seed}-${step}`;
          lines[2 + Math.floor(rng() * 2)] = mark;
          marks.push(mark);
          const next = text(lines.join("\n"));
          d.vault.files.set(file, next);
          await d.engine.handleLocalChange(file, "updated", next);
        }
      }

      await settle(devices);

      // A mark can legitimately be overwritten by a later edit on the
      // same device, so only the last one each device actually sent has
      // to survive. Losing that is losing someone's writing.
      const lastPerDevice = devices.map((d) => marks.filter((m) => m.startsWith(`${d.name}-`)).at(-1)!);
      for (const d of devices) {
        const everything = [...d.vault.files.values()].map((b) => new TextDecoder().decode(b)).join("\n");
        for (const mark of lastPerDevice) {
          expect(
            everything.includes(mark),
            `seed ${seed}: ${d.name} lost "${mark}" - not in the file and not in a conflict copy`,
          ).toBe(true);
        }
      }
    }
  });

  it("survives dropped connections without losing or duplicating work", async () => {
    for (let seed = 0; seed < 25; seed++) {
      const server = new FakeApiServer();
      server.install(VAULT_ID);
      const rng = mulberry32(seed * 31337 + 5);

      // Fails a share of requests outright, the way a flaky connection
      // or a restarting server does. Everything should stay queued and
      // go through on a later attempt.
      const underlying = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (rng() < 0.25) throw new Error("simulated network failure");
        return underlying(input as RequestInfo, init);
      }) as typeof fetch;

      const vaultKey = generateVaultKey();
      const devices = [makeDevice("A", vaultKey), makeDevice("B", vaultKey)];
      const file = "notes/flaky.md";

      devices[0]!.vault.files.set(file, text(body(file, ["x1", "x2", "x3"])));
      await devices[0]!.engine.handleLocalChange(file, "created", devices[0]!.vault.files.get(file)!);

      for (let step = 0; step < 10; step++) {
        const d = devices[Math.floor(rng() * devices.length)]!;
        const existing = d.vault.files.get(file);
        if (existing) {
          const lines = new TextDecoder().decode(existing).split("\n");
          lines[2] = `${d.name}-${step}`;
          const next = text(lines.join("\n"));
          d.vault.files.set(file, next);
          await d.engine.handleLocalChange(file, "updated", next);
        }
        await d.engine.flush().catch(() => undefined);
        await d.engine.pull().catch(() => undefined);
      }

      // Connection restored - everything queued must now drain.
      globalThis.fetch = underlying;
      await settle(devices, 20);

      for (const d of devices) {
        expect(await d.queue.list(), `seed ${seed}: ${d.name} never drained its queue`).toHaveLength(0);
      }
      const [a, b] = devices.map((d) => snapshot(d.vault));
      expect([...a!.keys()].sort(), `seed ${seed}: devices disagree on which files exist`).toEqual(
        [...b!.keys()].sort(),
      );
    }
  });
});
