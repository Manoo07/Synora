// Prevents sync loops: when the engine writes a remote change into the
// vault, Obsidian fires a normal file-change event for it. A naive global
// "isSyncing" flag would also suppress a genuine concurrent user edit that
// happens to land in that same window, so instead we tag suppression to
// the exact (path, content hash) pair the engine just wrote. The vault
// event handler consumes the mark - once checked, it's gone, so a second
// edit to the same path is never accidentally swallowed.
// See architecture doc §6, "Prevent sync loops".
export class WriteSuppressor {
  private pending = new Map<string, Set<string>>();

  markApplied(path: string, contentHash: string): void {
    const set = this.pending.get(path) ?? new Set<string>();
    set.add(contentHash);
    this.pending.set(path, set);
  }

  shouldSuppress(path: string, contentHash: string): boolean {
    const set = this.pending.get(path);
    if (!set?.has(contentHash)) return false;
    set.delete(contentHash);
    if (set.size === 0) this.pending.delete(path);
    return true;
  }
}
