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

  // An exhausted allowance must NOT refuse the shopper. §8: "never a hard
  // cut-off mid-conversation". This asserts the Phase 4 correction to an
  // earlier version of this file, which expected a 402 here.
  const exhausted = await fetch(`${BASE}/api/chat?shop=${SHOP}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello', page: { type: 'product' }, sessionId: 'new-session' }),
  });
  check('exhausted plan still serves the shopper', exhausted.status, 200);
  check('and is not a payment error', exhausted.status !== 402, true);
  await exhausted.body?.cancel().catch(() => undefined);

  // A shop Shopify has frozen drops to handoff, which needs no model at all —
  // so this path is both free to test and free to serve.
  {
    const db = new DatabaseSync(DB);
    db.prepare(
      `INSERT INTO subscriptions (shop, subscription_id, plan_id, status, test, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(shop) DO UPDATE SET status = excluded.status, plan_id = excluded.plan_id`,
    ).run(SHOP, 'gid://sub/1', 'growth', 'frozen', 1, Date.now());
    db.close();
  }

  const frozen = await fetch(`${BASE}/api/chat?shop=${SHOP}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello', page: { type: 'product' }, sessionId: 'frozen-session' }),
  });
  check('frozen shop still gets a response', frozen.status, 200);

  const text = await frozen.text();
  check('degraded to handoff', text.includes('"degraded":"handoff"'), true);
  // The shopper must never learn about the merchant's billing state.
  check(
    'shopper is told nothing about billing',
    !/plan|billing|quota|allowance|subscription|payment/i.test(text),
    true,
  );
  check('and is offered a person instead', /email/i.test(text), true);

  await stop(after.child);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'BILLING CHECK PASS' : `BILLING CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
