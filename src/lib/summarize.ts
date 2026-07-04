import Anthropic from "@anthropic-ai/sdk";
import type { DiffResult } from "./diff";

const SEVERITIES = ["info", "minor", "major", "breaking"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ChangeSummary {
  summary: string;
  severity: Severity;
  details: string[];
  summarySource: "claude" | "heuristic";
}

const SYSTEM_PROMPT =
  "You analyze diffs of monitored web content (API documentation, terms of service, policies, changelogs, knowledge-base pages) for developers whose products depend on that content staying accurate. Explain what changed and why it matters. Severity guide: breaking = consumers must act (removed/renamed endpoints or fields, auth changes, legal terms that force action); major = significant behavior/policy change worth reviewing soon; minor = small substantive edits; info = cosmetic or editorial changes.";

export async function summarizeChange(
  env: Env,
  sourceName: string,
  sourceUrl: string,
  diff: DiffResult,
  plan: "free" | "pro",
): Promise<ChangeSummary> {
  // Claude summaries are a pro-plan feature — every detected change on any plan runs
  // the same Claude call otherwise, so free-tier COGS would scale with total signups
  // rather than paying customers. Free tier gets the heuristic summary.
  if (plan === "pro" && env.ANTHROPIC_API_KEY) {
    try {
      return await claudeSummary(env, sourceName, sourceUrl, diff);
    } catch (err) {
      console.log(
        JSON.stringify({ event: "summary_fallback", source: sourceName, error: String(err) }),
      );
    }
  }
  return heuristicSummary(diff, plan);
}

async function claudeSummary(
  env: Env,
  sourceName: string,
  sourceUrl: string,
  diff: DiffResult,
): Promise<ChangeSummary> {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: 60_000,
    maxRetries: 1,
  });

  const response = await client.messages.create({
    model: env.SUMMARY_MODEL || "claude-opus-4-8",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Source: ${sourceName}\nURL: ${sourceUrl}\n\nUnified diff of the monitored content (lines starting with "-" were removed, "+" were added, two spaces are unchanged context):\n\n${diff.unified}\n\nSummarize what changed and why it matters to someone who depends on this content.`,
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "One or two sentences: what changed and why it matters.",
            },
            severity: { type: "string", enum: [...SEVERITIES] },
            details: {
              type: "array",
              items: { type: "string" },
              description: "Up to five short bullet points covering the notable changes.",
            },
          },
          required: ["summary", "severity", "details"],
          additionalProperties: false,
        },
      },
    },
  });

  if (response.stop_reason === "refusal") throw new Error("model declined the request");
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const parsed = JSON.parse(text) as { summary: string; severity: string; details: string[] };
  const severity = (SEVERITIES as readonly string[]).includes(parsed.severity)
    ? (parsed.severity as Severity)
    : "info";
  return {
    summary: parsed.summary,
    severity,
    details: (parsed.details ?? []).slice(0, 5),
    summarySource: "claude",
  };
}

function heuristicSummary(diff: DiffResult, plan: "free" | "pro"): ChangeSummary {
  const changed = diff.addedLines + diff.removedLines;
  const severity: Severity =
    diff.removedLines > 50 || diff.addedLines > 50 ? "major" : changed > 10 ? "minor" : "info";
  const changedLines = diff.unified
    .split("\n")
    .filter((l) => l.startsWith("+ ") || l.startsWith("- "))
    .slice(0, 5)
    .map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l));
  const upsell =
    plan === "free"
      ? "Upgrade to Pro for AI summaries of what changed and why it matters."
      : "Set ANTHROPIC_API_KEY for AI summaries of what changed and why it matters.";
  return {
    summary: `${diff.addedLines} line(s) added, ${diff.removedLines} removed. (${upsell})`,
    severity,
    details: changedLines,
    summarySource: "heuristic",
  };
}
