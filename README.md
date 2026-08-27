# Source Sentry

Know the moment the docs you depend on change.

Source Sentry watches the API docs, terms of service, policies, and knowledge-base
pages your product relies on, and tells you **what changed and why it matters** —
not just that something moved. Alerts go to Slack or to HMAC-signed webhooks so
your own systems (docs pipelines, RAG indexes, caches) can resync automatically.

It runs entirely on Cloudflare Workers: Hono for routing, D1 for storage, a Cron
Trigger for scheduling, and the Anthropic API for change summaries.

---

## How it works

```
Cron (*/10 min)  ──▶  pick sources whose check_interval_minutes has elapsed
                          │
                          ▼
                      fetch URL  ──▶  extract text (HTMLRewriter / JSON / plain)
                          │
                          ▼
                      SHA-256 hash  ──▶  same as last snapshot? ──▶ done
                          │ different
                          ▼
                      line diff  ──▶  summarize (Claude, or heuristic fallback)
                          │
                          ▼
                      record change  ──▶  fan out to Slack + webhook channels
```

Each step is a small module under `src/lib/` and is unit-tested against the real
Workers runtime via `@cloudflare/vitest-pool-workers`.

**Content extraction.** HTML is run through `HTMLRewriter`, dropping
`script`/`style`/`svg`/`iframe`/`head` and inserting newlines at block boundaries,
so markup churn doesn't register as a change. An optional CSS selector scopes
extraction to one region of the page. JSON is re-serialized with stable
formatting; other text types pass through. Responses are capped at 512 KB with a
20 s timeout, and non-text content types (PDFs, images) are rejected rather than
decoded into garbage.

**Change detection.** Text is normalized (whitespace collapsed, blank runs
squashed) and hashed. On a hash change, `src/lib/diff.ts` trims the common
prefix/suffix and runs an exact LCS diff over the changed middle, falling back to
block replacement when the middle exceeds 1200 lines. The last 10 snapshots per
source are retained.

**Summaries.** Pro-plan changes go to Claude with a JSON schema, producing a
one-line summary, up to five bullet points, and a severity of `info`, `minor`,
`major`, or `breaking`. Free-plan changes — and any Claude call that fails — fall
back to a heuristic summary (line counts plus changed-line excerpts). Every change
records which path produced it in `summary_source`.

**SSRF protection.** Every URL is validated before fetch: http(s) only, and
private/internal hosts (`localhost`, RFC1918, `169.254.x`, `.local`, `.internal`)
are rejected unless `ENVIRONMENT=development`. Redirects are followed manually so
each hop is re-validated — a public URL that later 302s to a metadata endpoint is
blocked. One residual risk is documented in `src/lib/extract.ts`: Workers' `fetch()`
re-resolves DNS itself and gives no way to pin the resolved IP, so DNS rebinding
between validation and fetch can't be closed at this layer.

---

## Quickstart (local)

Requires Node 20+. Tests and local dev run entirely against Miniflare's local D1,
so no Cloudflare account is needed until you deploy.

```bash
npm install

# Generate the Env types from wrangler.jsonc (writes worker-configuration.d.ts,
# which is gitignored).
npm run types

# Apply migrations to the local D1 instance under .wrangler/.
npm run db:migrate:local

# Optional: AI summaries and the billing webhook.
cp .dev.vars.example .dev.vars   # then fill in ANTHROPIC_API_KEY

# Run it. --test-scheduled exposes /__scheduled for firing the cron by hand.
npm run dev
```

The landing page is at `http://localhost:8787/` and the dashboard at
`http://localhost:8787/app`. The dashboard is a single self-contained HTML page
that talks to the same public API described below — sign up, paste your key, and
add sources from there, or use `curl`.

### End-to-end, by hand

```bash
BASE=http://localhost:8787

# 1. Sign up. The plaintext API key is returned exactly once — it is stored
#    only as a SHA-256 hash.
curl -sX POST $BASE/api/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@company.com"}'

KEY=ss_live_…

# 2. Watch a page.
curl -sX POST $BASE/api/sources \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url":"https://docs.stripe.com/api/charges","name":"Stripe charges API"}'

# 3. Route alerts to Slack.
curl -sX POST $BASE/api/channels \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"slack","url":"https://hooks.slack.com/services/…"}'

# 4. Force a check now, ignoring the interval.
curl -sX POST $BASE/api/sources/src_…/check -H "authorization: Bearer $KEY"

# 5. Read the change feed.
curl -s $BASE/api/changes -H "authorization: Bearer $KEY"
```

### Dev-only helpers

Mounted under `/dev/*` and hidden behind a 404 unless `ENVIRONMENT=development`,
which `wrangler.jsonc` deliberately does not set — start the dev server with
`npx wrangler dev --var ENVIRONMENT:development` to use them (this also disables
the private-host guard, so you can point sources at localhost).

