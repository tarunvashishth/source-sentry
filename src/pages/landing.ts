import { PRICING_ENABLED } from "../types";

const pricingSection = PRICING_ENABLED
  ? `
  <h2 class="sec">Pricing</h2>
  <div class="price">
    <div class="card">
      <h3>Free</h3>
      <div class="amount">$0</div>
      <ul><li>3 monitored sources</li><li>Hourly checks</li><li>AI change summaries</li><li>Slack + webhook alerts</li></ul>
    </div>
    <div class="card">
      <h3>Pro</h3>
      <div class="amount">$19<span style="font-size:14px;color:var(--muted)">/mo</span></div>
      <ul><li>50 monitored sources</li><li>Checks every 10 minutes</li><li>AI change summaries</li><li>Signed webhooks for auto-resync</li></ul>
    </div>
  </div>
`
  : "";

export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Source Sentry — know when the docs you depend on change</title>
<meta name="description" content="Monitor API docs, terms, and policies. Get AI summaries of what changed and why it matters — in Slack, or via signed webhooks.">
<style>
:root{--bg:#0b0f14;--card:#121820;--border:#1f2937;--text:#e5e7eb;--muted:#8b98a9;--accent:#f59e0b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:0 24px 96px}
header{display:flex;align-items:center;justify-content:space-between;padding:28px 0}
.brand{font-weight:700;font-size:18px}.brand span{color:var(--accent)}
a.cta{background:var(--accent);color:#0b0f14;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;font-size:14px}
a{color:var(--accent)}
.hero{padding:72px 0 48px;text-align:center}
h1{font-size:44px;line-height:1.15;margin:0 0 18px;letter-spacing:-.02em}
h1 em{color:var(--accent);font-style:normal}
.sub{color:var(--muted);font-size:19px;max-width:620px;margin:0 auto 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:56px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:22px}
.card h3{margin:0 0 8px;font-size:16px}
.card p{margin:0;color:var(--muted);font-size:14.5px}
h2.sec{font-size:14px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:56px 0 16px}
pre{background:#0d1319;border:1px solid var(--border);border-radius:10px;padding:18px;overflow:auto;font-size:13px;line-height:1.55;color:#c9d4e0}
.price{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.price .card{text-align:left}
.price .amount{font-size:32px;font-weight:800;margin:6px 0}
.price ul{margin:12px 0 0;padding-left:18px;color:var(--muted);font-size:14.5px}
footer{color:var(--muted);font-size:13px;text-align:center;margin-top:72px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">⛨ Source<span>Sentry</span></div>
    <a class="cta" href="/app">Open dashboard →</a>
  </header>

  <section class="hero">
    <h1>Know the moment the docs<br>you depend on <em>change</em>.</h1>
    <p class="sub">Source Sentry watches the API docs, terms of service, policies, and knowledge-base pages your product relies on — and tells you <strong>what changed and why it matters</strong>, not just that something moved.</p>
    <a class="cta" href="/app">Start monitoring — free</a>
  </section>

  <div class="grid">
    <div class="card"><h3>🔍 Continuous monitoring</h3><p>Register any URL. We snapshot the content on your schedule — from every 10 minutes to daily — and detect real content changes, not markup noise.</p></div>
    <div class="card"><h3>🧠 Semantic AI summaries</h3><p>Claude reads every diff and writes a plain-English summary with a severity rating: info, minor, major, or breaking. Skim your feed instead of reading diffs.</p></div>
    <div class="card"><h3>📣 Slack &amp; webhook alerts</h3><p>Push alerts to Slack, or receive HMAC-signed webhooks so your own systems — docs pipelines, RAG indexes, caches — can resync automatically.</p></div>
    <div class="card"><h3>🔁 Resync API</h3><p>Poll <code>/api/sources/:id/latest</code> for the current content hash and refresh your knowledge base only when it actually changed.</p></div>
  </div>

  <h2 class="sec">Quickstart</h2>
  <pre># 1. Get an API key
curl -X POST https://your-worker.dev/api/auth/signup \\
  -H 'content-type: application/json' \\
  -d '{"email":"you@company.com"}'

# 2. Watch a page
curl -X POST https://your-worker.dev/api/sources \\
  -H 'authorization: Bearer ss_live_…' \\
  -H 'content-type: application/json' \\
  -d '{"url":"https://docs.stripe.com/api/charges","name":"Stripe charges API"}'

# 3. Get alerted when it changes
curl -X POST https://your-worker.dev/api/channels \\
  -H 'authorization: Bearer ss_live_…' \\
  -H 'content-type: application/json' \\
  -d '{"type":"slack","url":"https://hooks.slack.com/services/…"}'</pre>

  ${pricingSection}
  <footer>Source Sentry — built on Cloudflare Workers. <a href="/app">Dashboard</a></footer>
</div>
</body>
</html>`;
