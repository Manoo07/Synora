import type { BlobStore } from "./storage.js";

// Narrowed to the handful of DataAdapter methods actually used, so this
// can be unit tested with a plain fake (same pattern as
// preferences-bundle.ts's MinimalDataAdapter).
export interface MinimalBlobAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

// Keys are generated UUIDs, so anything else means a caller bug rather
// than untrusted input - but this writes to disk by concatenating the
// key onto a directory, so it is checked rather than assumed.
function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(key) || key === "." || key === "..") {
    throw new Error(`Unsafe blob key: ${key}`);
  }
}

// Stores each pending op's encrypted payload as its own file under the
// plugin's own directory, which is inside the vault's config dir and so
// is excluded from sync (IGNORED_PREFIXES) and from the preferences
// bundle.
export class AdapterBlobStore implements BlobStore {
  private ensured = false;

  constructor(private adapter: MinimalBlobAdapter, private dir: string) {}

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    if (!(await this.adapter.exists(this.dir))) {
      await this.adapter.mkdir(this.dir).catch(() => {
        // Lost a race with something else creating it - fine.
      });
    }
    this.ensured = true;
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    return `${this.dir}/${key}`;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await this.ensureDir();
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.adapter.writeBinary(path, buffer);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const path = this.pathFor(key);
    if (!(await this.adapter.exists(path))) return undefined;
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async keys(): Promise<string[]> {
    if (!(await this.adapter.exists(this.dir))) return [];
    const { files } = await this.adapter.list(this.dir);
    return files.map((file) => file.slice(file.lastIndexOf("/") + 1));
  }
}
