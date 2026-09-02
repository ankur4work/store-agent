#!/usr/bin/env node
/**
 * Verify the merchant admin against a running gateway.
 *
 * Mints a session token locally (the same HS256 App Bridge mints), then checks
 * the auth boundary, CSP, persistence, and the accessibility gate.
 *
 * Start the gateway with matching Shopify env first:
 *   SHOPIFY_API_KEY=local-dev-client SHOPIFY_API_SECRET=local-dev-secret \
 *   SHOPIFY_APP_URL=https://example.test node packages/gateway/dist/src/main.js
 *
 *   node scripts/check-admin.mjs
 */
import { signSessionToken } from '../packages/gateway/dist/src/admin/session-token.js';

const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
const SHOP = 'acme.myshopify.com';
const API_KEY = process.env.SHOPIFY_API_KEY ?? 'local-dev-client';
const SECRET = process.env.SHOPIFY_API_SECRET ?? 'local-dev-secret';

const mint = (shop = SHOP) => signSessionToken({ dest: `https://${shop}`, aud: API_KEY }, SECRET);
const t = mint();
let failures = 0;

function check(label, actual, expected) {
  const pass = expected === undefined ? Boolean(actual) : actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${actual}`);
}

console.log('\n=== merchant admin ===\n');

const res = await fetch(`${BASE}/admin?id_token=${t}&host=abc`);
const body = await res.text();
check('authenticated load', res.status, 200);
check('csp scoped to shop', res.headers.get('content-security-policy'), `frame-ancestors https://${SHOP} https://admin.shopify.com;`);
check('no-store', res.headers.get('cache-control'), 'no-store');
check('renders shop', body.includes(SHOP), true);
check('loads App Bridge', body.includes('app-bridge.js'), true);
check('shows contrast ratio', /contrast \d+\.\d+:1/.test(body), true);

const unauth = await fetch(`${BASE}/admin`);
check('unauthenticated refused', unauth.status, 401);
check('framing denied when unauth', unauth.headers.get('content-security-policy'), "frame-ancestors 'none';");

const byShopParam = await fetch(`${BASE}/admin?shop=${SHOP}`);
check('shop param is not auth', byShopParam.status, 401);

const save = await fetch(`${BASE}/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
  body: JSON.stringify({ accentColor: '#8b1e3f', cornerRadius: 10, position: 'left' }),
});
check('save accepted', save.status, 200);

const after = await fetch(`${BASE}/admin?id_token=${t}`).then((r) => r.text());
check('setting persisted', after.includes('#8b1e3f'), true);

const pale = await fetch(`${BASE}/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
  body: JSON.stringify({ accentColor: '#ffff66' }),
});
check('pale accent rejected', pale.status, 422);

// Cross-tenant write: the shop must come from the token, never the payload.
await fetch(`${BASE}/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
  body: JSON.stringify({ shop: 'victim.myshopify.com', accentColor: '#0a0a0a' }),
});
const victim = await fetch(`${BASE}/admin?id_token=${mint('victim.myshopify.com')}`).then((r) => r.text());
check('cross-tenant write blocked', !victim.includes('#0a0a0a'), true);

const noToken = await fetch(`${BASE}/admin/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
check('unsigned save refused', noToken.status, 401);

console.log(`\n${failures === 0 ? 'ADMIN CHECK PASS' : `ADMIN CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
