import { bytesToBase64, base64ToBytes } from "./crypto/keys.js";

// Narrowed to just the handful of DataAdapter methods actually used,
// rather than depending on Obsidian's full (much larger) DataAdapter
// interface - a real adapter structurally satisfies this already, and
// it lets this module be unit tested with a plain fake, no Obsidian
// runtime needed (same pattern as api/client.ts's Transport interface).
export interface MinimalDataAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface PreferencesBundleHost {
  manifest: { id: string };
  app: {
    vault: {
      configDir: string;
      adapter: MinimalDataAdapter;
    };
  };
}

// Session/layout state - very much per-device (desktop vs mobile layouts
// differ entirely) and never something you'd want force-copied onto
// another device.
const EXCLUDED_TOP_LEVEL_FILES = new Set(["workspace.json", "workspace-mobile.json"]);

// The one hard safety rule this whole feature is built around: this
// plugin's own folder holds THIS device's secret key and access token
// (see settings.ts - "never leaves the device by design"). Copying it to
// another device would overwrite that device's own identity with the
// primary's, corrupting both devices' ability to sync. Checked by
// `plugin.manifest.id` at call time, not hardcoded, so it stays correct
// even if this plugin's id ever changes.
function isExcluded(relativePath: string, ownPluginId: string): boolean {
  if (EXCLUDED_TOP_LEVEL_FILES.has(relativePath)) return true;
  const ownPluginPrefix = `plugins/${ownPluginId}`;
  return relativePath === ownPluginPrefix || relativePath.startsWith(`${ownPluginPrefix}/`);
}

// A bundle's keys decide where its bytes get written, so a crafted one
// could otherwise walk out of the config directory entirely with ".."
// segments (or an absolute path), landing anywhere the app can write -
// including back inside this plugin's own folder, which would defeat
// the identity-overwrite rule above by spelling the path differently.
// Everything the collector produces is a plain relative path, so
// nothing legitimate is lost by refusing the rest.
function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(relativePath)) return false;
  return relativePath.split(/[/\\]/).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function listAllFilesRecursive(adapter: MinimalDataAdapter, root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const { files, folders } = await adapter.list(dir);
    result.push(...files);
    pending.push(...folders);
  }
  return result;
}

// Obsidian's adapter.mkdir doesn't reliably create every missing
// intermediate level in one call on all platforms (the same gap
// vault-adapter.ts's ensureParentFolder was fixed for, applied here
// since this touches a different API surface - the raw adapter, not
// Vault's own folder-creation path).
async function ensureFolderExists(adapter: MinimalDataAdapter, dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current).catch(() => {
        // Lost a race with something else creating the same folder - fine.
      });
    }
  }
}

// Walks the vault's config directory (".obsidian" by default, but never
// hardcoded - vault.configDir is the real, possibly-customized name) and
// reads every included file into a flat {relativePath: base64} map.
export async function collectPreferencesBundle(plugin: PreferencesBundleHost): Promise<Record<string, string>> {
  const adapter = plugin.app.vault.adapter;
  const configDir = plugin.app.vault.configDir;
  const ownPluginId = plugin.manifest.id;

  const bundle: Record<string, string> = {};
  const absolutePaths = await listAllFilesRecursive(adapter, configDir);

  for (const absolutePath of absolutePaths) {
    const relativePath = absolutePath.slice(configDir.length + 1);
    if (isExcluded(relativePath, ownPluginId)) continue;
    const bytes = new Uint8Array(await adapter.readBinary(absolutePath));
    bundle[relativePath] = bytesToBase64(bytes);
  }

  return bundle;
}

// Writes the bundle back under the vault's config directory. Applies the
// SAME exclusions again defensively on the way in - never trust a
// bundle's contents blindly, even one this same codebase produced.
export async function applyPreferencesBundle(plugin: PreferencesBundleHost, bundle: Record<string, string>): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  const configDir = plugin.app.vault.configDir;
  const ownPluginId = plugin.manifest.id;

  for (const [relativePath, base64] of Object.entries(bundle)) {
    if (!isSafeRelativePath(relativePath)) continue;
    if (isExcluded(relativePath, ownPluginId)) continue;

    const absolutePath = `${configDir}/${relativePath}`;
    const lastSlash = absolutePath.lastIndexOf("/");
    if (lastSlash !== -1) await ensureFolderExists(adapter, absolutePath.slice(0, lastSlash));

    const bytes = base64ToBytes(base64);
    await adapter.writeBinary(absolutePath, bytes.buffer as ArrayBuffer);
  }
}
