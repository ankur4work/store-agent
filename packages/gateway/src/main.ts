import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { createGateway } from './server.js';
import { createSqliteStores } from './store/sqlite.js';

// From packages/gateway/dist/src/main.js up to the repo root.
const envPath = fileURLToPath(new URL('../../../../.env', import.meta.url));
const config = loadConfig({ ...loadEnvFile(envPath), ...process.env });

const dbPath = resolve(config.databasePath);
mkdirSync(dirname(dbPath), { recursive: true });

const { db, sessions, shops, nonces, settings, attribution } = createSqliteStores({ path: dbPath });

// SQLite does not expire rows; a periodic sweep is what a TTL would be in Redis.
const sweeper = setInterval(() => {
  sessions.sweep();
  nonces.sweep();
}, 60_000);
sweeper.unref();

const server = createGateway({ config, sessions, shops, nonces, settings, attribution });

server.listen(config.port, () => {
  const mode = config.shopDomain ? `live (${config.shopDomain})` : 'demo (fixture catalog)';
  console.log(`\n  StoreAgent gateway`);
  console.log(`  ------------------`);
  console.log(`  env    : ${config.production ? 'production' : 'development'}`);
  console.log(`  mode   : ${mode}`);
  console.log(`  model  : ${config.models.workhorse}`);
  console.log(`  store  : ${dbPath}`);
  console.log(`  install: ${config.shopify ? 'enabled' : 'DISABLED (no Shopify credentials)'}`);
  console.log(`  demo   : http://localhost:${config.port}/`);
  console.log(`  health : http://localhost:${config.port}/healthz\n`);
});

/**
 * Shut down without truncating a write.
 *
 * A container orchestrator sends SIGTERM and then SIGKILLs after a grace
 * period, so the database must be closed deliberately — checkpointing the WAL
 * — rather than left to a hard kill. Idempotent, because a second signal
 * during shutdown must not run the whole sequence again.
 */
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    clearInterval(sweeper);

    const done = (code: number): never => {
      try {
        db.close();
      } catch {
        // Already closed, or closed by the timeout path below.
      }
      process.exit(code);
    };

    server.close(() => done(0));
    // A hung keep-alive connection must not hold the process past the
    // orchestrator's grace period, or SIGKILL arrives with the WAL open.
    setTimeout(() => done(0), 8000).unref();
  });
}
