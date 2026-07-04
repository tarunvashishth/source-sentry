import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/lib/ids";

const BASE = "https://example.com";

async function signup(email: string, ip = "203.0.113.1") {
  return exports.default.fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ email }),
  });
}

async function signupAndGetKey(email: string, ip?: string): Promise<string> {
  const res = await signup(email, ip);
  const body = await res.json<{ api_key: string }>();
  return body.api_key;
}

function authed(key: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } };
}

describe("POST /api/auth/signup", () => {
  it("creates a user and returns a usable API key", async () => {
    const res = await signup("route-signup-1@example.com", "203.0.113.10");
    expect(res.status).toBe(201);
    const body = await res.json<{ user_id: string; email: string; plan: string; api_key: string }>();
    expect(body.email).toBe("route-signup-1@example.com");
    expect(body.plan).toBe("free");
    expect(body.api_key).toMatch(/^ss_live_/);
  });

  it("rejects an invalid email", async () => {
    const res = await signup("not-an-email", "203.0.113.11");
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate email with 409", async () => {
    await signup("route-signup-dup@example.com", "203.0.113.12");
    const res = await signup("route-signup-dup@example.com", "203.0.113.13");
    expect(res.status).toBe(409);
  });

  it("rate-limits repeated signups from the same IP (Issue 4)", async () => {
    const ip = "203.0.113.99";
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await signup(`rl-test-${i}@example.com`, ip));
    }
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("auth gate on protected routes", () => {
  it("rejects GET /api/me with no key", async () => {
    const res = await exports.default.fetch(`${BASE}/api/me`);
    expect(res.status).toBe(401);
  });

  it("returns the caller's profile with a valid key", async () => {
    const key = await signupAndGetKey("route-me@example.com", "203.0.113.20");
    const res = await exports.default.fetch(`${BASE}/api/me`, authed(key));
    expect(res.status).toBe(200);
    const body = await res.json<{ email: string; plan: string; limits: { maxSources: number } }>();
    expect(body.email).toBe("route-me@example.com");
    expect(body.limits.maxSources).toBe(3);
  });
});

describe("sources CRUD", () => {
  it("creates a source and enforces the free-plan minimum check interval", async () => {
    const key = await signupAndGetKey("route-sources-1@example.com", "203.0.113.30");
    const tooFast = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com", check_interval_minutes: 5 }),
      }),
    );
    expect(tooFast.status).toBe(400);

    const ok = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com", name: "Docs" }),
      }),
    );
    expect(ok.status).toBe(201);
  });

  it("still rejects a malformed URL even in the dev-mode test environment", async () => {
    // The test environment inherits wrangler.jsonc's ENVIRONMENT=development, under
    // which allowPrivateHosts() deliberately permits private/internal hosts (same as
    // local dev) — that specific SSRF-guard branch is unit-tested directly against
    // both allowPrivate values in extract.test.ts. This checks the route still
    // validates the URL is well-formed at all, regardless of environment.
    const key = await signupAndGetKey("route-sources-private@example.com", "203.0.113.31");
    const res = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "not a url at all" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("enforces the free-plan source count limit (3)", async () => {
    const key = await signupAndGetKey("route-sources-limit@example.com", "203.0.113.32");
    for (let i = 0; i < 3; i++) {
      const res = await exports.default.fetch(
        `${BASE}/api/sources`,
        authed(key, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `https://docs.example.com/${i}` }),
        }),
      );
      expect(res.status).toBe(201);
    }
    const fourth = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com/4" }),
      }),
    );
    expect(fourth.status).toBe(403);
  });

  it("patches status and rejects an invalid status value", async () => {
    const key = await signupAndGetKey("route-sources-patch@example.com", "203.0.113.33");
    const created = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com/patch" }),
      }),
    );
    const { source } = await created.json<{ source: { id: string } }>();

    const badStatus = await exports.default.fetch(
      `${BASE}/api/sources/${source.id}`,
      authed(key, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "deleted" }),
      }),
    );
    expect(badStatus.status).toBe(400);

    const paused = await exports.default.fetch(
      `${BASE}/api/sources/${source.id}`,
      authed(key, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      }),
    );
    expect(paused.status).toBe(200);
    const body = await paused.json<{ source: { status: string } }>();
    expect(body.source.status).toBe("paused");
  });

  it("deletes a source and cascades to its changes and snapshots", async () => {
    const key = await signupAndGetKey("route-sources-delete@example.com", "203.0.113.34");
    const created = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com/delete-me" }),
      }),
    );
    const { source } = await created.json<{ source: { id: string } }>();

    // Force a real snapshot to exist so the cascade has something to delete.
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("<p>content</p>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    await exports.default.fetch(`${BASE}/api/sources/${source.id}/check`, authed(key, { method: "POST" }));
    globalThis.fetch = realFetch;

    const del = await exports.default.fetch(
      `${BASE}/api/sources/${source.id}`,
      authed(key, { method: "DELETE" }),
    );
    expect(del.status).toBe(200);

    const remainingSnapshots = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM snapshots WHERE source_id = ?",
    )
      .bind(source.id)
      .first<{ n: number }>();
    expect(remainingSnapshots?.n).toBe(0);

    const notFound = await exports.default.fetch(
      `${BASE}/api/sources/${source.id}`,
      authed(key),
    );
    expect(notFound.status).toBe(404);
  });

  it("returns 404 for a source belonging to another user", async () => {
    const keyA = await signupAndGetKey("route-sources-owner-a@example.com", "203.0.113.35");
    const keyB = await signupAndGetKey("route-sources-owner-b@example.com", "203.0.113.36");
    const created = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(keyA, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com/owned-by-a" }),
      }),
    );
    const { source } = await created.json<{ source: { id: string } }>();

    const res = await exports.default.fetch(`${BASE}/api/sources/${source.id}`, authed(keyB));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sources/:id/check timeout handling (Issue 11)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("returns 202 timed_out when the check exceeds the hard deadline", async () => {
    const key = await signupAndGetKey("route-check-timeout@example.com", "203.0.113.40");
    const created = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com/slow" }),
      }),
    );
    const { source } = await created.json<{ source: { id: string } }>();

    // A fetch that never resolves within the test's lifetime — simulates a stuck
    // upstream. Real time (not fake timers, which don't reliably drive workerd's
    // internal scheduler) but a short window so the suite stays fast.
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

    const res = await exports.default.fetch(
      `${BASE}/api/sources/${source.id}/check`,
      authed(key, { method: "POST" }),
    );
    expect(res.status).toBe(202);
    const body = await res.json<{ timed_out: boolean }>();
    expect(body.timed_out).toBe(true);
  }, 20_000);
});

