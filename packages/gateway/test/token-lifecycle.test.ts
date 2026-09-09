import { describe, expect, it, vi } from 'vitest';
import { MemoryShopStore, isExpired, isLegacyToken, type Shop } from '../src/shopify/shops.js';
import { freshShop } from '../src/shopify/token-lifecycle.js';

/**
 * Offline access tokens used to be permanent and the app was built on that.
 * They now live one hour, so "the token we stored" and "a token that works"
 * are different things, and everything that talks to the Admin API with no
 * merchant present depends on the difference being handled here.
 */

const SHOP = 'acme.myshopify.com';
const NOW = 1_700_000_000_000;
const HOUR = 3600 * 1000;

const DEPS = { apiKey: 'client-id', apiSecret: 'shpss_secret' };

function stored(over: Partial<Shop> = {}): Shop {
  return {
    shop: SHOP,
    accessToken: 'shpat_current',
    scopes: 'read_products',
    installedAt: NOW - 30 * 24 * HOUR,
    refreshToken: 'shprt_current',
    expiresAt: NOW + HOUR,
    refreshTokenExpiresAt: NOW + 90 * 24 * HOUR,
    ...over,
  };
}

/** Shopify's refresh endpoint, returning a rotated pair. */
function refreshEndpoint(body: unknown = {}, status = 200) {
  const calls: URLSearchParams[] = [];
  const doFetch = vi.fn(async (_url: any, init: any) => {
    calls.push(new URLSearchParams(String(init.body)));
    return new Response(
      JSON.stringify({
        access_token: 'shpat_renewed',
        scope: 'read_products',
        expires_in: 3600,
        refresh_token: 'shprt_renewed',
        refresh_token_expires_in: 7_776_000,
        ...(body as object),
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  });
  return { doFetch: doFetch as unknown as typeof fetch, calls };
}

describe('keeping an expiring offline token usable', () => {
  it('uses the stored token while it is still valid', async () => {
    const shops = new MemoryShopStore();
    await shops.put(stored());
    const { doFetch, calls } = refreshEndpoint();

    const r = await freshShop(SHOP, { ...DEPS, shops, doFetch }, NOW);

    expect(r?.accessToken).toBe('shpat_current');
    expect(calls).toHaveLength(0); // no pointless round trip
  });

  it('renews an expired token and stores the rotated pair', async () => {
    const shops = new MemoryShopStore();
    await shops.put(stored({ expiresAt: NOW - 1 }));
    const { doFetch, calls } = refreshEndpoint();

    const r = await freshShop(SHOP, { ...DEPS, shops, doFetch }, NOW);

    expect(r?.accessToken).toBe('shpat_renewed');
    expect(calls[0]?.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.get('refresh_token')).toBe('shprt_current');

    // Shopify retires the old refresh token on every renewal. Keeping it would
    // work once and then strand the shop until a merchant opened the app.
    const persisted = await shops.get(SHOP);
    expect(persisted?.refreshToken).toBe('shprt_renewed');
    expect(persisted?.expiresAt).toBe(NOW + HOUR);
  });

  it('renews slightly early, so a call cannot start on a token that dies mid-flight', async () => {
    const shops = new MemoryShopStore();
    await shops.put(stored({ expiresAt: NOW + 10_000 })); // 10s left
    const { doFetch, calls } = refreshEndpoint();

    await freshShop(SHOP, { ...DEPS, shops, doFetch }, NOW);
    expect(calls).toHaveLength(1);
  });

  it('preserves installedAt, because a refresh is not a reinstall', async () => {
    const shops = new MemoryShopStore();
    const installedAt = NOW - 30 * 24 * HOUR;
    await shops.put(stored({ expiresAt: NOW - 1, installedAt }));

    const r = await freshShop(SHOP, { ...DEPS, shops, ...refreshEndpoint() }, NOW);
    expect(r?.installedAt).toBe(installedAt);
  });

  it('refuses a legacy non-expiring token rather than making a call that cannot work', async () => {
    // This is the state production was wedged in: a stored token the Admin API
    // answers with 403 "Non-expiring access tokens are no longer accepted".
    const shops = new MemoryShopStore();
    await shops.put({
      shop: SHOP,
      accessToken: 'shpat_legacy',
      scopes: 'read_products',
      installedAt: NOW,
    });
    const { doFetch, calls } = refreshEndpoint();

    const r = await freshShop(SHOP, { ...DEPS, shops, doFetch }, NOW);

    // Treated as "no usable token" — the caller behaves as for an uninstalled
    // shop instead of retrying a request Shopify will always refuse.
    expect(r).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('gives up when the refresh token itself has expired', async () => {
    // 90 days without a merchant opening the app. Only a visit recovers this.
    const shops = new MemoryShopStore();
    await shops.put(stored({ expiresAt: NOW - 1, refreshTokenExpiresAt: NOW - 1 }));
    const { doFetch, calls } = refreshEndpoint();

    expect(await freshShop(SHOP, { ...DEPS, shops, doFetch }, NOW)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('keeps the old token when a refresh fails, rather than destroying the record', async () => {
    const shops = new MemoryShopStore();
    await shops.put(stored({ expiresAt: NOW - 1 }));
    const { doFetch } = refreshEndpoint({}, 500);

    expect(await freshShop(SHOP, { ...DEPS, shops, doFetch }, NOW)).toBeUndefined();
    // A transient Shopify failure must not read as an uninstall.
    expect((await shops.get(SHOP))?.refreshToken).toBe('shprt_current');
  });

  it('reports an unknown shop as having no token', async () => {
    const shops = new MemoryShopStore();
    expect(await freshShop(SHOP, { ...DEPS, shops, ...refreshEndpoint() }, NOW)).toBeUndefined();
  });
});

describe('token classification', () => {
  // Built without the key rather than with `expiresAt: undefined` — under
  // exactOptionalPropertyTypes those are different types, and only the absent
  // one is what a legacy row actually deserialises to.
  const legacy: Shop = {
    shop: SHOP,
    accessToken: 'shpat_legacy',
    scopes: 'read_products',
    installedAt: NOW,
  };

  it('recognises a legacy token by its missing expiry, not by its value', () => {
    // The two kinds are indistinguishable as strings.
    expect(isLegacyToken(legacy)).toBe(true);
    expect(isLegacyToken(stored())).toBe(false);
  });

  it('does not treat a legacy token as expired, which would imply it is refreshable', () => {
    expect(isExpired(legacy, NOW)).toBe(false);
  });
});
