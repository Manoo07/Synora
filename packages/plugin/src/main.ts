import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { sha256 } from "@noble/hashes/sha256";
import { SynoraApiClient } from "./api/client.js";
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

  async onload(): Promise<void> {
    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings as Partial<SynoraSettings>) };
    const store = new PluginDataStore(this, raw);

    this.api = new SynoraApiClient(this.settings.serverUrl);
    if (this.settings.accessToken) this.api.setAccessToken(this.settings.accessToken);

    if (this.settings.vaultId && this.settings.deviceSecretKeyB64) {
      await this.initEngine(store).catch((err) => {
        console.error("Synora: failed to initialize sync engine", err);
        new Notice("Synora: could not connect to sync server. Check settings.");
      });
    }

    this.addSettingTab(new SynoraSettingTab(this.app, this));
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("idle");

    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultEvent(f, "created")));
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultEvent(f, "updated")));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultEvent(f, "deleted")));

    this.registerInterval(
      window.setInterval(() => void this.syncCycle(), this.settings.syncIntervalSeconds * 1000),
    );
  }

  private async initEngine(store: KeyValueStore): Promise<void> {
    const { vaultId, deviceSecretKeyB64 } = this.settings;
    if (!vaultId || !deviceSecretKeyB64) return;

    const { wrappedKey } = await this.api.getWrappedKey(vaultId);
    this.vaultKey = unwrapVaultKey(base64ToBytes(wrappedKey), base64ToBytes(deviceSecretKeyB64));

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
      this.updateStatusBar("syncing");
      await this.engine.flush();
      await this.engine.pull();
      this.updateStatusBar("idle");
    } catch (err) {
      console.error("Synora: sync cycle failed", err);
      this.updateStatusBar("error");
    }
  }

  private updateStatusBar(state: "idle" | "syncing" | "error"): void {
    if (!this.statusBarEl) return;
    const icon = state === "syncing" ? "⟳" : state === "error" ? "⚠" : "✓";
    this.statusBarEl.setText(`Synora ${icon}`);
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
  }

  async approveDevice(deviceId: string, devicePublicKeyB64: string): Promise<void> {
    if (!this.settings.vaultId || !this.vaultKey) {
      new Notice("No vault key available on this device yet.");
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

    const vaults = await this.api.listVaults();
    const vault = vaults[0];
    if (!vault) throw new Error("No vault found on this account to recover.");

    const { wrappedKey } = await this.api.getRecoveryKey(vault.id);
    const vaultKey = unwrapVaultKey(base64ToBytes(wrappedKey), base64ToBytes(recoveryCodeB64));

    const wrappedForSelf = wrapVaultKey(vaultKey, base64ToBytes(devicePublicKeyB64));
    await this.api.selfRecoverDevice(vault.id, bytesToBase64(wrappedForSelf), 1);

    this.settings.vaultId = vault.id;
    await this.saveSettings();
    this.vaultKey = vaultKey;
    new Notice("Vault recovered.");

    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    await this.initEngine(new PluginDataStore(this, raw));
  }
}
