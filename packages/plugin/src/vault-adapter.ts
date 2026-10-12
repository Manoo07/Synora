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

  // Creates every missing ancestor directory, one level at a time, rather
  // than trusting a single createFolder(deeplyNestedPath) call to create
  // intermediate directories on its own. Confirmed live: on at least one
  // platform this silently failed for a multi-level-deep path (nothing
  // thrown here - the swallowed failure instead surfaced later as an
  // unhandled error from the actual file write, aborting the whole pull
  // with no visible error).
  private async ensureParentFolder(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!parent) return;
    const segments = parent.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (this.vault.getAbstractFileByPath(current)) continue;
      await this.vault.createFolder(current).catch(() => {
        // Another write racing to create the same folder is fine - only
        // matters that it exists by the time we reach the next segment.
      });
    }
  }
}
