import type { BlobBucket, BlobHead } from "../../src/storage/types.js";

export class MemoryBucket implements BlobBucket {
  private objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();

  async put(key: string, value: Uint8Array | ArrayBuffer, options?: { customMetadata?: Record<string, string> }) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes, customMetadata: options?.customMetadata });
  }

  async get(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { arrayBuffer: async () => entry.bytes.buffer as ArrayBuffer };
  }

  async head(key: string): Promise<BlobHead | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { size: entry.bytes.byteLength, customMetadata: entry.customMetadata };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}
