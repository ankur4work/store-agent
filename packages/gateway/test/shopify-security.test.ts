import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidShopDomain, parseShopDomain, shopUrl } from '../src/shopify/domain.js';
import { verifyQueryHmac, verifyWebhookHmac } from '../src/shopify/hmac.js';
import { beginInstall, completeInstall, callbackUrl } from '../src/shopify/oauth.js';
import { handleWebhook } from '../src/shopify/webhooks.js';
import { MemoryNonceStore, MemoryShopStore } from '../src/shopify/shops.js';

const SECRET = 'shpss_testsecret_do_not_use';
const APP = {
  apiKey: 'test-client-id',
  apiSecret: SECRET,
  scopes: 'read_products',
  appUrl: 'https://app.test',
};

function signQuery(params: Record<string, string>): URLSearchParams {
  const pairs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const hmac = createHmac('sha256', SECRET).update(pairs.join('&'), 'utf8').digest('hex');
  return new URLSearchParams({ ...params, hmac });
}

/**
 * The `shop` parameter is attacker-controlled and is used to build both a
 * browser redirect and a server-side POST carrying our client secret. A
 * permissive check is simultaneously an open redirect and a credential-leaking
 * SSRF, so this is the most security-critical function in the install flow.
 */
describe('shop domain validation', () => {
  it.each([
    'acme.myshopify.com',
    'a.myshopify.com',
    'my-store-123.myshopify.com',
  ])('accepts a legitimate domain: %s', (d) => {
    expect(parseShopDomain(d)).toMatchObject({ ok: true, shop: d });
  });

  it('normalises case', () => {
    expect(parseShopDomain('ACME.MyShopify.COM').shop).toBe('acme.myshopify.com');
  });

  it('trims surrounding whitespace', () => {
    expect(parseShopDomain('  acme.myshopify.com  ').shop).toBe('acme.myshopify.com');
  });

  it.each([
    ['suffix attack', 'acme.myshopify.com.evil.com'],
    ['prefix attack', 'evil.com/acme.myshopify.com'],
    ['path appended', 'acme.myshopify.com/admin'],
    ['scheme included', 'https://acme.myshopify.com'],
    ['port included', 'acme.myshopify.com:8080'],
    ['userinfo', 'user@acme.myshopify.com'],
    ['backslash path', 'acme.myshopify.com\\evil'],
    ['query appended', 'acme.myshopify.com?x=1'],
    ['fragment appended', 'acme.myshopify.com#x'],
    ['wrong tld', 'acme.myshopify.net'],
    ['bare domain', 'myshopify.com'],
    ['subdomain of subdomain', 'a.b.myshopify.com'],
    ['empty label', 'acme..myshopify.com'],
    ['trailing dot FQDN', 'acme.myshopify.com.'],
    ['leading hyphen', '-acme.myshopify.com'],
    ['trailing hyphen', 'acme-.myshopify.com'],
    ['underscore', 'ac_me.myshopify.com'],
    ['unicode homoglyph', 'аcme.myshopify.com'],
    ['fullwidth', 'ａcme.myshopify.com'],
    ['newline injection', 'acme.myshopify.com\nevil'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['plain evil', 'evil.com'],
    ['localhost', 'localhost'],
    ['ip address', '169.254.169.254'],
  ])('rejects %s: %s', (_label, input) => {
    expect(isValidShopDomain(input), `should reject ${JSON.stringify(input)}`).toBe(false);
  });

  it.each([null, undefined, 123, {}, [], true])('rejects non-string %s', (v) => {
    expect(isValidShopDomain(v)).toBe(false);
  });

  it('rejects an over-long value before doing anything else', () => {
    expect(isValidShopDomain('a'.repeat(200) + '.myshopify.com')).toBe(false);
  });

  it('shopUrl refuses to build a URL for an invalid domain', () => {
    expect(() => shopUrl('evil.com', '/admin')).toThrow(/invalid shop domain/);
  });

  it('shopUrl always targets the shop origin', () => {
    expect(shopUrl('acme.myshopify.com', '/admin/oauth/authorize')).toBe(
      'https://acme.myshopify.com/admin/oauth/authorize',
    );
  });
});

describe('query HMAC', () => {
  it('accepts a correctly signed query', () => {
    expect(verifyQueryHmac(signQuery({ shop: 'acme.myshopify.com', code: 'abc' }), SECRET)).toBe(true);
  });

  it('rejects a tampered parameter', () => {
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'abc' });
    q.set('shop', 'evil.myshopify.com');
    expect(verifyQueryHmac(q, SECRET)).toBe(false);
  });

  it('rejects a missing hmac', () => {
    expect(verifyQueryHmac(new URLSearchParams({ shop: 'acme.myshopify.com' }), SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyQueryHmac(signQuery({ shop: 'acme.myshopify.com' }), 'other-secret')).toBe(false);
  });

  it('excludes hmac and signature from the signed payload', () => {
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'abc' });
    q.set('signature', 'anything-at-all');
    expect(verifyQueryHmac(q, SECRET)).toBe(true);
  });

  it('is order-independent — Shopify sorts by key', () => {
    const a = signQuery({ shop: 'acme.myshopify.com', code: 'abc', state: 'xyz' });
    const shuffled = new URLSearchParams();
    shuffled.set('state', a.get('state')!);
    shuffled.set('hmac', a.get('hmac')!);
    shuffled.set('code', a.get('code')!);
    shuffled.set('shop', a.get('shop')!);
    expect(verifyQueryHmac(shuffled, SECRET)).toBe(true);
  });

  it('rejects a truncated hmac rather than throwing on length mismatch', () => {
    const q = signQuery({ shop: 'acme.myshopify.com' });
    q.set('hmac', q.get('hmac')!.slice(0, 10));
    expect(() => verifyQueryHmac(q, SECRET)).not.toThrow();
    expect(verifyQueryHmac(q, SECRET)).toBe(false);
  });
});

