import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { requireAuth } from "../src/auth";
import { sha256Hex } from "../src/lib/ids";
import type { AppEnv } from "../src/types";

function buildApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);
  app.get("/whoami", (c) => c.json({ id: c.get("user").id, email: c.get("user").email }));
  return app;
}

describe("requireAuth middleware", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const app = buildApp();
    const res = await app.request("/whoami", {}, env);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringContaining("missing API key") });
  });

  it("returns 401 for an invalid API key", async () => {
    const app = buildApp();
    const res = await app.request(
      "/whoami",
      { headers: { authorization: "Bearer not-a-real-key" } },
      env,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: "invalid API key" });
  });

  it("accepts a valid key via the Authorization: Bearer header and sets the user", async () => {
    const plainKey = "ss_live_test_key_via_bearer";
    const hash = await sha256Hex(plainKey);
    await env.DB.prepare(
      "INSERT INTO users (id, email, api_key_hash, plan) VALUES (?, ?, ?, 'free')",
    )
      .bind("usr_bearer_test", "bearer@example.com", hash)
      .run();

    const app = buildApp();
    const res = await app.request(
      "/whoami",
      { headers: { authorization: `Bearer ${plainKey}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "usr_bearer_test", email: "bearer@example.com" });
  });

  it("accepts a valid key via the x-api-key header fallback", async () => {
    const plainKey = "ss_live_test_key_via_xapikey";
    const hash = await sha256Hex(plainKey);
    await env.DB.prepare(
      "INSERT INTO users (id, email, api_key_hash, plan) VALUES (?, ?, ?, 'free')",
    )
      .bind("usr_xapikey_test", "xapikey@example.com", hash)
      .run();

    const app = buildApp();
    const res = await app.request("/whoami", { headers: { "x-api-key": plainKey } }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "usr_xapikey_test", email: "xapikey@example.com" });
  });

  it("stores only a hash, never the plaintext key (Issue 2)", async () => {
    const plainKey = "ss_live_never_stored_plaintext";
    const hash = await sha256Hex(plainKey);
    await env.DB.prepare(
      "INSERT INTO users (id, email, api_key_hash, plan) VALUES (?, ?, ?, 'free')",
    )
      .bind("usr_plaintext_check", "plaintext@example.com", hash)
      .run();

    const row = await env.DB.prepare("SELECT api_key_hash FROM users WHERE id = ?")
      .bind("usr_plaintext_check")
      .first<{ api_key_hash: string }>();
    expect(row?.api_key_hash).toBe(hash);
    expect(row?.api_key_hash).not.toBe(plainKey);

    // The users table should have no column capable of holding the raw key at all.
    const columns = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).not.toContain("api_key");
  });
});
