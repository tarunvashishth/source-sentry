const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
// Content-types we know how to turn into meaningful text. Anything outside this
// allowlist (PDF, images, other binary formats) is rejected explicitly rather than
// lossily UTF-8-decoded into garbage that would still hash, diff, and get "summarized".
const TEXT_CONTENT_TYPE = /^(text\/|application\/(json|.*\+json|xml|.*\+xml))|^\s*$/;

export interface ExtractResult {
  text: string;
  httpStatus: number;
}

// Known residual risk: this validates the hostname string at call time, but Workers'
// fetch() re-resolves DNS independently at request time and doesn't expose the resolved
// IP to pin against. A hostname that resolves to a public IP now could resolve to a
// private/internal address by the time of a later scheduled check (this function runs
// fresh on every check, not just once at source creation). There's no Workers primitive
// to close this fully — accepted as a known, platform-limited risk rather than a fixable
// bug. The redirect-based variant of this (same request, different hop) IS closed below.
export function assertAllowedUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are supported");
  }
  if (!allowPrivate) {
    const h = url.hostname;
    const isPrivate =
      h === "localhost" ||
      h === "0.0.0.0" ||
      h === "[::1]" ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h);
    if (isPrivate) throw new Error("private/internal hosts are not allowed");
  }
  return url;
}

// Fetches with redirects handled manually so each hop is re-validated against the
// same private-host allowlist as the original URL. Workers' fetch() follows redirects
// by default with no re-validation hook — a registered public URL that later 302s to
// an internal address (or cloud metadata endpoint) would otherwise bypass the guard
// entirely on every scheduled re-check.
async function fetchFollowingRedirects(url: URL, allowPrivate: boolean): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "SourceSentryBot/1.0 (+https://sourcesentry.dev)",
        accept: "text/html,application/json,text/*;q=0.9,*/*;q=0.5",
      },
    });
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (!isRedirect || !location) return response;

    await response.body?.cancel();
    if (hop === MAX_REDIRECTS) throw new Error(`too many redirects (max ${MAX_REDIRECTS})`);
    current = assertAllowedUrl(new URL(location, current).toString(), allowPrivate);
  }
  throw new Error("unreachable"); // loop always returns or throws
}

export async function fetchAndExtract(
  rawUrl: string,
  cssSelector: string | null,
  allowPrivate: boolean,
): Promise<ExtractResult> {
  const url = assertAllowedUrl(rawUrl, allowPrivate);

  const response = await fetchFollowingRedirects(url, allowPrivate);
  if (!response.ok) {
    // Drain so the connection can be reused.
    await response.body?.cancel();
    throw new Error(`fetch failed with HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!TEXT_CONTENT_TYPE.test(contentType)) {
    await response.body?.cancel();
    throw new Error(
      `unsupported content type: ${contentType || "(none)"} — binary/PDF sources aren't supported yet`,
    );
  }

  const raw = await readCapped(response);

  let text: string;
  if (contentType.includes("json")) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = raw;
    }
  } else if (contentType.includes("html") || /^\s*</.test(raw)) {
    text = await extractHtmlText(raw, cssSelector);
  } else {
    text = raw;
  }

  const normalized = normalize(text);
  if (!normalized) throw new Error("no text content extracted from source");
  return { text: normalized, httpStatus: response.status };
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value.slice(0, value.byteLength - (total - MAX_BYTES)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(merged);
}

const SKIP_TAGS = "script, style, noscript, svg, iframe, template, head";
const BLOCK_TAGS =
  "p, div, li, h1, h2, h3, h4, h5, h6, tr, td, th, br, section, article, header, footer, pre, blockquote, dt, dd";

async function extractHtmlText(html: string, cssSelector: string | null): Promise<string> {
  const chunks: string[] = [];
  let skipDepth = 0;
  // Without a selector every text node counts; with one, only text inside matches.
  let selectionDepth = cssSelector ? 0 : 1;

  const rewriter = new HTMLRewriter().on(SKIP_TAGS, {
    element(el) {
      skipDepth++;
      try {
        el.onEndTag(() => {
          skipDepth--;
        });
      } catch {
        skipDepth--; // void/implicitly-closed element
      }
    },
  });

  if (cssSelector) {
    rewriter.on(cssSelector, {
      element(el) {
        selectionDepth++;
        try {
          el.onEndTag(() => {
            selectionDepth--;
          });
        } catch {
          selectionDepth--;
        }
      },
    });
  }

  rewriter
    .on("*", {
      text(t) {
        if (skipDepth === 0 && selectionDepth > 0 && t.text) chunks.push(t.text);
      },
    })
    .on(BLOCK_TAGS, {
      element(el) {
        if (skipDepth === 0 && selectionDepth > 0) {
          try {
            el.onEndTag(() => {
              chunks.push("\n");
            });
          } catch {
            chunks.push("\n"); // e.g. <br>
          }
        }
      },
    });

  await rewriter.transform(new Response(html)).text(); // drain to run handlers
  return chunks.join("");
}

function normalize(raw: string): string {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[\t ]+/g, " ").trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
