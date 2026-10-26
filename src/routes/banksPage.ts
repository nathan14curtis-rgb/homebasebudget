/**
 * The one web page left after the dashboard went away: linking a bank.
 *
 * Everything else happens in the Google Sheet or by text, but Plaid Link
 * has to run in a browser — to add a bank, or to re-link one whose login
 * expired. This page signs in with a texted code (src/routes/auth.ts),
 * shows each account's status, opens Plaid Link, and links to the sheet.
 * Self-contained: no build step, no framework.
 */
export const BANKS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home Base · Banks</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#1d2330; --muted:#667085; --line:#e4e7ec; --accent:#2f5bd3; --warn:#b54708; --ok:#067647; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f26; --ink:#e8eaee; --muted:#98a2b3; --line:#2b323c; --accent:#7c9bff; --warn:#f79009; --ok:#47cd89; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  label { display:block; font-size:14px; color:var(--muted); margin-bottom:6px; }
  input { width:100%; font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; margin-bottom:12px; }
  button, a.button { display:inline-block; font:inherit; font-weight:600; padding:10px 16px; border-radius:8px; border:0; background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; }
  button:disabled { opacity:.6; cursor:default; }
  a.button.secondary { background:transparent; color:var(--accent); border:1px solid var(--line); }
  ul { list-style:none; padding:0; margin:0; }
  li { display:flex; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); }
  li:last-child { border-bottom:0; }
  .status { font-size:14px; white-space:nowrap; }
  .status.ok { color:var(--ok); } .status.warn { color:var(--warn); }
  .msg { min-height:1.5em; font-size:14px; color:var(--muted); margin-top:12px; }
  .msg.err { color:var(--warn); }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>Home Base</h1>
  <p class="sub">Your budget lives in your Google Sheet and the texting bot. This page is just for linking banks.</p>

  <section class="card" id="login">
    <form id="phone-form">
      <label for="phone">Your phone number</label>
      <input id="phone" type="tel" placeholder="+18015551234" autocomplete="tel" required>
      <button type="submit">Text me a code</button>
    </form>
    <form id="code-form" hidden>
      <label for="code">Code we texted you</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" required>
      <button type="submit">Sign in</button>
    </form>
    <div class="msg" id="login-msg"></div>
  </section>

  <section id="app" hidden>
    <div class="card" id="sheet-card" hidden>
      <a class="button secondary" id="sheet-link" target="_blank" rel="noopener">Open the budget sheet</a>
      <div class="msg" id="sheet-msg"></div>
    </div>
    <div class="card">
      <ul id="accounts"></ul>
      <p class="msg" id="accounts-empty" hidden>No banks linked yet.</p>
      <button id="link-btn" style="margin-top:12px">Link a bank</button>
      <div class="msg" id="link-msg"></div>
    </div>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let session = null;

  async function api(path, options = {}) {
    const res = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...options });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("Request failed (" + res.status + ")"));
    return body;
  }
  function say(el, text, isError) { el.textContent = text || ""; el.classList.toggle("err", !!isError); }

  async function start() {
    try { session = await api("/api/auth/session"); } catch { session = null; }
    $("login").hidden = !!session;
    $("app").hidden = !session;
    if (session) await load();
  }

  async function load() {
    const base = "/api/households/" + session.householdId;
    const [accounts, sheet] = await Promise.all([api(base + "/accounts"), api(base + "/sheet").catch(() => null)]);
    const list = $("accounts");
    list.innerHTML = "";
    const shown = accounts.filter((a) => a.status !== "removed");
    $("accounts-empty").hidden = shown.length > 0;
    for (const a of shown) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = a.name + (a.mask ? " ••" + a.mask : "");
      const status = document.createElement("span");
      const needsLogin = a.status === "login_required";
      status.className = "status " + (needsLogin ? "warn" : "ok");
      status.textContent = needsLogin ? "Needs re-link" : "Syncing";
      li.append(name, status);
      list.append(li);
    }
    if (sheet && sheet.connected) {
      $("sheet-card").hidden = false;
      $("sheet-link").href = sheet.url;
      say($("sheet-msg"), sheet.lastError ? "Last sync problem: " + sheet.lastError : (sheet.lastSyncedAt ? "Last synced " + new Date(sheet.lastSyncedAt).toLocaleString() : "Waiting for its first sync."), !!sheet.lastError);
    }
  }

  $("phone-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: $("phone").value.trim() }) });
      $("phone-form").hidden = true; $("code-form").hidden = false; say($("login-msg"), "Code sent.");
      $("code").focus();
    } catch (err) { say($("login-msg"), err.message, true); }
  });

  $("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ phoneE164: $("phone").value.trim(), code: $("code").value.trim() }) });
      await start();
    } catch (err) { say($("login-msg"), err.message, true); }
  });

  function loadPlaid() {
    return new Promise((resolve, reject) => {
      if (window.Plaid) return resolve();
      const s = document.createElement("script");
      s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Couldn't load the bank-linking window. Check your connection and try again."));
      document.head.append(s);
    });
  }

  $("link-btn").addEventListener("click", async () => {
    const btn = $("link-btn");
    btn.disabled = true; say($("link-msg"), "Opening…");
    try {
      await loadPlaid();
      const base = "/api/households/" + session.householdId;
      const { link_token } = await api(base + "/plaid/link-token", { method: "POST", body: JSON.stringify({ userId: session.userId }) });
      window.Plaid.create({
        token: link_token,
        onSuccess: async (publicToken, metadata) => {
          try {
            const bank = metadata && metadata.institution ? metadata.institution.name : undefined;
            await api(base + "/plaid/exchange-token", { method: "POST", body: JSON.stringify({ publicToken, institutionName: bank }) });
            say($("link-msg"), (bank || "Your bank") + " is linked. Transactions show up in the sheet within the hour.");
            await load();
          } catch (err) { say($("link-msg"), err.message, true); }
          btn.disabled = false;
        },
        onExit: (err) => { btn.disabled = false; say($("link-msg"), err ? (err.display_message || err.error_message || "Linking didn't finish.") : "", !!err); },
      }).open();
    } catch (err) { btn.disabled = false; say($("link-msg"), err.message, true); }
  });

  start();
})();
</script>
</body>
</html>`;
