# TODOs

Captured from the `/plan-eng-review` engineering review on 2026-07-04.

## 1. Encrypt webhook signing secrets at rest

**What:** Webhook channel signing secrets are currently stored as plaintext inside `channels.config` (JSON blob). Encrypt them with AES-GCM using a Workers secret as the key-encrypting-key, decrypting only at delivery time.

**Why:** Unlike API keys (Issue 2, fixed by hashing), this secret must be reversible — `hmacSha256Hex(config.secret, body)` in `src/lib/notify.ts:87-88` needs the actual plaintext value on every delivery. A DB leak lets an attacker forge convincing "source changed" webhook deliveries to a customer's own systems (lower blast radius than account takeover, but real if a customer gates an automated action — auto-merge, auto-refresh — on signature verification).

**Pros:** Closes the last plaintext-secret gap in the schema; matches the bar already set for API keys.

**Cons:** Meaningfully more work than the API-key fix — needs a new Workers secret (the KEK), an encrypt/decrypt helper, and a migration to backfill existing rows. Narrower threat model than account takeover.

**Context:** Source: `src/routes/api.ts:300` (create), `src/lib/notify.ts:87-88` (read+use). See `sha256Hex`/`hmacSha256Hex` in `src/lib/ids.ts` for the existing crypto helper pattern to extend.

**Depends on / blocked by:** Nothing — independent of other fixes.

---

## 2. Add email and GitHub-issue alert channels

**What:** Add `email` (via a transactional email provider or Cloudflare Email Routing) and `github_issue` (via GitHub API + a stored PAT/GitHub App) as additional channel types alongside the existing `slack`/`webhook`.

**Why:** The original product brief explicitly named "Push alerts to Slack/email or open GitHub issues automatically" as core scope. The shipped app only has Slack + generic webhook — GitHub-issue auto-creation in particular is the "easy integration into existing workflows" differentiator called out as the gap in the market vs. generic scrapers/uptime monitors.

**Pros:** Closes the gap between the landing page's implicit promise and the actual product; GitHub-issue creation is a strong, specific hook for the target dev audience.

**Cons:** Real new feature work, not a fix — needs a transactional-email account/API key and a GitHub App/PAT + repo-picker UX. Bigger than a typical review-driven task.

**Context:** `src/lib/notify.ts`'s `sendToChannel()` already branches cleanly on `channel.type` (`slack` / `webhook`) — adding two more cases is structurally trivial; the real cost is external-service integration and a bit of dashboard UI for repo/email config.

**Depends on / blocked by:** Nothing blocking — can be built independently of the review's other fixes.
