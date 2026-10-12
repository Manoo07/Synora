// Obsidian's Plugin.loadData/saveData persist a single JSON blob per
// plugin. We split "pending operations" and "local sync state" into two
// keys of that same blob so tests can swap in an in-memory fake without
// pulling in the Obsidian runtime.
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
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
