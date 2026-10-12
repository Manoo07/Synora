import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type SynoraPlugin from "./main.js";
import { ApiError } from "./api/client.js";

export class SynoraSettingTab extends PluginSettingTab {
  private password = "";
  private recoveryEmail = "";
  private recoveryPassword = "";
  private recoveryCode = "";
  private pendingNotice = false;
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
    } finally {
      this.isBusy = false;
      // On success most handlers call this.display(), which throws this
      // exact button away - restoring it here only matters on the error
      // path, where we stay on the same render.
      button.setDisabled(false).setButtonText(originalLabel);
    }
  }

  display(): void {
    this.containerEl.empty();

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

    if (this.plugin.settings.accessToken && !this.pendingNotice) {
      this.renderSignedIn();
    } else {
      this.renderSignIn();
    }
  }

  renderSignIn(): void {
    if (this.pendingNotice) {
      this.containerEl.createEl("p", {
        text: "Signed in, but this device isn't enrolled in a vault yet. Either approve it from an already-trusted device, or recover vault access below using your recovery code.",
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

    this.containerEl.createEl("h3", { text: "Recover vault access" });
    this.containerEl.createEl("p", {
      text: "No other trusted device around? Use the recovery code shown when the vault was created.",
    });

    new Setting(this.containerEl).setName("Email").addText((text) =>
      text.onChange((value) => {
        this.recoveryEmail = value;
      }),
    );
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
    this.containerEl.createEl("p", { text: `Signed in as ${this.plugin.settings.email ?? "unknown"}` });

    if (!this.plugin.settings.vaultId) {
      new Setting(this.containerEl)
        .setName("No vault yet")
        .addButton((btn) =>
          btn
            .setButtonText("Create vault")
            .setCta()
            .onClick(() => void this.runBusy(btn, "Creating...", () => this.plugin.createVault())),
        );
    } else {
      this.containerEl.createEl("p", { text: `Vault: ${this.plugin.settings.vaultId}` });
      new Setting(this.containerEl)
        .setName("Pending devices")
        .setDesc("Devices waiting to be approved for this vault.")
        .addButton((btn) =>
          btn.setButtonText("Refresh").onClick(() => void this.runBusy(btn, "Loading...", () => this.renderPendingDevices())),
        );
      this.pendingListEl = this.containerEl.createDiv();
      this.pendingListEl.createEl("p", { text: "Loading…" });
      void this.renderPendingDevices();
    }
  }

  private pendingListEl?: HTMLElement;

  private async renderPendingDevices(): Promise<void> {
    if (!this.pendingListEl || !this.plugin.settings.vaultId) return;
    this.pendingListEl.empty();
    try {
      const { pending } = await this.plugin.api.listDevices(this.plugin.settings.vaultId);
      if (pending.length === 0) {
        this.pendingListEl.createEl("p", { text: "No devices waiting." });
      }
      for (const device of pending as Array<{ id: string; name: string; publicKey: string }>) {
        new Setting(this.pendingListEl).setName(device.name).addButton((btn) =>
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
      this.pendingListEl.createEl("p", {
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
      this.display();
    } catch (err) {
      new Notice(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
