import type { VaultAdapter } from "../../src/sync/engine.js";

export class MemoryVault implements VaultAdapter {
  files = new Map<string, Uint8Array>();
  // Simulates a platform-specific write failure (e.g. a filename legal
  // on the device that created it but illegal on this one) for a
  // specific path, without needing a real filesystem to reproduce it.
  failWritesTo = new Set<string>();

  async read(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`No such file: ${path}`);
    return data;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if (this.failWritesTo.has(path)) {
      throw new Error('File name cannot contain any of the following characters: \\/:*?<>"');
    }
    this.files.set(path, data);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}
