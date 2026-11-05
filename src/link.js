import http from 'node:http';
import crypto from 'node:crypto';

const SESSION_MS = 15 * 60 * 1000;
const MAX_BODY = 64 * 1024;

let active = null;

export function linkSessionActive() {
  return Boolean(active);
}

function escapeForScript(obj) {
  // JSON for embedding inside <script>: neutralize characters that could end the tag.
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function page({ applicationId, environment, enrollmentId }) {
  const cfg = escapeForScript({ applicationId, environment, enrollmentId: enrollmentId || null });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link a bank</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfaf7; --fg:#1d1c1a; --muted:#6b6862; --accent:#1f5f4a; --card:#fff; --line:#e4e1da; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161715; --fg:#ecebe6; --muted:#a09d95; --accent:#5fb496; --card:#1e201d; --line:#2e312c; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; display:grid; min-height:100vh; place-items:center; padding:16px; box-sizing:border-box; }
  main { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; max-width:440px; width:100%; }
  h1 { font-size:1.25rem; margin:0 0 8px; }
  p { margin:8px 0; color:var(--muted); }
  button { margin-top:16px; background:var(--accent); color:#fff; border:0; border-radius:8px; padding:12px 18px; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  #msg { color:var(--fg); min-height:1.5em; }
  .env { font-size:.85rem; }
</style>
</head>
<body>
<main>
  <h1 id="title">Link a bank account</h1>
  <p class="env" id="env"></p>
  <p>You sign in inside Teller's secure window. Your bank password is never typed into this page or into Claude, and the access token stays on this computer.</p>
  <button id="go" type="button">Connect a bank</button>
  <p id="msg" role="status"></p>
</main>
<script src="https://cdn.teller.io/connect/connect.js"></script>
<script>
  var CFG = ${cfg};
  document.addEventListener("DOMContentLoaded", function () {
    var msg = document.getElementById("msg");
    var go = document.getElementById("go");
    document.getElementById("env").textContent = "Environment: " + CFG.environment;
    if (CFG.enrollmentId) {
      document.getElementById("title").textContent = "Reconnect a bank";
      go.textContent = "Reconnect";
    }
    if (typeof TellerConnect === "undefined") {
      msg.textContent = "Teller Connect failed to load. Check your internet connection and reload.";
      go.disabled = true;
      return;
    }
    var options = {
      applicationId: CFG.applicationId,
      environment: CFG.environment,
      products: ["transactions", "balance"],
      selectAccount: "multiple",
      onSuccess: function (enrollment) {
        msg.textContent = "Saving the connection...";
        fetch(location.pathname + "/enrolled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(enrollment)
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.ok) {
            msg.textContent = "Linked " + j.institution + ". You can close this tab and go back to Claude.";
            go.disabled = true;
          } else {
            msg.textContent = "Could not save the connection: " + ((j && j.error) || "unknown error");
          }
        }).catch(function (e) { msg.textContent = "Could not save the connection: " + e.message; });
      },
      onExit: function () { msg.textContent = "Closed without linking anything."; }
    };
    if (CFG.enrollmentId) options.enrollmentId = CFG.enrollmentId;
    var tc = TellerConnect.setup(options);
    go.addEventListener("click", function () { tc.open(); });
  });
</script>
</body>
</html>`;
}

export function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Starts a short-lived web server bound to 127.0.0.1 that hosts Teller Connect.
 * The URL contains a random secret, every request's Host header is checked
 * (DNS-rebinding guard), and the server shuts down after a successful link or 15 minutes.
 */
export function startLink({ cfg, store, label, repairEnrollmentId, onLinked }) {
  if (!cfg.applicationId) {
    return Promise.reject(
      new Error(
        'TELLER_APPLICATION_ID is not set. Create a free app at teller.io, copy its Application ID, and set it (see the plugin README).',
      ),
    );
  }
  if (active) active.close();

  const secret = crypto.randomBytes(16).toString('hex');
  const route = `/link/${secret}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const port = server.address().port;
      const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host || '');
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, {
          'Content-Type': `${type}; charset=utf-8`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (!hostOk) return send(403, { error: 'forbidden' });

      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === route) {
        return send(
          200,
          page({
            applicationId: cfg.applicationId,
            environment: cfg.environment,
            enrollmentId: repairEnrollmentId,
          }),
          'text/html',
        );
      }
      if (req.method === 'POST' && url.pathname === `${route}/enrolled`) {
        try {
          const body = await readJson(req);
          const token = body?.accessToken;
          const enrollmentId = body?.enrollment?.id;
          if (typeof token !== 'string' || !token || typeof enrollmentId !== 'string' || !enrollmentId) {
            return send(400, { ok: false, error: 'Unexpected enrollment payload' });
          }
          const institution = body.enrollment?.institution?.name || 'your bank';
          store.upsert({
            enrollmentId,
            accessToken: token,
            userId: body.user?.id || null,
            institution,
            label: label || null,
            environment: cfg.environment,
            linkedAt: new Date().toISOString(),
          });
          if (onLinked) onLinked();
          send(200, { ok: true, institution });
          setTimeout(() => session.close(), 1500).unref();
        } catch (e) {
          send(400, { ok: false, error: e.message });
        }
        return;
      }
      send(404, { error: 'not found' });
    });

    const session = {
      close() {
        clearTimeout(timer);
        server.close();
        server.closeAllConnections?.();
        if (active === session) active = null;
      },
    };
    const timer = setTimeout(() => session.close(), SESSION_MS);
    timer.unref();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      active = session;
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}${route}`, expiresInMinutes: SESSION_MS / 60000 });
    });
  });
}
