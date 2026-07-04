// Secrets are not part of wrangler.jsonc, so `wrangler types` can't see them.
// This declaration merges with the generated `Env` in worker-configuration.d.ts.
interface Env {
  ANTHROPIC_API_KEY?: string;
  SUMMARY_MODEL?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
}
