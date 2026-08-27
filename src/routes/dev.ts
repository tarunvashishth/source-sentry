// Dev-only helpers for exercising the pipeline locally:
//  - /dev/fixture        a fake docs page whose content is versioned in D1
//  - /dev/fixture/bump   mutate the fixture so the next check sees a change
//  - /dev/run-checks     force-check every active source (ignores intervals)
//  - /dev/webhook-sink   records the last webhook delivery for inspection
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { runSourceCheck } from "../lib/check";
import { isDevelopment, type AppEnv, type SourceRow } from "../types";

const dev = new Hono<AppEnv>();

dev.use(
  "*",
  createMiddleware<AppEnv>(async (c, next) => {
    if (!isDevelopment(c.env)) {
      return c.json({ error: "not found" }, 404);
    }
    await next();
  }),
);

async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM dev_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO dev_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

function fixtureHtml(version: number): string {
  const rateLimit = version < 2 ? "100 requests per minute" : "60 requests per minute";
  const auth =
    version < 3
      ? "API keys are passed via the X-Api-Key header."
      : "API keys must be passed as a Bearer token in the Authorization header. The X-Api-Key header is deprecated and will stop working on 2026-09-01.";
  const webhooks =
    version >= 2
      ? "<h2>Webhooks</h2><p>Webhook payloads are now signed with HMAC-SHA256. Verify the X-Acme-Signature header before processing.</p>"
      : "";
  return `<!doctype html>
<html>
<head><title>Acme API Docs v${version}</title><script>console.log("ignore me")</script></head>
<body>
  <nav>Home | Docs | Pricing</nav>
  <h1>Acme Payments API</h1>
  <p>Reference documentation for the Acme Payments API.</p>
  <h2>Authentication</h2>
  <p>${auth}</p>
  <h2>Rate limits</h2>
  <p>Requests are limited to ${rateLimit} per API key.</p>
  <h2>Endpoints</h2>
  <ul>
    <li>POST /v1/charges — create a charge</li>
    <li>GET /v1/charges/:id — retrieve a charge</li>
    <li>POST /v1/refunds — refund a charge</li>
  </ul>
  ${webhooks}
</body>
</html>`;
}

dev.get("/fixture", async (c) => {
  const version = Number((await getState(c.env, "fixture_version")) ?? "1");
  return c.html(fixtureHtml(version));
});

dev.post("/fixture/bump", async (c) => {
  const version = Number((await getState(c.env, "fixture_version")) ?? "1") + 1;
  await setState(c.env, "fixture_version", String(version));
  return c.json({ version });
});

dev.post("/run-checks", async (c) => {
  const sources = await c.env.DB.prepare("SELECT * FROM sources WHERE status = 'active'").all<SourceRow>();
  const results = [];
  for (const source of sources.results) {
    const result = await runSourceCheck(c.env, source);
    results.push({ source_id: source.id, name: source.name, ...result });
  }
  return c.json({ results });
});

dev.post("/webhook-sink", async (c) => {
  const body = await c.req.text();
  await setState(
    c.env,
    "webhook_sink",
    JSON.stringify({
      received_at: new Date().toISOString(),
      signature: c.req.header("x-sourcesentry-signature") ?? null,
      event: c.req.header("x-sourcesentry-event") ?? null,
      body: JSON.parse(body),
    }),
  );
  return c.json({ ok: true });
});

dev.get("/webhook-sink", async (c) => {
  const stored = await getState(c.env, "webhook_sink");
  return c.json(stored ? JSON.parse(stored) : { empty: true });
});

export default dev;
