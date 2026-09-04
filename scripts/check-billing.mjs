#!/usr/bin/env node
/**
 * Verify billing against the real built server.
 *
 * The unit tests cover the plan maths and the GraphQL request shapes. What they
 * cannot show is the behaviour that costs money in production: that an
 * exhausted shop is refused *before* a model call, that the admin billing route
 * cannot be reached without a verified session token, and that production
 * refuses to boot without an explicit choice about test charges.
 *
 * Spends no model tokens and contacts Shopify not at all.
 *
 *   node scripts/check-billing.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const dir = mkdtempSync(join(tmpdir(), 'storeagent-billing-'));
const DB = join(dir, 'billing.db');
const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP = 'billing-check.myshopify.com';
let failures = 0;

function check(label, actual, expected) {
  const pass = expected === undefined ? Boolean(actual) : actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${String(label).padEnd(46)} ${actual}`);
}

const SHOPIFY_ENV = {
  SHOPIFY_API_KEY: 'test-key',
  SHOPIFY_API_SECRET: 'test-secret',
  SHOPIFY_APP_URL: 'https://example.com',
};

function start(env = {}) {
  const child = spawn(process.execPath, ['packages/gateway/dist/src/main.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STOREAGENT_DB: DB,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'sk-test-not-used',
      SHOP_DOMAIN: SHOP,
      ...SHOPIFY_ENV,
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
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('gateway did not become healthy');
}

const stop = (child) =>
  new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10000).unref();
  });

console.log('\n=== billing ===\n');

try {
  // --- test mode must be an explicit decision in production ---------------
  const implicit = start({
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://shop.example.com',
    // SHOPIFY_BILLING_TEST deliberately unset.
  });
  const code = await new Promise((r) => implicit.child.once('exit', r));
  // Both directions of this mistake are silent: left on, merchants subscribe
  // and we are never paid; left off during a trial run, real cards are charged.
  check('production demands an explicit test flag', code !== 0, true);
  check('and says which variable', implicit.output().includes('SHOPIFY_BILLING_TEST'), true);

  // --- a normal boot ------------------------------------------------------
  const server = start({ SHOPIFY_BILLING_TEST: 'true' });
  await waitForHealth();
  check('starts with billing configured', true, true);
  check(
    'warns loudly that test mode is not paid',
    /TEST MODE/.test(server.output()),
    true,
  );

  // --- admin billing is not reachable without a session token -------------
  const noAuth = await fetch(`${BASE}/admin/billing`);
  check('admin billing rejects an unauthenticated read', noAuth.status, 401);

  const noAuthPost = await fetch(`${BASE}/admin/billing/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'plus' }),
  });
  // Otherwise anyone could start a subscription on any shop.
  check('and rejects an unauthenticated subscribe', noAuthPost.status, 401);

  // --- a free shop inside its allowance is served -------------------------
  // (Not a full chat turn — that would spend model tokens. We only need to see
  // that the request is NOT refused for billing reasons.)
  const allowed = await fetch(`${BASE}/api/chat?shop=${SHOP}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello', page: { type: 'product' }, sessionId: 'seed' }),
  });
  check('inside the allowance, not refused for billing', allowed.status !== 402, true);
  // Stop the stream so we do not wait on a model call.
  await allowed.body?.cancel().catch(() => undefined);

  await stop(server.child);

  // --- exhaust the free allowance, then restart ---------------------------
  {
    const db = new DatabaseSync(DB);
    const period = new Date().toISOString().slice(0, 7);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO resolved (shop, period, session_id, created_at) VALUES (?,?,?,?)',
    );
    for (let i = 0; i < 100; i++) insert.run(SHOP, period, `filler-${i}`, Date.now());
    db.close();
  }

  const after = start({ SHOPIFY_BILLING_TEST: 'true' });
  await waitForHealth();

  const refused = await fetch(`${BASE}/api/chat?shop=${SHOP}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello', page: { type: 'product' }, sessionId: 'new-session' }),
  });
  // 402, not 429: this is "not entitled", not "too fast", and the widget shows
  // a different message for each.
  check('exhausted free plan is refused', refused.status, 402);
  const body = await refused.json();
  check('with a billing verdict', body.verdict, 'quota_exhausted');
  check('and reports the plan', body.plan, 'free');
  check('and the counts', `${body.used}/${body.included}`, '100/100');

  // Usage counts persisted across the restart — an uncounted conversation is
  // revenue we never bill, and a reset counter would be free service forever.
  check('usage survived the restart', body.used, 100);

  await stop(after.child);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'BILLING CHECK PASS' : `BILLING CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
