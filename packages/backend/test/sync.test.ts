import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { app } from "../src/index.js";
import { users } from "../src/db/schema.js";
import { resetDb, testBindings, closeTestDb } from "./setup.js";
import { registerUser, createVault, requestUpload, putBlob, commit } from "./helpers.js";

describe("sync protocol", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("creates a file, then commits an update against the correct base version", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const upload1 = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob1 = await putBlob(bindings, alice.accessToken, upload1.uploadUrl, "version one");
    const create = await commit(bindings, alice.accessToken, vault.id, {
      blobKey: blob1.blobKey,
      ciphertextHash: blob1.ciphertextHash,
      sizeBytes: blob1.sizeBytes,
      operation: "created",
      idempotencyKey: "op-1",
    });
    expect(create.status).toBe(200);
    expect(create.body.status).toBe("committed");
    const fileId = create.body.fileId as string;
    const v1 = create.body.versionId as string;

    const upload2 = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob2 = await putBlob(bindings, alice.accessToken, upload2.uploadUrl, "version two");
    const update = await commit(bindings, alice.accessToken, vault.id, {
      fileId,
      baseVersionId: v1,
      blobKey: blob2.blobKey,
      ciphertextHash: blob2.ciphertextHash,
      sizeBytes: blob2.sizeBytes,
      operation: "updated",
      idempotencyKey: "op-2",
    });
    expect(update.status).toBe(200);
    expect((update.body as { sequence: number }).sequence).toBe(2);
  });

  it("retrying the same idempotencyKey returns the original result instead of double-committing", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const upload = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob = await putBlob(bindings, alice.accessToken, upload.uploadUrl, "content");
    const body = {
      blobKey: blob.blobKey,
      ciphertextHash: blob.ciphertextHash,
      sizeBytes: blob.sizeBytes,
      operation: "created",
      idempotencyKey: "same-key",
    };

    const first = await commit(bindings, alice.accessToken, vault.id, body);
    const second = await commit(bindings, alice.accessToken, vault.id, body);

    expect(first.body).toEqual(second.body);

    const changesRes = await app.request(
      `/v1/vaults/${vault.id}/changes`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    const changes = (await changesRes.json()) as { changes: unknown[] };
    expect(changes.changes).toHaveLength(1);
  });

  it("the core race condition: a stale commit is rejected, not silently overwritten", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const upload1 = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob1 = await putBlob(bindings, alice.accessToken, upload1.uploadUrl, "base content");
    const create = await commit(bindings, alice.accessToken, vault.id, {
      blobKey: blob1.blobKey,
      ciphertextHash: blob1.ciphertextHash,
      sizeBytes: blob1.sizeBytes,
      operation: "created",
      idempotencyKey: "create",
    });
    const fileId = create.body.fileId as string;
    const baseVersion = create.body.versionId as string;

    // Device A and device B both start from `baseVersion`. Device A wins
    // the race and commits version 14 first.
    const uploadA = await requestUpload(bindings, alice.accessToken, vault.id);
    const blobA = await putBlob(bindings, alice.accessToken, uploadA.uploadUrl, "device A edit");
    const commitA = await commit(bindings, alice.accessToken, vault.id, {
      fileId,
      baseVersionId: baseVersion,
      blobKey: blobA.blobKey,
      ciphertextHash: blobA.ciphertextHash,
      sizeBytes: blobA.sizeBytes,
      operation: "updated",
      idempotencyKey: "device-a-edit",
    });
    expect(commitA.status).toBe(200);
    expect(commitA.body.status).toBe("committed");

    // Device B, unaware A already moved the file forward, tries to commit
    // against the now-stale `baseVersion`.
    const uploadB = await requestUpload(bindings, alice.accessToken, vault.id);
    const blobB = await putBlob(bindings, alice.accessToken, uploadB.uploadUrl, "device B edit");
    const commitB = await commit(bindings, alice.accessToken, vault.id, {
      fileId,
      baseVersionId: baseVersion,
      blobKey: blobB.blobKey,
      ciphertextHash: blobB.ciphertextHash,
      sizeBytes: blobB.sizeBytes,
      operation: "updated",
      idempotencyKey: "device-b-edit",
    });

    expect(commitB.status).toBe(409);
    expect(commitB.body.status).toBe("conflict");
    expect(commitB.body.currentVersionId).toBe(commitA.body.versionId);

    // Device A's version must still be the one the server considers
    // current -- B's rejected commit must not have overwritten it.
    const changesRes = await app.request(
      `/v1/vaults/${vault.id}/changes`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    const changes = (await changesRes.json()) as { changes: Array<{ versionId: string }> };
    expect(changes.changes.at(-1)!.versionId).toBe(commitA.body.versionId);
  });

  it("rejects a commit whose declared hash does not match the uploaded blob", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const upload = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob = await putBlob(bindings, alice.accessToken, upload.uploadUrl, "content");

    const res = await commit(bindings, alice.accessToken, vault.id, {
      blobKey: blob.blobKey,
      ciphertextHash: "0".repeat(64),
      sizeBytes: blob.sizeBytes,
      operation: "created",
      idempotencyKey: "bad-hash",
    });
    expect(res.status).toBe(400);
  });

  it("round-trips an uploaded blob through download", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const upload = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob = await putBlob(bindings, alice.accessToken, upload.uploadUrl, "hello vault");

    const res = await app.request(
      `/v1/vaults/${vault.id}/objects/${encodeURIComponent(blob.blobKey)}`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello vault");
  });

  it("tracks ack cursors and pending count via status", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const upload = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob = await putBlob(bindings, alice.accessToken, upload.uploadUrl, "content");
    await commit(bindings, alice.accessToken, vault.id, {
      blobKey: blob.blobKey,
      ciphertextHash: blob.ciphertextHash,
      sizeBytes: blob.sizeBytes,
      operation: "created",
      idempotencyKey: "op-1",
    });

    const statusBefore = await app.request(
      `/v1/vaults/${vault.id}/status`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect((await statusBefore.json()) as { pendingCount: number }).toMatchObject({ pendingCount: 1 });

    await app.request(
      `/v1/vaults/${vault.id}/acks`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ lastSequence: 1 }),
      },
      bindings,
    );

    const statusAfter = await app.request(
      `/v1/vaults/${vault.id}/status`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect((await statusAfter.json()) as { pendingCount: number }).toMatchObject({ pendingCount: 0 });
  });

  it("rejects an upload over the size cap", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);
    const upload = await requestUpload(bindings, alice.accessToken, vault.id);

    const oversized = new Uint8Array(100 * 1024 * 1024 + 1);
    const res = await app.request(
      upload.uploadUrl,
      { method: "PUT", headers: { authorization: `Bearer ${alice.accessToken}` }, body: oversized },
      bindings,
    );
    expect(res.status).toBe(413);
  });

  it("rejects a commit that would push a free account over its storage quota", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);
    await bindings.DB.update(users).set({ storageLimitBytes: 20 }).where(eq(users.email, "alice@example.com"));

    const upload1 = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob1 = await putBlob(bindings, alice.accessToken, upload1.uploadUrl, "under the limit");
    const first = await commit(bindings, alice.accessToken, vault.id, {
      blobKey: blob1.blobKey,
      ciphertextHash: blob1.ciphertextHash,
      sizeBytes: blob1.sizeBytes,
      operation: "created",
      idempotencyKey: "op-1",
    });
    expect(first.status).toBe(200);

    const [userAfterFirst] = await bindings.DB.select().from(users).where(eq(users.email, "alice@example.com"));
    expect(userAfterFirst!.storageBytesUsed).toBe(blob1.sizeBytes);

    const upload2 = await requestUpload(bindings, alice.accessToken, vault.id);
    const blob2 = await putBlob(bindings, alice.accessToken, upload2.uploadUrl, "this one pushes it over the limit");
    const second = await commit(bindings, alice.accessToken, vault.id, {
      fileId: first.body.fileId,
      baseVersionId: first.body.versionId,
      blobKey: blob2.blobKey,
      ciphertextHash: blob2.ciphertextHash,
      sizeBytes: blob2.sizeBytes,
      operation: "updated",
      idempotencyKey: "op-2",
    });
    expect(second.status).toBe(402);
    expect(second.body.error).toBe("quota_exceeded");

    // The rejected commit must not have been counted - usage stays exactly
    // where it was after the first, successful commit.
    const [userAfterSecond] = await bindings.DB.select().from(users).where(eq(users.email, "alice@example.com"));
    expect(userAfterSecond!.storageBytesUsed).toBe(blob1.sizeBytes);
  });

  // --- Preferences (primary device's theme/plugins/settings bundle) -----
  // Kept in this same describe block rather than a sibling one - a
  // second top-level describe with its own afterAll(closeTestDb) would
  // close the shared DB connection before these tests run, since Vitest
  // runs sibling describes sequentially, each with its own
  // before/afterAll scope.

  it("reports no preferences shared yet, then round-trips a push from the primary device", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken); // alice.deviceId is primary by default

    const infoBefore = await app.request(
      `/v1/vaults/${vault.id}/preferences/info`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect((await infoBefore.json()) as { exists: boolean }).toMatchObject({ exists: false });

    const pushRes = await app.request(
      `/v1/vaults/${vault.id}/preferences`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${alice.accessToken}` },
        body: new TextEncoder().encode("fake-encrypted-preferences-bundle"),
      },
      bindings,
    );
    expect(pushRes.status).toBe(200);

    const infoAfter = await app.request(
      `/v1/vaults/${vault.id}/preferences/info`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect((await infoAfter.json()) as { exists: boolean; sizeBytes: number }).toMatchObject({
      exists: true,
      sizeBytes: "fake-encrypted-preferences-bundle".length,
    });

    const getRes = await app.request(
      `/v1/vaults/${vault.id}/preferences`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe("fake-encrypted-preferences-bundle");
  });

  it("rejects a push from a device that isn't the vault's primary", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const secondLogin = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "password123", devicePublicKey: "device-2" }),
      },
      bindings,
    );
    const { deviceId: secondDeviceId } = (await secondLogin.json()) as { deviceId: string };
    await app.request(
      `/v1/vaults/${vault.id}/devices`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ deviceId: secondDeviceId, wrappedVaultKey: "wrapped-for-device-2", keyEpoch: 1 }),
      },
      bindings,
    );
    const secondLoginAgain = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "password123", devicePublicKey: "device-2" }),
      },
      bindings,
    );
    const { accessToken: secondToken } = (await secondLoginAgain.json()) as { accessToken: string };

    const pushRes = await app.request(
      `/v1/vaults/${vault.id}/preferences`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${secondToken}` },
        body: new TextEncoder().encode("sneaky-bundle"),
      },
      bindings,
    );
    expect(pushRes.status).toBe(403);

    // A non-primary device can still fetch it, once it exists.
    await app.request(
      `/v1/vaults/${vault.id}/preferences`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${alice.accessToken}` },
        body: new TextEncoder().encode("real-bundle"),
      },
      bindings,
    );
    const getRes = await app.request(
      `/v1/vaults/${vault.id}/preferences`,
      { headers: { authorization: `Bearer ${secondToken}` } },
      bindings,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe("real-bundle");
  });

  it("replaces rather than accumulates on a second push - usage reflects only the latest bundle's size", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    await app.request(
      `/v1/vaults/${vault.id}/preferences`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${alice.accessToken}` },
        body: new TextEncoder().encode("a".repeat(100)),
      },
      bindings,
    );
    const [afterFirst] = await bindings.DB.select().from(users).where(eq(users.email, "alice@example.com"));
    expect(afterFirst!.storageBytesUsed).toBe(100);

    await app.request(
      `/v1/vaults/${vault.id}/preferences`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${alice.accessToken}` },
        body: new TextEncoder().encode("b".repeat(40)),
      },
      bindings,
    );
    const [afterSecond] = await bindings.DB.select().from(users).where(eq(users.email, "alice@example.com"));
    // Net delta (-100 + 40), not 100 + 40 - a smaller re-push must shrink
    // recorded usage, not add to it.
    expect(afterSecond!.storageBytesUsed).toBe(40);
  });
});
