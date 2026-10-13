import { Notice, Plugin, TAbstractFile, TFile, setIcon } from "obsidian";
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
import { ICON_PACKS } from "./icon-packs.js";
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
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"];

export default class SynoraPlugin extends Plugin {
  settings: SynoraSettings = DEFAULT_SETTINGS;
  api!: SynoraApiClient;

  private engine?: SyncEngine;
  private vaultKey?: Uint8Array;
  private suppressor = new WriteSuppressor();
  private pendingDebounces = new Map<string, ReturnType<typeof setTimeout>>();
  private statusBarEl?: HTMLElement;
  private statusIconEl?: HTMLElement;
  private statusTextEl?: HTMLElement;
  // Guards against two overlapping sync cycles - the automatic interval
  // and a manual click (or two quick manual clicks) racing against the
  // same local queue/state store otherwise.
  private isSyncing = false;
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
    this.statusBarEl.addClass("synora-status-bar-item");
    this.statusBarEl.setAttribute("aria-label", "Click to sync now");
    this.statusIconEl = this.statusBarEl.createSpan({ cls: "synora-status-icon" });
    this.statusTextEl = this.statusBarEl.createSpan({ text: "Synora" });
    this.registerDomEvent(this.statusBarEl, "click", () => {
      if (this.isSyncing) return;
      if (this.settings.syncPaused) {
        new Notice("Synora: sync is paused. Resume it in settings to sync.");
        return;
      }
      if (!this.engine) {
        new Notice("Synora: not connected. Open settings to sign in and attach a vault.");
        return;
      }
      void this.syncCycle();
    });
    void this.updateStatusBar("idle");

    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultEvent(f, "created")));
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultEvent(f, "updated")));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultEvent(f, "deleted")));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.onVaultRename(f, oldPath)));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        const paused = this.isPathPaused(file.path);
        menu.addItem((item) =>
          item
            .setTitle(paused ? "Resume Synora sync for this file" : "Pause Synora sync for this file")
            .setIcon(paused ? "play" : "pause")
            .onClick(() => void (paused ? this.resumeFileSync(file.path) : this.pauseFileSync(file.path))),
        );
      }),
    );

    this.registerInterval(
      window.setInterval(() => void this.syncCycle(), this.settings.syncIntervalSeconds * 1000),
    );

    this.applyIconPack();
  }

  // Purely cosmetic: toggles a body class that gates the CSS-only icon
  // rules in styles.css (file-explorer icons by extension, via the
  // data-path attribute Obsidian already sets on each row) - no DOM
  // watching needed. Called on load and whenever the setting changes.
  // Generalized over ICON_PACKS so a new pack needs no edit here - just
  // a registry entry (icon-packs.ts) and its own CSS block.
  applyIconPack(): void {
    for (const pack of ICON_PACKS) {
      document.body.toggleClass(`synora-icon-pack-${pack.id}`, pack.id !== "none" && this.settings.iconPack === pack.id);
    }
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
    if (this.settings.syncPaused || this.isPathPaused(file.path)) return;

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

  // Obsidian's rename event has a different shape ((file, oldPath)) than
  // create/modify/delete's single-arg callback, so it needs its own
  // debounced handler rather than reusing onVaultEvent/handleDebounced.
  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (IGNORED_PREFIXES.some((p) => file.path.startsWith(p) || oldPath.startsWith(p))) return;
    if (!(file instanceof TFile)) return; // folders: contained files get their own rename events

    // An earlier modify/create event on this same file could still have a
    // debounce pending under its old path - left alone, it would later
    // try to re-read a path that no longer exists.
    const stale = this.pendingDebounces.get(oldPath);
    if (stale) {
      clearTimeout(stale);
      this.pendingDebounces.delete(oldPath);
    }

    const existing = this.pendingDebounces.get(file.path);
    if (existing) clearTimeout(existing);
    this.pendingDebounces.set(
      file.path,
      setTimeout(() => void this.handleDebouncedRename(file, oldPath), DEBOUNCE_MS),
    );
  }

  private async handleDebouncedRename(file: TFile, oldPath: string): Promise<void> {
    this.pendingDebounces.delete(file.path);
    if (!this.engine) return;
    if (this.settings.syncPaused || this.isPathPaused(file.path)) return;

    const current = this.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile)) return;
    const content = new Uint8Array(await this.app.vault.readBinary(current));
    const hash = toHex(sha256(content));
    if (this.suppressor.shouldSuppress(file.path, hash)) return;

    await this.engine.handleLocalRename(oldPath, file.path, content);
  }

  async syncCycle(): Promise<void> {
    // The one line that makes "entire" pause genuinely mean zero
    // requests - the 30s interval timer keeps firing regardless (cheap,
    // local-only), it just no-ops immediately every time while paused.
    if (this.settings.syncPaused) return;
    if (!this.engine || this.isSyncing) return;
    this.isSyncing = true;
    try {
      void this.updateStatusBar("syncing");
      const { failed } = await this.engine.flush();
      this.notifyFailed(failed);
      const { skipped } = await this.engine.pull();
      this.notifySkipped(skipped);
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
      // A quota-exceeded commit retries identically forever otherwise,
      // same as the 401 case above - called out distinctly from the
      // generic Notice below since "upgrade or free up space" is a very
      // different next step than "something went wrong."
      if (err instanceof ApiError && err.code === "quota_exceeded") {
        new Notice(
          "Synora: this account's free storage limit is used up. Free up space or ask the server operator to raise your limit.",
          15_000,
        );
        return;
      }
      // Anything else: this is the only place the actual failure reason
      // is visible at all on a platform with no console access (mobile) -
      // console.error alone is invisible there. Shown for a full 15s
      // since it's often long enough to need copying down by hand.
      new Notice(`Synora sync failed: ${err instanceof Error ? err.message : String(err)}`, 15_000);
    } finally {
      this.isSyncing = false;
    }
  }

  // Lucide icon names (bundled with Obsidian - setIcon renders them as
  // inline SVG, unlike a plain unicode glyph, which depends on the
  // platform's emoji font and - confirmed live on Android - can render as
  // a broken/unrelated glyph instead of the intended one).
  private async updateStatusBar(state: "idle" | "syncing" | "error"): Promise<void> {
    if (!this.statusBarEl || !this.statusIconEl || !this.statusTextEl) return;
    this.statusBarEl.removeClass("is-error", "is-synced");
    this.statusIconEl.removeClass("is-spinning");

    // Overrides whatever state was requested - paused is paused
    // regardless of what triggered this call.
    if (this.settings.syncPaused) {
      setIcon(this.statusIconEl, "pause");
      this.statusTextEl.setText("Paused");
      return;
    }

    if (state === "syncing") {
      setIcon(this.statusIconEl, "refresh-cw");
      this.statusIconEl.addClass("is-spinning");
      this.statusTextEl.setText("Syncing…");
      return;
    }
    if (state === "error") {
      setIcon(this.statusIconEl, "alert-triangle");
      this.statusBarEl.addClass("is-error");
      this.statusTextEl.setText("Sync error");
      return;
    }
    // "idle" on its own doesn't say whether there's still unsent work -
    // the whole point of a clean "fully synced" signal is distinguishing
    // "nothing happening right now" from "everything is actually caught
    // up," which flush()/pull() finishing doesn't guarantee on its own
    // (a flush can leave a just-re-queued conflict copy behind, say).
    const pending = (await this.engine?.pendingUploadCount()) ?? 0;
    if (pending > 0) {
      setIcon(this.statusIconEl, "upload-cloud");
      this.statusTextEl.setText(`${pending} pending`);
    } else {
      setIcon(this.statusIconEl, "check-circle-2");
      this.statusBarEl.addClass("is-synced");
      this.statusTextEl.setText("Synced");
    }
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

  // One-time bulk reorganization: moves every image into the configured
  // folder. app.fileManager.renameFile() is Obsidian's own move/rename
  // API - it physically moves the file *and* rewrites every link to it
  // across the vault (wikilinks and markdown links both), so notes stay
  // correct with no markdown-parsing of our own needed. Each call also
  // fires a real vault "rename" event, which syncs normally via
  // onVaultRename/handleLocalRename - no separate sync logic needed here.
  async moveImagesToConfiguredFolder(): Promise<{ moved: number; skipped: number }> {
    const folder = this.settings.attachmentFolder?.trim();
    if (!folder) throw new Error("Set an attachments folder first.");
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {
        // Already exists (race with something else) - fine, proceed.
      });
    }

    let moved = 0;
    let skipped = 0;
    for (const file of this.app.vault.getFiles()) {
      if (!IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) continue;
      if ((file.parent?.path ?? "") === folder) {
        skipped++;
        continue;
      }
      const targetPath = this.uniqueTargetPath(folder, file.name);
      try {
        await this.app.fileManager.renameFile(file, targetPath);
        moved++;
      } catch (err) {
        console.error(`Synora: failed to move ${file.path}`, err);
        skipped++;
      }
    }
    return { moved, skipped };
  }

  private uniqueTargetPath(folder: string, fileName: string): string {
    let candidate = `${folder}/${fileName}`;
    if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;

    const dot = fileName.lastIndexOf(".");
    const stem = dot === -1 ? fileName : fileName.slice(0, dot);
    const ext = dot === -1 ? "" : fileName.slice(dot);
    for (let i = 1; ; i++) {
      candidate = `${folder}/${stem} ${i}${ext}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
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
    const pulled = await this.engine.pull();
    this.notifySkipped(pulled.skipped);

    const files = this.app.vault.getFiles().filter((f) => !IGNORED_PREFIXES.some((p) => f.path.startsWith(p)));
    let queued = 0;
    for (const file of files) {
      if (await this.engine.isTracked(file.path)) continue;
      if (this.isPathPaused(file.path)) continue;
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

  // One file that pull() couldn't apply (e.g. a filename with characters
  // illegal on this device's filesystem - confirmed live) used to abort
  // every change behind it in the feed, silently, forever. pull() now
  // skips just that file and keeps going; this is what makes the skip
  // itself visible instead of trading one silent failure for another.
  private notifySkipped(skipped: string[]): void {
    if (skipped.length === 0) return;
    new Notice(
      `Synora: ${skipped.length} file${skipped.length === 1 ? "" : "s"} could not sync on this device (see console for details) - the rest synced normally.`,
      15_000,
    );
  }

  // Mirrors notifySkipped above, but for the push side: an edit the
  // server permanently rejected (not a transient failure - see
  // engine.ts flush()) and dropped from the queue rather than retrying
  // forever. Re-editing the file queues a fresh, valid change.
  private notifyFailed(failed: string[]): void {
    if (failed.length === 0) return;
    new Notice(
      `Synora: ${failed.length} edit${failed.length === 1 ? "" : "s"} could not be synced and ${failed.length === 1 ? "was" : "were"} dropped (see console for details) - re-save the file to try again: ${failed.join(", ")}`,
      15_000,
    );
  }

  isPathPaused(path: string): boolean {
    return (this.settings.pausedPaths ?? []).includes(path);
  }

  async pauseSync(): Promise<void> {
    this.settings.syncPaused = true;
    await this.saveSettings();
    void this.updateStatusBar("idle"); // overridden to "Paused" inside updateStatusBar
  }

  async resumeSync(): Promise<void> {
    this.settings.syncPaused = false;
    await this.saveSettings();
    // The bulk catch-up - don't wait for the next 30s tick.
    void this.syncCycle();
  }

  async pauseFileSync(path: string): Promise<void> {
    const paths = new Set(this.settings.pausedPaths ?? []);
    paths.add(path);
    this.settings.pausedPaths = [...paths];
    await this.saveSettings();
  }

  async resumeFileSync(path: string): Promise<void> {
    this.settings.pausedPaths = (this.settings.pausedPaths ?? []).filter((p) => p !== path);
    await this.saveSettings();
    // No vault-event listener ever queued this file's edits while it was
    // paused - catch it up explicitly, then push everything in one bulk
    // sync rather than waiting for the next tick.
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && this.engine) {
      const content = new Uint8Array(await this.app.vault.readBinary(file));
      await this.engine.handleLocalChange(path, "updated", content);
    }
    void this.syncCycle();
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

  // Vaults this device can attach to directly - no recovery code needed,
  // because the server already has a device-specific grant for it (from
  // an earlier successful recovery/enrollment this device's local
  // settings have since lost track of). Includes each vault's latest
  // change sequence so the UI can show which ones actually have content,
  // rather than the user guessing between several opaque vault ids -
  // exactly the ambiguity that led to repeatedly recreating empty vaults
  // instead of reattaching to the real one, confirmed live (one device
  // ended up with three separate grants this way).
  async listAccessibleVaults(): Promise<Array<{ id: string; latestSequence: number }>> {
    const vaults = await this.api.listVaults();
    const accessible: Array<{ id: string; latestSequence: number }> = [];
    for (const vault of vaults) {
      try {
        await this.api.getWrappedKey(vault.id);
      } catch {
        continue; // no grant for this vault - not an option here
      }
      const status = await this.api.status(vault.id).catch(() => ({ latestSequence: 0 }));
      accessible.push({ id: vault.id, latestSequence: status.latestSequence });
    }
    return accessible;
  }

  async attachToVault(vaultId: string): Promise<void> {
    if (!this.settings.deviceSecretKeyB64) throw new Error("No device key pair on this device yet.");
    const { wrappedKey } = await this.api.getWrappedKey(vaultId);
    const vaultKey = unwrapVaultKey(base64ToBytes(wrappedKey), base64ToBytes(this.settings.deviceSecretKeyB64));

    this.settings.vaultId = vaultId;
    await this.saveSettings();
    this.vaultKey = vaultKey;
    this.needsVaultKeyRecovery = false;
    new Notice("Attached to vault. Pulling files…");

    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    await this.initEngine(new PluginDataStore(this, raw));
    const pulled = await this.engine?.pull();
    new Notice("Files pulled.");
    if (pulled) this.notifySkipped(pulled.skipped);
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
    const pulled = await this.engine?.pull();
    new Notice("Files pulled.");
    if (pulled) this.notifySkipped(pulled.skipped);
  }
}
