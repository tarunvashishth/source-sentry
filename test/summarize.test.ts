import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { diffLines } from "../src/lib/diff";
import { summarizeChange } from "../src/lib/summarize";

const smallDiff = diffLines("Requests are limited to 100/min.", "Requests are limited to 60/min.");
const bigDiff = diffLines(
  "",
  Array.from({ length: 60 }, (_, i) => `new line ${i}`).join("\n"),
);

describe("summarizeChange — heuristic path (no ANTHROPIC_API_KEY / free plan)", () => {
  it("uses the heuristic summary when no ANTHROPIC_API_KEY is configured, regardless of plan", async () => {
    const envNoKey = { ...env, ANTHROPIC_API_KEY: undefined } as Env;
    const result = await summarizeChange(envNoKey, "Acme Docs", "https://example.com", smallDiff, "pro");
    expect(result.summarySource).toBe("heuristic");
    expect(result.summary).toContain("line(s) added");
  });

  it("free plan always gets the heuristic summary, even with a key configured", async () => {
    const envWithKey = { ...env, ANTHROPIC_API_KEY: "sk-test-fake" } as Env;
    const result = await summarizeChange(
      envWithKey,
      "Acme Docs",
      "https://example.com",
      smallDiff,
      "free",
    );
    expect(result.summarySource).toBe("heuristic");
    expect(result.summary).toContain("Upgrade to Pro");
  });

  it("pro plan without a key falls back to heuristic with the ops-facing message", async () => {
    const envNoKey = { ...env, ANTHROPIC_API_KEY: undefined } as Env;
    const result = await summarizeChange(envNoKey, "Acme Docs", "https://example.com", smallDiff, "pro");
    expect(result.summary).toContain("Set ANTHROPIC_API_KEY");
  });

  it("classifies severity as info for small changes", async () => {
    const envNoKey = { ...env, ANTHROPIC_API_KEY: undefined } as Env;
    const result = await summarizeChange(envNoKey, "Acme Docs", "https://example.com", smallDiff, "free");
    expect(result.severity).toBe("info");
  });

  it("classifies severity as major for large changes (>50 lines either direction)", async () => {
    const envNoKey = { ...env, ANTHROPIC_API_KEY: undefined } as Env;
    const result = await summarizeChange(envNoKey, "Acme Docs", "https://example.com", bigDiff, "free");
    expect(result.severity).toBe("major");
  });

  it("classifies severity as minor for medium changes (>10, <=50 lines)", async () => {
    const oldText = "";
    const newText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const diff = diffLines(oldText, newText);
    const envNoKey = { ...env, ANTHROPIC_API_KEY: undefined } as Env;
    const result = await summarizeChange(envNoKey, "Acme Docs", "https://example.com", diff, "free");
    expect(result.severity).toBe("minor");
  });

  it("caps heuristic detail bullets at 5 lines", async () => {
    const envNoKey = { ...env, ANTHROPIC_API_KEY: undefined } as Env;
    const result = await summarizeChange(envNoKey, "Acme Docs", "https://example.com", bigDiff, "free");
    expect(result.details.length).toBeLessThanOrEqual(5);
  });
});

// Live smoke test — proves the model ID and output_config.format.json_schema shape are
// actually accepted by the real Anthropic API, not just correct on paper (the gap the
// outside-voice cross-model tension flagged during review). Skipped unless a real key
// is present; never runs in CI without one configured.
describe.skipIf(!env.ANTHROPIC_API_KEY)("summarizeChange — live Claude call", () => {
  it("returns a Claude-sourced summary for a real diff against the live API", async () => {
    const result = await summarizeChange(
      env,
      "Acme Payments API",
      "https://example.com/docs",
      smallDiff,
      "pro",
    );
    expect(result.summarySource).toBe("claude");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(["info", "minor", "major", "breaking"]).toContain(result.severity);
  }, 30_000);
});
