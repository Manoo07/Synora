import type { MinimalDataAdapter } from "../../src/preferences-bundle.js";

// A minimal in-memory stand-in for Obsidian's low-level DataAdapter,
// just enough to drive collectPreferencesBundle/applyPreferencesBundle
// without a real Obsidian runtime. Folders are tracked implicitly from
// file paths plus whatever was explicitly mkdir'd.
export class MemoryAdapter implements MinimalDataAdapter {
  files = new Map<string, Uint8Array>();
  folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest.includes("/")) {
        folders.add(prefix + rest.split("/")[0]);
      } else {
        files.push(filePath);
      }
    }
    for (const folderPath of this.folders) {
      if (folderPath.startsWith(prefix) && folderPath !== path) {
        const rest = folderPath.slice(prefix.length);
        if (!rest.includes("/")) folders.add(folderPath);
      }
    }
    return { files, folders: [...folders] };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.files.get(path);
    if (!data) throw new Error(`No such file: ${path}`);
    return data.buffer as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(data));
  }
}