| Route | Purpose |
| --- | --- |
| `GET /dev/fixture` | A fake Acme API docs page whose content is versioned in D1. |
| `POST /dev/fixture/bump` | Advance the fixture version so the next check sees a real change. |
| `POST /dev/run-checks` | Check every active source immediately, ignoring intervals. |
| `POST /dev/webhook-sink` | Records the last webhook delivery (used as a channel target). |
| `GET /dev/webhook-sink` | Read back what the sink last received, signature header included. |

A full loop: point a source at `/dev/fixture`, add a webhook channel pointing at
`/dev/webhook-sink`, `POST /dev/run-checks` to take a baseline, `POST
/dev/fixture/bump`, run checks again, then `GET /dev/webhook-sink`.

---

## API

Base path `/api`. Everything except `/auth/signup` and `/webhooks/lemonsqueezy`
requires an API key, sent as `Authorization: Bearer <key>` or `X-Api-Key: <key>`.
All responses are JSON; errors are `{"error": "..."}`.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/auth/signup` | Body `{"email"}`. Returns `api_key` once. Rate-limited to 3/min per client IP; 409 if the email is already registered. |
| `GET` | `/me` | Current user, plan, and plan limits. |

### Sources

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/sources` | All sources for the caller, newest first. |
| `POST` | `/sources` | Body `{"url", "name"?, "css_selector"?, "check_interval_minutes"?}`. Defaults to 60 min; name defaults to the hostname. 403 once the plan's source limit is reached. |
| `GET` | `/sources/:id` | Single source. |
| `PATCH` | `/sources/:id` | Update `name`, `css_selector` (`null` clears it), `check_interval_minutes`, or `status` (`active` / `paused`). |
| `DELETE` | `/sources/:id` | Deletes the source and its snapshots and changes. |
| `POST` | `/sources/:id/check` | Check now. Returns `202` with `{"timed_out": true}` after 15 s and finishes the check in the background. |
| `GET` | `/sources/:id/latest` | Cheap current-state lookup: `content_hash`, `fetched_at`, `last_changed_at`. Poll this to refresh a cache or index only when the hash actually moves. |

### Changes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/changes` | Feed across all sources. Optional `source_id`; `limit` defaults to 50, capped at 200. |
| `GET` | `/changes/:id` | One change, including the full unified diff. |

