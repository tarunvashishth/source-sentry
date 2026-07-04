import { Hono } from "hono";
import { requireAuth } from "../auth";
import { CHECK_NOW_TIMEOUT_MS, runSourceCheck } from "../lib/check";
import { assertAllowedUrl } from "../lib/extract";
import { hmacSha256Hex, newApiKey, newId, newWebhookSecret, sha256Hex } from "../lib/ids";
import { sendToChannel, testEvent } from "../lib/notify";
import {
  allowPrivateHosts,
  planFor,
  type AppEnv,
  type ChangeRow,
  type ChannelRow,
  type SnapshotRow,
  type SourceRow,
  type UserRow,
} from "../types";

const api = new Hono<AppEnv>();

// ---------------------------------------------------------------- auth

api.post("/auth/signup", async (c) => {
  // Anti-abuse throttle — keyed on client IP so a single script can't farm free-tier
  // accounts. CF-Connecting-IP is set by Cloudflare and not client-controllable.
  const clientIp = c.req.header("cf-connecting-ip") ?? "unknown";
  const rateLimit = await c.env.SIGNUP_RATE_LIMITER.limit({ key: clientIp });
  if (!rateLimit.success) {
    return c.json({ error: "too many signup attempts — try again in a minute" }, 429);
  }

  const body = await c.req.json<{ email?: string }>().catch(() => null);
  const email = body?.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "valid email required" }, 400);
  }
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) {
    return c.json({ error: "email already registered — use your existing API key" }, 409);
  }
  const id = newId("usr");
  const apiKey = newApiKey();
  const apiKeyHash = await sha256Hex(apiKey);
  await c.env.DB.prepare("INSERT INTO users (id, email, api_key_hash) VALUES (?, ?, ?)")
    .bind(id, email, apiKeyHash)
    .run();
  // The plaintext key is returned exactly once, here — never persisted or logged.
  return c.json({ user_id: id, email, plan: "free", api_key: apiKey }, 201);
});

// ------------------------------------------------------- billing webhook
// Lemon Squeezy: subscription events flip the plan for the matching email.

api.post("/webhooks/lemonsqueezy", async (c) => {
  const secret = c.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "billing webhook not configured" }, 501);
  const rawBody = await c.req.text();
  const signature = c.req.header("x-signature") ?? "";
  const expected = await hmacSha256Hex(secret, rawBody);
  if (signature !== expected) return c.json({ error: "invalid signature" }, 401);

  const payload = JSON.parse(rawBody) as {
    meta?: { event_name?: string };
    data?: { attributes?: { user_email?: string } };
  };
  const eventName = payload.meta?.event_name ?? "";
  const email = payload.data?.attributes?.user_email?.toLowerCase();
  if (!email) return c.json({ ok: true, skipped: "no email in payload" });

  if (["subscription_created", "subscription_resumed", "subscription_unpaused"].includes(eventName)) {
    await c.env.DB.prepare("UPDATE users SET plan = 'pro' WHERE email = ?").bind(email).run();
  } else if (["subscription_expired", "subscription_cancelled"].includes(eventName)) {
    await c.env.DB.prepare("UPDATE users SET plan = 'free' WHERE email = ?").bind(email).run();
  }
  return c.json({ ok: true });
});

// Everything below requires an API key.
api.use("*", requireAuth);

api.get("/me", (c) => {
  const user = c.get("user");
  return c.json({
    id: user.id,
    email: user.email,
    plan: user.plan,
    limits: planFor(user),
    created_at: user.created_at,
  });
});

// ---------------------------------------------------------------- sources

