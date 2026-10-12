import type { VaultAdapter } from "../../src/sync/engine.js";

export class MemoryVault implements VaultAdapter {
  files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`No such file: ${path}`);
    return data;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}
