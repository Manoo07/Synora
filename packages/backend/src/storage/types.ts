// Minimal duck-typed subset of Cloudflare's R2Bucket that our routes
// actually use. A real R2Bucket satisfies this structurally, so production
// code just passes the binding straight through; tests pass an in-memory
// fake instead (see test/fakes/memory-bucket.ts).
export interface BlobHead {
  size: number;
  customMetadata?: Record<string, string>;
}

export interface BlobBucket {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<BlobHead | null>;
  delete(key: string): Promise<void>;
}
