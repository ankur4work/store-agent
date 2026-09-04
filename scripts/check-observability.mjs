#!/usr/bin/env node
/**
 * Verify observability against the real built server.
 *
 * Two things unit tests cannot show. First, that /metrics is genuinely
 * unreachable without the token — it exposes conversation volumes, error rates
 * and per-shop token spend, which is a competitive read on the business.
 * Second, that a real request actually moves the counters, because a metric
 * that is defined but never incremented looks exactly like a healthy system.
 *
 *   node scripts/check-observability.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'storeagent-obs-'));
const PORT = 8805;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-metrics-token-do-not-use';
let failures = 0;

function check(label, actual, expected) {
  const pass = expected === undefined ? Boolean(actual) : actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${String(label).padEnd(48)} ${actual}`);
}

function start(env = {}) {
  const child = spawn(process.execPath, ['packages/gateway/dist/src/main.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STOREAGENT_DB: join(dir, 'obs.db'),
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'sk-test-not-used',
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

const auth = { authorization: `Bearer ${TOKEN}` };

console.log('\n=== observability ===\n');

try {
  // --- fails closed without a token ---------------------------------------
  const noToken = start();
  await waitForHealth();
  const disabled = await fetch(`${BASE}/metrics`);
  // Forgetting to configure a token must not silently publish the metrics.
  check('no token => /metrics is 404, not open', disabled.status, 404);
  const sloDisabled = await fetch(`${BASE}/api/slo`);
  check('no token => /api/slo is 404, not open', sloDisabled.status, 404);
  await stop(noToken.child);

  // --- with a token -------------------------------------------------------
  const server = start({ METRICS_TOKEN: TOKEN, LOG_LEVEL: 'info' });
  await waitForHealth();

  check('unauthenticated scrape is refused', (await fetch(`${BASE}/metrics`)).status, 401);
  check(
    'a wrong token is refused',
    (await fetch(`${BASE}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );

  const scrape = await fetch(`${BASE}/metrics`, { headers: auth });
  check('authenticated scrape succeeds', scrape.status, 200);
  check(
    'served in Prometheus exposition format',
    (scrape.headers.get('content-type') ?? '').includes('text/plain'),
    true,
  );
  const body = await scrape.text();
  check('reports uptime', /storeagent_uptime_seconds \d+/.test(body), true);
  check('reports memory', /storeagent_memory_rss_bytes \d+/.test(body), true);

  // --- a real request moves the counters ----------------------------------
  for (let i = 0; i < 3; i++) await fetch(`${BASE}/api/config?shop=obs.myshopify.com`);
  // Trip the limiter so the refusal counter has something in it.
  for (let i = 0; i < 200; i++) await fetch(`${BASE}/api/config?shop=obs.myshopify.com`);

  const after = await (await fetch(`${BASE}/metrics`, { headers: auth })).text();
  check('rate-limit refusals are counted', /storeagent_rate_limited_total\{reason="ip"\} [1-9]/.test(after), true);
  check('tracked clients gauge is populated', /storeagent_rate_limit_clients [1-9]/.test(after), true);

  // --- SLO endpoint -------------------------------------------------------
  const slo = await (await fetch(`${BASE}/api/slo`, { headers: auth })).json();
  check('slo endpoint responds', typeof slo.turns, 'number');
  // "no data yet" and "failing" must not look the same on a dashboard.
  check('gates say unknown on no data', slo.groundingGate, 'unknown');
  check('and the TTFT gate too', slo.ttftGate, 'unknown');

  // --- logs carry no shopper content --------------------------------------
  const logs = server.output();
  check('startup announces metrics', logs.includes('/metrics'), true);
  // Nothing in a normal run should print a conversation.
  check('no shopper content in logs', /"message"\s*:\s*"(?!\[redacted\])/.test(logs), false);

  await stop(server.child);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'OBSERVABILITY CHECK PASS' : `OBSERVABILITY CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
