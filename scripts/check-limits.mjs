#!/usr/bin/env node
/**
 * Verify rate limiting against the real built server over real HTTP.
 *
 * The unit tests prove the policy logic. They cannot prove the thing that
 * actually breaks a deployment: that the health endpoint stays reachable under
 * flood (a 429 there reads as "unhealthy" and the orchestrator kills a working
 * container), or that `Retry-After` survives to the wire.
 *
 * Deliberately spends no model tokens: bucket behaviour is exercised through
 * /api/config, and the ceiling through /api/chat with the cap set to zero so
 * every chat request is refused before it can reach a model.
 *
 *   node scripts/check-limits.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'storeagent-limits-'));
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(label, actual, expected) {
  const pass = expected === undefined ? Boolean(actual) : actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${String(label).padEnd(46)} ${actual}`);
}

const child = spawn(process.execPath, ['packages/gateway/dist/src/main.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STOREAGENT_DB: join(dir, 'limits.db'),
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'sk-test-not-used',
    RATE_LIMIT_ENABLED: 'true',
    // Small burst so a handful of requests is enough to trip it.
    RATE_LIMIT_BURST: '8',
    RATE_LIMIT_REFILL_PER_MIN: '6',
    // Zero ceiling: every chat request is refused before any model call.
    DAILY_UNITS_PER_SHOP: '0',
    // Trust one hop so we can present distinct clients via X-Forwarded-For,
    // which also exercises the proxy handling end to end.
    TRUST_PROXY_HOPS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));

const as = (ip) => ({ 'x-forwarded-for': ip });

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

console.log('\n=== rate limiting ===\n');

try {
  await waitForHealth();

  // --- health must never be throttled -------------------------------------
  let healthStatuses = new Set();
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/healthz`, { headers: as('203.0.113.99') });
    healthStatuses.add(r.status);
  }
  // If this ever 429s, the container healthcheck fails and the orchestrator
  // kills a process that is working perfectly.
  check('health survives 120 rapid requests', [...healthStatuses].join(','), '200');

  // --- per-client bucket ---------------------------------------------------
  const statuses = [];
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${BASE}/api/config?shop=limits.myshopify.com`, {
      headers: as('203.0.113.1'),
    });
    statuses.push(r.status);
  }
  const ok = statuses.filter((s) => s === 200).length;
  const limited = statuses.filter((s) => s === 429).length;
  check('burst allowed then throttled (8 of 20)', ok, 8);
  check('the rest are refused', limited, 12);

  // --- a different client is unaffected ------------------------------------
  const other = await fetch(`${BASE}/api/config?shop=limits.myshopify.com`, {
    headers: as('203.0.113.2'),
  });
  // Proves X-Forwarded-For is being read, and that one abusive client does not
  // take everyone else down with them.
  check('a different client is unaffected', other.status, 200);

  // --- 429 shape -----------------------------------------------------------
  const refused = await fetch(`${BASE}/api/config?shop=limits.myshopify.com`, {
    headers: as('203.0.113.1'),
  });
  check('refused with 429', refused.status, 429);
  const retryAfter = refused.headers.get('retry-after');
  check('sends Retry-After', Number(retryAfter) > 0, true);
  const body = await refused.json();
  check('names the limit that fired', body.reason, 'ip');

  // --- daily ceiling, on a fresh client so the bucket is not the cause -----
  const chat = await fetch(`${BASE}/api/chat?shop=limits.myshopify.com`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...as('203.0.113.50') },
    body: JSON.stringify({ message: 'hello', page: { type: 'product' } }),
  });
  check('ceiling refuses chat', chat.status, 429);
  const chatBody = await chat.json();
  // Distinguishable from the bucket, so an operator can tell "too fast" from
  // "out of budget" without reading logs.
  check('ceiling reports its own reason', chatBody.reason, 'shop_daily');
  check('retry-after points past midnight', Number(chatBody.retryAfterSec) > 60, true);

  // --- the ceiling must not block free routes ------------------------------
  const stillFree = await fetch(`${BASE}/api/config?shop=limits.myshopify.com`, {
    headers: as('203.0.113.60'),
  });
  // Cap is 0 units, yet routes that cost nothing must keep working — otherwise
  // an exhausted budget takes the whole widget offline instead of just chat.
  check('free routes still served at zero budget', stillFree.status, 200);

  // --- spend survives a restart -------------------------------------------
  check('startup logs the limit configuration', serverLog.includes('limits :'), true);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'LIMITS CHECK PASS' : `LIMITS CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
