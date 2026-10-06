/**
 * The web client served at `/`.
 *
 * The `WEB:` row in the startup banner has to lead somewhere a human can use,
 * not to a JSON blob: the thing this tool supervises is invisible by nature —
 * a connection owner holding an MTProto session — and a page that shows which
 * accounts are alive, lets you start or stop one and tails the log is the
 * whole interface most runs need. The JSON route index moved to `/api`.
 *
 * Plain inline HTML/CSS/JS on purpose: no build step, no bundle to serve, and
 * the page keeps working from a file the server reads out of its own source.
 */

import { BIN_NAME, VERSION } from "./constants.ts";

/** 📡 as a favicon — served unauthenticated so the tab icon never 401s. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50%" y="85" text-anchor="middle" font-size="90">📡</text></svg>`;

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f7; color: #1d1d1f; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
  a { color: #0071e3; text-decoration: none; }
  a:hover { text-decoration: underline; }
`;

export function getHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${BIN_NAME}</title>
  <link rel="icon" href="/favicon.ico">
  <style>
${BASE_CSS}
    body { padding: 24px; max-width: 760px; margin: 0 auto; }
    .subtitle { color: #86868b; margin-bottom: 24px; font-size: 14px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
    .tab { padding: 6px 14px; border-radius: 8px; border: 1px solid #d2d2d7; background: #fff; cursor: pointer; font-size: 13px; color: #1d1d1f; transition: all 0.15s; }
    .tab.active { background: #0071e3; color: #fff; border-color: #0071e3; }
    .tab:hover:not(.active) { background: #e8e8ed; }
    .card { background: #fff; border: 1px solid #e8e8ed; border-radius: 10px; padding: 14px; margin-bottom: 8px; }
    .row { display: flex; align-items: center; gap: 10px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; background: #d2d2d7; }
    .dot.alive { background: #34c759; }
    .dot.orphaned { background: #ff3b30; }
    .dot.stale-lock, .dot.no-session, .dot.stopped { background: #ff9500; }
    .name { font-size: 15px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .health { font-size: 12px; color: #86868b; text-transform: uppercase; letter-spacing: 0.4px; }
    .message { font-size: 13px; color: #1d1d1f; margin-top: 8px; line-height: 1.5; }
    .advice { font-size: 13px; color: #86868b; margin-top: 4px; }
    .advice code { background: #f5f5f7; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
    .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    button.act { padding: 5px 11px; font-size: 12px; border-radius: 7px; border: 1px solid #d2d2d7; background: #fff; cursor: pointer; color: #1d1d1f; }
    button.act:hover { background: #e8e8ed; }
    button.act:disabled { opacity: 0.5; cursor: default; }
    button.act.danger { color: #ff3b30; border-color: #ffd3d1; }
    pre { background: #1d1d1f; color: #e8e8ed; border-radius: 8px; padding: 12px; margin-top: 10px; font-size: 12px; line-height: 1.5; overflow-x: auto; max-height: 340px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
    .empty, .loading, .error { padding: 32px; text-align: center; color: #86868b; font-size: 14px; }
    .error { color: #ff3b30; }
    .note { font-size: 12px; color: #86868b; margin-top: 16px; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${BIN_NAME}</h1>
  <p class="subtitle">Telegram connection owners &middot; v${VERSION} &middot; <a href="/api">API</a></p>
  <div class="tabs" id="tabs"></div>
  <div id="view"><div class="loading">Loading…</div></div>
  <p class="note" id="note"></p>
  <script>
    const TABS = ['accounts', 'doctor', 'orphans'];
    let current = 'accounts';
    // Which account's log is expanded; the tail is re-fetched on every refresh
    // so an open log behaves like a tail -f rather than a snapshot.
    let openLog = null;
    let timer = null;

    const tabsEl = document.getElementById('tabs');
    const viewEl = document.getElementById('view');
    const noteEl = document.getElementById('note');

    function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

    /** Any 401 means the cookie is gone: send the browser to the token form. */
    async function api(path, options) {
      const res = await fetch(path, options);
      if (res.status === 401) {
        location.href = '/auth?next=' + encodeURIComponent(location.pathname);
        throw new Error('unauthorized');
      }
      return res.json();
    }

    function renderTabs() {
      tabsEl.innerHTML = '';
      for (const tab of TABS) {
        const btn = document.createElement('button');
        btn.className = 'tab' + (tab === current ? ' active' : '');
        btn.textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
        btn.onclick = () => { current = tab; openLog = null; renderTabs(); refresh(); };
        tabsEl.appendChild(btn);
      }
    }

    async function renderAccounts() {
      const accounts = await api('/status');
      if (!accounts.length) {
        viewEl.innerHTML = '<div class="empty">No accounts yet — run <code>${BIN_NAME} login &lt;account&gt;</code></div>';
        return;
      }
      const tail = openLog ? await api('/logs?account=' + encodeURIComponent(openLog) + '&lines=200') : null;

      viewEl.innerHTML = accounts.map((a) => {
        const isOpen = a.account === openLog;
        const log = isOpen
          ? '<pre>' + esc(tail && tail.exists ? (tail.lines.join('\\n') || '(empty)') : 'no log file at ' + (tail ? tail.path : '?')) + '</pre>'
          : '';
        return '<div class="card">'
          + '<div class="row">'
          + '<span class="dot ' + esc(a.health) + '"></span>'
          + '<span class="name">' + esc(a.account) + '</span>'
          + '<span class="health">' + esc(a.health) + '</span>'
          + '</div>'
          + '<div class="message">' + esc(a.message) + '</div>'
          + (a.advice ? '<div class="advice">→ <code>' + esc(a.advice) + '</code></div>' : '')
          + '<div class="actions">'
          + '<button class="act" data-do="start" data-account="' + esc(a.account) + '">Start</button>'
          + '<button class="act danger" data-do="stop" data-account="' + esc(a.account) + '">Stop</button>'
          + '<button class="act" data-do="log" data-account="' + esc(a.account) + '">' + (isOpen ? 'Hide log' : 'Log') + '</button>'
          + '</div>' + log + '</div>';
      }).join('');

      for (const btn of viewEl.querySelectorAll('button.act')) {
        btn.onclick = () => action(btn);
      }
    }

    async function action(btn) {
      const account = btn.dataset.account;
      const what = btn.dataset.do;
      if (what === 'log') {
        openLog = openLog === account ? null : account;
        return refresh();
      }
      // Starting and stopping an owner takes seconds and must not be fired
      // twice: a second start on a live MTProto session is AUTH_KEY_DUPLICATED.
      for (const other of viewEl.querySelectorAll('button.act')) other.disabled = true;
      btn.textContent = what === 'start' ? 'Starting…' : 'Stopping…';
      try {
        const result = await api('/' + what + '?account=' + encodeURIComponent(account), { method: 'POST' });
        noteEl.textContent = account + ': ' + (result.error || result.message || JSON.stringify(result));
      } catch (error) {
        noteEl.textContent = account + ': ' + error.message;
      }
      refresh();
    }

    async function renderJson(path) {
      const data = await api(path);
      viewEl.innerHTML = '<pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>';
    }

    async function refresh() {
      try {
        if (current === 'accounts') await renderAccounts();
        else await renderJson('/' + current);
      } catch (error) {
        if (error.message !== 'unauthorized') {
          viewEl.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
        }
      }
    }

    renderTabs();
    refresh();
    // Polling, not SSE: the state lives in lock files and sockets on disk, so
    // there is nothing to push — and a dead server just stops updating.
    timer = setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

