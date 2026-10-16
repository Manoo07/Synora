import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { resetDb, testBindings, closeTestDb } from "./setup.js";
import { registerUser, createVault } from "./helpers.js";

describe("vaults and device isolation", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("creates a vault and lists it back for the owner", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const res = await app.request(
      "/v1/vaults",
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    const list = (await res.json()) as Array<{ id: string }>;
    expect(list.map((v) => v.id)).toContain(vault.id);
  });

  it("does not let one user access another user's vault", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const bob = await registerUser(bindings, "bob@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const res = await app.request(
      `/v1/vaults/${vault.id}/devices`,
      { headers: { authorization: `Bearer ${bob.accessToken}` } },
      bindings,
    );
    expect(res.status).toBe(403);
  });

  it("enrolls a pending device and lets it fetch its wrapped key", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    // Second device logs in for the first time -> pending.
    const loginRes = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "password123",
          devicePublicKey: "second-device-key",
        }),
      },
      bindings,
    );
    expect(loginRes.status).toBe(200);
    const { deviceId: secondDeviceId, deviceStatus } = (await loginRes.json()) as {
      deviceId: string;
      deviceStatus: string;
    };
    expect(deviceStatus).toBe("pending");

    // First (trusted) device enrolls it.
    const enrollRes = await app.request(
      `/v1/vaults/${vault.id}/devices`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ deviceId: secondDeviceId, wrappedVaultKey: "wrapped-for-device-2", keyEpoch: 1 }),
      },
      bindings,
    );
    expect(enrollRes.status).toBe(200);

    // Second device logs in again -> now active.
    const secondLogin = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "password123",
          devicePublicKey: "second-device-key",
        }),
      },
      bindings,
    );
    expect(secondLogin.status).toBe(200);
    const secondToken = (await secondLogin.json() as { accessToken: string }).accessToken;

    const keyRes = await app.request(
      `/v1/vaults/${vault.id}/wrapped-key`,
      { headers: { authorization: `Bearer ${secondToken}` } },
      bindings,
    );
    expect(keyRes.status).toBe(200);
    const keyBody = (await keyRes.json()) as { wrappedKey: string };
    expect(keyBody.wrappedKey).toBe("wrapped-for-device-2");

    // GET .../devices joins devices against wrappedVaultKeys by holderId,
    // which is `text` (it also holds the literal "recovery") against
    // devices.id's real `uuid` column - this previously threw
    // `operator does not exist: uuid = text` for any vault with at least
    // one actually-enrolled device, caught live against production.
    const listRes = await app.request(
      `/v1/vaults/${vault.id}/devices`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { enrolled: Array<{ id: string }> };
    expect(listBody.enrolled.map((d) => d.id).sort()).toEqual([alice.deviceId, secondDeviceId].sort());
  });

  it("revokes a device so it can no longer authenticate for new requests", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const revokeRes = await app.request(
      `/v1/vaults/${vault.id}/devices/${alice.deviceId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(revokeRes.status).toBe(200);

    // Listing vaults only needs account auth, so a revoked device's token
    // still works there - but anything gated on an *active* device must
    // reject it, even though the JWT itself hasn't expired.
    const listRes = await app.request(
      "/v1/vaults",
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(listRes.status).toBe(200);

    const keyRes = await app.request(
      `/v1/vaults/${vault.id}/wrapped-key`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(keyRes.status).toBe(401);
  });

  it("recovers vault access on a new device using the vault's recovery key, with no other trusted device involved", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");

    const vaultRes = await app.request(
      "/v1/vaults",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ wrappedVaultKey: "wrapped-for-device-1", wrappedRecoveryKey: "wrapped-for-recovery" }),
      },
      bindings,
    );
    const vault = (await vaultRes.json()) as { id: string };

    // A brand new device, with no existing trusted device able to
    // approve it, logs in and lands in "pending".
    const loginRes = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "password123", devicePublicKey: "recovery-device-key" }),
      },
      bindings,
    );
    const { deviceId: newDeviceId, accessToken: newDeviceToken } = (await loginRes.json()) as {
      deviceId: string;
      accessToken: string;
    };

    // It fetches the recovery-wrapped key using only its account token...
    const recoveryKeyRes = await app.request(
      `/v1/vaults/${vault.id}/recovery-key`,
      { headers: { authorization: `Bearer ${newDeviceToken}` } },
      bindings,
    );
    expect(recoveryKeyRes.status).toBe(200);
    expect((await recoveryKeyRes.json()) as { wrappedKey: string }).toMatchObject({ wrappedKey: "wrapped-for-recovery" });

    // ...and self-activates by presenting its own freshly-wrapped copy.
    const recoverRes = await app.request(
      `/v1/vaults/${vault.id}/devices/self-recover`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${newDeviceToken}` },
        body: JSON.stringify({ wrappedVaultKey: "wrapped-for-recovered-device", keyEpoch: 1 }),
      },
      bindings,
    );
    expect(recoverRes.status).toBe(200);

    // It now behaves like any other active, enrolled device.
    const keyRes = await app.request(
      `/v1/vaults/${vault.id}/wrapped-key`,
      { headers: { authorization: `Bearer ${newDeviceToken}` } },
      bindings,
    );
    expect(keyRes.status).toBe(200);
    expect((await keyRes.json()) as { wrappedKey: string }).toMatchObject({ wrappedKey: "wrapped-for-recovered-device" });
    void newDeviceId;
  });

  it("does not let a revoked device self-recover", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    // alice's own device gets explicitly revoked...
    await app.request(
      `/v1/vaults/${vault.id}/devices/${alice.deviceId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );

    // ...and must not be able to self-recover back into the vault just by
    // presenting the same (still cryptographically valid) account token -
    // revocation would otherwise be meaningless.
    const recoverRes = await app.request(
      `/v1/vaults/${vault.id}/devices/self-recover`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ wrappedVaultKey: "sneaky-rewrap", keyEpoch: 1 }),
      },
      bindings,
    );
    expect(recoverRes.status).toBe(403);
  });

  it("lets a device already active for one vault self-recover into a second vault on the same account", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");

    // Alice's first device creates TWO vaults (both owned by the same
    // account), vaultA with a recovery key set up (the helper doesn't,
    // since most tests don't need one).
    const vaultARes = await app.request(
      "/v1/vaults",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ wrappedVaultKey: "wrapped-a-for-device-1", wrappedRecoveryKey: "wrapped-recovery-a" }),
      },
      bindings,
    );
    const vaultA = (await vaultARes.json()) as { id: string };
    const vaultBRes = await app.request(
      "/v1/vaults",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ wrappedVaultKey: "wrapped-b-for-device-1" }),
      },
      bindings,
    );
    const vaultB = (await vaultBRes.json()) as { id: string };

    // A second device logs in (lands "pending") and gets enrolled into
    // vaultB ONLY - mirroring a device that's legitimately active
    // somewhere, but has never touched vaultA.
    const secondLogin = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "password123", devicePublicKey: "second-device-key" }),
      },
      bindings,
    );
    const secondToken = (await secondLogin.json() as { accessToken: string; deviceId: string });
    await app.request(
      `/v1/vaults/${vaultB.id}/devices`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ deviceId: secondToken.deviceId, wrappedVaultKey: "wrapped-b-for-device-2", keyEpoch: 1 }),
      },
      bindings,
    );
    const reLogin = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "password123", devicePublicKey: "second-device-key" }),
      },
      bindings,
    );
    const secondDeviceToken = (await reLogin.json() as { accessToken: string; deviceStatus: string });
    expect(secondDeviceToken.deviceStatus).toBe("active");

    // Now the second device tries to self-recover into vaultA using
    // vaultA's recovery key - it's globally "active" (for vaultB), but
    // must still be allowed to gain access to vaultA.
    const recoveryKeyRes = await app.request(
      `/v1/vaults/${vaultA.id}/recovery-key`,
      { headers: { authorization: `Bearer ${secondDeviceToken.accessToken}` } },
      bindings,
    );
    expect(recoveryKeyRes.status).toBe(200);

    const recoverRes = await app.request(
      `/v1/vaults/${vaultA.id}/devices/self-recover`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secondDeviceToken.accessToken}` },
        body: JSON.stringify({ wrappedVaultKey: "wrapped-a-for-device-2-recovered", keyEpoch: 1 }),
      },
      bindings,
    );
    expect(recoverRes.status).toBe(200);

    const keyRes = await app.request(
      `/v1/vaults/${vaultA.id}/wrapped-key`,
      { headers: { authorization: `Bearer ${secondDeviceToken.accessToken}` } },
      bindings,
    );
    expect(keyRes.status).toBe(200);
    expect((await keyRes.json()) as { wrappedKey: string }).toMatchObject({
      wrappedKey: "wrapped-a-for-device-2-recovered",
    });
  });

  it("defaults the creating device to primary, and lets another enrolled device claim it instead", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const initial = await app.request(
      `/v1/vaults/${vault.id}/primary-device`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect(initial.status).toBe(200);
    expect((await initial.json()) as { deviceId: string }).toMatchObject({ deviceId: alice.deviceId });

    // A second device, enrolled normally, claims primary for itself -
    // every device here belongs to the same account, no owner-only
    // restriction.
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

    const claim = await app.request(
      `/v1/vaults/${vault.id}/primary-device`,
      { method: "PUT", headers: { authorization: `Bearer ${secondToken}` } },
      bindings,
    );
    expect(claim.status).toBe(200);

    const after = await app.request(
      `/v1/vaults/${vault.id}/primary-device`,
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    expect((await after.json()) as { deviceId: string }).toMatchObject({ deviceId: secondDeviceId });
  });

  it("stores and hands back a vault name without being able to read it", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    // Opaque bytes as far as the server is concerned - it never
    // decrypts, so a vault's name leaks nothing to the host.
    const ciphertext = "ZW5jcnlwdGVkLXZhdWx0LW5hbWU=";
    const put = await app.request(
      `/v1/vaults/${vault.id}/name`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: JSON.stringify({ nameCiphertext: ciphertext }),
      },
      bindings,
    );
    expect(put.status).toBe(200);

    const list = await app.request(
      "/v1/vaults",
      { headers: { authorization: `Bearer ${alice.accessToken}` } },
      bindings,
    );
    const vaults = (await list.json()) as Array<{ id: string; nameCiphertext: string | null }>;
    expect(vaults.find((v) => v.id === vault.id)?.nameCiphertext).toBe(ciphertext);
  });

  it("will not let someone rename a vault they are not a member of", async () => {
    const bindings = testBindings();
    const alice = await registerUser(bindings, "alice@example.com");
    const bob = await registerUser(bindings, "bob@example.com");
    const vault = await createVault(bindings, alice.accessToken);

    const res = await app.request(
      `/v1/vaults/${vault.id}/name`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${bob.accessToken}` },
        body: JSON.stringify({ nameCiphertext: "aGFja2Vk" }),
      },
      bindings,
    );
    expect(res.status).toBe(403);
  });
});
