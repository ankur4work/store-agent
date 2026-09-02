#!/usr/bin/env node
/**
 * Verify the attribution chain end to end against a running gateway.
 *
 * Simulates a population of shoppers: each gets an exposure beacon, the server
 * assigns an arm, and a realistic fraction of each arm converts via the pixel.
 * Then checks the admin reports a lift consistent with the effect we injected —
 * and, just as importantly, refuses to report one when the sample is thin.
 *
 * Start the gateway with matching Shopify env first (see scripts/check-admin.mjs).
 *
 *   node scripts/check-attribution.mjs
 */
import { signSessionToken } from '../packages/gateway/dist/src/admin/session-token.js';

const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
// Unique per run: the store is in-memory and shared across invocations, so a
// fixed shop makes the thin-sample assertions see the previous run's data.
const SHOP = `attrib-test-${Date.now().toString(36)}.myshopify.com`;
const API_KEY = process.env.SHOPIFY_API_KEY ?? 'local-dev-client';
const SECRET = process.env.SHOPIFY_API_SECRET ?? 'local-dev-secret';
// Minted per request: session tokens live ~60s and this script runs longer
// than that. Reusing one silently turns later admin fetches into 401s.
const mint = () => signSessionToken({ dest: `https://${SHOP}`, aud: API_KEY }, SECRET);

let failures = 0;
function check(label, actual, expected) {
  const pass = expected === undefined ? Boolean(actual) : actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(40)} ${actual}`);
}

async function expose(sessionId) {
  const r = await fetch(`${BASE}/api/exposure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, shop: SHOP }),
  });
  return (await r.json()).arm;
}

async function convert(sessionId, orderId, totalMinor) {
  await fetch(`${BASE}/api/pixel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, shop: SHOP, orderId, totalMinor }),
  });
}

async function admin() {
  const r = await fetch(`${BASE}/admin?id_token=${mint()}`);
  if (r.status !== 200) throw new Error(`admin returned ${r.status}`);
  return r.text();
}

/** Run `fn` over `items` with bounded concurrency — 9k sequential is glacial. */
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }),
  );
}

console.log('\n=== attribution chain ===\n');

// --- 1. thin sample: must refuse to report ------------------------------
for (let i = 0; i < 40; i++) {
  const sid = `warm_${i}`;
  const arm = await expose(sid);
  if (i % 5 === 0) await convert(sid, `w${i}`, 18_900);
  if (i === 0) check('server assigns an arm', ['exposed', 'holdout'].includes(arm), true);
}
let page = await admin();
check('refuses a figure on a thin sample', page.includes('Still measuring'), true);
check('explains what is missing', /Not enough (sessions|orders)/.test(page), true);

// --- 2. deterministic assignment ----------------------------------------
const a1 = await expose('stable_session');
const a2 = await expose('stable_session');
check('arm is stable for a session', a1, a2);

// --- 3. a real population with a clearly real effect ---------------------
// 7% conversion when shown the assistant, 3% when held back. Deliberately a
// large effect: the point here is to prove the POSITIVE path renders, not to
// re-test the statistics (that is what the unit tests are for).
const N = 9000;
const stats = { exposedN: 0, holdoutN: 0, exposedC: 0, holdoutC: 0 };

await pool([...Array(N).keys()], 24, async (i) => {
  const sid = `pop_${i}`;
  const arm = await expose(sid);
  const roll = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  const converts = roll < (arm === 'holdout' ? 0.03 : 0.07);
  if (arm === 'holdout') {
    stats.holdoutN++;
    if (converts) stats.holdoutC++;
  } else {
    stats.exposedN++;
    if (converts) stats.exposedC++;
  }
  if (converts) await convert(sid, `o_${i}`, 18_900);
});

console.log(
  `\n  injected: exposed ${stats.exposedC}/${stats.exposedN} ` +
    `(${((stats.exposedC / stats.exposedN) * 100).toFixed(2)}%) · holdout ${stats.holdoutC}/${stats.holdoutN} ` +
    `(${((stats.holdoutC / stats.holdoutN) * 100).toFixed(2)}%)\n`,
);

check('holdout arm is populated', stats.holdoutN > 0, true);
check('holdout share is near the 20% default', Math.abs(stats.holdoutN / N - 0.2) < 0.03, true);

page = await admin();
check('now reports a result', !page.includes('Still measuring'), true);
check('shows a confidence interval', page.includes('95% CI'), true);
check('shows both arms', page.includes('Held back (control)'), true);

const m = /Incremental revenue[\s\S]{0,400}?(\$[\d,]+\.\d{2}|Not proven yet)/.exec(page);
console.log(`  reported incremental revenue: ${m ? m[1] : '(not found)'}`);
check('reports a revenue figure for a large real effect', /^\$/.test(m?.[1] ?? ''), true);

const ci = /95% CI (-?\d+\.\d+) to (-?\d+\.\d+)/.exec(page);
check('confidence interval excludes zero', ci !== null && Number(ci[1]) > 0, true);

console.log(`\n${failures === 0 ? 'ATTRIBUTION CHECK PASS' : `ATTRIBUTION CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
