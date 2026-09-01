/**
 * Self-contained dashboard HTML served at GET /.
 * No external assets — works offline, renders instantly on Workers.
 *
 * Features:
 *  - Create API keys (admin-secret gated; keys are HMAC-signed and work
 *    immediately without any storage/KV setup)
 *  - Playground to test any endpoint with a key
 *  - Copy-paste fetch snippet for use in the user's app
 */

export function dashboardHtml(host: string, adminConfigured: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MangaFire API</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --border:#30363d; --fg:#e6edf3; --dim:#8b949e; --accent:#f97316; --accent2:#fb923c; --ok:#3fb950; --err:#f85149; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; }
  .wrap { max-width: 860px; margin: 0 auto; display: grid; gap: 20px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 22px; }
  header h1 span { color: var(--accent); }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 99px; border: 1px solid var(--border); color: var(--dim); }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .card h2 { font-size: 16px; margin-bottom: 4px; }
  .card p.sub { color: var(--dim); font-size: 13px; margin-bottom: 14px; }
  label { display: block; font-size: 13px; color: var(--dim); margin: 10px 0 4px; }
  input, select { width: 100%; background: #0d1117; color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; font: inherit; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer; margin-top: 14px; }
  button:hover { background: var(--accent2); }
  button.ghost { background: transparent; border: 1px solid var(--border); color: var(--fg); font-weight: 400; padding: 6px 12px; margin: 0; font-size: 13px; }
  button.ghost:hover { border-color: var(--accent); color: var(--accent); }
  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 140px; }
  .keyout { display: none; margin-top: 14px; background: #0d1117; border: 1px solid var(--ok); border-radius: 8px; padding: 12px; }
  .keyout code { word-break: break-all; color: var(--ok); font-size: 13px; }
  .keyout .row { margin-top: 10px; align-items: center; }
  .warn { color: #d29922; font-size: 12px; margin-top: 8px; }
  .err { color: var(--err); font-size: 13px; margin-top: 10px; display: none; }
  pre { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow: auto; max-height: 380px; font-size: 12.5px; display: none; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--dim); font-weight: 500; }
  td code { color: var(--accent2); font-size: 12.5px; }
  .status { font-size: 13px; color: var(--dim); margin-top: 10px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🔥 MangaFire <span>API</span></h1>
    <span class="pill" id="health">checking…</span>
    <span class="pill">${host}</span>
  </header>

  <!-- ── Create key ─────────────────────────────────────────────── -->
  <div class="card">
    <h2>🔑 Create an API key</h2>
    <p class="sub">Keys are signed with your admin secret and work instantly — nothing to redeploy.</p>
    ${adminConfigured ? `
    <div class="row">
      <div>
        <label for="admin">Admin secret</label>
        <input id="admin" type="password" placeholder="Your ADMIN_KEY secret" autocomplete="off">
      </div>
      <div>
        <label for="kname">Key label (optional)</label>
        <input id="kname" type="text" placeholder="e.g. my-app" maxlength="40">
      </div>
      <div>
        <label for="kexp">Expires</label>
        <select id="kexp">
          <option value="0">Never</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
      </div>
    </div>
    <button id="gen">Generate key</button>
    <div class="err" id="generr"></div>
    <div class="keyout" id="keyout">
      <code id="newkey"></code>
      <div class="row">
        <button class="ghost" id="copykey">📋 Copy key</button>
        <button class="ghost" id="usekey">Use in playground ↓</button>
      </div>
      <div class="warn">⚠ Store this key somewhere safe — it can't be recovered, only regenerated.</div>
    </div>
    ` : `
    <p class="sub" style="color:#d29922">⚠ Key creation is disabled: set the <code>ADMIN_KEY</code> secret on this Worker
    (dashboard → Settings → Variables and Secrets), then reload this page.</p>
    `}
  </div>

  <!-- ── Playground ─────────────────────────────────────────────── -->
  <div class="card">
    <h2>🧪 Playground</h2>
    <p class="sub">Test your key against any endpoint, then copy the snippet into your app.</p>
    <label for="apikey">API key</label>
    <input id="apikey" type="text" placeholder="mf-sk-…" autocomplete="off">
    <div class="row">
      <div>
        <label for="ep">Endpoint</label>
        <select id="ep">
          <option value="/api/home">Home — /api/home</option>
          <option value="/api/search/{q}">Search — /api/search/:keyword</option>
          <option value="/api/updated">Latest updated — /api/updated</option>
          <option value="/api/newest">Newest — /api/newest</option>
          <option value="/api/manga/{id}">Manga info — /api/manga/:id</option>
          <option value="/api/manga/{id}/chapters">Chapters — /api/manga/:id/chapters</option>
          <option value="/api/chapter/{cid}">Chapter pages — /api/chapter/:chapterId</option>
          <option value="/api/resolve">Resolve URL — /api/resolve?url=</option>
        </select>
      </div>
      <div id="paramwrap" class="hidden">
        <label id="paramlabel" for="param">Parameter</label>
        <input id="param" type="text" placeholder="">
      </div>
    </div>
    <button id="send">Send request</button>
    <div class="status" id="status"></div>
    <pre id="result"></pre>
    <div class="row hidden" id="snippetrow" style="margin-top:12px">
      <button class="ghost" id="copysnippet">📋 Copy JS snippet for my app</button>
    </div>
  </div>

  <!-- ── Endpoints ──────────────────────────────────────────────── -->
  <div class="card">
    <h2>📚 Endpoints</h2>
    <p class="sub">All endpoints accept the key as <code>Authorization: Bearer</code>, <code>x-api-key</code> header, or <code>?api_key=</code>.</p>
    <table>
      <tr><th>Endpoint</th><th>Description</th></tr>
      <tr><td><code>GET /api/home</code></td><td>Trending, most-viewed, recent</td></tr>
      <tr><td><code>GET /api/search/:keyword?page=</code></td><td>Search manga</td></tr>
      <tr><td><code>GET /api/manga/:id</code></td><td>Manga details (id or id-slug)</td></tr>
      <tr><td><code>GET /api/manga/:id/chapters/:lng?</code></td><td>Chapter list</td></tr>
      <tr><td><code>GET /api/chapter/:chapterId</code></td><td>Page image URLs for a chapter</td></tr>
      <tr><td><code>GET /api/resolve?url=</code></td><td>Normalize a MangaFire URL → ids</td></tr>
      <tr><td><code>GET /api/updated|newest|added?page=</code></td><td>Latest listings</td></tr>
      <tr><td><code>GET /api/category/:c, /api/genre/:g</code></td><td>Browse category / genre</td></tr>
      <tr><td><code>GET /proxy-image?url=</code></td><td>CORS-friendly image proxy</td></tr>
    </table>
  </div>
</div>

<script>
var host = location.origin;
var $ = function (id) { return document.getElementById(id); };

// health pill
fetch(host + '/health').then(function (r) { return r.json(); }).then(function (d) {
  var p = $('health');
  p.textContent = d.status === 'ok' ? '● online' : 'degraded';
  p.className = 'pill ' + (d.status === 'ok' ? 'ok' : '');
}).catch(function () { $('health').textContent = 'offline'; });

// remember inputs
['admin', 'apikey'].forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.value = localStorage.getItem('mf_' + id) || '';
  el.addEventListener('input', function () { localStorage.setItem('mf_' + id, el.value); });
});

