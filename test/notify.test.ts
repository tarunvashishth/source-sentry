import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex, newId } from "../src/lib/ids";
import { dispatchNotifications, sendToChannel, testEvent } from "../src/lib/notify";
import type { ChannelRow } from "../src/types";

async function insertUser(): Promise<string> {
  const id = newId("usr");
  await env.DB.prepare(
    "INSERT INTO users (id, email, api_key_hash, plan) VALUES (?, ?, ?, 'free')",
  )
    .bind(id, `${id}@example.com`, `hash-${id}`)
    .run();
  return id;
}

async function insertChannel(
  userId: string,
  type: "slack" | "webhook",
  config: Record<string, unknown>,
): Promise<string> {
  const id = newId("chn");
  await env.DB.prepare("INSERT INTO channels (id, user_id, type, config) VALUES (?, ?, ?, ?)")
    .bind(id, userId, type, JSON.stringify(config))
    .run();
  return id;
}

describe("sendToChannel", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("sends a Slack message and does not throw on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;
    const channel: ChannelRow = {
      id: "chn_1",
      user_id: "usr_1",
      type: "slack",
      config: JSON.stringify({ url: "https://hooks.slack.com/services/x" }),
      created_at: "",
    };
    await expect(sendToChannel(channel, testEvent())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/x",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws when Slack returns a non-ok status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const channel: ChannelRow = {
      id: "chn_1",
      user_id: "usr_1",
      type: "slack",
      config: JSON.stringify({ url: "https://hooks.slack.com/services/dead" }),
      created_at: "",
    };
    await expect(sendToChannel(channel, testEvent())).rejects.toThrow(
      "slack webhook returned HTTP 404",
    );
  });

  it("signs webhook deliveries with HMAC-SHA256 when a secret is configured", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      capturedBody = init.body as string;
      return new Response(null, { status: 200 });
    });
    const secret = "whsec_test_secret";
    const channel: ChannelRow = {
      id: "chn_1",
      user_id: "usr_1",
      type: "webhook",
      config: JSON.stringify({ url: "https://example.com/hook", secret }),
      created_at: "",
    };
    await sendToChannel(channel, testEvent());
    const expectedSig = `sha256=${await hmacSha256Hex(secret, capturedBody!)}`;
    expect(capturedHeaders?.get("x-sourcesentry-signature")).toBe(expectedSig);
  });

  it("sends no signature header when a webhook channel has no secret", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      return new Response(null, { status: 200 });
    });
    const channel: ChannelRow = {
      id: "chn_1",
      user_id: "usr_1",
      type: "webhook",
      config: JSON.stringify({ url: "https://example.com/hook" }),
      created_at: "",
    };
    await sendToChannel(channel, testEvent());
    expect(capturedHeaders?.has("x-sourcesentry-signature")).toBe(false);
  });

  it("throws when a webhook endpoint returns a non-ok status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const channel: ChannelRow = {
      id: "chn_1",
      user_id: "usr_1",
      type: "webhook",
      config: JSON.stringify({ url: "https://example.com/hook" }),
      created_at: "",
    };
    await expect(sendToChannel(channel, testEvent())).rejects.toThrow(
      "webhook returned HTTP 500",
    );
  });
});

describe("dispatchNotifications — delivery outcome tracking (Issue 7)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("reports attempted=0 when the user has no channels configured", async () => {
    const userId = await insertUser();
    const result = await dispatchNotifications(env, userId, testEvent());
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });

  it("reports all-succeeded when every channel delivers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const userId = await insertUser();
    await insertChannel(userId, "webhook", { url: "https://a.example.com" });
    await insertChannel(userId, "webhook", { url: "https://b.example.com" });
    const result = await dispatchNotifications(env, userId, testEvent());
    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
  });

  it("counts partial failures correctly when one of several channels fails", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 500 });
    });
    const userId = await insertUser();
    await insertChannel(userId, "webhook", { url: "https://ok.example.com" });
    await insertChannel(userId, "webhook", { url: "https://broken.example.com" });
    const result = await dispatchNotifications(env, userId, testEvent());
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("does not throw when every channel fails — errors are contained per-channel", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const userId = await insertUser();
    await insertChannel(userId, "webhook", { url: "https://down.example.com" });
    const result = await dispatchNotifications(env, userId, testEvent());
    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });
});