api.get("/sources", async (c) => {
  const user = c.get("user");
  const rows = await c.env.DB.prepare(
    "SELECT * FROM sources WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(user.id)
    .all<SourceRow>();
  return c.json({ sources: rows.results });
});

api.post("/sources", async (c) => {
  const user = c.get("user");
  const plan = planFor(user);
  const body = await c.req
    .json<{
      url?: string;
      name?: string;
      css_selector?: string;
      check_interval_minutes?: number;
    }>()
    .catch(() => null);
  if (!body?.url) return c.json({ error: "url is required" }, 400);

  let url: URL;
  try {
    url = assertAllowedUrl(body.url, allowPrivateHosts(c.env));
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
  }

  const interval = body.check_interval_minutes ?? 60;
  if (!Number.isInteger(interval) || interval < plan.minIntervalMinutes) {
    return c.json(
      { error: `check_interval_minutes must be an integer >= ${plan.minIntervalMinutes} on the ${user.plan} plan` },
      400,
    );
  }
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM sources WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= plan.maxSources) {
    return c.json({ error: `source limit reached (${plan.maxSources} on the ${user.plan} plan)` }, 403);
  }

  const id = newId("src");
  const name = (body.name?.trim() || url.hostname).slice(0, 120);
  await c.env.DB.prepare(
    "INSERT INTO sources (id, user_id, name, url, css_selector, check_interval_minutes) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, name, url.toString(), body.css_selector?.trim() || null, interval)
    .run();
  const source = await c.env.DB.prepare("SELECT * FROM sources WHERE id = ?")
    .bind(id)
    .first<SourceRow>();
  return c.json({ source }, 201);
});

async function loadOwnedSource(c: { env: Env }, userId: string, sourceId: string) {
  return c.env.DB.prepare("SELECT * FROM sources WHERE id = ? AND user_id = ?")
    .bind(sourceId, userId)
    .first<SourceRow>();
}

api.get("/sources/:id", async (c) => {
  const source = await loadOwnedSource(c, c.get("user").id, c.req.param("id"));
  if (!source) return c.json({ error: "source not found" }, 404);
  return c.json({ source });
});

api.patch("/sources/:id", async (c) => {
  const user = c.get("user");
  const plan = planFor(user);
  const source = await loadOwnedSource(c, user.id, c.req.param("id"));
  if (!source) return c.json({ error: "source not found" }, 404);
  const body = await c.req
    .json<{
      name?: string;
      css_selector?: string | null;
      check_interval_minutes?: number;
      status?: string;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);

  const name = body.name?.trim() ? body.name.trim().slice(0, 120) : source.name;
  const selector =
    body.css_selector === undefined ? source.css_selector : body.css_selector?.trim() || null;
  const interval = body.check_interval_minutes ?? source.check_interval_minutes;
  if (!Number.isInteger(interval) || interval < plan.minIntervalMinutes) {
    return c.json(
      { error: `check_interval_minutes must be an integer >= ${plan.minIntervalMinutes} on the ${user.plan} plan` },
      400,
    );
  }
  const status = body.status ?? source.status;
  if (status !== "active" && status !== "paused") {
    return c.json({ error: "status must be 'active' or 'paused'" }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE sources SET name = ?, css_selector = ?, check_interval_minutes = ?, status = ? WHERE id = ?",
  )
    .bind(name, selector, interval, status, source.id)
    .run();
  const updated = await c.env.DB.prepare("SELECT * FROM sources WHERE id = ?")
    .bind(source.id)
    .first<SourceRow>();
  return c.json({ source: updated });
});

api.delete("/sources/:id", async (c) => {
  const source = await loadOwnedSource(c, c.get("user").id, c.req.param("id"));
  if (!source) return c.json({ error: "source not found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM changes WHERE source_id = ?").bind(source.id),
    c.env.DB.prepare("DELETE FROM snapshots WHERE source_id = ?").bind(source.id),
    c.env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(source.id),
  ]);
  return c.json({ ok: true });
});

api.post("/sources/:id/check", async (c) => {
  const source = await loadOwnedSource(c, c.get("user").id, c.req.param("id"));
  if (!source) return c.json({ error: "source not found" }, 404);

  // Stacked fetch/Claude/notify timeouts inside runSourceCheck can add up to 70+s —
  // far past what a browser tab waiting on "Check now" should sit through. Race
  // against a hard deadline; if it fires, let the real check keep running via
  // waitUntil so a genuinely slow (not stuck) source still gets recorded correctly.
  const checkPromise = runSourceCheck(c.env, source);
  const timedOut = Symbol("timed_out");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    setTimeout(() => resolve(timedOut), CHECK_NOW_TIMEOUT_MS);
  });
  const result = await Promise.race([checkPromise, timeoutPromise]);
  if (result === timedOut) {
    c.executionCtx.waitUntil(checkPromise.catch(() => undefined));
    return c.json(
      { changed: false, timed_out: true, message: "still running — check back shortly" },
      202,
    );
  }
  return c.json(result);
});

