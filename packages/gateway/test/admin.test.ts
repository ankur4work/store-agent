import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { bearerToken, signSessionToken, verifySessionToken } from '../src/admin/session-token.js';
import {
  MemorySettingsStore,
  accentIsAccessible,
  contrastWithWhite,
  validateSettings,
} from '../src/admin/settings.js';
import { esc, renderAdmin } from '../src/admin/render.js';

const API_KEY = 'test-client-id';
const SECRET = 'shpss_admin_secret';
const SHOP = 'acme.myshopify.com';
const AUTH = { apiKey: API_KEY, apiSecret: SECRET };

function token(over: Record<string, unknown> = {}, secret = SECRET, alg = 'HS256'): string {
  return signSessionToken({ dest: `https://${SHOP}`, aud: API_KEY, ...over }, secret, alg);
}

/**
 * The session token is the auth boundary for the whole admin — everything a
 * merchant can see or change sits behind it. It gets the same scrutiny as the
 * OAuth path.
 */
describe('session token verification', () => {
  it('accepts a well-formed token', () => {
    const r = verifySessionToken(token(), AUTH);
    expect(r.ok).toBe(true);
    expect((r as { shop: string }).shop).toBe(SHOP);
  });

  it('rejects alg:none — the classic forgery', () => {
    // A token claiming no signature must never be trusted, however well-formed.
    const r = verifySessionToken(token({}, SECRET, 'none'), AUTH);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toContain('unsupported alg');
  });

  it('rejects RS256 rather than verifying it with our HMAC secret', () => {
    // Algorithm confusion: treating the HMAC secret as an RSA public key.
    expect(verifySessionToken(token({}, SECRET, 'RS256'), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects a signature from a different secret', () => {
    expect(verifySessionToken(token({}, 'other-secret'), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects a tampered payload', () => {
    const t = token();
    const [h, , s] = t.split('.');
    const evil = Buffer.from(JSON.stringify({ dest: 'https://evil.myshopify.com', aud: API_KEY }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifySessionToken(`${h}.${evil}.${s}`, AUTH)).toMatchObject({ ok: false });
  });

  it('rejects an expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifySessionToken(token({ exp: now - 600, nbf: now - 700 }), AUTH)).toMatchObject({
      ok: false,
      reason: 'token expired',
    });
  });

  it('rejects a not-yet-valid token', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifySessionToken(token({ nbf: now + 600, exp: now + 900 }), AUTH)).toMatchObject({
      ok: false,
      reason: 'token not yet valid',
    });
  });

  it('rejects a token minted for a DIFFERENT app', () => {
    // Same store, another app's token. Without the aud check it would pass.
    expect(verifySessionToken(token({ aud: 'someone-elses-app' }), AUTH)).toMatchObject({
      ok: false,
      reason: 'audience mismatch',
    });
  });

  it('rejects a dest that is not a shop domain', () => {
    expect(verifySessionToken(token({ dest: 'https://evil.com' }), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects a non-https dest', () => {
    expect(verifySessionToken(token({ dest: `http://${SHOP}` }), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects an iss that does not match dest', () => {
    expect(
      verifySessionToken(token({ iss: 'https://other.myshopify.com/admin' }), AUTH),
    ).toMatchObject({ ok: false, reason: 'iss does not match dest' });
  });

  it.each([undefined, '', 'not.a.jwt', 'a.b', 'a.b.c.d'])('rejects malformed input: %s', (t) => {
    expect(verifySessionToken(t as string | undefined, AUTH)).toMatchObject({ ok: false });
  });

  it('does not throw on a garbage signature length', () => {
    const [h, p] = token().split('.');
    expect(() => verifySessionToken(`${h}.${p}.AA`, AUTH)).not.toThrow();
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['  Bearer   abc  ', 'abc'],
  ])('parses %s', (h, expected) => {
    expect(bearerToken(h)).toBe(expected);
  });

  it.each([undefined, '', 'Basic abc', 'abc'])('rejects %s', (h) => {
    expect(bearerToken(h)).toBeUndefined();
  });
});

describe('settings validation', () => {
  it('accepts a sane payload', () => {
    const r = validateSettings(SHOP, { accentColor: '#1b3a34', cornerRadius: 16, position: 'left' });
    expect(r.ok).toBe(true);
    expect(r.settings).toMatchObject({ shop: SHOP, position: 'left' });
  });

  it.each([
    'red;} body{display:none',
    'javascript:alert(1)',
    'var(--x)',
    '#12',
    'rgb(0,0,0)',
    '#1b3a34; background:url(x)',
  ])('rejects a non-hex accent: %s', (colour) => {
    // The accent is interpolated into a CSS custom property, so anything but a
    // strict hex literal could escape the declaration.
    expect(validateSettings(SHOP, { accentColor: colour }).ok).toBe(false);
  });

  it('rejects an out-of-range radius', () => {
    expect(validateSettings(SHOP, { cornerRadius: 400 }).ok).toBe(false);
    expect(validateSettings(SHOP, { cornerRadius: -4 }).ok).toBe(false);
  });

  it('rejects an unknown position', () => {
    expect(validateSettings(SHOP, { position: 'middle' }).ok).toBe(false);
  });

  it('rejects an over-long greeting', () => {
    expect(validateSettings(SHOP, { greeting: 'x'.repeat(200) }).ok).toBe(false);
  });

  it('always takes the shop from the caller, never the payload', () => {
    // Guards against a merchant writing another store's settings.
    const r = validateSettings(SHOP, { shop: 'victim.myshopify.com', accentColor: '#000000' });
    expect(r.settings!.shop).toBe(SHOP);
  });

  it('round-trips through the store', async () => {
    const store = new MemorySettingsStore();
    const r = validateSettings(SHOP, { accentColor: '#112233' });
    await store.put(r.settings!);
    expect((await store.get(SHOP)).accentColor).toBe('#112233');
  });

  it('returns defaults for an unknown shop', async () => {
    expect((await new MemorySettingsStore().get('new.myshopify.com')).accentColor).toBe('#1b3a34');
  });
});

describe('accent contrast', () => {
  it('passes a dark accent', () => {
    expect(accentIsAccessible('#1b3a34')).toBe(true);
  });

  it.each(['#ffff00', '#e0e0e0', '#ffffff', '#7fffd4'])('rejects a pale accent: %s', (c) => {
    // White text sits on the accent; a pale one is unreadable.
    expect(accentIsAccessible(c)).toBe(false);
  });

  it('expands 3-digit hex', () => {
    expect(contrastWithWhite('#000')).toBeCloseTo(contrastWithWhite('#000000'), 5);
  });

  it('gives black the maximum contrast', () => {
    expect(contrastWithWhite('#000000')).toBeCloseTo(21, 0);
  });
});

describe('render escaping', () => {
  it('escapes html metacharacters', () => {
    expect(esc('<script>"x"&\'y\'')).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
  });

  it('escapes a hostile greeting rather than emitting it raw', () => {
    const out = renderAdmin({
      shop: SHOP,
      apiKey: API_KEY,
      host: '',
      settings: {
        shop: SHOP,
        accentColor: '#1b3a34',
        cornerRadius: 16,
        position: 'right',
        greeting: '"><script>alert(1)</script>',
        enabled: true,
        updatedAt: 0,
      },
      stats: { activeSessions: 0, mode: 'demo', model: 'm' },
    });
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });
});

describe('admin http surface', () => {
  let server: Server;
  let base: string;

  const env = {
    OPENAI_API_KEY: 'sk-test',
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: SECRET,
    SHOPIFY_APP_URL: 'https://app.test',
  };

  beforeEach(async () => {
    server = createGateway({ config: loadConfig(env) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses an unauthenticated admin load', async () => {
    const r = await fetch(`${base}/admin`);
    expect(r.status).toBe(401);
  });

  it('refuses a shop query parameter as authentication', async () => {
    // Otherwise anyone could read any merchant's settings by guessing a name.
    const r = await fetch(`${base}/admin?shop=${SHOP}`);
    expect(r.status).toBe(401);
  });

  it('renders for a valid session token', async () => {
    const r = await fetch(`${base}/admin?id_token=${token()}&host=abc`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(SHOP);
    expect(body).toContain('StoreAgent');
  });

  it('scopes frame-ancestors to the shop and the Shopify admin', async () => {
    const r = await fetch(`${base}/admin?id_token=${token()}`);
    expect(r.headers.get('content-security-policy')).toBe(
      `frame-ancestors https://${SHOP} https://admin.shopify.com;`,
    );
  });

  it('denies framing entirely when unauthenticated', async () => {
    const r = await fetch(`${base}/admin`);
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none';");
  });

  it('never caches admin html', async () => {
    const r = await fetch(`${base}/admin?id_token=${token()}`);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a settings write with no token', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accentColor: '#000000' }),
    });
    expect(r.status).toBe(401);
  });

  it('accepts a valid settings write', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ accentColor: '#102030', cornerRadius: 12, position: 'left' }),
    });
    expect(r.status).toBe(200);
  });

  it('rejects a pale accent with an explanation', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ accentColor: '#ffff00' }),
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toContain('4.5:1');
  });

  it('ignores a shop supplied in the settings payload', async () => {
    // The shop must come from the verified token, not the request body.
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ shop: 'victim.myshopify.com', accentColor: '#123456' }),
    });
    expect(r.status).toBe(200);

    // Victim's settings must be untouched: load the admin AS the victim.
    const victimToken = signSessionToken(
      { dest: 'https://victim.myshopify.com', aud: API_KEY },
      SECRET,
    );
    const page = await fetch(`${base}/admin?id_token=${victimToken}`).then((x) => x.text());
    expect(page).not.toContain('#123456');
  });

  it('rejects malformed json on save', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: 'nope',
    });
    expect(r.status).toBe(400);
  });

  it('404s an unknown admin route', async () => {
    expect((await fetch(`${base}/admin/nope?id_token=${token()}`)).status).toBe(404);
  });
});