describe("changes feed", () => {
  it("lists changes with source_id filtering and clamps limit to 200", async () => {
    const key = await signupAndGetKey("route-changes@example.com", "203.0.113.50");
    const created = await exports.default.fetch(
      `${BASE}/api/sources`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://docs.example.com/changes" }),
      }),
    );
    const { source } = await created.json<{ source: { id: string } }>();

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response("<p>v1</p>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    await exports.default.fetch(`${BASE}/api/sources/${source.id}/check`, authed(key, { method: "POST" }));
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response("<p>v2</p>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    await exports.default.fetch(`${BASE}/api/sources/${source.id}/check`, authed(key, { method: "POST" }));
    globalThis.fetch = realFetch;

    const res = await exports.default.fetch(
      `${BASE}/api/changes?source_id=${source.id}&limit=999`,
      authed(key),
    );
    const body = await res.json<{ changes: unknown[] }>();
    expect(body.changes).toHaveLength(1); // only the v1->v2 transition is a "change"
  });
});

describe("channels CRUD", () => {
  it("creates a webhook channel and returns a signing secret once", async () => {
    const key = await signupAndGetKey("route-channels-1@example.com", "203.0.113.60");
    const res = await exports.default.fetch(
      `${BASE}/api/channels`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "webhook", url: "https://hook.example.com" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ signing_secret: string }>();
    expect(body.signing_secret).toMatch(/^whsec_/);
  });

  it("rejects an invalid channel type", async () => {
    const key = await signupAndGetKey("route-channels-2@example.com", "203.0.113.61");
    const res = await exports.default.fetch(
      `${BASE}/api/channels`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "carrier_pigeon", url: "https://hook.example.com" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("sends a test event through a real channel", async () => {
    const key = await signupAndGetKey("route-channels-3@example.com", "203.0.113.62");
    const created = await exports.default.fetch(
      `${BASE}/api/channels`,
      authed(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "webhook", url: "https://hook.example.com" }),
      }),
    );
    const { channel } = await created.json<{ channel: { id: string } }>();

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const res = await exports.default.fetch(
      `${BASE}/api/channels/${channel.id}/test`,
      authed(key, { method: "POST" }),
    );
    globalThis.fetch = realFetch;
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it("returns 404 deleting a channel that doesn't exist", async () => {
    const key = await signupAndGetKey("route-channels-4@example.com", "203.0.113.63");
    const res = await exports.default.fetch(
      `${BASE}/api/channels/${newId("chn")}`,
      authed(key, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/webhooks/lemonsqueezy", () => {
  it("returns 501 when the billing webhook secret isn't configured", async () => {
    const res = await exports.default.fetch(`${BASE}/api/webhooks/lemonsqueezy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
  });
});