// create key
var genBtn = $('gen');
if (genBtn) genBtn.addEventListener('click', function () {
  var err = $('generr');
  err.style.display = 'none';
  genBtn.disabled = true; genBtn.textContent = 'Generating…';
  fetch(host + '/admin/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('admin').value.trim() },
    body: JSON.stringify({ name: $('kname').value.trim(), expiresInDays: parseInt($('kexp').value, 10) })
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.d.error || 'Failed');
      $('newkey').textContent = res.d.key;
      $('keyout').style.display = 'block';
    })
    .catch(function (e) { err.textContent = e.message; err.style.display = 'block'; })
    .finally(function () { genBtn.disabled = false; genBtn.textContent = 'Generate key'; });
});

var copyBtn = $('copykey');
if (copyBtn) copyBtn.addEventListener('click', function () {
  navigator.clipboard.writeText($('newkey').textContent);
  copyBtn.textContent = '✓ Copied'; setTimeout(function () { copyBtn.textContent = '📋 Copy key'; }, 1500);
});
var useBtn = $('usekey');
if (useBtn) useBtn.addEventListener('click', function () {
  $('apikey').value = $('newkey').textContent;
  $('apikey').dispatchEvent(new Event('input'));
  $('apikey').scrollIntoView({ behavior: 'smooth' });
});

