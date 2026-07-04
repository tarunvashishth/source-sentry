export const dashboardPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Source Sentry — Dashboard</title>
<style>
:root{--bg:#0b0f14;--card:#121820;--border:#1f2937;--text:#e5e7eb;--muted:#8b98a9;--accent:#f59e0b;--danger:#ef4444;--ok:#10b981}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 20px 96px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.brand{font-weight:700;font-size:18px}.brand span{color:var(--accent)}
.brand a{color:inherit;text-decoration:none}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:20px}
h2{font-size:13px;margin:0 0 14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
input,select{background:#0d1319;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px 10px;font-size:14px}
input:focus{outline:none;border-color:var(--accent)}
button{background:var(--accent);color:#0b0f14;border:none;border-radius:6px;padding:8px 14px;font-weight:600;font-size:13px;cursor:pointer}
button:hover{filter:brightness(1.1)}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
button.danger{background:transparent;color:var(--danger);border:1px solid var(--border)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.item{border-top:1px solid var(--border);padding:14px 0}
.item:first-child{border-top:none;padding-top:4px}
.badge{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11px;font-weight:700;text-transform:uppercase;vertical-align:middle}
.badge.info{background:#12314b;color:#7dd3fc}
.badge.minor{background:#3d3a14;color:#fde047}
.badge.major{background:#4a2510;color:#fdba74}
.badge.breaking{background:#4c1d1d;color:#fca5a5}
.badge.paused{background:#26303c;color:#9ca3af}
.badge.active{background:#123b2e;color:#6ee7b7}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
pre.diff{background:#0d1319;border:1px solid var(--border);border-radius:6px;padding:10px;overflow:auto;max-height:340px;font-size:12px;line-height:1.5;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre}
.dadd{color:#4ade80}.ddel{color:#f87171}
.muted{color:var(--muted);font-size:13px}
.title{font-weight:600}
ul.details{margin:6px 0 0;padding-left:20px;color:var(--muted);font-size:13.5px}
.toast{position:fixed;bottom:20px;right:20px;background:#1f2937;border:1px solid var(--border);padding:10px 16px;border-radius:8px;display:none;max-width:420px;font-size:14px;z-index:10}
a{color:var(--accent)}
.secret{background:#0d1319;border:1px dashed var(--accent);border-radius:6px;padding:10px;margin-top:10px;word-break:break-all}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><a href="/">⛨ Source<span>Sentry</span></a></div>
    <div class="row">
      <span id="whoami" class="muted"></span>
      <button class="ghost" id="logoutBtn" style="display:none">Sign out</button>
    </div>
  </header>

  <div class="card" id="authCard" style="display:none">
    <h2>Get started</h2>
    <p class="muted">Create an account to get an API key, or paste an existing one. The key is stored only in this browser.</p>
    <div class="row" style="margin-bottom:10px">
      <input id="email" type="email" placeholder="you@company.com" style="flex:2;min-width:220px">
      <button id="signupBtn">Create account</button>
    </div>
    <div class="row">
      <input id="keyInput" type="text" placeholder="ss_live_…" class="mono" style="flex:2;min-width:220px">
      <button class="ghost" id="useKeyBtn">Use key</button>
    </div>
    <div class="secret mono" id="newKeyMsg" style="display:none"></div>
  </div>

  <div id="appView" style="display:none">
    <div class="card">
      <h2>Monitored sources</h2>
      <div class="row" style="margin-bottom:14px">
        <input id="srcUrl" placeholder="https://docs.example.com/api" style="flex:2;min-width:240px">
        <input id="srcName" placeholder="Name (optional)" style="flex:1;min-width:130px">
        <input id="srcSel" placeholder="CSS selector (optional)" style="flex:1;min-width:130px">
        <select id="srcInterval">
          <option value="60">every hour</option>
          <option value="360">every 6 hours</option>
          <option value="1440">daily</option>
          <option value="10">every 10 min (pro)</option>
        </select>
        <button id="addSrcBtn">Add source</button>
      </div>
      <div id="sources" class="muted">Loading…</div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:2px">
        <h2 style="margin-bottom:0">Recent changes</h2>
        <button class="ghost" id="refreshBtn">Refresh</button>
      </div>
      <div id="changes" class="muted" style="margin-top:12px">Loading…</div>
    </div>

    <div class="card">
      <h2>Alert channels</h2>
      <div class="row" style="margin-bottom:14px">
        <select id="chType">
          <option value="slack">Slack incoming webhook</option>
          <option value="webhook">Generic webhook (HMAC signed)</option>
        </select>
        <input id="chUrl" placeholder="https://hooks.slack.com/services/…" style="flex:2;min-width:240px">
        <button id="addChBtn">Add channel</button>
      </div>
      <div class="secret mono" id="chSecretMsg" style="display:none"></div>
      <div id="channels" class="muted">Loading…</div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var key = localStorage.getItem("ss_api_key") || "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  var toastTimer;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = "none"; }, 4000);
  }

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(
      { "content-type": "application/json" },
      key ? { authorization: "Bearer " + key } : {},
      opts.headers || {}
    );
    var res = await fetch("/api" + path, opts);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  function setView(authed) {
    $("authCard").style.display = authed ? "none" : "block";
    $("appView").style.display = authed ? "block" : "none";
    $("logoutBtn").style.display = authed ? "inline-block" : "none";
  }

  async function boot() {
    if (!key) { setView(false); return; }
    try {
      var me = await api("/me");
      $("whoami").textContent = me.email + " · " + me.plan;
      setView(true);
      refreshAll();
    } catch (err) {
      localStorage.removeItem("ss_api_key");
      key = "";
      setView(false);
      toast(String(err.message || err));
    }
  }

  function refreshAll() { loadSources(); loadChanges(); loadChannels(); }

  // ------------------------------------------------------------ sources
  async function loadSources() {
    try {
      var data = await api("/sources");
      var el = $("sources");
      if (!data.sources.length) {
        el.innerHTML = '<span class="muted">No sources yet — add a URL above to start monitoring.</span>';
        return;
      }
      el.classList.remove("muted");
      el.innerHTML = data.sources.map(function (s) {
        return '<div class="item">' +
          '<div class="row" style="justify-content:space-between">' +
            '<div><span class="title">' + esc(s.name) + '</span> ' +
              '<span class="badge ' + esc(s.status) + '">' + esc(s.status) + '</span><br>' +
              '<a class="mono" href="' + esc(s.url) + '" target="_blank" rel="noreferrer">' + esc(s.url) + '</a><br>' +
              '<span class="muted">every ' + esc(s.check_interval_minutes) + ' min · last check: ' + esc(s.last_checked_at || "never") + (s.last_error ? ' · <span style="color:var(--danger)">error: ' + esc(s.last_error) + '</span>' : '') + '</span>' +
            '</div>' +
            '<div class="row">' +
              '<button class="ghost" data-action="check" data-id="' + esc(s.id) + '">Check now</button>' +
              '<button class="ghost" data-action="toggle" data-id="' + esc(s.id) + '" data-status="' + esc(s.status) + '">' + (s.status === "active" ? "Pause" : "Resume") + '</button>' +
              '<button class="danger" data-action="delete" data-id="' + esc(s.id) + '">Delete</button>' +
            '</div>' +
          '</div></div>';
      }).join("");
    } catch (err) { toast(String(err.message || err)); }
  }

  $("sources").addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    var id = btn.dataset.id;
    btn.disabled = true;
    try {
      if (btn.dataset.action === "check") {
        btn.textContent = "Checking…";
        var r = await api("/sources/" + id + "/check", { method: "POST" });
        if (r.error) toast("Check failed: " + r.error);
        else if (r.changed) toast("Change detected: " + (r.summary || ""));
        else if (r.firstSnapshot) toast("First snapshot captured — future checks will diff against it.");
        else toast("No change since last snapshot.");
        refreshAll();
      } else if (btn.dataset.action === "toggle") {
        await api("/sources/" + id, {
          method: "PATCH",
          body: JSON.stringify({ status: btn.dataset.status === "active" ? "paused" : "active" }),
        });
        loadSources();
      } else if (btn.dataset.action === "delete") {
        if (!confirm("Delete this source and its history?")) { btn.disabled = false; return; }
        await api("/sources/" + id, { method: "DELETE" });
        refreshAll();
      }
    } catch (err) { toast(String(err.message || err)); }
    btn.disabled = false;
  });

  $("addSrcBtn").addEventListener("click", async function () {
    try {
      await api("/sources", {
        method: "POST",
        body: JSON.stringify({
          url: $("srcUrl").value.trim(),
          name: $("srcName").value.trim() || undefined,
          css_selector: $("srcSel").value.trim() || undefined,
          check_interval_minutes: Number($("srcInterval").value),
        }),
      });
      $("srcUrl").value = ""; $("srcName").value = ""; $("srcSel").value = "";
      toast("Source added. Run 'Check now' to capture the first snapshot.");
      loadSources();
    } catch (err) { toast(String(err.message || err)); }
  });

  // ------------------------------------------------------------ changes
  function renderDiff(text) {
    return text.split("\\n").map(function (line) {
      var cls = line.startsWith("+") ? "dadd" : line.startsWith("-") ? "ddel" : "";
      return '<span class="' + cls + '">' + esc(line) + "</span>";
    }).join("\\n");
  }

  async function loadChanges() {
    try {
      var data = await api("/changes?limit=30");
      var el = $("changes");
      if (!data.changes.length) {
        el.innerHTML = '<span class="muted">No changes yet. Once a monitored source changes between checks, it shows up here with a summary.</span>';
        return;
      }
      el.classList.remove("muted");
      el.innerHTML = data.changes.map(function (ch) {
        var details = (ch.details || []).map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("");
        return '<div class="item">' +
          '<div><span class="badge ' + esc(ch.severity) + '">' + esc(ch.severity) + '</span> ' +
            '<span class="title">' + esc(ch.source_name) + '</span> ' +
            '<span class="muted">· ' + esc(ch.created_at) + ' UTC · +' + esc(ch.added_lines) + "/−" + esc(ch.removed_lines) + " lines · " + esc(ch.summary_source) + " summary</span></div>" +
          '<div style="margin-top:6px">' + esc(ch.summary) + "</div>" +
          (details ? '<ul class="details">' + details + "</ul>" : "") +
          '<div style="margin-top:8px"><button class="ghost" data-action="diff" data-id="' + esc(ch.id) + '">View diff</button></div>' +
          '<div id="diff-' + esc(ch.id) + '"></div>' +
        "</div>";
      }).join("");
    } catch (err) { toast(String(err.message || err)); }
  }

  $("changes").addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-action=diff]");
    if (!btn) return;
    var holder = $("diff-" + btn.dataset.id);
    if (holder.innerHTML) { holder.innerHTML = ""; btn.textContent = "View diff"; return; }
    try {
      var data = await api("/changes/" + btn.dataset.id);
      holder.innerHTML = '<pre class="diff">' + renderDiff(data.change.diff_text) + "</pre>";
      btn.textContent = "Hide diff";
    } catch (err) { toast(String(err.message || err)); }
  });

  $("refreshBtn").addEventListener("click", refreshAll);

  // ------------------------------------------------------------ channels
  async function loadChannels() {
    try {
      var data = await api("/channels");
      var el = $("channels");
      if (!data.channels.length) {
        el.innerHTML = '<span class="muted">No channels yet — add Slack or a webhook to get alerts.</span>';
        return;
      }
      el.classList.remove("muted");
      el.innerHTML = data.channels.map(function (ch) {
        return '<div class="item"><div class="row" style="justify-content:space-between">' +
          '<div><span class="title">' + esc(ch.type) + "</span>" + (ch.has_secret ? ' <span class="muted">(signed)</span>' : "") + '<br><span class="mono muted">' + esc(ch.url) + "</span></div>" +
          '<div class="row">' +
            '<button class="ghost" data-action="test" data-id="' + esc(ch.id) + '">Send test</button>' +
            '<button class="danger" data-action="delete" data-id="' + esc(ch.id) + '">Delete</button>' +
          "</div></div></div>";
      }).join("");
    } catch (err) { toast(String(err.message || err)); }
  }

  $("channels").addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    btn.disabled = true;
    try {
      if (btn.dataset.action === "test") {
        var r = await api("/channels/" + btn.dataset.id + "/test", { method: "POST" });
        toast(r.ok ? "Test notification sent ✔" : "Test failed: " + (r.error || ""));
      } else if (btn.dataset.action === "delete") {
        await api("/channels/" + btn.dataset.id, { method: "DELETE" });
        loadChannels();
      }
    } catch (err) { toast(String(err.message || err)); }
    btn.disabled = false;
  });

  $("addChBtn").addEventListener("click", async function () {
    try {
      var r = await api("/channels", {
        method: "POST",
        body: JSON.stringify({ type: $("chType").value, url: $("chUrl").value.trim() }),
      });
      $("chUrl").value = "";
      if (r.signing_secret) {
        var msg = $("chSecretMsg");
        msg.style.display = "block";
        msg.textContent = "Webhook signing secret (shown once — deliveries carry x-sourcesentry-signature: sha256=HMAC(secret, body)): " + r.signing_secret;
      }
      loadChannels();
    } catch (err) { toast(String(err.message || err)); }
  });

  // ------------------------------------------------------------ auth
  $("signupBtn").addEventListener("click", async function () {
    try {
      var r = await api("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email: $("email").value.trim() }),
      });
      var msg = $("newKeyMsg");
      msg.style.display = "block";
      msg.textContent = "Your API key (save it somewhere safe): " + r.api_key;
      key = r.api_key;
      localStorage.setItem("ss_api_key", key);
      setTimeout(boot, 1500);
    } catch (err) { toast(String(err.message || err)); }
  });

  $("useKeyBtn").addEventListener("click", function () {
    key = $("keyInput").value.trim();
    if (!key) { toast("paste an API key first"); return; }
    localStorage.setItem("ss_api_key", key);
    boot();
  });

  $("logoutBtn").addEventListener("click", function () {
    localStorage.removeItem("ss_api_key");
    key = "";
    setView(false);
    $("whoami").textContent = "";
  });

  boot();
})();
</script>
</body>
</html>`;
