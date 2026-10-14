// Obsidian's Plugin.loadData/saveData persist a single JSON blob per
// plugin. We split "pending operations" and "local sync state" into two
// keys of that same blob so tests can swap in an in-memory fake without
// pulling in the Obsidian runtime.
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

// Pending operations carry the whole encrypted file with them, and the
// KeyValueStore above persists as one JSON blob that is rewritten in
// full on every single write. Keeping payloads in there meant importing
// twenty 3MB photos pushed over a gigabyte through that one file, with
// the entire thing held in memory to be serialised each time. Payloads
// live here instead - one file each, written once and deleted once.
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class InMemoryBlobStore implements BlobStore {
  private blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(key);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.blobs.keys()];
  }
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}
