export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

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

  constructor(private baseUrl: string) {}

  setAccessToken(token: string | undefined) {
    this.accessToken = token;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; raw?: Uint8Array; acceptStatuses?: number[] } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    let body: BodyInit | undefined;
    if (init.raw !== undefined) {
      body = init.raw.slice().buffer as ArrayBuffer;
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const res = await fetch(`${this.baseUrl}${path}`, { method: init.method ?? "GET", headers, body });
    if (!res.ok && !init.acceptStatuses?.includes(res.status)) {
      let message = res.statusText;
      let code = "unknown";
      try {
        const errBody = (await res.json()) as { code?: string; error?: string; message?: string };
        code = errBody.code ?? errBody.error ?? code;
        message = errBody.message ?? message;
      } catch {
        // non-JSON error body; fall back to statusText
      }
      throw new ApiError(res.status, code, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
    const res = await fetch(`${this.baseUrl}/v1/vaults/${vaultId}/objects/${encodeURIComponent(blobKey)}`, {
      headers,
    });
    if (!res.ok) throw new ApiError(res.status, "download_failed", res.statusText);
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
