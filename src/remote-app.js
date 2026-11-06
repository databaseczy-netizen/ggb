import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store } from './store.js';
import { BankData } from './data.js';
import { buildServer } from './index.js';
import { page, readJson } from './link.js';

const LINK_TTL_MS = 15 * 60 * 1000;
const MAX_LINK_SESSIONS = 10;
const MAX_MCP_BODY = 1024 * 1024;
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(s).digest();

/**
 * Hosted HTTP front end: stateless MCP over Streamable HTTP behind a bearer token,
 * plus a one-time-URL page that hosts Teller Connect. Returns a plain Node
 * (req, res) handler so it can run behind any host and be tested offline.
 */
export function createRemoteApp({ cfg, store, bank }) {
  store = store || new Store(cfg.dataDir, { key: cfg.storeKey, seed: cfg.storeBlob });
  bank = bank || new BankData(cfg, store);

  const linkSessions = new Map();
  const failures = new Map();

  const publicUrl = () => (cfg.publicUrl || '').replace(/\/+$/, '');
  const allowedHost = () => {
    try {
      return new URL(publicUrl()).host;
    } catch {
      return null;
    }
  };

  // Render (and most hosts) append the real client address last in X-Forwarded-For.
  const clientIp = (req) => {
    const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
  };
  const blocked = (ip) => {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() > f.until) {
      failures.delete(ip);
      return false;
    }
    return f.count >= FAIL_LIMIT;
  };
  const recordFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() > f.until) failures.set(ip, { count: 1, until: Date.now() + FAIL_WINDOW_MS });
    else f.count += 1;
    if (failures.size > 5000) failures.clear(); // bound memory under a flood
  };

  const authorized = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return Boolean(m && cfg.bearerToken && crypto.timingSafeEqual(sha(m[1]), sha(cfg.bearerToken)));
  };

  const send = (res, status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const startLinkFn = async ({ label, repairEnrollmentId, onLinked }) => {
    if (!cfg.applicationId) {
      throw new Error('TELLER_APPLICATION_ID is not set on the server.');
    }
    if (!publicUrl()) {
      throw new Error('PUBLIC_URL is not set on the server, so it cannot build a link address.');
    }
    const now = Date.now();
    for (const [k, s] of linkSessions) if (s.expires < now) linkSessions.delete(k);
    if (linkSessions.size >= MAX_LINK_SESSIONS) {
      throw new Error('Too many open link sessions. Finish or wait for the existing ones to expire.');
    }
    const secret = crypto.randomBytes(16).toString('hex');
    linkSessions.set(secret, { label, repairEnrollmentId, onLinked, expires: now + LINK_TTL_MS });
    return { url: `${publicUrl()}/link/${secret}`, expiresInMinutes: LINK_TTL_MS / 60000 };
  };

  async function handleMcp(req, res) {
    if (!cfg.bearerToken) {
      return send(res, 503, { error: 'MCP_BEARER_TOKEN is not configured on the server.' });
    }
    const ip = clientIp(req);
    if (blocked(ip)) return send(res, 429, { error: 'too many failed attempts' }, 'application/json', { 'Retry-After': '900' });
    if (!authorized(req)) {
      recordFailure(ip);
      return send(res, 401, { error: 'unauthorized' }, 'application/json', { 'WWW-Authenticate': 'Bearer' });
    }
    if (req.method !== 'POST') {
      return send(
        res,
        405,
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null },
        'application/json',
        { Allow: 'POST' },
      );
    }
    let body;
    try {
      body = await readJson(req, MAX_MCP_BODY);
    } catch {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    const server = buildServer({ cfg, store, bank, startLinkFn });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      Promise.resolve(transport.close()).catch(() => {});
      Promise.resolve(server.close()).catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleLink(req, res, url) {
    const ip = clientIp(req);
    if (blocked(ip)) return send(res, 429, { error: 'too many failed attempts' });
    if ((req.headers.host || '') !== allowedHost()) return send(res, 403, { error: 'forbidden' });

    const m = /^\/link\/([0-9a-f]{32})(\/enrolled)?$/.exec(url.pathname);
    const session = m && linkSessions.get(m[1]);
    if (!session || session.expires < Date.now()) {
      if (m) linkSessions.delete(m[1]);
      recordFailure(ip);
      return send(res, 404, { error: 'This link is invalid or has expired. Ask Claude for a new one.' });
    }

    if (!m[2] && req.method === 'GET') {
      return send(
        res,
        200,
        page({ applicationId: cfg.applicationId, environment: cfg.environment, enrollmentId: session.repairEnrollmentId }),
        'text/html',
        { 'X-Frame-Options': 'DENY' },
      );
    }
    if (m[2] && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const token = body?.accessToken;
        const enrollmentId = body?.enrollment?.id;
        if (typeof token !== 'string' || !token || typeof enrollmentId !== 'string' || !enrollmentId) {
          return send(res, 400, { ok: false, error: 'Unexpected enrollment payload' });
        }
        const institution = body.enrollment?.institution?.name || 'your bank';
        store.upsert({
          enrollmentId,
          accessToken: token,
          userId: body.user?.id || null,
          institution,
          label: session.label || null,
          environment: cfg.environment,
          linkedAt: new Date().toISOString(),
        });
        linkSessions.delete(m[1]); // one bank per link
        if (session.onLinked) session.onLinked();
        bank.invalidate();
        return send(res, 200, { ok: true, institution, store_blob: store.exportBlob() });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
      if (url.pathname === '/mcp') return await handleMcp(req, res);
      if (url.pathname.startsWith('/link/')) return await handleLink(req, res, url);
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[teller-bank-sync] request error:', e.message);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    }
  }

  return { handle, store, bank, linkSessions };
}
