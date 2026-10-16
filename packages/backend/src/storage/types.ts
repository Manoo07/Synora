// The entire storage surface the routes use - four methods, no more.
//
// Keeping it this small is what let the R2 access swap from a Workers
// binding to the S3 API without a single route noticing, and it is why
// the tests can run against an in-memory fake (test/fakes/memory-bucket.ts)
// rather than real object storage. Anything added here has to be
// implemented twice, so add sparingly.
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
