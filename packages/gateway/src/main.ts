import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile } from './config.js';
import { createGateway } from './server.js';
import { MemorySessionStore } from './sessions.js';

// From packages/gateway/dist/src/main.js up to the repo root.
const envPath = fileURLToPath(new URL('../../../../.env', import.meta.url));
const config = loadConfig({ ...loadEnvFile(envPath), ...process.env });

const sessions = new MemorySessionStore();
// Redis expires keys for us; a Map needs sweeping.
const sweeper = setInterval(() => sessions.sweep(), 60_000);
sweeper.unref();

const server = createGateway({ config, sessions });

server.listen(config.port, () => {
  const mode = config.shopDomain ? `live (${config.shopDomain})` : 'demo (fixture catalog)';
  console.log(`\n  StoreAgent gateway`);
  console.log(`  ------------------`);
  console.log(`  mode   : ${mode}`);
  console.log(`  model  : ${config.models.workhorse}`);
  console.log(`  demo   : http://localhost:${config.port}/`);
  console.log(`  health : http://localhost:${config.port}/healthz\n`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Don't let a hung keep-alive connection block shutdown forever.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
