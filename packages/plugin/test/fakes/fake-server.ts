// A minimal in-memory stand-in for the backend's sync endpoints, just
// enough to drive SyncEngine through upload -> commit -> conflict ->
// change-feed -> download. Wire-contract correctness against the real
// Postgres-backed implementation (including the base-version race
// condition) is covered by packages/backend's own test suite; this fake
// exists to exercise the plugin's call sequencing and crypto round-trip
// in isolation, without spinning up that whole stack from this package.
interface StoredFile {
  currentVersionId: string | null;
}
interface StoredVersion {
  blobKey: string;
  ciphertextHash: string;
  sizeBytes: number;
}
interface ChangeRow {
  sequence: number;
  fileId: string;
  versionId: string | null;
  operation: string;
  blobKey: string | null;
  ciphertextHash: string | null;
  sizeBytes: number | null;
}

export class FakeApiServer {
  private objects = new Map<string, Uint8Array>();
  private files = new Map<string, StoredFile>();
  private versions = new Map<string, StoredVersion>();
  private changes: ChangeRow[] = [];
  private idempotency = new Map<string, unknown>();
  private seq = 0;
  private nextId = 1;

  install(vaultId: string) {
    const self = this;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://fake");
      return self.handle(vaultId, url, init ?? {});
    }) as typeof fetch;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(vaultId: string, url: URL, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    const path = url.pathname;

    if (method === "POST" && path === `/v1/vaults/${vaultId}/uploads`) {
      const blobKey = `${vaultId}/${this.nextId++}`;
      return this.json({ uploadId: blobKey, uploadUrl: `/v1/vaults/${vaultId}/uploads/${encodeURIComponent(blobKey)}` });
    }

    if (method === "PUT" && path.startsWith(`/v1/vaults/${vaultId}/uploads/`)) {
      const blobKey = decodeURIComponent(path.slice(`/v1/vaults/${vaultId}/uploads/`.length));
      const bytes = new Uint8Array(await bodyToArrayBuffer(init.body));
      this.objects.set(blobKey, bytes);
      const hash = await sha256Hex(bytes);
      return this.json({ blobKey, sizeBytes: bytes.byteLength, ciphertextHash: hash });
    }

    if (method === "POST" && path === `/v1/vaults/${vaultId}/commits`) {
      const body = JSON.parse(String(init.body)) as {
        fileId?: string;
        baseVersionId?: string;
        blobKey: string;
        ciphertextHash: string;
        sizeBytes: number;
        operation: string;
        idempotencyKey: string;
      };

      if (this.idempotency.has(body.idempotencyKey)) {
        return this.json(this.idempotency.get(body.idempotencyKey));
      }

      // The real backend validates a *present* fileId/baseVersionId as a
      // UUID via zod, rejecting an empty string with a 400 "Invalid
      // uuid" - confirmed live as the root cause of a real bug (see
      // engine.test.ts "flush() drops a permanently-invalid op..."). This
      // fake doesn't otherwise generate real UUID-shaped ids itself
      // (its own ids look like "file-3"/"version-5"), so it only checks
      // for the one thing that actually mattered for that bug - a
      // present-but-empty value - rather than full UUID-format fidelity.
      if (body.fileId === "" || body.baseVersionId === "") {
        return this.json({ error: "bad_request", message: "Invalid uuid" }, 400);
      }

      let fileId = body.fileId;
      if (fileId) {
        const file = this.files.get(fileId);
        if (!file || file.currentVersionId !== (body.baseVersionId ?? null)) {
          const result = { status: "conflict", currentFileId: fileId, currentVersionId: file?.currentVersionId ?? null };
          return this.json(result, 409);
        }
      } else {
        fileId = `file-${this.nextId++}`;
        this.files.set(fileId, { currentVersionId: null });
      }

      const versionId = `version-${this.nextId++}`;
      this.versions.set(versionId, { blobKey: body.blobKey, ciphertextHash: body.ciphertextHash, sizeBytes: body.sizeBytes });
      this.files.set(fileId, { currentVersionId: versionId });
      const sequence = ++this.seq;
      this.changes.push({
        sequence,
        fileId,
        versionId,
        operation: body.operation,
        blobKey: body.blobKey,
        ciphertextHash: body.ciphertextHash,
        sizeBytes: body.sizeBytes,
      });

      const result = { status: "committed", fileId, versionId, sequence };
      this.idempotency.set(body.idempotencyKey, result);
      return this.json(result);
    }

    if (method === "GET" && path === `/v1/vaults/${vaultId}/changes`) {
      const since = Number(url.searchParams.get("since") ?? "0");
      // Mirrors the real route, which pages oldest-first and caps the
      // page at 500 - without that cap here a caller that only works
      // while the whole history fits in one page looks fine in tests.
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 500);
      const matching = this.changes.filter((c) => c.sequence > since);
      const changes = matching.slice(0, limit);
      return this.json({ changes, hasMore: matching.length > changes.length });
    }

    if (method === "GET" && path.startsWith(`/v1/vaults/${vaultId}/versions/`)) {
      const versionId = decodeURIComponent(path.slice(`/v1/vaults/${vaultId}/versions/`.length));
      const version = this.versions.get(versionId);
      if (!version) return new Response(JSON.stringify({ code: "not_found", message: "no version" }), { status: 404 });
      return this.json({ versionId, ...version });
    }

    if (method === "GET" && path.startsWith(`/v1/vaults/${vaultId}/objects/`)) {
      const blobKey = decodeURIComponent(path.slice(`/v1/vaults/${vaultId}/objects/`.length));
      const bytes = this.objects.get(blobKey);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
    }

    if (method === "POST" && path === `/v1/vaults/${vaultId}/acks`) {
      return this.json({ status: "acked" });
    }

    return new Response(JSON.stringify({ code: "not_found", message: "no fake route" }), { status: 404 });
  }
}

async function bodyToArrayBuffer(body: BodyInit | null | undefined): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);
  if (body instanceof ArrayBuffer) return body;
  if (body instanceof Uint8Array) return body.buffer as ArrayBuffer;
  if (typeof body === "string") return new TextEncoder().encode(body).buffer as ArrayBuffer;
  throw new Error("Unsupported body type in fake server");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { sha256 } = await import("@noble/hashes/sha256");
  return Array.from(sha256(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
