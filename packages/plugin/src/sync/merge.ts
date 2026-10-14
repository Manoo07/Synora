// A from-scratch line-based three-way merge (diff3-style), used only to
// try to resolve a sync conflict automatically for plain text notes. This
// is NOT security- or correctness-critical the way the crypto layer is:
// the engine only trusts `hasConflict: false` to skip its safe fallback
// (preserve both versions as separate files); any bug here just means we
// fall back to that always-safe path more often than strictly necessary,
// never that we silently lose an edit. See architecture doc's conflict
// policy table, "Both changed, safe text merge" row.

interface Hunk {
  baseStart: number;
  baseEnd: number; // [baseStart, baseEnd) range of BASE lines this hunk replaces
  lines: string[]; // the replacement lines from the non-base side
}

function lcsMatchedPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

// Hunks describing where `other` differs from `base`: each hunk says
// "base lines [baseStart, baseEnd) were replaced by these other lines".
// Hunks are non-overlapping and sorted by baseStart, since they come
// directly from walking the LCS alignment in order.
function computeHunks(base: string[], other: string[]): Hunk[] {
  const pairs = lcsMatchedPairs(base, other);
  const hunks: Hunk[] = [];
  let baseIdx = 0;
  let otherIdx = 0;
  for (const [bi, oi] of pairs) {
    if (bi > baseIdx || oi > otherIdx) {
      hunks.push({ baseStart: baseIdx, baseEnd: bi, lines: other.slice(otherIdx, oi) });
    }
    baseIdx = bi + 1;
    otherIdx = oi + 1;
  }
  if (baseIdx < base.length || otherIdx < other.length) {
    hunks.push({ baseStart: baseIdx, baseEnd: base.length, lines: other.slice(otherIdx) });
  }
  return hunks;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// True when the base lines in [start, end) also occur, identically, at
// some other position in base - i.e. that range is NOT uniquely
// identifiable by its content alone.
function appearsElsewhere(baseLines: string[], start: number, end: number): boolean {
  const needle = baseLines.slice(start, end);
  if (needle.length === 0) return false;
  for (let i = 0; i <= baseLines.length - needle.length; i++) {
    if (i === start) continue;
    if (arraysEqual(baseLines.slice(i, i + needle.length), needle)) return true;
  }
  return false;
}

function reconstructFromHunks(baseLines: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let baseIdx = 0;
  for (const h of hunks) {
    out.push(...baseLines.slice(baseIdx, h.baseStart));
    out.push(...h.lines);
    baseIdx = h.baseEnd;
  }
  out.push(...baseLines.slice(baseIdx));
  return out;
}

export interface MergeResult {
  lines: string[];
  hasConflict: boolean;
}

// Merges hunks from both sides against the shared base. Hunks that don't
// overlap each other's base range apply cleanly; hunks that do overlap
// are clustered together and resolved as a conflict unless they're the
// exact same single edit (both sides changed the same base range to the
// same replacement).
export function mergeLines(baseLines: string[], localLines: string[], remoteLines: string[]): MergeResult {
  const localHunks = computeHunks(baseLines, localLines).map((h) => ({ ...h, side: "local" as const }));
  const remoteHunks = computeHunks(baseLines, remoteLines).map((h) => ({ ...h, side: "remote" as const }));

  // computeHunks' two calls are independent - each one's own LCS
  // alignment can be ambiguous around repeated/similar lines (a known
  // class of diff edge case), and the two calls have no way to agree
  // with each other about which physical line is which when that
  // happens. Verify each side's hunks actually reconstruct that side's
  // real content before trusting them for anything below - if they
  // don't, this input broke the hunk computation, and the only safe
  // thing left to do is report a conflict (the caller's always-safe
  // preserve-both fallback) rather than risk silently merging to content
  // that matches neither device's actual file. Without this, a wrong-
  // but-unflagged merge gets committed and re-diverges on the very next
  // sync, looping back into conflict resolution indefinitely - confirmed
  // live as a real, serious bug (a user had to disable the plugin).
  if (
    !arraysEqual(reconstructFromHunks(baseLines, localHunks), localLines) ||
    !arraysEqual(reconstructFromHunks(baseLines, remoteHunks), remoteLines)
  ) {
    return { lines: [...localLines, ...remoteLines], hasConflict: true };
  }

  const all = [...localHunks, ...remoteHunks].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

  const clusters: Array<typeof all> = [];
  for (const h of all) {
    const last = clusters.at(-1);
    const lastEnd = last ? Math.max(...last.map((x) => x.baseEnd)) : -1;
    if (last && h.baseStart <= lastEnd) {
      last.push(h);
    } else {
      clusters.push([h]);
    }
  }

  let hasConflict = false;
  const out: string[] = [];
  let baseIdx = 0;

  for (const cluster of clusters) {
    const start = Math.min(...cluster.map((h) => h.baseStart));
    const end = Math.max(...cluster.map((h) => h.baseEnd));
    out.push(...baseLines.slice(baseIdx, start));

    const localOnes = cluster.filter((h) => h.side === "local").sort((a, b) => a.baseStart - b.baseStart);
    const remoteOnes = cluster.filter((h) => h.side === "remote").sort((a, b) => a.baseStart - b.baseStart);

    if (localOnes.length === 0) {
      for (const h of remoteOnes) out.push(...h.lines);
    } else if (remoteOnes.length === 0) {
      for (const h of localOnes) out.push(...h.lines);
    } else {
      const localFlat = localOnes.flatMap((h) => h.lines);
      const remoteFlat = remoteOnes.flatMap((h) => h.lines);
      const sameSingleEdit =
        localOnes.length === 1 &&
        remoteOnes.length === 1 &&
        localOnes[0]!.baseStart === remoteOnes[0]!.baseStart &&
        localOnes[0]!.baseEnd === remoteOnes[0]!.baseEnd &&
        arraysEqual(localFlat, remoteFlat) &&
        // ...and the base range both sides supposedly edited is unique
        // in the file. The two computeHunks calls are independent, so
        // over repeated identical lines they can each pick a DIFFERENT
        // physical instance and still report hunks that look identical
        // here. Collapsing those to a single edit silently drops one
        // side's change: base ["x","a","a","a","a"] where local removes
        // one "a" and remote removes a different "a" must end up with
        // two removed, but without this guard only one is applied. The
        // dropped edit then re-diverges on the next sync and the devices
        // keep re-resolving the same conflict forever - confirmed live
        // as a real bug (a user had to disable the plugin).
        !appearsElsewhere(baseLines, localOnes[0]!.baseStart, localOnes[0]!.baseEnd);
      if (sameSingleEdit) {
        out.push(...localFlat);
      } else {
        // Genuine overlap - the caller falls back to its always-safe
        // preserve-both path and never reads `out` in this case, so what
        // we push here doesn't need to be meaningful, only present.
        hasConflict = true;
        out.push(...localFlat, ...remoteFlat);
      }
    }
    baseIdx = end;
  }
  out.push(...baseLines.slice(baseIdx));

  return { lines: out, hasConflict };
}

export function mergeText(base: string, local: string, remote: string): MergeResult {
  return mergeLines(base.split("\n"), local.split("\n"), remote.split("\n"));
}
