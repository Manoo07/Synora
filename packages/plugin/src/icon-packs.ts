// Adding a new pack: append an entry here, then add its own
// `.synora-icon-pack-<id>` CSS block in styles.css - that's the whole
// change. The settings type (IconPackId), the dropdown's options
// (settings-tab.ts), and the body-class toggle (main.ts
// applyIconPack()) all derive from this one list instead of each
// separately hardcoding the set of packs.
export const ICON_PACKS = [
  { id: "none", label: "None (default)" },
  { id: "vscode", label: "VS Code style" },
] as const;

export type IconPackId = (typeof ICON_PACKS)[number]["id"];
