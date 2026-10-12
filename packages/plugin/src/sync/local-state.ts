import type { KeyValueStore } from "./storage.js";

// Identifies files by a stable server-assigned id rather than path, so
// renames don't look like delete+create. See protocol-spec.md §4.
export interface FileRecord {
  fileId: string;
  logicalPath: string;
  currentVersionId: string | null;
  contentHash: string; // of the last content this device applied or sent
}

interface Snapshot {
  lastAppliedSequence: number;
  filesByPath: Record<string, FileRecord>;
}

const STATE_KEY = "localState";

export class LocalStateStore {
  constructor(private store: KeyValueStore) {}

  private async read(): Promise<Snapshot> {
    // A fresh object every time a store has no snapshot yet - callers
    // mutate what `read()` returns before writing it back, so sharing one
    // "empty" object across instances would leak state between them (it
    // did, until this was caught by a cross-device test: two LocalState
    // stores for different devices ended up sharing the same `filesByPath`).
    return (await this.store.get<Snapshot>(STATE_KEY)) ?? { lastAppliedSequence: 0, filesByPath: {} };
  }

  private async write(snapshot: Snapshot): Promise<void> {
    await this.store.set(STATE_KEY, snapshot);
  }

  async getLastAppliedSequence(): Promise<number> {
    return (await this.read()).lastAppliedSequence;
  }

  async setLastAppliedSequence(sequence: number): Promise<void> {
    const snapshot = await this.read();
    snapshot.lastAppliedSequence = sequence;
    await this.write(snapshot);
  }

  async getByPath(path: string): Promise<FileRecord | undefined> {
    return (await this.read()).filesByPath[path];
  }

  async findByFileId(fileId: string): Promise<FileRecord | undefined> {
    return Object.values((await this.read()).filesByPath).find((r) => r.fileId === fileId);
  }

  async upsert(record: FileRecord): Promise<void> {
    const snapshot = await this.read();
    snapshot.filesByPath[record.logicalPath] = record;
    await this.write(snapshot);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const snapshot = await this.read();
    const record = snapshot.filesByPath[oldPath];
    if (!record) return;
    delete snapshot.filesByPath[oldPath];
    snapshot.filesByPath[newPath] = { ...record, logicalPath: newPath };
    await this.write(snapshot);
  }

  async remove(path: string): Promise<void> {
    const snapshot = await this.read();
    delete snapshot.filesByPath[path];
    await this.write(snapshot);
  }
}
