import { describe, expect, it } from "vitest";
import { mergeText } from "../src/sync/merge.js";

describe("mergeText", () => {
  it("merges disjoint edits without conflict", () => {
    const base = "line1\nline2\nline3\nline4\nline5";
    const local = "LOCAL1\nline2\nline3\nline4\nline5"; // edited top
    const remote = "line1\nline2\nline3\nline4\nREMOTE5"; // edited bottom

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe("LOCAL1\nline2\nline3\nline4\nREMOTE5");
  });

  it("flags a conflict when both sides edit the same line differently", () => {
    const base = "line1\nline2\nline3";
    const local = "line1\nLOCAL-CHANGE\nline3";
    const remote = "line1\nREMOTE-CHANGE\nline3";

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(true);
  });

  it("does not flag a conflict when both sides make the identical edit", () => {
    const base = "line1\nline2\nline3";
    const local = "line1\nSAME-CHANGE\nline3";
    const remote = "line1\nSAME-CHANGE\nline3";

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe("line1\nSAME-CHANGE\nline3");
  });

  it("applies the only side that changed when the other is untouched", () => {
    const base = "line1\nline2\nline3";
    const local = "line1\nline2\nline3"; // unchanged
    const remote = "line1\nEDITED\nline3";

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe("line1\nEDITED\nline3");
  });

  it("merges a pure insertion on one side with an edit elsewhere on the other", () => {
    const base = "line1\nline2\nline3";
    const local = "line1\nNEW LINE\nline2\nline3"; // inserted after line1
    const remote = "line1\nline2\nEDITED3"; // edited line3

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe("line1\nNEW LINE\nline2\nEDITED3");
  });

  it("flags a conflict when both sides insert different content at the same point", () => {
    const base = "line1\nline2";
    const local = "line1\nLOCAL INSERT\nline2";
    const remote = "line1\nREMOTE INSERT\nline2";

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(true);
  });

  it("never silently drops one side's deletion of a repeated identical line", () => {
    // Both sides delete a DIFFERENT instance of an identical repeated
    // line. The two diffs are computed independently, so they can report
    // hunks that look like "the same edit" even though two separate
    // lines were removed. Collapsing them would drop one deletion, which
    // then re-diverges and re-conflicts on every subsequent sync.
    const base = "anchor\nsame\nsame\nsame\nsame";
    const local = "anchor\nsame\nsame\nsame"; // removed one
    const remote = "anchor\nsame\nsame\nsame"; // removed a different one

    const result = mergeText(base, local, remote);
    // Which instance each side removed is undecidable from the text, so
    // the only safe answer is the caller's preserve-both fallback - what
    // must never happen is claiming a clean merge that keeps a line both
    // sides deleted.
    if (!result.hasConflict) {
      expect(result.lines.length).toBe(3);
    }
  });

  it("still collapses a genuine identical edit on a uniquely identifiable line", () => {
    // Guard against the fix above over-triggering: when the edited range
    // is unique in the file there is no ambiguity, so two sides making
    // the same change must still merge cleanly rather than conflict.
    const base = "intro\nsame\nunique-target\nsame\noutro";
    const local = "intro\nsame\nEDITED\nsame\noutro";
    const remote = "intro\nsame\nEDITED\nsame\noutro";

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe("intro\nsame\nEDITED\nsame\noutro");
  });

  it("merges independent edits in the middle of a file", () => {
    const base = "h1\n\npara one\n\npara two\n\npara three\n\nend";
    const local = "h1\n\npara one EDITED\n\npara two\n\npara three\n\nend";
    const remote = "h1\n\npara one\n\npara two\n\npara three EDITED\n\nend";

    const result = mergeText(base, local, remote);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe("h1\n\npara one EDITED\n\npara two\n\npara three EDITED\n\nend");
  });

  it("round-trips identical content on both sides (no-op merge)", () => {
    const base = "a\nb\nc";
    const result = mergeText(base, base, base);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe(base);
  });
});
