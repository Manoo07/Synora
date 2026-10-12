import { App, Modal } from "obsidian";

// Shown exactly once, right after vault creation. There is no way to
// retrieve this code later - the server only ever sees it wrapped, never
// in the clear - so losing it (with no other trusted device left) means
// the vault's content is permanently unrecoverable. See protocol-spec.md
// §2, "Recovery is a product decision".
export class RecoveryCodeModal extends Modal {
  constructor(app: App, private code: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Save your recovery code" });
    contentEl.createEl("p", {
      text: "This is the only way to regain access to this vault if you lose every device that currently has it. Synora cannot recover it for you - it never leaves your device in a form we can read.",
    });
    const codeEl = contentEl.createEl("code", { text: this.code });
    codeEl.style.display = "block";
    codeEl.style.whiteSpace = "pre-wrap";
    codeEl.style.wordBreak = "break-all";
    codeEl.style.padding = "0.75em";
    codeEl.style.marginTop = "0.5em";
    codeEl.style.userSelect = "all";

    const button = contentEl.createEl("button", { text: "Copy to clipboard" });
    button.style.marginTop = "1em";
    button.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.code);
      button.setText("Copied");
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
