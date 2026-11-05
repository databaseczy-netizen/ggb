import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

export class TellerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TellerError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Teller API client: mTLS client certificate + HTTP Basic auth with the
 * enrollment access token as the username. Read endpoints only, plus the
 * explicit "revoke enrollment" call.
 */
export class TellerClient {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.base = new URL(cfg.apiBase);
    this.retryDelayMs = opts.retryDelayMs ?? 1500;
    this._agent = null;
  }

  agent() {
    if (this.base.protocol !== 'https:') return undefined;
    if (this._agent) return this._agent;

    const o = { keepAlive: true };
    const { certPath, keyPath, certPem, keyPem, environment } = this.cfg;
    const havePem = Boolean(certPem && keyPem);
    const haveFiles = Boolean(certPath && keyPath);

    if (havePem) {
      o.cert = certPem;
      o.key = keyPem;
    } else if (haveFiles || certPath || keyPath || environment !== 'sandbox') {
      if (!haveFiles) {
        throw new TellerError(
          0,
          'config.missing_certificate',
          'Set TELLER_CERT_PATH and TELLER_KEY_PATH (or TELLER_CERT_PEM and TELLER_KEY_PEM) to your Teller client certificate and private key. They are required for the development and production environments.',
        );
      }
      try {
        o.cert = fs.readFileSync(certPath);
        o.key = fs.readFileSync(keyPath);
      } catch (e) {
        throw new TellerError(
          0,
          'config.unreadable_certificate',
          `Cannot read the Teller certificate or key file: ${e.message}`,
        );
      }
    }
    this._agent = new https.Agent(o);
    return this._agent;
  }

  async request(method, pathname, { token, query } = {}) {
    const agent = this.agent();
    const url = new URL(pathname, this.base);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const mod = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method,
          agent,
          timeout: 30_000,
          headers: {
            Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
            Accept: 'application/json',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode || 0;
            let body = null;
            if (raw) {
              try {
                body = JSON.parse(raw);
              } catch {
                body = raw;
              }
            }
            if (status >= 200 && status < 300) return resolve(body);
            const err = body && typeof body === 'object' ? body.error || body : null;
            reject(
              new TellerError(
                status,
                (err && err.code) || `http.${status}`,
                (err && err.message) || `Teller returned HTTP ${status}`,
              ),
            );
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new TellerError(0, 'network.timeout', 'The request to Teller timed out')),
      );
      req.on('error', (e) =>
        reject(e instanceof TellerError ? e : new TellerError(0, 'network.error', e.message)),
      );
      req.end();
    });
  }

  /** GET with a couple of retries: Teller documents that the first transactions call can time out. */
  async get(pathname, opts, retries = 2) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request('GET', pathname, opts);
      } catch (e) {
        const retriable =
          e instanceof TellerError &&
          (e.status >= 500 || e.code === 'network.timeout' || e.code === 'network.error');
        if (!retriable || attempt >= retries) throw e;
        await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
  }

  accounts(token) {
    return this.get('/accounts', { token });
  }

  balances(token, accountId) {
    return this.get(`/accounts/${encodeURIComponent(accountId)}/balances`, { token });
  }

  transactionsPage(token, accountId, query) {
    return this.get(`/accounts/${encodeURIComponent(accountId)}/transactions`, { token, query });
  }

  /** Removes this app's authorization for the whole enrollment (also stops billing for it). */
  revokeEnrollment(token) {
    return this.request('DELETE', '/accounts', { token });
  }
}
