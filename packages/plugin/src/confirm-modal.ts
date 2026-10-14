import { App, Modal } from "obsidian";

// A plain yes/no gate for actions that cannot be undone from the UI.
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: { title: string; body: string[]; confirmText: string; onConfirm: () => void },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.opts.title });
    for (const paragraph of this.opts.body) contentEl.createEl("p", { text: paragraph });

    const buttonRow = contentEl.createDiv();
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "0.5em";
    buttonRow.style.marginTop = "1em";

    const confirmButton = buttonRow.createEl("button", { text: this.opts.confirmText });
    confirmButton.addClass("mod-warning");
    confirmButton.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm();
    });

    const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