### Channels

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/channels` | Configured channels. Secrets are never returned — only `has_secret`. |
| `POST` | `/channels` | Body `{"type": "slack" \| "webhook", "url"}`. Webhook channels get a `signing_secret`, returned once. |
| `POST` | `/channels/:id/test` | Send a sample `channel.test` event. `502` with the upstream error if delivery fails. |
| `DELETE` | `/channels/:id` | Remove a channel. |

### Billing webhook

`POST /webhooks/lemonsqueezy` flips the matching user's plan on subscription
events. It returns `501` unless `LEMONSQUEEZY_WEBHOOK_SECRET` is set, and `401`
unless the `X-Signature` header matches the HMAC-SHA256 of the raw body.

---

## Webhook deliveries

Webhook channels receive a POST per change:

```
POST <your endpoint>
content-type: application/json
user-agent: SourceSentry-Webhooks/1.0
x-sourcesentry-event: source.changed
x-sourcesentry-signature: sha256=<hex>
```

```json
{
  "event": "source.changed",
  "timestamp": "2026-08-27T09:00:00.000Z",
  "source": { "id": "src_…", "name": "Stripe charges API", "url": "https://…", "content_hash": "…" },
  "change": {
    "id": "chg_…",
    "summary": "The X-Api-Key header is deprecated in favor of bearer tokens.",
    "severity": "breaking",
    "details": ["…", "…"],
    "added_lines": 4,
    "removed_lines": 1,
    "diff_excerpt": "…first 2000 chars of the unified diff…",
    "created_at": "2026-08-27T09:00:00.000Z"
  }
}
```

The signature is `sha256=` plus the hex HMAC-SHA256 of the **raw request body**
using the `signing_secret` returned when the channel was created. Verify it
against the raw bytes, before JSON parsing, using a constant-time comparison.

Delivery is best-effort: each channel is attempted once with a 10 s timeout, and
failures are logged and counted in `changes.notify_failed_count` rather than
retried. A change counts as `notified` if at least one channel accepted it, or if
no channels are configured at all.

---

## Configuration

`wrangler.jsonc` holds the non-secret config: the D1 binding, the `*/10 * * * *`
cron trigger, the signup rate limiter, and `ENVIRONMENT`. Note that `vars` are
overwritten from this file on every `wrangler deploy`, which is why `ENVIRONMENT`
is pinned to `production` — that keeps the SSRF guard on and `/dev/*` unreachable
in the deployed Worker.

Secrets are set with `npx wrangler secret put <NAME>` (or `.dev.vars` locally) —
all three are optional:

| Secret | Effect when unset |
| --- | --- |
| `ANTHROPIC_API_KEY` | All summaries use the heuristic fallback. |
| `SUMMARY_MODEL` | Defaults to `claude-opus-4-8`; set e.g. `claude-haiku-4-5` to cut cost. |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | The billing webhook returns `501`. |

### Plans

Defined in `src/types.ts`:

| Plan | Sources | Min interval | Summaries |
| --- | --- | --- | --- |
| Free | 3 | 60 min | Heuristic |
| Pro | 50 | 10 min | Claude |

Claude summaries are gated on the Pro plan so free-tier inference cost scales with
paying customers rather than signups. `PRICING_ENABLED` in `src/types.ts` is
currently `false`, which hides the landing page's pricing section while everyone
is on the free tier; the plan limits and billing webhook stay wired underneath.

---

## Data model

Three migrations in `migrations/`, applied with `npm run db:migrate:local` or
`db:migrate:remote`.

| Table | Holds |
| --- | --- |
| `users` | Email, `api_key_hash` (SHA-256 — the plaintext key is never stored), plan. |
| `sources` | Monitored URL, optional CSS selector, interval, status, last check/change/error. |
| `snapshots` | Extracted text plus its hash, most recent 10 per source. |
| `changes` | Diff, summary, severity, details, line counts, delivery outcome. |
| `channels` | Slack or webhook destination as a JSON `config` blob. |
| `dev_state` | Scratch state for the `/dev/*` helpers. Unused in production. |

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | `wrangler dev --test-scheduled` — local server with `/__scheduled` for firing the cron. |
| `npm test` | Vitest against the real Workers runtime; migrations are applied per run. |
| `npm run types` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc`. Rerun after editing that file. |
| `npm run check` | `tsc --noEmit`. See the note below. |
| `npm run deploy` | `wrangler deploy`. |
| `npm run db:migrate:local` / `:remote` | Apply D1 migrations. |

`npm run check` currently reports two pre-existing errors in `src/routes/dev.ts`
and `src/types.ts`: `wrangler types` narrows `ENVIRONMENT` to the literal
`"production"` from the `vars` block, so both `=== "development"` comparisons are
flagged as impossible. The comparisons are correct at runtime, since
`--var ENVIRONMENT:development` overrides the value, but the generated type
doesn't model the override. Widening the declaration in `src/env.d.ts` would fix
it. `npm test` is unaffected.

---

## Deploying

```bash
npx wrangler d1 create source-sentry     # paste database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

The cron trigger and rate limiter are created from `wrangler.jsonc` on deploy.
Observability is enabled at a 1.0 head sampling rate; the Worker emits structured
JSON logs for `cron_run`, `check_crashed`, `notify_failed`, `summary_fallback`,
and `unhandled_error`.

### Scaling ceiling

Each cron tick checks at most 25 due sources, 5 at a time, and fires every 10
minutes — a sustained ceiling of **150 checks/hour** across all users. Past that,
sources quietly drift behind their configured interval. The `cron_run` log line
carries `oldest_overdue_minutes`, the worst-case drift across *all* due sources
(not just the ones in that tick's batch), as the early-warning signal. Raise
`BATCH_SIZE` / `CONCURRENCY` in `src/lib/check.ts`, or shorten the cron interval,
before that number starts growing.

---

## Project layout

```
src/
  index.ts            Hono app, route mounting, scheduled() handler
  auth.ts             API-key middleware (hash lookup)
  types.ts            Row types, plan limits, feature flags
  env.d.ts            Secret declarations, merged with generated Env
  lib/
    check.ts          Per-source check pipeline + cron batch runner
    extract.ts        URL validation, redirect-safe fetch, text extraction
    diff.ts           Line diff with prefix/suffix trim and LCS middle
    summarize.ts      Claude summary with heuristic fallback
    notify.ts         Slack + signed-webhook delivery and fan-out
    ids.ts            ID/key generation, SHA-256 and HMAC helpers
  pages/              Self-contained landing page and dashboard HTML
  routes/
    api.ts            Public JSON API
    dev.ts            Dev-only fixture, runner, and webhook sink
migrations/           D1 schema
test/                 Vitest suites, one per lib module plus routes
```

## Known gaps

Tracked in [TODOS.md](TODOS.md): webhook signing secrets are still stored as
plaintext inside `channels.config` and want encryption at rest, and email and
GitHub-issue alert channels from the original brief aren't built yet —
`sendToChannel()` already branches on channel type, so the structure is there.
