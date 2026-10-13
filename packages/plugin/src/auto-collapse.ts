import { Plugin, TFolder } from "obsidian";

// Collapsing a folder in Obsidian's file explorer only collapses that
// one folder - any already-expanded children stay expanded underneath
// it. This forces every descendant to collapse too, so re-expanding the
// parent later always comes back to the same simple, fully-collapsed
// state rather than whatever children happened to be left open.
//
// Obsidian's file-explorer collapse state isn't part of the public
// plugin API at all (confirmed against node_modules/obsidian's own
// type definitions - no folder-collapse API exists there). This reaches
// into the File Explorer view's internal (undocumented) `fileItems` map
// instead, the same way dedicated "auto collapse folders" community
// plugins do. Every internal-API access is wrapped so that if a future
// Obsidian version changes that internal shape, this silently stops
// doing anything instead of breaking the rest of the plugin.

interface InternalFileExplorerItem {
  setCollapsed?: (collapsed: boolean) => void;
}

interface InternalFileExplorerView {
  containerEl?: HTMLElement;
  fileItems?: Record<string, InternalFileExplorerItem>;
}

function getFileExplorerView(plugin: Plugin): InternalFileExplorerView | undefined {
  const leaf = plugin.app.workspace.getLeavesOfType("file-explorer")[0];
  return leaf?.view as unknown as InternalFileExplorerView | undefined;
}

export function setupAutoCollapseChildren(plugin: Plugin): void {
  // Re-entrancy guard: collapsing each child below also flips that
  // child's own "is-collapsed" class, which would otherwise re-trigger
  // this same observer callback for every descendant - harmless (an
  // already-collapsed folder's descendants are already collapsed too),
  // but pointless repeated work.
  let applying = false;
  let attached = false;

  const attach = () => {
    if (attached) return;
    const view = getFileExplorerView(plugin);
    if (!view?.containerEl) return;
    attached = true;

    const observer = new MutationObserver((mutations) => {
      if (applying) return;
      for (const mutation of mutations) {
        if (mutation.attributeName !== "class") continue;
        const el = mutation.target;
        if (!(el instanceof HTMLElement)) continue;
        if (!el.classList.contains("nav-folder") || !el.classList.contains("is-collapsed")) continue;

        const path = el.querySelector(":scope > .nav-folder-title")?.getAttribute("data-path");
        if (path == null) continue;
        collapseDescendants(plugin, view, path, (v) => {
          applying = v;
        });
      }
    });

    observer.observe(view.containerEl, { attributes: true, attributeFilter: ["class"], subtree: true });
    plugin.register(() => observer.disconnect());
  };

  // The file-explorer leaf may not exist yet at onload() time depending
  // on startup ordering - try once layout settles, and again whenever
  // the workspace layout changes (e.g. the explorer pane closed and
  // reopened later).
  plugin.app.workspace.onLayoutReady(attach);
  plugin.registerEvent(plugin.app.workspace.on("layout-change", attach));
}

function collapseDescendants(
  plugin: Plugin,
  view: InternalFileExplorerView,
  parentPath: string,
  setApplying: (value: boolean) => void,
): void {
  setApplying(true);
  try {
    const prefix = parentPath === "/" ? "" : `${parentPath}/`;
    for (const file of plugin.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder)) continue;
      if (file.path === parentPath || !file.path.startsWith(prefix)) continue;
      view.fileItems?.[file.path]?.setCollapsed?.(true);
    }
  } catch (err) {
    console.error("Synora: auto-collapse-children failed (Obsidian's internals may have changed)", err);
  } finally {
    setApplying(false);
  }
}
