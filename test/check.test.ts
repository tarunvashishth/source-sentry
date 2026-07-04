import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDueChecks, runSourceCheck } from "../src/lib/check";
import { newId } from "../src/lib/ids";
import type { SourceRow } from "../src/types";

async function insertUser(plan: "free" | "pro" = "free"): Promise<string> {
  const id = newId("usr");
  await env.DB.prepare("INSERT INTO users (id, email, api_key_hash, plan) VALUES (?, ?, ?, ?)")
    .bind(id, `${id}@example.com`, `hash-${id}`, plan)
    .run();
  return id;
}

async function insertSource(
  userId: string,
  overrides: Partial<Pick<SourceRow, "check_interval_minutes" | "last_checked_at" | "status">> = {},
): Promise<SourceRow> {
  const id = newId("src");
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, name, url, check_interval_minutes, status, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      "Test Source",
      `https://example.com/${id}`,
      overrides.check_interval_minutes ?? 60,
      overrides.status ?? "active",
      overrides.last_checked_at ?? null,
    )
    .run();
  const row = await env.DB.prepare("SELECT * FROM sources WHERE id = ?")
    .bind(id)
    .first<SourceRow>();
  if (!row) throw new Error("failed to insert test source");
  return row;
}

function mockFetchHtml(html: string) {
  // A fresh Response per call — Response bodies are single-use streams, and
  // mockResolvedValue() would otherwise hand back the same locked stream on retries.
  globalThis.fetch = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
}

describe("runSourceCheck", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("captures a baseline snapshot on the first check, without diffing or notifying", async () => {
    mockFetchHtml("<p>Version 1 content</p>");
    const userId = await insertUser();
    const source = await insertSource(userId);

    const result = await runSourceCheck(env, source);
    expect(result).toEqual({ changed: false, firstSnapshot: true });

    const snapshots = await env.DB.prepare("SELECT * FROM snapshots WHERE source_id = ?")
      .bind(source.id)
      .all();
    expect(snapshots.results).toHaveLength(1);

    const changes = await env.DB.prepare("SELECT * FROM changes WHERE source_id = ?")
      .bind(source.id)
      .all();
    expect(changes.results).toHaveLength(0);
  });

  it("reports no change when content hash is identical to the last snapshot", async () => {
    mockFetchHtml("<p>Stable content</p>");
    const userId = await insertUser();
    const source = await insertSource(userId);

    await runSourceCheck(env, source); // baseline
    const result = await runSourceCheck(env, source); // same content again
    expect(result).toEqual({ changed: false });

    const snapshots = await env.DB.prepare("SELECT * FROM snapshots WHERE source_id = ?")
      .bind(source.id)
      .all();
    expect(snapshots.results).toHaveLength(1); // no duplicate snapshot written
  });

  it("runs the full change pipeline: diff, summarize, notify, and record the change", async () => {
    const userId = await insertUser("free"); // free plan -> heuristic summary, no Claude call
    const source = await insertSource(userId);
    await env.DB.prepare("INSERT INTO channels (id, user_id, type, config) VALUES (?, ?, ?, ?)")
      .bind(newId("chn"), userId, "webhook", JSON.stringify({ url: "https://sink.example.com" }))
      .run();

    mockFetchHtml("<p>Requests are limited to 100 requests per minute.</p>");
    await runSourceCheck(env, source); // baseline

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === "https://sink.example.com") return new Response(null, { status: 200 });
      return new Response("<p>Requests are limited to 60 requests per minute.</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const result = await runSourceCheck(env, source);

    expect(result.changed).toBe(true);
    expect(result.changeId).toBeDefined();
    expect(result.notifyFailedCount).toBe(0);

    const change = await env.DB.prepare("SELECT * FROM changes WHERE id = ?")
      .bind(result.changeId)
      .first<{ notified: number; notify_failed_count: number; summary_source: string }>();
    expect(change?.notified).toBe(1);
    expect(change?.notify_failed_count).toBe(0);
    expect(change?.summary_source).toBe("heuristic"); // free plan, per Issue 13's fix

    const source2 = await env.DB.prepare("SELECT * FROM sources WHERE id = ?")
      .bind(source.id)
      .first<SourceRow>();
    expect(source2?.last_changed_at).not.toBeNull();
  });

  it("sets notified=0 and records notify_failed_count when every channel fails (Issue 7)", async () => {
    const userId = await insertUser();
    const source = await insertSource(userId);
    await env.DB.prepare("INSERT INTO channels (id, user_id, type, config) VALUES (?, ?, ?, ?)")
      .bind(newId("chn"), userId, "webhook", JSON.stringify({ url: "https://dead.example.com" }))
      .run();

    mockFetchHtml("<p>Version A</p>");
    await runSourceCheck(env, source); // baseline

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === "https://dead.example.com") throw new Error("connection refused");
      return new Response("<p>Version B</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const result = await runSourceCheck(env, source);

    expect(result.notifyFailedCount).toBe(1);
    const change = await env.DB.prepare("SELECT notified, notify_failed_count FROM changes WHERE id = ?")
      .bind(result.changeId)
      .first<{ notified: number; notify_failed_count: number }>();
    expect(change?.notified).toBe(0); // the fix: not "1 regardless of outcome"
    expect(change?.notify_failed_count).toBe(1);
  });

  it("records last_error and does not throw when fetch/extract fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("fail", { status: 503 }));
    const userId = await insertUser();
    const source = await insertSource(userId);

    const result = await runSourceCheck(env, source);
    expect(result.changed).toBe(false);
    expect(result.error).toContain("HTTP 503");

    const updated = await env.DB.prepare("SELECT last_error FROM sources WHERE id = ?")
      .bind(source.id)
      .first<{ last_error: string }>();
    expect(updated?.last_error).toContain("HTTP 503");
  });

  it("only prunes old snapshots once the count exceeds the keep limit (Issue 10)", async () => {
    const userId = await insertUser();
    const source = await insertSource(userId);

    // 11 distinct versions -> 11 checks -> should trigger exactly one prune (limit=10)
    for (let i = 0; i < 11; i++) {
      mockFetchHtml(`<p>Version ${i}</p>`);
      await runSourceCheck(env, source);
    }

    const snapshots = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM snapshots WHERE source_id = ?",
    )
      .bind(source.id)
      .first<{ n: number }>();
    expect(snapshots?.n).toBe(10);
  });
});

