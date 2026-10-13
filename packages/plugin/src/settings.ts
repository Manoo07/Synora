import type { IconPackId } from "./icon-packs.js";

export interface SynoraSettings {
  serverUrl: string;
  deviceName: string;
  syncIntervalSeconds: number;
  // Purely cosmetic - toggles a CSS-only file-explorer icon pack (see
  // styles.css). "none" changes nothing from Obsidian's default look.
  // See icon-packs.ts for the registry this type is derived from.
  iconPack: IconPackId;

  // Undefined/empty = the "move images to a folder" feature isn't
  // configured. One-time bulk reorganization, not an ongoing router -
  // see main.ts moveImagesToConfiguredFolder().
  attachmentFolder?: string;

  // Undefined/empty behave the same as false/[] (not paused) - lets
  // stopping sync, for the whole vault or just specific files, mean
  // genuinely zero requests rather than just skipping uploads. See
  // main.ts pauseSync()/pauseFileSync() and syncCycle()'s early return.
  syncPaused?: boolean;
  pausedPaths?: string[];

  // Populated once signed in. The device secret key never leaves this
  // device by design; it lives here because Obsidian's plugin data file
  // is the only durable local storage available to a plugin. The vault
  // key itself is deliberately NOT persisted here - it's re-derived each
  // session by unwrapping wrappedKey (fetched from the server) with
  // deviceSecretKeyB64, and kept in memory only.
  email?: string;
  deviceId?: string;
  devicePublicKeyB64?: string;
  deviceSecretKeyB64?: string;
  accessToken?: string;
  vaultId?: string;
}

export const DEFAULT_SETTINGS: SynoraSettings = {
  serverUrl: "http://localhost:8787",
  deviceName: "Obsidian device",
  syncIntervalSeconds: 30,
  iconPack: "none",
};
