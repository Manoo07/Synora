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

  it("round-trips identical content on both sides (no-op merge)", () => {
    const base = "a\nb\nc";
    const result = mergeText(base, base, base);
    expect(result.hasConflict).toBe(false);
    expect(result.lines.join("\n")).toBe(base);
  });
});
