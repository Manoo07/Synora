import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { sha256 } from "@noble/hashes/sha256";
import { ApiError, SynoraApiClient } from "./api/client.js";
import { obsidianTransport } from "./api/obsidian-transport.js";
import { SyncEngine } from "./sync/engine.js";
import { SyncQueue } from "./sync/queue.js";
import { LocalStateStore } from "./sync/local-state.js";
import { WriteSuppressor } from "./sync/suppressor.js";
import type { KeyValueStore } from "./sync/storage.js";
import { ObsidianVaultAdapter } from "./vault-adapter.js";
import { DEFAULT_SETTINGS, type SynoraSettings } from "./settings.js";
import { SynoraSettingTab } from "./settings-tab.js";
import { RecoveryCodeModal } from "./recovery-modal.js";
import {
  generateDeviceKeyPair,
  generateVaultKey,
  wrapVaultKey,
  unwrapVaultKey,
  bytesToBase64,
  base64ToBytes,
} from "./crypto/keys.js";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

class PluginDataStore implements KeyValueStore {
  constructor(private plugin: Plugin, private data: Record<string, unknown>) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.data[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data[key] = value;
    await this.plugin.saveData(this.data);
  }
}

const DEBOUNCE_MS = 1500;
const IGNORED_PREFIXES = [".obsidian/"];

export default class SynoraPlugin extends Plugin {
  settings: SynoraSettings = DEFAULT_SETTINGS;
  api!: SynoraApiClient;

  private engine?: SyncEngine;
  private vaultKey?: Uint8Array;
  private suppressor = new WriteSuppressor();
  private pendingDebounces = new Map<string, ReturnType<typeof setTimeout>>();
  private statusBarEl?: HTMLElement;
  // True specifically when this device is signed in, a vaultId is known,
  // but the server has no wrapped vault key for THIS device (distinct
  // from a connectivity failure) - the settings tab uses this to offer
  // self-recovery inline instead of a generic error. See initEngine().
  needsVaultKeyRecovery = false;

