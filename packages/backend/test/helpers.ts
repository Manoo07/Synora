import { app } from "../src/app.js";
import type { AppBindings } from "../src/context.js";

export async function registerUser(bindings: AppBindings, email: string) {
  const res = await app.request(
    "/v1/auth/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123", devicePublicKey: `pk-${email}-1` }),
    },
    bindings,
  );
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { userId: string; deviceId: string; accessToken: string };
}

export async function createVault(bindings: AppBindings, accessToken: string) {
  const res = await app.request(
    "/v1/vaults",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ wrappedVaultKey: "opaque-wrapped-key" }),
    },
    bindings,
  );
  if (res.status !== 201) throw new Error(`create vault failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; keyEpoch: number };
}

export async function requestUpload(bindings: AppBindings, accessToken: string, vaultId: string) {
  const res = await app.request(
    `/v1/vaults/${vaultId}/uploads`,
    { method: "POST", headers: { authorization: `Bearer ${accessToken}` } },
    bindings,
  );
  if (res.status !== 200) throw new Error(`upload slot failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { uploadId: string; uploadUrl: string };
}

export async function putBlob(bindings: AppBindings, accessToken: string, uploadUrl: string, content: string) {
  const res = await app.request(
    uploadUrl,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}` },
      body: new TextEncoder().encode(content),
    },
    bindings,
  );
  if (res.status !== 200) throw new Error(`put blob failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { blobKey: string; sizeBytes: number; ciphertextHash: string };
}

export async function commit(
  bindings: AppBindings,
  accessToken: string,
  vaultId: string,
  body: Record<string, unknown>,
) {
  const res = await app.request(
    `/v1/vaults/${vaultId}/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    },
    bindings,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