// playground param visibility
var ep = $('ep');
function syncParam() {
  var v = ep.value;
  var wrap = $('paramwrap'), label = $('paramlabel'), input = $('param');
  if (v.indexOf('{q}') >= 0) { wrap.className = ''; label.textContent = 'Search keyword'; input.placeholder = 'one piece'; }
  else if (v.indexOf('{id}') >= 0) { wrap.className = ''; label.textContent = 'Manga id or id-slug'; input.placeholder = 'k3z8r-one-husband-is-enoughh'; }
  else if (v.indexOf('{cid}') >= 0) { wrap.className = ''; label.textContent = 'Chapter id'; input.placeholder = '9395820'; }
  else if (v === '/api/resolve') { wrap.className = ''; label.textContent = 'MangaFire URL'; input.placeholder = 'https://mangafire.to/title/…'; }
  else wrap.className = 'hidden';
}
ep.addEventListener('change', syncParam); syncParam();

var lastUrl = '', lastKey = '';
$('send').addEventListener('click', function () {
  var path = ep.value, p = $('param').value.trim();
  if (path.indexOf('{q}') >= 0) path = path.replace('{q}', encodeURIComponent(p));
  if (path.indexOf('{id}') >= 0) path = path.replace('{id}', encodeURIComponent(p));
  if (path.indexOf('{cid}') >= 0) path = path.replace('{cid}', encodeURIComponent(p));
  if (path === '/api/resolve') path += '?url=' + encodeURIComponent(p);
  var key = $('apikey').value.trim();
  lastUrl = host + path; lastKey = key;
  var out = $('result'), st = $('status');
  out.style.display = 'none'; $('snippetrow').className = 'hidden';
  st.textContent = 'Loading…';
  var t0 = performance.now();
  fetch(lastUrl, { headers: { 'x-api-key': key } })
    .then(function (r) { return r.text().then(function (t) { return { status: r.status, t: t }; }); })
    .then(function (res) {
      var ms = Math.round(performance.now() - t0);
      st.textContent = 'HTTP ' + res.status + ' · ' + ms + ' ms';
      var pretty = res.t;
      try { pretty = JSON.stringify(JSON.parse(res.t), null, 2); } catch (e) {}
      out.textContent = pretty; out.style.display = 'block';
      if (res.status !== 429) $('snippetrow').className = 'row';
    })
    .catch(function (e) { st.textContent = 'Request failed: ' + e.message; });
});

$('copysnippet').addEventListener('click', function () {
  var s = 'const res = await fetch("' + lastUrl + '", {\n' +
    '  headers: { "x-api-key": "' + lastKey + '" }\n' +
    '});\nconst data = await res.json();\nconsole.log(data);';
  navigator.clipboard.writeText(s);
  var b = $('copysnippet'); b.textContent = '✓ Copied';
  setTimeout(function () { b.textContent = '📋 Copy JS snippet for my app'; }, 1500);
});
</script>
</body>
</html>`;
}
