import { App, Modal } from "obsidian";

// Shown when a device attaches to or recovers a vault that already has a
// primary device's preferences bundle available. Nothing applies
// automatically - this is the explicit opt-in the feature is built
// around, since applying overwrites this device's own current
// preferences and copies any other community plugins' own settings too.
export class ConfirmPreferencesModal extends Modal {
  constructor(app: App, private onConfirm: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Apply preferences from the primary device?" });
    contentEl.createEl("p", {
      text:
        "The primary device for this vault has shared its theme, community plugins (including their code), " +
        "core-plugin toggles, hotkeys, and CSS snippets.",
    });
    contentEl.createEl("p", {
      text:
        "Applying this overwrites this device's current versions of those files, and copies any other " +
        "community plugins' own settings too - skip this if another plugin stores something device-specific " +
        "you don't want duplicated. A restart (or reloading the vault) is needed afterward for any newly-added " +
        "plugins to actually load.",
    });

    const buttonRow = contentEl.createDiv();
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "0.5em";
    buttonRow.style.marginTop = "1em";

    const applyButton = buttonRow.createEl("button", { text: "Apply preferences" });
    applyButton.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });

    const skipButton = buttonRow.createEl("button", { text: "Skip" });
    skipButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
