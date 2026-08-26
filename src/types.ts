export interface UserRow {
  id: string;
  email: string;
  api_key_hash: string;
  plan: "free" | "pro";
  created_at: string;
}

export interface SourceRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  css_selector: string | null;
  check_interval_minutes: number;
  status: "active" | "paused";
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface SnapshotRow {
  id: string;
  source_id: string;
  content_hash: string;
  content_text: string;
  http_status: number | null;
  fetched_at: string;
}

export interface ChangeRow {
  id: string;
  source_id: string;
  user_id: string;
  old_snapshot_id: string | null;
  new_snapshot_id: string;
  diff_text: string;
  summary: string;
  severity: string;
  details: string;
  summary_source: string;
  added_lines: number;
  removed_lines: number;
  notified: number;
  notify_failed_count: number;
  created_at: string;
}

export interface ChannelRow {
  id: string;
  user_id: string;
  type: "slack" | "webhook";
  config: string;
  created_at: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: UserRow } };

export const PLANS = {
  free: { maxSources: 3, minIntervalMinutes: 60 },
  pro: { maxSources: 50, minIntervalMinutes: 10 },
} as const;

// Pricing UI is hidden while everyone is on the free tier. Flip to true to
// bring back the landing-page pricing section — PLANS and the Lemon Squeezy
// webhook stay wired underneath either way.
export const PRICING_ENABLED = false;

export function planFor(user: UserRow) {
  return PLANS[user.plan] ?? PLANS.free;
}

// Single source of truth for the SSRF bypass flag — used at every assertAllowedUrl
// call site so dev-only private-host access can't drift out of sync between them.
export function allowPrivateHosts(env: Env): boolean {
  return env.ENVIRONMENT === "development";
}
