import { allowPrivateHosts, type SnapshotRow, type SourceRow } from "../types";
import { diffLines } from "./diff";
import { fetchAndExtract } from "./extract";
import { newId, sha256Hex } from "./ids";
import { dispatchNotifications, type ChangeEvent } from "./notify";
import { summarizeChange } from "./summarize";

const SNAPSHOTS_KEPT_PER_SOURCE = 10;
const BATCH_SIZE = 25;
const CONCURRENCY = 5;
// Cron fires every 10 minutes (wrangler.jsonc); BATCH_SIZE=25 sources/tick means a max
// sustained throughput of 150/hour. Past that, sources silently drift behind their
// configured check_interval_minutes — see the oldest_overdue_minutes log in runDueChecks.
export const CHECK_NOW_TIMEOUT_MS = 15_000;

export interface CheckResult {
  changed: boolean;
  firstSnapshot?: boolean;
  changeId?: string;
  summary?: string;
  severity?: string;
  error?: string;
  notifyFailedCount?: number;
}

export async function runSourceCheck(env: Env, source: SourceRow): Promise<CheckResult> {
  let extracted;
  try {
    extracted = await fetchAndExtract(source.url, source.css_selector, allowPrivateHosts(env));
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 500);
    await env.DB.prepare(
      "UPDATE sources SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?",
    )
      .bind(message, source.id)
      .run();
    return { changed: false, error: message };
  }

  const hash = await sha256Hex(extracted.text);
  const prev = await env.DB.prepare(
    "SELECT * FROM snapshots WHERE source_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1",
  )
    .bind(source.id)
    .first<SnapshotRow>();

  if (prev && prev.content_hash === hash) {
    await env.DB.prepare(
      "UPDATE sources SET last_checked_at = datetime('now'), last_error = NULL WHERE id = ?",
    )
      .bind(source.id)
      .run();
    return { changed: false };
  }

  const snapshotId = newId("snap");
  await env.DB.prepare(
    "INSERT INTO snapshots (id, source_id, content_hash, content_text, http_status) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(snapshotId, source.id, hash, extracted.text, extracted.httpStatus)
    .run();

  // Prune only when there's actually something to prune — for the first
  // SNAPSHOTS_KEPT_PER_SOURCE checks of every source's life, the DELETE below would
  // always match zero rows; skip the (subquery + NOT IN) scan entirely until needed.
  const snapshotCount = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM snapshots WHERE source_id = ?",
  )
    .bind(source.id)
    .first<{ n: number }>();
  if ((snapshotCount?.n ?? 0) > SNAPSHOTS_KEPT_PER_SOURCE) {
    await env.DB.prepare(
      `DELETE FROM snapshots WHERE source_id = ?1 AND id NOT IN (
         SELECT id FROM snapshots WHERE source_id = ?1 ORDER BY fetched_at DESC, id DESC LIMIT ?2
       )`,
    )
      .bind(source.id, SNAPSHOTS_KEPT_PER_SOURCE)
      .run();
  }

  if (!prev) {
    await env.DB.prepare(
      "UPDATE sources SET last_checked_at = datetime('now'), last_error = NULL WHERE id = ?",
    )
      .bind(source.id)
      .run();
    return { changed: false, firstSnapshot: true };
  }

  const owner = await env.DB.prepare("SELECT plan FROM users WHERE id = ?")
    .bind(source.user_id)
    .first<{ plan: "free" | "pro" }>();
  const plan = owner?.plan ?? "free";

  const diff = diffLines(prev.content_text, extracted.text);
  const summary = await summarizeChange(env, source.name, source.url, diff, plan);

  const changeId = newId("chg");
  await env.DB.prepare(
    `INSERT INTO changes (id, source_id, user_id, old_snapshot_id, new_snapshot_id, diff_text,
       summary, severity, details, summary_source, added_lines, removed_lines)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      changeId,
      source.id,
      source.user_id,
      prev.id,
      snapshotId,
      diff.unified,
      summary.summary,
      summary.severity,
      JSON.stringify(summary.details),
      summary.summarySource,
      diff.addedLines,
      diff.removedLines,
    )
    .run();
  await env.DB.prepare(
    "UPDATE sources SET last_checked_at = datetime('now'), last_changed_at = datetime('now'), last_error = NULL WHERE id = ?",
  )
    .bind(source.id)
    .run();

  const event: ChangeEvent = {
    event: "source.changed",
    timestamp: new Date().toISOString(),
    source: { id: source.id, name: source.name, url: source.url, content_hash: hash },
    change: {
      id: changeId,
      summary: summary.summary,
      severity: summary.severity,
      details: summary.details,
      added_lines: diff.addedLines,
      removed_lines: diff.removedLines,
      diff_excerpt: diff.unified.slice(0, 2000),
      created_at: new Date().toISOString(),
    },
  };
  const dispatchResult = await dispatchNotifications(env, source.user_id, event);
  // "notified" means at least one channel actually received it — not just "we tried".
  // No channels configured isn't a delivery failure, so it still counts as notified.
  const notified = dispatchResult.attempted === 0 || dispatchResult.succeeded > 0 ? 1 : 0;
  await env.DB.prepare("UPDATE changes SET notified = ?, notify_failed_count = ? WHERE id = ?")
    .bind(notified, dispatchResult.failed, changeId)
    .run();

  return {
    changed: true,
    changeId,
    summary: summary.summary,
    severity: summary.severity,
    notifyFailedCount: dispatchResult.failed,
  };
}

export async function runDueChecks(env: Env): Promise<{
  checked: number;
  changed: number;
  errors: number;
}> {
  // Early-warning signal for the fixed-BATCH_SIZE scaling ceiling: the worst-case
  // drift (in minutes) of any active source past its own configured interval, across
  // ALL due sources — not just the ones that fit in this tick's batch. A non-zero and
  // growing value here means demand has outgrown 150 checks/hour before any customer
  // notices their alerts arriving late.
  const drift = await env.DB.prepare(
    `SELECT MAX(
       (strftime('%s','now') - strftime('%s', last_checked_at)) / 60.0 - check_interval_minutes
     ) as max_overdue_minutes
     FROM sources
     WHERE status = 'active' AND last_checked_at IS NOT NULL
       AND strftime('%s','now') - strftime('%s', last_checked_at) >= check_interval_minutes * 60`,
  ).first<{ max_overdue_minutes: number | null }>();

  const due = await env.DB.prepare(
    `SELECT * FROM sources
     WHERE status = 'active'
       AND (last_checked_at IS NULL
            OR strftime('%s','now') - strftime('%s', last_checked_at) >= check_interval_minutes * 60)
     ORDER BY last_checked_at ASC
     LIMIT ?`,
  )
    .bind(BATCH_SIZE)
    .all<SourceRow>();

  let changed = 0;
  let errors = 0;
  const sources = due.results;
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((s) => runSourceCheck(env, s)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "rejected") {
        errors++;
        console.log(
          JSON.stringify({
            event: "check_crashed",
            source_id: batch[j].id,
            error: String(r.reason),
          }),
        );
      } else {
        if (r.value.changed) changed++;
        if (r.value.error) errors++;
      }
    }
  }
  console.log(
    JSON.stringify({
      event: "cron_run",
      checked: sources.length,
      changed,
      errors,
      oldest_overdue_minutes: Math.round(drift?.max_overdue_minutes ?? 0),
    }),
  );
  return { checked: sources.length, changed, errors };
}