  async onload(): Promise<void> {
    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings as Partial<SynoraSettings>) };

    this.api = new SynoraApiClient(this.settings.serverUrl, obsidianTransport);
    if (this.settings.accessToken) this.api.setAccessToken(this.settings.accessToken);

    await this.ensureEngineInitialized();

    this.addSettingTab(new SynoraSettingTab(this.app, this));
    this.statusBarEl = this.addStatusBarItem();
    void this.updateStatusBar("idle");

    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultEvent(f, "created")));
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultEvent(f, "updated")));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultEvent(f, "deleted")));

    this.registerInterval(
      window.setInterval(() => void this.syncCycle(), this.settings.syncIntervalSeconds * 1000),
    );
  }

  // Reusable whenever the engine might need to come up: on load, and
  // after a sign-in that could follow either a stale 401 (engine was
  // torn down, token's fresh now) or a device that never got its wrapped
  // key in the first place. Safe to call when it's already running - it
  // just redoes the same check.
  async ensureEngineInitialized(): Promise<void> {
    if (!this.settings.vaultId || !this.settings.deviceSecretKeyB64) return;
    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    const store = new PluginDataStore(this, raw);
    await this.initEngine(store).catch((err) => {
      console.error("Synora: failed to initialize sync engine", err);
      if (err instanceof ApiError && err.status === 403) {
        // This device is signed in and knows the vaultId, but the server
        // has never wrapped the vault key for it - either it's a second
        // device that was never approved/recovered, or (as happened live)
        // a prior device identity got lost and this is really a fresh one
        // under the same account.
        this.needsVaultKeyRecovery = true;
      } else {
        new Notice("Synora: could not connect to sync server. Check settings.");
      }
    });
  }

  private async initEngine(store: KeyValueStore): Promise<void> {
    const { vaultId, deviceSecretKeyB64 } = this.settings;
    if (!vaultId || !deviceSecretKeyB64) return;

    const { wrappedKey } = await this.api.getWrappedKey(vaultId);
    this.vaultKey = unwrapVaultKey(base64ToBytes(wrappedKey), base64ToBytes(deviceSecretKeyB64));
    this.needsVaultKeyRecovery = false;

    this.engine = new SyncEngine({
      api: this.api,
      vaultId,
      vaultKey: this.vaultKey,
      vault: new ObsidianVaultAdapter(this.app.vault),
      queue: new SyncQueue(store),
      state: new LocalStateStore(store),
      suppressor: this.suppressor,
    });
  }

  private onVaultEvent(file: TAbstractFile, operation: "created" | "updated" | "deleted"): void {
    if (IGNORED_PREFIXES.some((p) => file.path.startsWith(p))) return;
    if (!(file instanceof TFile) && operation !== "deleted") return;

    const existing = this.pendingDebounces.get(file.path);
    if (existing) clearTimeout(existing);
    this.pendingDebounces.set(
      file.path,
      setTimeout(() => void this.handleDebounced(file, operation), DEBOUNCE_MS),
    );
  }

  private async handleDebounced(file: TAbstractFile, operation: "created" | "updated" | "deleted"): Promise<void> {
    this.pendingDebounces.delete(file.path);
    if (!this.engine) return;

    if (operation === "deleted") {
      await this.engine.handleLocalChange(file.path, "deleted");
      return;
    }

    // Re-read at fire time, not at event time - the file may have changed
    // again while we were debouncing.
    const current = this.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile)) return;
    const content = new Uint8Array(await this.app.vault.readBinary(current));
    const hash = toHex(sha256(content));
    if (this.suppressor.shouldSuppress(file.path, hash)) return;

    await this.engine.handleLocalChange(file.path, operation, content);
  }

  async syncCycle(): Promise<void> {
    if (!this.engine) return;
    try {
      void this.updateStatusBar("syncing");
      await this.engine.flush();
      await this.engine.pull();
      await this.updateStatusBar("idle");
    } catch (err) {
      console.error("Synora: sync cycle failed", err);
      void this.updateStatusBar("error");
      // A stale token stops every future sync cycle identically, forever,
      // with only a silent status-bar icon as a clue. Stop and say so
      // plainly rather than retrying the same failure on every interval -
      // the open settings tab (if any) picks this up on its own next
      // render via the same 401 check.
      if (err instanceof ApiError && err.status === 401) {
        this.engine = undefined;
        this.settings.accessToken = undefined;
        await this.saveSettings();
        new Notice("Synora: your session expired. Open settings to sign in again.");
        return;
      }
      // Anything else: this is the only place the actual failure reason
      // is visible at all on a platform with no console access (mobile) -
      // console.error alone is invisible there. Shown for a full 15s
      // since it's often long enough to need copying down by hand.
      new Notice(`Synora sync failed: ${err instanceof Error ? err.message : String(err)}`, 15_000);
    }
  }

  private async updateStatusBar(state: "idle" | "syncing" | "error"): Promise<void> {
    if (!this.statusBarEl) return;
    if (state === "syncing") {
      this.statusBarEl.setText("Synora ⟳");
      return;
    }
    if (state === "error") {
      this.statusBarEl.setText("Synora ⚠");
      return;
    }
    // "idle" on its own doesn't say whether there's still unsent work -
    // the whole point of a clean "fully synced" signal is distinguishing
    // "nothing happening right now" from "everything is actually caught
    // up," which flush()/pull() finishing doesn't guarantee on its own
    // (a flush can leave a just-re-queued conflict copy behind, say).
    const pending = (await this.engine?.pendingUploadCount()) ?? 0;
    this.statusBarEl.setText(pending > 0 ? `Synora ⟳ ${pending} pending` : "Synora ✓ Synced");
  }

  async saveSettings(): Promise<void> {
    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    raw.settings = this.settings;
    await this.saveData(raw);
  }

  async signIn(mode: "register" | "login", email: string, password: string): Promise<"active" | "pending"> {
    if (!this.settings.deviceSecretKeyB64) {
      const kp = generateDeviceKeyPair();
      this.settings.devicePublicKeyB64 = bytesToBase64(kp.publicKey);
      this.settings.deviceSecretKeyB64 = bytesToBase64(kp.secretKey);
    }
    const devicePublicKeyB64 = this.settings.devicePublicKeyB64!;
    const params = { email, password, devicePublicKey: devicePublicKeyB64, deviceName: this.settings.deviceName };

    this.settings.email = email;
    if (mode === "register") {
      const result = await this.api.register(params);
      this.settings.deviceId = result.deviceId;
      this.settings.accessToken = result.accessToken;
      this.api.setAccessToken(result.accessToken);
      await this.saveSettings();
      return "active";
    }

    const result = await this.api.login(params);
    this.settings.deviceId = result.deviceId;
    this.settings.accessToken = result.accessToken;
    this.api.setAccessToken(result.accessToken);
    await this.saveSettings();
    return result.deviceStatus === "active" ? "active" : "pending";
  }

  async createVault(): Promise<void> {
    if (!this.settings.deviceId || !this.settings.devicePublicKeyB64) return;
    const vaultKey = generateVaultKey();
    const wrapped = wrapVaultKey(vaultKey, base64ToBytes(this.settings.devicePublicKeyB64));

    // The recovery "key" is itself an X25519 keypair: its public half
    // wraps the vault key exactly like a device would, and its secret
    // half - shown once, below, and never stored by us - is what a
    // future device uses to unwrap it with no other trusted device
    // around. See protocol-spec.md §2 and crypto/keys.ts.
    const recoveryKeyPair = generateDeviceKeyPair();
    const wrappedForRecovery = wrapVaultKey(vaultKey, recoveryKeyPair.publicKey);

    const vault = await this.api.createVault(bytesToBase64(wrapped), bytesToBase64(wrappedForRecovery));
    this.settings.vaultId = vault.id;
    await this.saveSettings();
    this.vaultKey = vaultKey;
    new Notice("Vault created.");
    new RecoveryCodeModal(this.app, bytesToBase64(recoveryKeyPair.secretKey)).open();

    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    await this.initEngine(new PluginDataStore(this, raw));

    // This is a brand-new vault with nothing on the server yet, so every
    // file already in the local vault is "new" from the server's point of
    // view. Without this, the sync engine only ever sees changes from this
    // point forward - everything that existed before enabling the plugin
    // would silently never sync. Only correct to do this here (vault
    // creation): a device joining an *existing* vault should pull what's
    // already there instead, never dump its own local files into it.
    await this.scanAndQueueExistingFiles();
  }

  // Enqueues every vault file the sync engine doesn't already know about.
  // Safe to call repeatedly - already-tracked files are skipped, so it
  // also works as a manual "did I miss anything" repair action.
  async scanAndQueueExistingFiles(): Promise<void> {
    if (!this.engine) return;
    void this.updateStatusBar("syncing");

    // Pull first, always. "isTracked" only reflects this device's own
    // sync history - without catching up to the server's state first, a
    // device that hasn't pulled yet (most exposed right after recovering
    // into an *existing* vault) would see every one of its own local
    // files as "new" and could create a second, unrelated file record
    // for a path the server already has, since paths are encrypted and
    // the server has no way to catch that collision on its own.
    await this.engine.pull();

    const files = this.app.vault.getFiles().filter((f) => !IGNORED_PREFIXES.some((p) => f.path.startsWith(p)));
    let queued = 0;
    for (const file of files) {
      if (await this.engine.isTracked(file.path)) continue;
      const content = new Uint8Array(await this.app.vault.readBinary(file));
      await this.engine.handleLocalChange(file.path, "created", content);
      queued++;
    }
    await this.updateStatusBar("idle");

    if (queued > 0) {
      new Notice(`Synora: queued ${queued} existing file${queued === 1 ? "" : "s"} for sync.`);
      void this.syncCycle();
    }
  }

  async getPendingUploadCount(): Promise<number> {
    return (await this.engine?.pendingUploadCount()) ?? 0;
  }

  // Detaches this device from whatever vault it's currently pointed at -
  // purely local: nothing is deleted server-side, and the device's
  // account sign-in and key pair are untouched. For when a device ended
  // up attached to the wrong vault (confirmed live: a mis-tap landing on
  // "Create vault" instead of "Recover vault") with no other way back,
  // since once vaultId is set there was previously no way to change it
  // short of clearing the plugin's data file directly.
  async disconnectFromVault(): Promise<void> {
    this.settings.vaultId = undefined;
    this.needsVaultKeyRecovery = false;
    await this.saveSettings();
    this.vaultKey = undefined;
    this.engine = undefined;
    new Notice("Disconnected from vault. Pick Recover vault access to reattach to the right one.");
  }

  async approveDevice(deviceId: string, devicePublicKeyB64: string): Promise<void> {
    if (deviceId === this.settings.deviceId) {
      new Notice("This is the current device - it can't approve itself. Use Recover vault access instead.");
      return;
    }
    if (!this.settings.vaultId || !this.vaultKey) {
      new Notice(
        "This device doesn't have the vault key itself, so it can't approve others. Use Recover vault access on this device first.",
      );
      return;
    }
    const wrapped = wrapVaultKey(this.vaultKey, base64ToBytes(devicePublicKeyB64));
    await this.api.enrollDevice(this.settings.vaultId, deviceId, bytesToBase64(wrapped), 1);
    new Notice("Device approved.");
  }

  // Regains vault access on a device with no other trusted device able
  // to approve it, using only the account password and the recovery code
  // shown once at vault creation. Assumes a single vault per account for
  // now (same MVP simplification as the rest of the plugin).
  async recoverVault(email: string, password: string, recoveryCodeB64: string): Promise<void> {
    if (!this.settings.deviceSecretKeyB64) {
      const kp = generateDeviceKeyPair();
      this.settings.devicePublicKeyB64 = bytesToBase64(kp.publicKey);
      this.settings.deviceSecretKeyB64 = bytesToBase64(kp.secretKey);
    }
    const devicePublicKeyB64 = this.settings.devicePublicKeyB64!;

    const login = await this.api.login({ email, password, devicePublicKey: devicePublicKeyB64, deviceName: this.settings.deviceName });
    this.settings.email = email;
    this.settings.deviceId = login.deviceId;
    this.settings.accessToken = login.accessToken;
    this.api.setAccessToken(login.accessToken);
    await this.saveSettings();

    // Don't guess which vault this recovery code is for - a device can
    // already have a vaultId saved that's wrong for this code (e.g. it
    // created its own separate vault before ever attempting recovery,
    // confirmed live). The recovery code itself is the actual proof of
    // which vault it belongs to: try every vault on the account and keep
    // whichever one the code actually unwraps. Trying the device's
    // already-known vault first is just an ordering optimization, not a
    // trust decision.
    const vaults = await this.api.listVaults();
    if (vaults.length === 0) throw new Error("No vault found on this account to recover.");
    const candidates = this.settings.vaultId
      ? [this.settings.vaultId, ...vaults.map((v) => v.id).filter((id) => id !== this.settings.vaultId)]
      : vaults.map((v) => v.id);

    let vaultId: string | undefined;
    let vaultKey: Uint8Array | undefined;
    for (const candidateId of candidates) {
      try {
        const { wrappedKey } = await this.api.getRecoveryKey(candidateId);
        vaultKey = unwrapVaultKey(base64ToBytes(wrappedKey), base64ToBytes(recoveryCodeB64));
        vaultId = candidateId;
        break;
      } catch {
        // Wrong vault for this code (or it has no recovery key set up at
        // all) - try the next one rather than failing on the first miss.
      }
    }
    if (!vaultId || !vaultKey) {
      throw new Error("This recovery code didn't match any vault on this account.");
    }

    // The vaultKey above is already correct and usable regardless of
    // what happens next - it came from successfully unwrapping the
    // recovery code against this exact vault, independent of whether
    // this device has its own device-specific grant yet. So a device
    // that already has one (e.g. a prior recovery attempt actually
    // succeeded, and only the local settings were since reset - confirmed
    // live) isn't an error here, just a no-op for this step.
    const wrappedForSelf = wrapVaultKey(vaultKey, base64ToBytes(devicePublicKeyB64));
    try {
      await this.api.selfRecoverDevice(vaultId, bytesToBase64(wrappedForSelf), 1);
    } catch (err) {
      const alreadyEnrolled = err instanceof ApiError && err.status === 403 && /already has access/i.test(err.message);
      if (!alreadyEnrolled) throw err;
    }

    this.settings.vaultId = vaultId;
    await this.saveSettings();
    this.vaultKey = vaultKey;
    this.needsVaultKeyRecovery = false;
    new Notice("Vault recovered. Pulling files…");

    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    await this.initEngine(new PluginDataStore(this, raw));

    // Recovery otherwise leaves the vault looking empty until the next
    // background sync cycle (up to 30s away) - confusing right after
    // "Vault recovered" says nothing came through yet. Pull immediately
    // instead of making the user wait or go find the Scan button.
    await this.engine?.pull();
    new Notice("Files pulled.");
  }
}
