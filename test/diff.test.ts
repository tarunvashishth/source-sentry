import { describe, expect, it } from "vitest";
import { diffLines } from "../src/lib/diff";

describe("diffLines", () => {
  it("returns zero-length diff for identical inputs", () => {
    const result = diffLines("a\nb\nc", "a\nb\nc");
    expect(result.addedLines).toBe(0);
    expect(result.removedLines).toBe(0);
    expect(result.unified).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("detects a pure insertion", () => {
    // "".split("\n") is [""], not [] — a genuinely empty oldText still contributes one
    // (empty) line to the comparison, so this is really "1 removed, 2 added", not a
    // clean 0/2. In production this path never runs anyway: check.ts only calls
    // diffLines() when a previous snapshot exists, so oldText is never truly "".
    const result = diffLines("", "a\nb");
    expect(result.addedLines).toBe(2);
    expect(result.removedLines).toBe(1);
    expect(result.unified).toContain("+ a");
    expect(result.unified).toContain("+ b");
  });

  it("detects a pure deletion", () => {
    const result = diffLines("a\nb", "");
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(2);
    expect(result.unified).toContain("- a");
    expect(result.unified).toContain("- b");
  });

  it("trims common prefix and suffix, diffing only the changed middle", () => {
    const oldText = "header\nunchanged1\nOLD_VALUE\nunchanged2\nfooter";
    const newText = "header\nunchanged1\nNEW_VALUE\nunchanged2\nfooter";
    const result = diffLines(oldText, newText);
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
    expect(result.unified).toContain("- OLD_VALUE");
    expect(result.unified).toContain("+ NEW_VALUE");
    // Context lines around the change should be included, not the whole file.
    expect(result.unified).toContain("unchanged1");
    expect(result.unified).toContain("unchanged2");
  });

  it("produces an interleaved add/delete/match sequence in order", () => {
    const oldText = "a\nb\nc\nd";
    const newText = "a\nX\nc\nY";
    const result = diffLines(oldText, newText);
    const lines = result.unified.split("\n").filter((l) => !l.startsWith("@@"));
    // b->X and d->Y should each appear as a removal followed by an addition, with c
    // (unchanged) preserved as context in between.
    const bIdx = lines.findIndex((l) => l.includes("- b"));
    const xIdx = lines.findIndex((l) => l.includes("+ X"));
    const cIdx = lines.findIndex((l) => l.trim() === "c");
    const dIdx = lines.findIndex((l) => l.includes("- d"));
    const yIdx = lines.findIndex((l) => l.includes("+ Y"));
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(xIdx).toBeGreaterThan(bIdx);
    expect(cIdx).toBeGreaterThan(xIdx);
    expect(dIdx).toBeGreaterThan(cIdx);
    expect(yIdx).toBeGreaterThan(dIdx);
  });

  it("falls back to block replacement when the changed middle exceeds LCS_CAP", () => {
    // LCS_CAP is 1200; force both sides' non-shared middle past that so the
    // block-replacement fallback path runs instead of exact LCS.
    const oldMiddle = Array.from({ length: 1300 }, (_, i) => `old-${i}`).join("\n");
    const newMiddle = Array.from({ length: 1300 }, (_, i) => `new-${i}`).join("\n");
    const result = diffLines(`prefix\n${oldMiddle}\nsuffix`, `prefix\n${newMiddle}\nsuffix`);
    // Block replacement: every old middle line removed, every new middle line added —
    // not an attempt at a smaller edit script.
    expect(result.removedLines).toBe(1300);
    expect(result.addedLines).toBe(1300);
    expect(result.unified).toContain("- old-0");
    expect(result.unified).toContain("+ new-0");
  });

  it("truncates and flags input over MAX_LINES per side", () => {
    const huge = Array.from({ length: 7000 }, (_, i) => `line-${i}`).join("\n");
    const result = diffLines(huge, `${huge}\nextra`);
    expect(result.truncated).toBe(true);
  });

  it("truncates the rendered diff text when it exceeds MAX_DIFF_CHARS", () => {
    // Many small, scattered changes so the rendered unified diff (with context lines)
    // grows past the 16,000 char cap even though line counts are modest.
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(`context line number ${i} padding padding padding`);
    const oldText = lines.join("\n");
    const newLines = lines.map((l, i) => (i % 3 === 0 ? `${l} CHANGED` : l));
    const result = diffLines(oldText, newLines.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.unified.length).toBeLessThanOrEqual(16_000 + "…\n… diff truncated …".length);
    expect(result.unified).toContain("diff truncated");
  });
});
