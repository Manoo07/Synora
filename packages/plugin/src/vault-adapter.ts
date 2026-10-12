import { TFile, Vault, normalizePath } from "obsidian";
import type { VaultAdapter } from "./sync/engine.js";

// Thin wrapper so SyncEngine depends on the small VaultAdapter interface
// instead of all of Obsidian's Vault API - that's what let engine.ts be
// unit tested without Obsidian installed.
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private vault: Vault) {}

  async read(path: string): Promise<Uint8Array> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Not a file: ${path}`);
    return new Uint8Array(await this.vault.readBinary(file));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, buffer);
    } else {
      await this.ensureParentFolder(normalized);
      await this.vault.createBinary(normalized, buffer);
    }
  }

  async delete(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file) await this.vault.delete(file);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!parent || this.vault.getAbstractFileByPath(parent)) return;
    await this.vault.createFolder(parent).catch(() => {
      // Races with another create are fine; the folder exists either way.
    });
  }
}