describe('webhook HMAC', () => {
  const body = Buffer.from(JSON.stringify({ id: 1, note: 'hello' }));
  const good = createHmac('sha256', SECRET).update(body).digest('base64');

  it('accepts a correct signature over the raw body', () => {
    expect(verifyWebhookHmac(body, good, SECRET)).toBe(true);
  });

  it('rejects a body that has been altered', () => {
    expect(verifyWebhookHmac(Buffer.from('{"id":2}'), good, SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhookHmac(body, undefined, SECRET)).toBe(false);
  });

  it('fails on a re-serialized body — why raw bytes are required', () => {
    // JSON.parse then stringify changes whitespace/key order. The tempting
    // "fix" for this failure is to skip verification, which makes the endpoint
    // forgeable by anyone who knows the URL.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString())) + ' ');
    expect(verifyWebhookHmac(reserialized, good, SECRET)).toBe(false);
  });
});

describe('OAuth begin', () => {
  const deps = { config: APP, shops: new MemoryShopStore(), nonces: new MemoryNonceStore() };

  it('redirects to the shop origin with the right parameters', async () => {
    const r = await beginInstall('acme.myshopify.com', deps);
    expect(r.ok).toBe(true);
    const url = new URL((r as { redirectTo: string }).redirectTo);
    expect(url.origin).toBe('https://acme.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(APP.apiKey);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/shopify/auth/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('refuses an attacker-supplied shop', async () => {
    const r = await beginInstall('evil.com', deps);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('issues a fresh nonce each time', async () => {
    const a = await beginInstall('acme.myshopify.com', deps);
    const b = await beginInstall('acme.myshopify.com', deps);
    const sa = new URL((a as { redirectTo: string }).redirectTo).searchParams.get('state');
    const sb = new URL((b as { redirectTo: string }).redirectTo).searchParams.get('state');
    expect(sa).not.toBe(sb);
  });

  it('builds the documented callback url', () => {
    expect(callbackUrl('https://app.test/')).toBe('https://app.test/shopify/auth/callback');
  });
});

describe('OAuth callback', () => {
  function setup(tokenResponse: unknown = { access_token: 'shpat_xxx', scope: 'read_products' }, status = 200) {
    const shops = new MemoryShopStore();
    const nonces = new MemoryNonceStore();
    const calls: { url: string; body: unknown }[] = [];
    const deps = {
      config: APP,
      shops,
      nonces,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify(tokenResponse), { status });
      }) as typeof globalThis.fetch,
    };
    return { deps, shops, nonces, calls };
  }

  async function issued(nonces: MemoryNonceStore, shop = 'acme.myshopify.com'): Promise<string> {
    return nonces.issue(shop);
  }

  it('completes a valid install and stores the token', async () => {
    const { deps, shops, nonces, calls } = setup();
    const state = await issued(nonces);
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'the-code', state });

    const r = await completeInstall(q, deps);
    expect(r.ok).toBe(true);
    expect((await shops.get('acme.myshopify.com'))?.accessToken).toBe('shpat_xxx');
    // Token exchange must go to the SHOP's origin, never anywhere else.
    expect(calls[0]!.url).toBe('https://acme.myshopify.com/admin/oauth/access_token');
  });

  it('rejects a forged callback with no valid hmac', async () => {
    const { deps, nonces } = setup();
    const state = await issued(nonces);
    const q = new URLSearchParams({ shop: 'acme.myshopify.com', code: 'c', state, hmac: 'deadbeef' });
    expect(await completeInstall(q, deps)).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a replayed state — nonces are single use', async () => {
    const { deps, nonces } = setup();
    const state = await issued(nonces);
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'c', state });

    expect((await completeInstall(q, deps)).ok).toBe(true);
    // Same signed callback, captured and replayed.
    expect(await completeInstall(q, deps)).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a state issued for a DIFFERENT shop', async () => {
    // Without this check, a valid nonce for shop A authorizes an install
    // against shop B.
    const { deps, nonces } = setup();
    const state = await issued(nonces, 'attacker.myshopify.com');
    const q = signQuery({ shop: 'victim.myshopify.com', code: 'c', state });
    expect(await completeInstall(q, deps)).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a missing state', async () => {
    const { deps } = setup();
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'c' });
    expect(await completeInstall(q, deps)).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects an invalid shop even when the hmac is valid', async () => {
    // An attacker who somehow obtains the secret still cannot point the token
    // exchange at their own host.
    const { deps, nonces } = setup();
    const state = await issued(nonces);
    const q = signQuery({ shop: 'evil.com', code: 'c', state });
    expect(await completeInstall(q, deps)).toMatchObject({ ok: false, status: 400 });
  });

  it('surfaces a token-exchange failure without echoing the response body', async () => {
    const { deps, nonces } = setup({ error: 'invalid_request', code: 'leaky' }, 400);
    const state = await issued(nonces);
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'c', state });
    const r = await completeInstall(q, deps);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(r)).not.toContain('leaky');
  });

  it('rejects a token response with no access_token', async () => {
    const { deps, nonces } = setup({ scope: 'read_products' });
    const state = await issued(nonces);
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'c', state });
    expect(await completeInstall(q, deps)).toMatchObject({ ok: false, status: 502 });
  });

  it('expires a stale nonce', async () => {
    const { deps, nonces } = setup();
    const state = await nonces.issue('acme.myshopify.com');
    // Reach in and age it past the TTL.
    (nonces as unknown as { map: Map<string, { expires: number }> }).map.get(state)!.expires = Date.now() - 1;
    const q = signQuery({ shop: 'acme.myshopify.com', code: 'c', state });
    expect(await completeInstall(q, deps)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('webhooks', () => {
  function signed(topic: string, payload: unknown, shop = 'acme.myshopify.com') {
    const rawBody = Buffer.from(JSON.stringify(payload));
    return {
      topic,
      shopHeader: shop,
      hmacHeader: createHmac('sha256', SECRET).update(rawBody).digest('base64'),
      rawBody,
    };
  }

  it('rejects an unsigned webhook', async () => {
    const shops = new MemoryShopStore();
    const r = await handleWebhook(
      { topic: 'app/uninstalled', shopHeader: 'acme.myshopify.com', hmacHeader: undefined, rawBody: Buffer.from('{}') },
      { apiSecret: SECRET, shops },
    );
    expect(r.status).toBe(401);
  });

  it('gives no detail on rejection', async () => {
    const shops = new MemoryShopStore();
    const r = await handleWebhook(
      { topic: 'app/uninstalled', shopHeader: 'acme.myshopify.com', hmacHeader: 'wrong', rawBody: Buffer.from('{}') },
      { apiSecret: SECRET, shops },
    );
    expect(JSON.stringify(r.body)).toBe('{"error":"unauthorized"}');
  });

  it('rejects an invalid shop header', async () => {
    const shops = new MemoryShopStore();
    const r = await handleWebhook(
      { ...signed('app/uninstalled', {}), shopHeader: 'evil.com' },
      { apiSecret: SECRET, shops },
    );
    expect(r.status).toBe(400);
  });

  it('marks the shop uninstalled on app/uninstalled', async () => {
    const shops = new MemoryShopStore();
    await shops.put({ shop: 'acme.myshopify.com', accessToken: 't', scopes: 's', installedAt: Date.now() });
    await handleWebhook(signed('app/uninstalled', {}), { apiSecret: SECRET, shops });
    expect(await shops.get('acme.myshopify.com')).toBeUndefined();
  });

  it('purges the shop on shop/redact', async () => {
    const shops = new MemoryShopStore();
    await shops.put({ shop: 'acme.myshopify.com', accessToken: 't', scopes: 's', installedAt: Date.now() });
    await handleWebhook(signed('shop/redact', {}), { apiSecret: SECRET, shops });
    expect(await shops.count()).toBe(0);
  });

  it.each(['customers/redact', 'customers/data_request'])('acknowledges mandatory topic %s', async (topic) => {
    const shops = new MemoryShopStore();
    // Shopify rejects apps that do not respond correctly to these.
    expect((await handleWebhook(signed(topic, {}), { apiSecret: SECRET, shops })).status).toBe(200);
  });

  it('200s an unknown topic so Shopify does not disable the subscription', async () => {
    const shops = new MemoryShopStore();
    expect((await handleWebhook(signed('carts/update', {}), { apiSecret: SECRET, shops })).status).toBe(200);
  });

  it('passes orders/create through to the attribution hook', async () => {
    const shops = new MemoryShopStore();
    let seen: unknown;
    await handleWebhook(signed('orders/create', { id: 99 }), {
      apiSecret: SECRET,
      shops,
      onOrder: (_s, p) => {
        seen = p;
      },
    });
    expect(seen).toEqual({ id: 99 });
  });

  it('rejects a signed body that is not json', async () => {
    const shops = new MemoryShopStore();
    const rawBody = Buffer.from('not json');
    const r = await handleWebhook(
      {
        topic: 'app/uninstalled',
        shopHeader: 'acme.myshopify.com',
        hmacHeader: createHmac('sha256', SECRET).update(rawBody).digest('base64'),
        rawBody,
      },
      { apiSecret: SECRET, shops },
    );
    expect(r.status).toBe(400);
  });
});
