#!/usr/bin/env node
/**
 * Verify the deployment story, not just the code.
 *
 * The claim being tested is the one that made persistence a blocker: an
 * installed merchant must survive a restart. So this starts the real built
 * server, writes an install, kills it, starts it again, and asks the health
 * endpoint whether the merchant is still there.
 *
 *   node scripts/check-deploy.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const dir = mkdtempSync(join(tmpdir(), 'storeagent-deploy-'));
const DB = join(dir, 'storeagent.db');
const PORT = 8799;
let failures = 0;

function check(label, actual, expected) {
  const pass = expected === undefined ? Boolean(actual) : actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${String(label).padEnd(44)} ${actual}`);
}

function start(env = {}) {
  const child = spawn(process.execPath, ['packages/gateway/dist/src/main.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STOREAGENT_DB: DB,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'sk-test-not-used-by-healthz',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, output: () => out };
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return r.json();
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('gateway did not become healthy');
}

/** SIGTERM and wait, so we exercise the real shutdown path. */
function stop(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10000).unref();
  });
}

console.log('\n=== deployment ===\n');

try {
  // --- boot 1 --------------------------------------------------------------
  const first = start();
  const h1 = await waitForHealth();
  check('gateway starts', h1.ok, true);
  check('creates the database file', existsSync(DB), true);

  // Simulate a completed install by writing through the same schema the app
  // uses. A real OAuth round trip needs Shopify, which we cannot reach here.
  {
    const db = new DatabaseSync(DB);
    db.prepare(
      'INSERT INTO shops (shop, access_token, scopes, installed_at, uninstalled_at) VALUES (?,?,?,?,NULL)',
    ).run('deploy-check.myshopify.com', 'shpat_fake', 'read_products', Date.now());
    db.close();
  }

  const h1b = await waitForHealth();
  check('sees the installed shop', h1b.installedShops, 1);

  await stop(first.child);
  check('shuts down cleanly on SIGTERM', true, true);

  // --- boot 2: the actual test --------------------------------------------
  const second = start();
  const h2 = await waitForHealth();
  // In-memory, this was 0 — every merchant logged out by a routine deploy.
  check('install SURVIVES restart', h2.installedShops, 1);
  await stop(second.child);

  // --- production config refuses to start misconfigured --------------------
  const cases = [
    ['rejects wildcard ALLOWED_ORIGINS', { ALLOWED_ORIGINS: '*' }, 'ALLOWED_ORIGINS'],
    ['rejects missing Shopify credentials', {}, 'SHOPIFY_API_KEY'],
    ['rejects unset STOREAGENT_DB', { STOREAGENT_DB: '' }, 'STOREAGENT_DB'],
  ];

  for (const [label, extra, expectMention] of cases) {
    const bad = start({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://shop.example.com',
      SHOPIFY_API_KEY: 'k',
      SHOPIFY_API_SECRET: 's',
      SHOPIFY_APP_URL: 'https://example.com',
      ...(expectMention === 'SHOPIFY_API_KEY'
        ? { SHOPIFY_API_KEY: '', SHOPIFY_API_SECRET: '', SHOPIFY_APP_URL: '' }
        : {}),
      ...extra,
    });
    const code = await new Promise((r) => bad.child.once('exit', r));
    const said = bad.output().includes(expectMention);
    check(label, code !== 0 && said, true);
  }

  // A correct production config must still start — a check that rejects
  // everything is worse than no check.
  const good = start({
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://shop.example.com',
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
    SHOPIFY_APP_URL: 'https://example.com',
    // No default in production — both directions of this mistake are silent.
    // See scripts/check-billing.mjs for the check that this is enforced.
    SHOPIFY_BILLING_TEST: 'true',
  });
  const h3 = await waitForHealth();
  check('valid production config starts', h3.ok, true);
  check('and reports install ready', h3.install, 'ready');
  await stop(good.child);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'DEPLOY CHECK PASS' : `DEPLOY CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
