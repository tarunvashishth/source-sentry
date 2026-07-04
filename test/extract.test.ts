import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAllowedUrl, fetchAndExtract } from "../src/lib/extract";

describe("assertAllowedUrl", () => {
  it("throws on an invalid URL string", () => {
    expect(() => assertAllowedUrl("not a url", false)).toThrow("invalid URL");
  });

  it("throws on a non-http(s) protocol", () => {
    expect(() => assertAllowedUrl("ftp://example.com/file", false)).toThrow(
      "only http(s) URLs are supported",
    );
  });

  it.each([
    "http://localhost/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://foo.local/",
    "http://foo.internal/",
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://169.254.169.254/", // cloud metadata endpoint
  ])("blocks private/internal host %s when allowPrivate is false", (url) => {
    expect(() => assertAllowedUrl(url, false)).toThrow("private/internal hosts are not allowed");
  });

  it("does not block a public host", () => {
    expect(() => assertAllowedUrl("https://example.com/docs", false)).not.toThrow();
  });

  it("does not treat 172.32.x (outside the 172.16-31 private range) as private", () => {
    expect(() => assertAllowedUrl("http://172.32.0.1/", false)).not.toThrow();
  });

  it("allows private hosts when allowPrivate is true (dev mode)", () => {
    expect(() => assertAllowedUrl("http://localhost:8787/", true)).not.toThrow();
  });
});

describe("fetchAndExtract", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function mockFetchOnce(response: Response) {
    globalThis.fetch = vi.fn().mockResolvedValue(response);
  }

  function mockFetchSequence(responses: Response[]) {
    const fn = vi.fn();
    for (const r of responses) fn.mockResolvedValueOnce(r);
    globalThis.fetch = fn;
  }

  it("extracts text from an HTML response, stripping script/style and tags", async () => {
    const html = `<!doctype html><html><head><script>evil()</script></head>
      <body><h1>Title</h1><p>Hello <b>world</b></p><style>.x{color:red}</style></body></html>`;
    mockFetchOnce(
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const result = await fetchAndExtract("https://example.com/docs", null, false);
    expect(result.text).toContain("Title");
    expect(result.text).toContain("Hello world");
    expect(result.text).not.toContain("evil");
    expect(result.text).not.toContain("color:red");
    expect(result.httpStatus).toBe(200);
  });

  it("scopes extraction to a CSS selector when provided", async () => {
    const html = `<html><body><nav>Home | Docs</nav><main><p>Actual content</p></main></body></html>`;
    mockFetchOnce(
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const result = await fetchAndExtract("https://example.com/docs", "main", false);
    expect(result.text).toContain("Actual content");
    expect(result.text).not.toContain("Home");
  });

  it("reformats valid JSON content", async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ b: 2, a: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await fetchAndExtract("https://example.com/api.json", null, false);
    expect(JSON.parse(result.text)).toEqual({ b: 2, a: 1 });
  });

  it("falls back to raw text when content-type says json but body isn't valid JSON", async () => {
    mockFetchOnce(
      new Response("not actually json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await fetchAndExtract("https://example.com/api.json", null, false);
    expect(result.text).toBe("not actually json");
  });

  it("throws with the HTTP status when the response is not ok", async () => {
    mockFetchOnce(new Response("nope", { status: 500 }));
    await expect(fetchAndExtract("https://example.com/broken", null, false)).rejects.toThrow(
      "fetch failed with HTTP 500",
    );
  });

  it("rejects binary/unsupported content-types instead of decoding garbage (Issue 8)", async () => {
    mockFetchOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    await expect(fetchAndExtract("https://example.com/terms.pdf", null, false)).rejects.toThrow(
      /unsupported content type: application\/pdf/,
    );
  });

  it("accepts a response with no content-type header (sniffs as HTML/text)", async () => {
    mockFetchOnce(new Response("<p>Plain body, no content-type</p>", { status: 200 }));
    const result = await fetchAndExtract("https://example.com/mystery", null, false);
    expect(result.text).toContain("Plain body, no content-type");
  });

  it("throws when normalized text ends up empty", async () => {
    mockFetchOnce(
      new Response("   \n\n  ", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(fetchAndExtract("https://example.com/blank", null, false)).rejects.toThrow(
      "no text content extracted from source",
    );
  });

  it("follows a same-origin-safe redirect and re-validates the target (Issue 1)", async () => {
    mockFetchSequence([
      new Response(null, { status: 302, headers: { location: "https://example.com/final" } }),
      new Response("<p>final content</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    const result = await fetchAndExtract("https://example.com/start", null, false);
    expect(result.text).toContain("final content");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect into a private/internal host (Issue 1 — the actual SSRF fix)", async () => {
    mockFetchSequence([
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    ]);
    await expect(fetchAndExtract("https://example.com/start", null, false)).rejects.toThrow(
      "private/internal hosts are not allowed",
    );
  });

  it("throws after too many redirects instead of looping forever", async () => {
    const hops = Array.from(
      { length: 7 },
      (_, i) =>
        new Response(null, { status: 302, headers: { location: `https://example.com/hop${i}` } }),
    );
    mockFetchSequence(hops);
    await expect(fetchAndExtract("https://example.com/start", null, false)).rejects.toThrow(
      /too many redirects/,
    );
  });
});
