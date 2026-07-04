import type { ChannelRow } from "../types";
import { hmacSha256Hex } from "./ids";

export interface ChangeEvent {
  event: "source.changed" | "channel.test";
  timestamp: string;
  source: { id: string; name: string; url: string; content_hash: string };
  change: {
    id: string;
    summary: string;
    severity: string;
    details: string[];
    added_lines: number;
    removed_lines: number;
    diff_excerpt: string;
    created_at: string;
  };
}

interface ChannelConfig {
  url: string;
  secret?: string;
}

export interface DispatchResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

export async function dispatchNotifications(
  env: Env,
  userId: string,
  event: ChangeEvent,
): Promise<DispatchResult> {
  const channels = await env.DB.prepare("SELECT * FROM channels WHERE user_id = ?")
    .bind(userId)
    .all<ChannelRow>();
  const results = await Promise.allSettled(
    channels.results.map((ch) => sendToChannel(ch, event)),
  );
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      failed++;
      console.log(
        JSON.stringify({
          event: "notify_failed",
          channel_id: channels.results[i].id,
          channel_type: channels.results[i].type,
          error: String(r.reason),
        }),
      );
    }
  }
  return { attempted: results.length, succeeded: results.length - failed, failed };
}

export async function sendToChannel(channel: ChannelRow, event: ChangeEvent): Promise<void> {
  const config = JSON.parse(channel.config) as ChannelConfig;
  if (channel.type === "slack") {
    await sendSlack(config.url, event);
  } else {
    await sendWebhook(config, event);
  }
}

async function sendSlack(url: string, event: ChangeEvent): Promise<void> {
  const bullets = event.change.details.map((d) => `• ${d}`).join("\n");
  const text = [
    `:bell: *${event.source.name}* changed — *${event.change.severity}*`,
    event.change.summary,
    bullets,
    `<${event.source.url}|View source> · +${event.change.added_lines}/−${event.change.removed_lines} lines`,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`slack webhook returned HTTP ${res.status}`);
  await res.body?.cancel();
}

async function sendWebhook(config: ChannelConfig, event: ChangeEvent): Promise<void> {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "SourceSentry-Webhooks/1.0",
    "x-sourcesentry-event": event.event,
  };
  if (config.secret) {
    headers["x-sourcesentry-signature"] = `sha256=${await hmacSha256Hex(config.secret, body)}`;
  }
  const res = await fetch(config.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
  await res.body?.cancel();
}

export function testEvent(): ChangeEvent {
  const now = new Date().toISOString();
  return {
    event: "channel.test",
    timestamp: now,
    source: {
      id: "src_test",
      name: "Test source",
      url: "https://example.com/docs",
      content_hash: "0".repeat(64),
    },
    change: {
      id: "chg_test",
      summary: "This is a test notification from Source Sentry.",
      severity: "info",
      details: ["If you can read this, the channel is wired up correctly."],
      added_lines: 1,
      removed_lines: 0,
      diff_excerpt: "+ Hello from Source Sentry",
      created_at: now,
    },
  };
}