// For cache-refresh pollers: cheap current-state lookup.
api.get("/sources/:id/latest", async (c) => {
  const source = await loadOwnedSource(c, c.get("user").id, c.req.param("id"));
  if (!source) return c.json({ error: "source not found" }, 404);
  const snap = await c.env.DB.prepare(
    "SELECT id, content_hash, fetched_at FROM snapshots WHERE source_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1",
  )
    .bind(source.id)
    .first<Pick<SnapshotRow, "id" | "content_hash" | "fetched_at">>();
  return c.json({
    source_id: source.id,
    content_hash: snap?.content_hash ?? null,
    fetched_at: snap?.fetched_at ?? null,
    last_changed_at: source.last_changed_at,
  });
});

// ---------------------------------------------------------------- changes

api.get("/changes", async (c) => {
  const user = c.get("user");
  const sourceId = c.req.query("source_id");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const query = sourceId
    ? c.env.DB.prepare(
        `SELECT ch.id, ch.source_id, ch.summary, ch.severity, ch.details, ch.summary_source,
                ch.added_lines, ch.removed_lines, ch.created_at, s.name AS source_name, s.url AS source_url
         FROM changes ch JOIN sources s ON s.id = ch.source_id
         WHERE ch.user_id = ? AND ch.source_id = ?
         ORDER BY ch.created_at DESC, ch.id DESC LIMIT ?`,
      ).bind(user.id, sourceId, limit)
    : c.env.DB.prepare(
        `SELECT ch.id, ch.source_id, ch.summary, ch.severity, ch.details, ch.summary_source,
                ch.added_lines, ch.removed_lines, ch.created_at, s.name AS source_name, s.url AS source_url
         FROM changes ch JOIN sources s ON s.id = ch.source_id
         WHERE ch.user_id = ?
         ORDER BY ch.created_at DESC, ch.id DESC LIMIT ?`,
      ).bind(user.id, limit);
  const rows = await query.all<ChangeRow & { source_name: string; source_url: string }>();
  const changes = rows.results.map((r) => ({ ...r, details: JSON.parse(r.details) }));
  return c.json({ changes });
});

api.get("/changes/:id", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    `SELECT ch.*, s.name AS source_name, s.url AS source_url
     FROM changes ch JOIN sources s ON s.id = ch.source_id
     WHERE ch.id = ? AND ch.user_id = ?`,
  )
    .bind(c.req.param("id"), user.id)
    .first<ChangeRow & { source_name: string; source_url: string }>();
  if (!row) return c.json({ error: "change not found" }, 404);
  return c.json({ change: { ...row, details: JSON.parse(row.details) } });
});

// ---------------------------------------------------------------- channels

api.get("/channels", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM channels WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(c.get("user").id)
    .all<ChannelRow>();
  const channels = rows.results.map((ch) => {
    const config = JSON.parse(ch.config) as { url: string; secret?: string };
    return { id: ch.id, type: ch.type, url: config.url, has_secret: Boolean(config.secret), created_at: ch.created_at };
  });
  return c.json({ channels });
});

api.post("/channels", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ type?: string; url?: string }>().catch(() => null);
  if (!body?.type || !["slack", "webhook"].includes(body.type)) {
    return c.json({ error: "type must be 'slack' or 'webhook'" }, 400);
  }
  if (!body.url) return c.json({ error: "url is required" }, 400);
  try {
    assertAllowedUrl(body.url, allowPrivateHosts(c.env));
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
  }

  const id = newId("chn");
  const secret = body.type === "webhook" ? newWebhookSecret() : undefined;
  const config = JSON.stringify({ url: body.url, ...(secret ? { secret } : {}) });
  await c.env.DB.prepare(
    "INSERT INTO channels (id, user_id, type, config) VALUES (?, ?, ?, ?)",
  )
    .bind(id, user.id, body.type, config)
    .run();
  return c.json(
    {
      channel: { id, type: body.type, url: body.url },
      // Returned once — used to verify x-sourcesentry-signature on deliveries.
      ...(secret ? { signing_secret: secret } : {}),
    },
    201,
  );
});

api.post("/channels/:id/test", async (c) => {
  const channel = await c.env.DB.prepare(
    "SELECT * FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first<ChannelRow>();
  if (!channel) return c.json({ error: "channel not found" }, 404);
  try {
    await sendToChannel(channel, testEvent());
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

api.delete("/channels/:id", async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .run();
  if (!result.meta.changes) return c.json({ error: "channel not found" }, 404);
  return c.json({ ok: true });
});

export default api;