/** Token form. Posts to /auth, which answers with an HttpOnly cookie. */
export function getAuthPage(next = "/", error?: string): string {
  const safeNext = next.startsWith("/") ? next : "/";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${BIN_NAME} — sign in</title>
  <link rel="icon" href="/favicon.ico">
  <style>
${BASE_CSS}
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #fff; border: 1px solid #e8e8ed; border-radius: 14px; padding: 28px; width: 100%; max-width: 380px; }
    h1 { font-size: 22px; margin-bottom: 6px; }
    p { color: #86868b; font-size: 13px; margin-bottom: 18px; line-height: 1.5; }
    input { width: 100%; padding: 10px 12px; font-size: 14px; border: 1px solid #d2d2d7; border-radius: 9px; margin-bottom: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    input:focus { outline: none; border-color: #0071e3; }
    button { width: 100%; padding: 10px; font-size: 14px; font-weight: 600; color: #fff; background: #0071e3; border: 0; border-radius: 9px; cursor: pointer; }
    button:hover { background: #0077ed; }
    .error { color: #ff3b30; font-size: 13px; margin-bottom: 12px; }
    code { background: #f5f5f7; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${BIN_NAME}</h1>
    <p>Paste the token printed on startup, or the value of <code>${BIN_NAME.toUpperCase()}_TOKEN</code>.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/auth">
      <input type="hidden" name="next" value="${safeNext}">
      <input type="password" name="token" placeholder="Token" autofocus autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}
