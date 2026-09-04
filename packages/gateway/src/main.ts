import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { createGateway } from './server.js';
import { createSqliteStores } from './store/sqlite.js';
import { SqliteSpendStore } from './limits/budget.js';
import { RateLimiter } from './limits/limiter.js';
import { SqliteBillingStore } from './billing/store.js';
import { BillingService } from './billing/service.js';

// From packages/gateway/dist/src/main.js up to the repo root.
const envPath = fileURLToPath(new URL('../../../../.env', import.meta.url));
const config = loadConfig({ ...loadEnvFile(envPath), ...process.env });

const dbPath = resolve(config.databasePath);
mkdirSync(dirname(dbPath), { recursive: true });

const { db, sessions, shops, nonces, settings, attribution } = createSqliteStores({ path: dbPath });

// Spend counters are persisted so a crash loop cannot reset the daily budget.
const spend = new SqliteSpendStore(db);
const limiter = new RateLimiter(config.rateLimits, spend);

// SQLite does not expire rows; a periodic sweep is what a TTL would be in Redis.
const sweeper = setInterval(() => {
  sessions.sweep();
  nonces.sweep();
  // Idle rate-limit buckets are indistinguishable from absent ones, and
  // reclaiming them is what keeps the limiter from growing under attack.
  limiter.sweep();
  spend.prune(Date.now());
}, 60_000);
sweeper.unref();

// Billing needs a shop's access token to talk to the Admin API, so it exists
// only when the app is actually installable. In demo mode there is no shop to
// bill and the whole subsystem stays absent rather than half-configured.
const billingStore = new SqliteBillingStore(db);
const billing =
  config.shopify === undefined
    ? undefined
    : new BillingService({
        store: billingStore,
        apiFor: async (shop) => {
          const record = await shops.get(shop);
          if (record === undefined) return undefined;
          return {
            shop,
            accessToken: record.accessToken,
            returnUrl: `${config.shopify!.appUrl}/admin?shop=${encodeURIComponent(shop)}`,
            test: config.billingTest,
          };
        },
      });

const server = createGateway({
  config,
  sessions,
  shops,
  nonces,
  settings,
  attribution,
  limiter,
  ...(billing === undefined ? {} : { billing }),
});

server.listen(config.port, () => {
  const mode = config.shopDomain ? `live (${config.shopDomain})` : 'demo (fixture catalog)';
  console.log(`\n  StoreAgent gateway`);
  console.log(`  ------------------`);
  console.log(`  env    : ${config.production ? 'production' : 'development'}`);
  console.log(`  mode   : ${mode}`);
  console.log(`  model  : ${config.models.workhorse}`);
  console.log(`  store  : ${dbPath}`);
  console.log(`  install: ${config.shopify ? 'enabled' : 'DISABLED (no Shopify credentials)'}`);
  console.log(
    `  billing: ${
      billing === undefined
        ? 'disabled (no Shopify credentials)'
        : config.billingTest
          ? 'TEST MODE — subscriptions are simulated and you will NOT be paid'
          : 'live charges'
    }`,
  );
  console.log(
    `  limits : ${
      config.rateLimits.enabled
        ? `${config.rateLimits.shopDailyUnits}/shop/day, ${config.rateLimits.globalDailyUnits} global, ` +
          `proxy hops ${config.rateLimits.trustProxyHops}`
        : 'DISABLED'
    }`,
  );
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
