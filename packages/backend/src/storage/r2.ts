import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { BlobBucket, BlobHead } from "./types.js";

// R2 reached through its S3-compatible API rather than a Workers
// binding. Same bucket, same objects - only the way in differs, so
// nothing already stored needs touching.
//
// Implements the same small BlobBucket interface the routes have always
// used, which is why none of them change: the Workers binding happened
// to satisfy that shape structurally, and this satisfies it explicitly.
export class R2BlobBucket implements BlobBucket {
  private client: S3Client;

  constructor(
    private bucket: string,
    options: { accountId: string; accessKeyId: string; secretAccessKey: string; endpoint?: string },
  ) {
    this.client = new S3Client({
      // R2 ignores regions but the SDK insists on one.
      region: "auto",
      endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown> {
    const body = value instanceof Uint8Array ? value : new Uint8Array(value);
    return this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        Metadata: options?.customMetadata,
      }),
    );
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      // transformToByteArray drains the stream fully, which is what the
      // callers want - every one of them reads the whole blob to verify
      // its hash before doing anything with it.
      const bytes = await result.Body.transformToByteArray();
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: result.ContentLength ?? 0,
        // S3 lowercases metadata keys on the way out; the only one
        // stored is already lowercase, but normalise so a commit's hash
        // check cannot fail over capitalisation.
        customMetadata: Object.fromEntries(
          Object.entries(result.Metadata ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        ),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // Deleting something already gone is the desired end state, and
      // garbage collection relies on that being safe to retry.
      if (!isNotFound(err)) throw err;
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}

// The SDK reports a missing object as NoSuchKey on GET but as a bare
// 404 on HEAD, so both shapes have to count.
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}
