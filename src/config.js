import os from 'node:os';
import path from 'node:path';

const clean = (v) => (v ?? '').toString().trim();

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Env vars often carry PEMs with literal "\n" sequences; restore real newlines.
function pem(v) {
  const s = clean(v);
  return s ? s.replace(/\\n/g, '\n') : '';
}

export const ENVIRONMENTS =['sandbox', 'development', 'production'];

export function loadConfig(env = process.env) {
  const environment = (clean(env.TELLER_ENV) || 'development').toLowerCase();
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `TELLER_ENV must be one of ${ENVIRONMENTS.join(', ')} (got "${environment}")`,
    );
  }
  return {
    environment,
    applicationId: clean(env.TELLER_APPLICATION_ID),
    certPath: expandHome(clean(env.TELLER_CERT_PATH)),
    keyPath: expandHome(clean(env.TELLER_KEY_PATH)),
    // Hosted mode: PEM contents supplied directly (for hosts without local files).
    certPem: pem(env.TELLER_CERT_PEM),
    keyPem: pem(env.TELLER_KEY_PEM),
    // Hosted mode only.
    port: parseInt(clean(env.PORT), 10) || 10000,
    publicUrl: clean(env.PUBLIC_URL) || clean(env.RENDER_EXTERNAL_URL),
    bearerToken: clean(env.MCP_BEARER_TOKEN),
    storeKey: clean(env.TELLER_STORE_KEY),
    // Hosts with no persistent disk keep the encrypted store in this setting instead.
    storeBlob: clean(env.TELLER_STORE_BLOB),
    dataDir:
      expandHome(clean(env.TELLER_DATA_DIR)) || path.join(os.homedir(), '.teller-claude'),
    // Overridable for tests only. Real use always talks to Teller.
    apiBase: clean(env.TELLER_API_BASE) || 'https://api.teller.io',
  };
}
