// A Server URL with a trailing slash (easy to paste in by accident) would
// otherwise produce a double slash before every path - e.g.
// "https://host.workers.dev//v1/auth/login" - which the backend's router
// doesn't match, giving an opaque 404. Confirmed live.
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// Minimal response shape both a `fetch` Response and Obsidian's
// `requestUrl` result can satisfy. Kept this narrow (not `fetch`'s full
// Response type) specifically so this file never imports from "obsidian" -
// that's what lets api/client.ts be unit tested with a plain mocked
// `fetch` in Node, with no Obsidian runtime involved.
export interface TransportResponse {
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: ArrayBuffer | string },
) => Promise<TransportResponse>;

// Obsidian's desktop app enforces a CSP that blocks the browser `fetch`
// API from reaching arbitrary external hosts (surfaces as a generic
// "Failed to fetch", no useful detail). Obsidian's own `requestUrl` API
// goes through Electron's net layer instead and isn't subject to that CSP -
// this default transport is for tests/Node; main.ts wires in an
// `requestUrl`-based transport for the real plugin. See
// src/obsidian-transport.ts.
const fetchTransport: Transport = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, arrayBuffer: () => res.arrayBuffer(), text: () => res.text() };
};

export interface Change {
  sequence: number;
  fileId: string;
  versionId: string | null;
  operation: "created" | "updated" | "renamed" | "deleted";
  blobKey: string | null;
  ciphertextHash: string | null;
  sizeBytes: number | null;
}

export interface CommitRequest {
  fileId?: string;
  baseVersionId?: string;
  blobKey: string;
  ciphertextHash: string;
  sizeBytes: number;
  operation: "created" | "updated" | "renamed" | "deleted";
  idempotencyKey: string;
  parentVersionIds?: string[];
  conflictOfFileId?: string;
}

export type CommitResult =
  | { status: "committed"; fileId: string; versionId: string; sequence: number }
  | { status: "conflict"; currentFileId: string; currentVersionId: string | null };

export class SynoraApiClient {
  private accessToken: string | undefined;

  private baseUrl: string;

  constructor(baseUrl: string, private transport: Transport = fetchTransport) {
    this.baseUrl = stripTrailingSlash(baseUrl);
  }

  setAccessToken(token: string | undefined) {
    this.accessToken = token;
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = stripTrailingSlash(baseUrl);
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; raw?: Uint8Array; acceptStatuses?: number[] } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    let body: ArrayBuffer | string | undefined;
    if (init.raw !== undefined) {
      body = init.raw.slice().buffer as ArrayBuffer;
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const res = await this.transport(`${this.baseUrl}${path}`, { method: init.method ?? "GET", headers, body });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok && !init.acceptStatuses?.includes(res.status)) {
      let message = `HTTP ${res.status}`;
      let code = "unknown";
      try {
        const errBody = JSON.parse(await res.text()) as { code?: string; error?: string; message?: string };
        code = errBody.code ?? errBody.error ?? code;
        message = errBody.message ?? message;
      } catch {
        // non-JSON error body; fall back to the generic message above
      }
      throw new ApiError(res.status, code, message);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  register(params: { email: string; password: string; devicePublicKey: string; deviceName?: string }) {
    return this.request<{ userId: string; deviceId: string; accessToken: string }>("/v1/auth/register", {
      method: "POST",
      body: params,
    });
  }

  login(params: { email: string; password: string; devicePublicKey: string; deviceName?: string }) {
    return this.request<{ userId: string; deviceId: string; accessToken: string; deviceStatus: "active" | "pending" | "revoked" }>(
      "/v1/auth/login",
      { method: "POST", body: params },
    );
  }

  createVault(wrappedVaultKey: string, wrappedRecoveryKey?: string) {
    return this.request<{ id: string; keyEpoch: number }>("/v1/vaults", {
      method: "POST",
      body: { wrappedVaultKey, wrappedRecoveryKey },
    });
  }

  listVaults() {
    return this.request<Array<{ id: string; keyEpoch: number }>>("/v1/vaults");
  }

  enrollDevice(vaultId: string, deviceId: string, wrappedVaultKey: string, keyEpoch: number) {
    return this.request<{ status: string; deviceId: string }>(`/v1/vaults/${vaultId}/devices`, {
      method: "POST",
      body: { deviceId, wrappedVaultKey, keyEpoch },
    });
  }

  listDevices(vaultId: string) {
    return this.request<{ enrolled: unknown[]; pending: Array<{ id: string; name: string }> }>(
      `/v1/vaults/${vaultId}/devices`,
    );
  }

  revokeDevice(vaultId: string, deviceId: string) {
    return this.request<{ status: string }>(`/v1/vaults/${vaultId}/devices/${deviceId}`, { method: "DELETE" });
  }

  getRecoveryKey(vaultId: string) {
    return this.request<{ wrappedKey: string; keyEpoch: number }>(`/v1/vaults/${vaultId}/recovery-key`);
  }

  selfRecoverDevice(vaultId: string, wrappedVaultKey: string, keyEpoch: number) {
    return this.request<{ status: string; deviceId: string }>(`/v1/vaults/${vaultId}/devices/self-recover`, {
      method: "POST",
      body: { wrappedVaultKey, keyEpoch },
    });
  }

  getWrappedKey(vaultId: string) {
    return this.request<{ wrappedKey: string; keyEpoch: number }>(`/v1/vaults/${vaultId}/wrapped-key`);
  }

  async requestUpload(vaultId: string) {
    return this.request<{ uploadId: string; uploadUrl: string }>(`/v1/vaults/${vaultId}/uploads`, {
      method: "POST",
    });
  }

  async putBlob(uploadUrl: string, bytes: Uint8Array) {
    return this.request<{ blobKey: string; sizeBytes: number; ciphertextHash: string }>(uploadUrl, {
      method: "PUT",
      raw: bytes,
    });
  }

  commit(vaultId: string, body: CommitRequest) {
    // A 409 here is an expected, meaningful response (the server lost the
    // race and says who won) - not a transport error. See protocol-spec.md §5.
    return this.request<CommitResult>(`/v1/vaults/${vaultId}/commits`, {
      method: "POST",
      body,
      acceptStatuses: [409],
    });
  }

  getChanges(vaultId: string, since: number, limit = 200) {
    return this.request<{ changes: Change[]; hasMore: boolean }>(
      `/v1/vaults/${vaultId}/changes?since=${since}&limit=${limit}`,
    );
  }

  async getObject(vaultId: string, blobKey: string): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    const res = await this.transport(`${this.baseUrl}/v1/vaults/${vaultId}/objects/${encodeURIComponent(blobKey)}`, {
      method: "GET",
      headers,
    });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) throw new ApiError(res.status, "download_failed", `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  ack(vaultId: string, lastSequence: number) {
    return this.request<{ status: string }>(`/v1/vaults/${vaultId}/acks`, {
      method: "POST",
      body: { lastSequence },
    });
  }

  status(vaultId: string) {
    return this.request<{ latestSequence: number; lastAckedSequence: number; pendingCount: number }>(
      `/v1/vaults/${vaultId}/status`,
    );
  }
}
