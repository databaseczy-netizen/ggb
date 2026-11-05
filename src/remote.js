// Hosted entry point (Render, etc.): HTTP server for MCP + the Teller Connect link page.
import http from 'node:http';
import { loadConfig } from './config.js';
import { createRemoteApp } from './remote-app.js';

const log = (...a) => console.log('[teller-bank-sync]', ...a);

function main() {
  const cfg = loadConfig();
  const problems = [];
  if (cfg.bearerToken.length < 24) {
    problems.push('MCP_BEARER_TOKEN must be set to a random secret of at least 24 characters.');
  }
  if (!cfg.applicationId) problems.push('TELLER_APPLICATION_ID is not set.');
  if (cfg.environment !== 'sandbox' && !(cfg.certPem && cfg.keyPem) && !(cfg.certPath && cfg.keyPath)) {
    problems.push('TELLER_CERT_PEM and TELLER_KEY_PEM (or the file path variants) are required outside sandbox.');
  }
  if (cfg.storeKey.length < 16) {
    problems.push('TELLER_STORE_KEY must be set (16+ characters). It encrypts your bank tokens on disk.');
  }
  if (!cfg.publicUrl) problems.push('PUBLIC_URL is not set (Render usually provides RENDER_EXTERNAL_URL).');
  if (problems.length) {
    for (const p of problems) console.error(`[teller-bank-sync] config error: ${p}`);
    process.exit(1);
  }

  const app = createRemoteApp({ cfg });
  const server = http.createServer(app.handle);
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;
  server.listen(cfg.port, '0.0.0.0', () => {
    log(`listening on :${cfg.port} (environment: ${cfg.environment}, public: ${cfg.publicUrl})`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