describe("runDueChecks", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns zero when no sources are due", async () => {
    const result = await runDueChecks(env);
    expect(result).toEqual({ checked: 0, changed: 0, errors: 0 });
  });

  it("only checks active sources whose interval has elapsed", async () => {
    mockFetchHtml("<p>content</p>");
    const userId = await insertUser();
    // Never checked -> due immediately.
    const due = await insertSource(userId, { last_checked_at: null });
    // Checked recently, 60 min interval -> not due.
    const notDue = await insertSource(userId, {
      last_checked_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    });
    // Paused -> never due regardless of timing.
    const paused = await insertSource(userId, { status: "paused", last_checked_at: null });

    const result = await runDueChecks(env);
    expect(result.checked).toBe(1);

    const dueRow = await env.DB.prepare("SELECT last_checked_at FROM sources WHERE id = ?")
      .bind(due.id)
      .first<{ last_checked_at: string }>();
    expect(dueRow?.last_checked_at).not.toBeNull();

    const pausedRow = await env.DB.prepare("SELECT last_checked_at FROM sources WHERE id = ?")
      .bind(paused.id)
      .first<{ last_checked_at: string | null }>();
    expect(pausedRow?.last_checked_at).toBeNull();
  });

  it("continues processing the rest of a batch when one source's check throws unexpectedly", async () => {
    const userId = await insertUser();
    const willCrash = await insertSource(userId, { last_checked_at: null });
    const willSucceed = await insertSource(userId, { last_checked_at: null });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(willCrash.id)) throw new Error("boom");
      return new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } });
    });

    const result = await runDueChecks(env);
    expect(result.checked).toBe(2);
    // The crashing source surfaces as a recorded error (fetch throw), not an uncaught
    // rejection that aborts the batch — runSourceCheck itself catches fetch errors.
    expect(result.errors).toBe(1);

    const succeededRow = await env.DB.prepare("SELECT last_checked_at FROM sources WHERE id = ?")
      .bind(willSucceed.id)
      .first<{ last_checked_at: string | null }>();
    expect(succeededRow?.last_checked_at).not.toBeNull();
  });
});
