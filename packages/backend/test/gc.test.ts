import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { collectGarbage } from "../src/gc.js";
import { users } from "../src/db/schema.js";
import { resetDb, testBindings, closeTestDb } from "./setup.js";
import { registerUser, createVault, requestUpload, putBlob, commit } from "./helpers.js";
import type { AppBindings } from "../src/context.js";

// Collects immediately rather than after the real retention window, so
// the tests exercise the cursor and supersession rules rather than just
// bouncing off the age check.
const NOW_RETENTION = { retentionDays: 0 };

async function save(
  bindings: AppBindings,
  token: string,
  vaultId: string,
  content: string,
  extra: Record<string, unknown>,
) {
  const upload = await requestUpload(bindings, token, vaultId);
  const blob = await putBlob(bindings, token, upload.uploadUrl, content);
  const res = await commit(bindings, token, vaultId, {
    blobKey: blob.blobKey,
    ciphertextHash: blob.ciphertextHash,
    sizeBytes: blob.sizeBytes,
    idempotencyKey: `op-${Math.random()}`,
    ...extra,
  });
  if (res.status !== 200) throw new Error(`commit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { fileId: string; versionId: string; sequence: number };
}

async function ack(bindings: AppBindings, token: string, vaultId: string, lastSequence: number) {
  const res = await app.request(
    `/v1/vaults/${vaultId}/acks`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ lastSequence }),
    },
    bindings,
  );
  if (res.status !== 200) throw new Error(`ack failed: ${res.status}`);
}

async function changesFromZero(bindings: AppBindings, token: string, vaultId: string) {
  const res = await app.request(
    `/v1/vaults/${vaultId}/changes?since=0&limit=500`,
    { headers: { authorization: `Bearer ${token}` } },
    bindings,
  );
  return (await res.json()) as { changes: Array<{ fileId: string; versionId: string; blobKey: string | null }> };
}

describe("storage reclamation", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("reclaims superseded versions and gives the quota back", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const created = await save(bindings, alice.accessToken, vault.id, "v1", { operation: "created" });
    const second = await save(bindings, alice.accessToken, vault.id, "version two", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: created.versionId,
    });
    const third = await save(bindings, alice.accessToken, vault.id, "version three", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: second.versionId,
    });
    await ack(bindings, alice.accessToken, vault.id, third.sequence);

    const [before] = await bindings.DB.select().from(users).where(eq(users.id, alice.userId));
    const result = await collectGarbage(bindings, NOW_RETENTION);
    const [after] = await bindings.DB.select().from(users).where(eq(users.id, alice.userId));

    // The first two versions are superseded; the third is live.
    expect(result.versionsCollected).toBe(2);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    expect(after!.storageBytesUsed).toBe(before!.storageBytesUsed - result.bytesReclaimed);
  });

  it("never collects a file's current version", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    // One file, saved once, fully acked and well past any retention
    // window. Nothing supersedes it, so it must survive - the database
    // has no foreign key protecting this, only gc.ts's own check.
    const only = await save(bindings, alice.accessToken, vault.id, "the only copy", { operation: "created" });
    await ack(bindings, alice.accessToken, vault.id, only.sequence);

    const result = await collectGarbage(bindings, NOW_RETENTION);

    expect(result.versionsCollected).toBe(0);
    const feed = await changesFromZero(bindings, alice.accessToken, vault.id);
    expect(feed.changes).toHaveLength(1);
    const blob = await bindings.BUCKET.get(feed.changes[0]!.blobKey!);
    expect(blob).not.toBeNull();
  });

  it("leaves a vault reconstructible from sequence zero for a device that has never synced", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    // Three files, one of them edited repeatedly. A brand new device
    // replays the feed from zero to build the vault, so whatever GC
    // leaves behind has to still describe all three.
    const a = await save(bindings, alice.accessToken, vault.id, "note A", { operation: "created" });
    const b = await save(bindings, alice.accessToken, vault.id, "note B", { operation: "created" });
    const c = await save(bindings, alice.accessToken, vault.id, "note C", { operation: "created" });
    let head = a;
    for (const text of ["A2", "A3", "A4"]) {
      head = await save(bindings, alice.accessToken, vault.id, text, {
        operation: "updated",
        fileId: a.fileId,
        baseVersionId: head.versionId,
      });
    }
    await ack(bindings, alice.accessToken, vault.id, head.sequence);

    await collectGarbage(bindings, NOW_RETENTION);

    const feed = await changesFromZero(bindings, alice.accessToken, vault.id);
    const fileIds = new Set(feed.changes.map((change) => change.fileId));
    expect(fileIds).toEqual(new Set([a.fileId, b.fileId, c.fileId]));

    // And every blob the surviving feed points at must still exist, or a
    // new device would fail to materialise that file.
    for (const change of feed.changes) {
      expect(await bindings.BUCKET.get(change.blobKey!)).not.toBeNull();
    }
  });

  it("will not collect anything a device has not acked yet", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const created = await save(bindings, alice.accessToken, vault.id, "v1", { operation: "created" });
    const second = await save(bindings, alice.accessToken, vault.id, "v2", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: created.versionId,
    });
    // Acked only the first change: the device has not yet seen the second,
    // so nothing may be reclaimed out from under it.
    await ack(bindings, alice.accessToken, vault.id, created.sequence);

    const result = await collectGarbage(bindings, NOW_RETENTION);
    expect(result.versionsCollected).toBe(0);
    expect(second.versionId).toBeTruthy();
  });

  it("collects nothing on a vault whose devices have never acked", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const created = await save(bindings, alice.accessToken, vault.id, "v1", { operation: "created" });
    await save(bindings, alice.accessToken, vault.id, "v2", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: created.versionId,
    });

    const result = await collectGarbage(bindings, NOW_RETENTION);
    expect(result.versionsCollected).toBe(0);
  });

  it("respects the retention window even once everything is acked", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const created = await save(bindings, alice.accessToken, vault.id, "v1", { operation: "created" });
    const second = await save(bindings, alice.accessToken, vault.id, "v2", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: created.versionId,
    });
    await ack(bindings, alice.accessToken, vault.id, second.sequence);

    // Default 30 day window: these versions are seconds old.
    const result = await collectGarbage(bindings);
    expect(result.versionsCollected).toBe(0);
  });

  it("removes a deleted file outright once every device has seen the tombstone", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const created = await save(bindings, alice.accessToken, vault.id, "doomed", { operation: "created" });
    const tombstone = await save(bindings, alice.accessToken, vault.id, "", {
      operation: "deleted",
      fileId: created.fileId,
      baseVersionId: created.versionId,
    });
    await ack(bindings, alice.accessToken, vault.id, tombstone.sequence);

    const result = await collectGarbage(bindings, NOW_RETENTION);

    expect(result.filesRemoved).toBe(1);
    // A device syncing for the first time now never learns it existed,
    // which is correct - it has nothing to delete locally.
    const feed = await changesFromZero(bindings, alice.accessToken, vault.id);
    expect(feed.changes).toHaveLength(0);
  });

  it("keeps the version a lagging device is still using as its merge base", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const v1 = await save(bindings, alice.accessToken, vault.id, "v1", { operation: "created" });
    const v2 = await save(bindings, alice.accessToken, vault.id, "v2", {
      operation: "updated",
      fileId: v1.fileId,
      baseVersionId: v1.versionId,
    });
    const v3 = await save(bindings, alice.accessToken, vault.id, "v3", {
      operation: "updated",
      fileId: v1.fileId,
      baseVersionId: v2.versionId,
    });
    // This device stopped at v2. That version is what any pending edit
    // of theirs merges against, so it has to survive even though a newer
    // one exists - otherwise their next conflict silently degrades into
    // a conflict copy.
    await ack(bindings, alice.accessToken, vault.id, v2.sequence);

    await collectGarbage(bindings, NOW_RETENTION);

    const lookup = await app.request(
      `/v1/vaults/${vault.id}/versions/${v2.versionId}`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(lookup.status).toBe(200);
    // v1 is genuinely behind everyone and can go; v3 is live.
    const v3Lookup = await app.request(
      `/v1/vaults/${vault.id}/versions/${v3.versionId}`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(v3Lookup.status).toBe(200);
  });

  it("is idempotent - a second run finds nothing and does not decrement again", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const created = await save(bindings, alice.accessToken, vault.id, "v1", { operation: "created" });
    const second = await save(bindings, alice.accessToken, vault.id, "v2", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: created.versionId,
    });
    const third = await save(bindings, alice.accessToken, vault.id, "v3", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: second.versionId,
    });
    await ack(bindings, alice.accessToken, vault.id, third.sequence);

    const first = await collectGarbage(bindings, NOW_RETENTION);
    expect(first.versionsCollected).toBeGreaterThan(0);
    const [afterFirst] = await bindings.DB.select().from(users).where(eq(users.id, alice.userId));

    const again = await collectGarbage(bindings, NOW_RETENTION);
    const [afterSecond] = await bindings.DB.select().from(users).where(eq(users.id, alice.userId));

    expect(again.versionsCollected).toBe(0);
    expect(afterSecond!.storageBytesUsed).toBe(afterFirst!.storageBytesUsed);
  });

  it("does not drive a drifted storage total below zero", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const created = await save(bindings, alice.accessToken, vault.id, "v1", { operation: "created" });
    const second = await save(bindings, alice.accessToken, vault.id, "v2", {
      operation: "updated",
      fileId: created.fileId,
      baseVersionId: created.versionId,
    });
    await ack(bindings, alice.accessToken, vault.id, second.sequence);

    // Simulate a total that has drifted below what GC is about to
    // reclaim - the running counter is maintained by hand, so this is a
    // real possibility and must not produce free quota.
    await bindings.DB.update(users).set({ storageBytesUsed: 1 }).where(eq(users.id, alice.userId));
    await collectGarbage(bindings, NOW_RETENTION);

    const [after] = await bindings.DB.select().from(users).where(eq(users.id, alice.userId));
    expect(after!.storageBytesUsed).toBe(0);
  });
});
