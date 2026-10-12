import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SynoraPlugin from "./main.js";

export class SynoraSettingTab extends PluginSettingTab {
  private password = "";
  private recoveryEmail = "";
  private recoveryPassword = "";
  private recoveryCode = "";
  private pendingNotice = false;

  constructor(app: App, private plugin: SynoraPlugin) {
    super(app, plugin);
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
        btn.setButtonText("Register new account").onClick(() => void this.handleAuth("register")),
      )
      .addButton((btn) => btn.setButtonText("Sign in").setCta().onClick(() => void this.handleAuth("login")));

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
      btn.setButtonText("Recover vault").setCta().onClick(() => void this.handleRecovery()),
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
          btn.setButtonText("Create vault").setCta().onClick(() => void this.plugin.createVault()),
        );
    } else {
      this.containerEl.createEl("p", { text: `Vault: ${this.plugin.settings.vaultId}` });
      new Setting(this.containerEl)
        .setName("Pending devices")
        .setDesc("Devices waiting to be approved for this vault.")
        .addButton((btn) => btn.setButtonText("Refresh").onClick(() => void this.renderPendingDevices()));
      this.pendingListEl = this.containerEl.createDiv();
      void this.renderPendingDevices();
    }
  }

  private pendingListEl?: HTMLElement;

  private async renderPendingDevices(): Promise<void> {
    if (!this.pendingListEl || !this.plugin.settings.vaultId) return;
    this.pendingListEl.empty();
    try {
      const { pending } = await this.plugin.api.listDevices(this.plugin.settings.vaultId);
      for (const device of pending as Array<{ id: string; name: string; publicKey: string }>) {
        new Setting(this.pendingListEl).setName(device.name).addButton((btn) =>
          btn
            .setButtonText("Approve")
            .setCta()
            .onClick(() => void this.plugin.approveDevice(device.id, device.publicKey)),
        );
      }
    } catch {
      this.pendingListEl.createEl("p", { text: "Could not load pending devices." });
    }
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
