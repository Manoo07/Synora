import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type SynoraPlugin from "./main.js";
import { ApiError } from "./api/client.js";
import { ICON_PACKS, type IconPackId } from "./icon-packs.js";

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb < 10 ? 1 : 0)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export class SynoraSettingTab extends PluginSettingTab {
  private password = "";
  private recoveryEmail = "";
  private recoveryPassword = "";
  private recoveryCode = "";
  private pendingNotice = false;
  // Obsidian can invoke display() twice in quick succession when the tab
  // is opened (a known quirk - not something this plugin triggers). Each
  // call's async follow-ups (vault lookups, device list refreshes) used
  // to write into shared instance fields re-read at resolution time, so
  // a stale first call's callback could still land in the DOM the second
  // call had already rebuilt - confirmed live as a duplicated "No other
  // devices waiting." line. Every async callback below captures its own
  // generation and bails out if a newer display() has since superseded
  // it, rather than touching the DOM at all.
  private renderGeneration = 0;
  // Guards every network-triggering action on this tab against a second
  // click while the first is still in flight - without this, a button
  // with no visual feedback gets clicked repeatedly (confirmed live: 7
  // rapid duplicate login POSTs from one impatient click sequence).
  private isBusy = false;

  constructor(app: App, private plugin: SynoraPlugin) {
    super(app, plugin);
  }

  // Wraps a button's click handler so the button visibly shows it's
  // working (disabled + "loading label") and can't be re-triggered until
  // the action settles, regardless of which other button the user tries
  // next.
  private async runBusy(button: ButtonComponent, loadingLabel: string, action: () => Promise<void>): Promise<void> {
    if (this.isBusy) return;
    this.isBusy = true;
    const originalLabel = button.buttonEl.textContent ?? "";
    button.setDisabled(true).setButtonText(loadingLabel);
    try {
      await action();
    } catch (err) {
      // Without this, any action whose own handler doesn't already catch
      // its errors (e.g. Scan) fails as a silent unhandled rejection -
      // no Notice, nothing in the UI, just nothing visibly happening.
      // Confirmed live: exactly this, on mobile with no console access
      // to even notice the rejection in the first place.
      new Notice(`Synora: ${err instanceof Error ? err.message : String(err)}`, 15_000);
    } finally {
      this.isBusy = false;
      // On success most handlers call this.display(), which throws this
      // exact button away - restoring it here only matters on the error
      // path, where we stay on the same render.
      button.setDisabled(false).setButtonText(originalLabel);
    }
  }

  display(): void {
    this.renderGeneration++;
    this.containerEl.empty();

    this.containerEl.createEl("h2", { text: "Sync" });

    new Setting(this.containerEl).setName("Server URL").addText((text) =>
      text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value;
        this.plugin.api.setBaseUrl(value);
        await this.plugin.saveSettings();
      }),
    );

    new Setting(this.containerEl).setName("Device name").addText((text) =>
      text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
        this.plugin.settings.deviceName = value;
        await this.plugin.saveSettings();
      }),
    );

    const needsRecovery = this.pendingNotice || this.plugin.needsVaultKeyRecovery;
    if (this.plugin.settings.accessToken && !needsRecovery) {
      this.renderSignedIn();
    } else {
      this.renderSignIn(needsRecovery);
    }

    this.containerEl.createEl("h2", { text: "Appearance" });

    new Setting(this.containerEl)
      .setName("File icon pack")
      .setDesc("Adds file-type icons to the file explorer, for easier scanning of large vaults.")
      .addDropdown((dd) => {
        for (const pack of ICON_PACKS) dd.addOption(pack.id, pack.label);
        dd.setValue(this.plugin.settings.iconPack).onChange(async (value) => {
          this.plugin.settings.iconPack = value as IconPackId;
          await this.plugin.saveSettings();
          this.plugin.applyIconPack();
        });
      });

    new Setting(this.containerEl)
      .setName("Auto-collapse child folders")
      .setDesc(
        "Collapsing a folder also collapses everything inside it, so expanding it again always starts from the " +
          "same clean state. Relies on an internal Obsidian API, not an officially supported one - takes effect " +
          "on the next reload of Synora (or Obsidian restart), not immediately.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCollapseChildren ?? false).onChange(async (value) => {
          this.plugin.settings.autoCollapseChildren = value;
          await this.plugin.saveSettings();
        }),
      );

    this.containerEl.createEl("h2", { text: "Attachments" });

    new Setting(this.containerEl)
      .setName("Attachments folder")
      .setDesc(
        "Set a folder, then use \"Move images now\" to relocate every image in the vault there. " +
          "Notes referencing them are updated automatically (Obsidian's own rename behavior) - this is a one-time move, not an ongoing router.",
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. Attachments")
          .setValue(this.plugin.settings.attachmentFolder ?? "")
          .onChange(async (value) => {
            this.plugin.settings.attachmentFolder = value;
            await this.plugin.saveSettings();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Move images now").onClick(() =>
          void this.runBusy(btn, "Moving...", async () => {
            const { moved, skipped } = await this.plugin.moveImagesToConfiguredFolder();
            new Notice(`Synora: moved ${moved} image${moved === 1 ? "" : "s"} (${skipped} already there or skipped).`);
          }),
        ),
      );
  }

  renderSignIn(needsRecovery = false): void {
    if (needsRecovery) {
      const vaultNote = this.plugin.settings.vaultId ? ` for vault ${this.plugin.settings.vaultId}` : "";
      this.containerEl.createEl("p", {
        text: `This device (${this.plugin.settings.deviceName}) is signed in but doesn't have the vault key${vaultNote} yet. Either approve it from an already-trusted device, or use "Recover vault access" below with your recovery code - it's pre-filled with your email already.`,
      });
    }

    new Setting(this.containerEl).setName("Email").addText((text) =>
      text.onChange((value) => {
        this.plugin.settings.email = value;
      }),
    );

    new Setting(this.containerEl).setName("Password").addText((text) => {
      text.inputEl.type = "password";
      text.onChange((value) => {
        this.password = value;
      });
    });

    new Setting(this.containerEl)
      .addButton((btn) =>
        btn
          .setButtonText("Register new account")
          .onClick(() => void this.runBusy(btn, "Registering...", () => this.handleAuth("register"))),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Sign in")
          .setCta()
          .onClick(() => void this.runBusy(btn, "Signing in...", () => this.handleAuth("login"))),
      );

    this.renderRecoveryForm();
  }

  private renderRecoveryForm(): void {
    this.containerEl.createEl("h3", { text: "Recover vault access" });
    this.containerEl.createEl("p", {
      text: "No other trusted device around? Use the recovery code shown when the vault was created.",
    });

    new Setting(this.containerEl).setName("Email").addText((text) => {
      // Pre-filled when we already know the account email (e.g. this
      // device just had a session expire, or is mid-recovery) so the only
      // thing actually left to type is the password and recovery code.
      if (this.plugin.settings.email) {
        this.recoveryEmail = this.plugin.settings.email;
        text.setValue(this.plugin.settings.email);
      }
      text.onChange((value) => {
        this.recoveryEmail = value;
      });
    });
    new Setting(this.containerEl).setName("Password").addText((text) => {
      text.inputEl.type = "password";
      text.onChange((value) => {
        this.recoveryPassword = value;
      });
    });
    new Setting(this.containerEl).setName("Recovery code").addText((text) =>
      text.onChange((value) => {
        this.recoveryCode = value;
      }),
    );
    new Setting(this.containerEl).addButton((btn) =>
      btn
        .setButtonText("Recover vault")
        .setCta()
        .onClick(() => void this.runBusy(btn, "Recovering...", () => this.handleRecovery())),
    );
  }

  private async handleRecovery(): Promise<void> {
    if (!this.recoveryEmail || !this.recoveryPassword || !this.recoveryCode) {
      new Notice("Enter email, password, and the recovery code.");
      return;
    }
    try {
      await this.plugin.recoverVault(this.recoveryEmail, this.recoveryPassword, this.recoveryCode.trim());
      this.recoveryPassword = "";
      this.pendingNotice = false;
      this.display();
    } catch (err) {
      new Notice(`Recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  renderSignedIn(): void {
    const myGeneration = this.renderGeneration;
    const info = this.containerEl.createDiv({ cls: "synora-info-panel" });
    this.addInfoRow(info, "Account", this.plugin.settings.email ?? "unknown");
    const deviceValue = this.addInfoRow(info, "Device", this.plugin.settings.deviceName);
    deviceValue.title = this.plugin.settings.deviceId ?? "unknown id";

    if (!this.plugin.settings.vaultId) {
      // Don't assume "no vaultId on this device" means "no vault on this
      // account" - a device that's never been recovered looks identical
      // to a genuinely fresh account otherwise, and would happily create
      // a second, separate, empty vault instead of joining the real one.
      // Confirmed live, repeatedly: a device ended up with three separate
      // empty-vault grants from mis-tapping "Create vault" each time it
      // meant to reattach, because there was no direct "just use the one
      // you already have access to" option - only recovery (needs the
      // code) or create (the actual mis-tap target).
      const checkingEl = this.containerEl.createEl("p", { text: "Checking this account's vaults…" });
      void this.plugin
        .listAccessibleVaults()
        .then(async (accessible) => {
          if (myGeneration !== this.renderGeneration) return;
          checkingEl.remove();
          if (accessible.length > 0) {
            this.containerEl.createEl("h3", { text: "This device already has access to" });
            this.containerEl.createEl("p", {
              text: "No recovery code needed - pick the one with real content in it.",
            });
            for (const vault of accessible) {
              new Setting(this.containerEl)
                .setName(vault.id)
                .setDesc(vault.latestSequence > 0 ? `${vault.latestSequence} synced change(s)` : "Empty")
                .addButton((btn) =>
                  btn
                    .setButtonText("Attach")
                    .setCta()
                    .onClick(() => void this.runBusy(btn, "Attaching...", () => this.plugin.attachToVault(vault.id))),
                );
            }
          }

          const vaults = await this.plugin.api.listVaults();
          if (myGeneration !== this.renderGeneration) return;
          const foundExisting = vaults.length > 0;
          if (foundExisting) {
            this.containerEl.createEl("h3", { text: accessible.length > 0 ? "Or recover a different vault" : "Recover vault access" });
            this.containerEl.createEl("p", {
              text: `This account has a vault this device doesn't have direct access to yet. Use the recovery code shown when it was created.`,
            });
            this.renderRecoveryForm();
            this.containerEl.createEl("h3", { text: "Or create a separate vault" });
            this.containerEl.createEl("p", { text: "Only do this if you actually want an unrelated, empty vault." });
          }
          new Setting(this.containerEl)
            .setName(foundExisting ? "Create a new, separate vault" : "No vault yet")
            .addButton((btn) => {
              btn.setButtonText(foundExisting ? "Create an unrelated empty vault" : "Create vault").onClick(() =>
                void this.runBusy(btn, "Creating...", () => this.plugin.createVault()),
              );
              // Only the genuinely-first-vault-ever case gets the
              // prominent styling - whenever there's something to attach
              // to or recover instead, this button sitting at equal
              // visual weight is exactly what led to repeated mis-taps.
              if (!foundExisting && accessible.length === 0) btn.setCta();
            });
        })
        .catch(async (err) => {
          if (myGeneration !== this.renderGeneration) return;
          checkingEl.remove();
          if (await this.handleIfSessionExpired(err)) return;
          if (myGeneration !== this.renderGeneration) return;
          new Setting(this.containerEl)
            .setName("No vault yet")
            .setDesc(`Could not check for an existing vault: ${err instanceof Error ? err.message : String(err)}`)
            .addButton((btn) =>
              btn
                .setButtonText("Create vault")
                .setCta()
                .onClick(() => void this.runBusy(btn, "Creating...", () => this.plugin.createVault())),
            );
        });
    } else {
      const vaultId = this.plugin.settings.vaultId;
      const vaultValue = this.addInfoRow(info, "Vault", vaultId.slice(0, 8) + "…");
      vaultValue.title = vaultId;
      const syncValue = this.addInfoRow(info, "Sync", "Checking…");
      void this.renderSyncStatus(syncValue, myGeneration);

      new Setting(this.containerEl)
        .setName("Pause sync")
        .setDesc(
          "Stops all background syncing for the whole vault - genuinely zero requests while paused, " +
            "not just skipped uploads. Turning it back on syncs everything caught up in one go.",
        )
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.syncPaused ?? false).onChange(async (value) => {
            if (value) await this.plugin.pauseSync();
            else await this.plugin.resumeSync();
            this.display();
          }),
        );

      const pausedPaths = this.plugin.settings.pausedPaths ?? [];
      if (pausedPaths.length > 0) {
        this.containerEl.createEl("p", {
          text: "Individually paused files (right-click a file to pause/resume just that one):",
          cls: "synora-muted",
        });
        for (const path of pausedPaths) {
          new Setting(this.containerEl).setName(path).addButton((btn) =>
            btn.setButtonText("Resume").onClick(() =>
              void this.runBusy(btn, "Resuming...", async () => {
                await this.plugin.resumeFileSync(path);
                this.display();
              }),
            ),
          );
        }
      }

      new Setting(this.containerEl)
        .setName("Wrong vault?")
        .setDesc(
          "Detaches this device locally so you can recover the correct vault instead. Doesn't delete anything on the server.",
        )
        .addButton((btn) =>
          btn.setButtonText("Disconnect").onClick(() =>
            void this.runBusy(btn, "Disconnecting...", async () => {
              await this.plugin.disconnectFromVault();
              this.display();
            }),
          ),
        );
      new Setting(this.containerEl)
        .setName("Scan vault for existing files")
        .setDesc("Queues any file not yet synced - safe to run repeatedly, already-synced files are skipped.")
        .addButton((btn) =>
          btn.setButtonText("Scan").onClick(() =>
            void this.runBusy(btn, "Scanning...", async () => {
              await this.plugin.scanAndQueueExistingFiles();
              await this.renderSyncStatus(syncValue, myGeneration);
            }),
          ),
        );
      new Setting(this.containerEl)
        .setName("Pending devices")
        .setDesc("Devices waiting to be approved for this vault.")
        .addButton((btn) =>
          btn
            .setButtonText("Refresh")
            .onClick(() => void this.runBusy(btn, "Loading...", () => this.renderPendingDevices(pendingListEl, myGeneration))),
        );
      const pendingListEl = this.containerEl.createDiv();
      pendingListEl.createEl("p", { text: "Loading…", cls: "synora-muted" });
      void this.renderPendingDevices(pendingListEl, myGeneration);
    }
  }

  // A clean label/value row inside the account-status card, replacing a
  // loose <p> line. Returns the value element so callers (sync status,
  // in particular) can update it in place later.
  private addInfoRow(container: HTMLElement, label: string, value: string): HTMLElement {
    const row = container.createDiv({ cls: "synora-info-row" });
    row.createSpan({ cls: "synora-info-label", text: label });
    return row.createSpan({ cls: "synora-info-value", text: value });
  }

  // The clean "yes, everything is synced" signal the status bar alone
  // doesn't give: zero items left in this device's local upload queue.
  // Distinct from "nothing is happening right now" - a flush can finish
  // and still leave something queued (e.g. a conflict it just re-filed).
  // Takes its target element and the display() generation it belongs to
  // directly, rather than reading a shared instance field - see
  // renderGeneration above for why.
  private async renderSyncStatus(target: HTMLElement, generation: number): Promise<void> {
    const pending = await this.plugin.getPendingUploadCount();
    if (generation !== this.renderGeneration) return;
    let text = pending > 0 ? `⟳ ${pending} file${pending === 1 ? "" : "s"} waiting to upload` : "✓ All files synced";

    try {
      const usage = await this.plugin.api.getUsage();
      if (usage.plan === "free") {
        text += ` · ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.limitBytes)} used`;
        text += ` · ${usage.deviceCount} of ${usage.deviceLimit} device${usage.deviceLimit === 1 ? "" : "s"}`;
      }
    } catch {
      // Usage is a nice-to-have on top of the sync status above, which
      // already rendered - not worth failing the whole status line over.
    }

    if (generation !== this.renderGeneration) return;
    target.setText(text);
  }

  private async renderPendingDevices(target: HTMLElement, generation: number): Promise<void> {
    if (!this.plugin.settings.vaultId) return;
    target.empty();
    try {
      const { pending } = await this.plugin.api.listDevices(this.plugin.settings.vaultId);
      if (generation !== this.renderGeneration) return;
      const others = (pending as Array<{ id: string; name: string; publicKey: string }>).filter(
        (d) => d.id !== this.plugin.settings.deviceId,
      );
      if (others.length === 0) {
        target.createEl("p", { text: "No other devices waiting.", cls: "synora-muted" });
      }
      for (const device of others) {
        new Setting(target).setName(device.name).addButton((btn) =>
          btn
            .setButtonText("Approve")
            .setCta()
            .onClick(() =>
              void this.runBusy(btn, "Approving...", () => this.plugin.approveDevice(device.id, device.publicKey)),
            ),
        );
      }
    } catch (err) {
      if (await this.handleIfSessionExpired(err)) return;
      if (generation !== this.renderGeneration) return;
      target.createEl("p", {
        text: `Could not load pending devices: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // A stale access token doesn't mean "signed out" from the server's
  // perspective (the device stays active) - it just means this JWT
  // stopped working. Before this, the UI kept showing "Signed in as ..."
  // forever while every call silently failed "Invalid or expired token",
  // with no way back in short of restarting Obsidian. Dropping the token
  // and re-rendering into the sign-in form (same email, device keys
  // intact) is the honest and recoverable state to show instead.
  private async handleIfSessionExpired(err: unknown): Promise<boolean> {
    if (!(err instanceof ApiError) || err.status !== 401) return false;
    this.plugin.settings.accessToken = undefined;
    await this.plugin.saveSettings();
    new Notice("Your session expired. Please sign in again.");
    this.display();
    return true;
  }

  private async handleAuth(mode: "register" | "login"): Promise<void> {
    const { email } = this.plugin.settings;
    if (!email || !this.password) {
      new Notice("Enter an email and password first.");
      return;
    }
    try {
      const status = await this.plugin.signIn(mode, email, this.password);
      this.password = "";
      this.pendingNotice = status === "pending";
      // A fresh sign-in is exactly when a previously torn-down engine
      // (e.g. after a 401) needs to come back up - nothing else triggers
      // that on its own. No-ops harmlessly if it's already running.
      if (status === "active") await this.plugin.ensureEngineInitialized();
      this.display();
    } catch (err) {
      new Notice(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
