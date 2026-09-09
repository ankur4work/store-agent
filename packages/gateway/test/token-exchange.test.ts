import { describe, expect, it } from 'vitest';
import { exchangeSessionToken, refreshAccessToken } from '../src/shopify/token-exchange.js';

/**
 * Token exchange is how the app gets an access token under Shopify managed
 * installation, where the OAuth callback never fires.
 *
 * It was found the hard way: a store with a rendering theme extension, a
 * loading admin page and a paid Plus subscription, and `installedShops: 0` —
 * every server-side call short-circuiting on a token that was never going to
 * arrive by the route the code was waiting on.
 */

const DEPS = { apiKey: 'client-id', apiSecret: 'shpss_secret' };
const SHOP = 'acme.myshopify.com';

/** A successful expiring-offline-token response, as Shopify returns it. */
const EXPIRING = {
  access_token: 'shpat_x',
  scope: 'read_products',
  expires_in: 3600,
  refresh_token: 'shprt_y',
  refresh_token_expires_in: 7_776_000,
};

/** The request body, which is form-encoded rather than JSON. */
const sent = (cap: { init?: RequestInit | undefined }) =>
  new URLSearchParams(String(cap.init?.body));

function fetchReturning(status: number, body: unknown, capture?: { url?: string | undefined; init?: RequestInit | undefined }) {
  return (async (url: string | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('token exchange', () => {
  it('returns a shop record with the offline token and its refresh pair', async () => {
    const r = await exchangeSessionToken(
      SHOP,
      'session-token',
      { ...DEPS, doFetch: fetchReturning(200, EXPIRING) },
      1_700_000_000_000,
    );
    expect(r).toEqual({
      ok: true,
      shop: {
        shop: SHOP,
        accessToken: 'shpat_x',
        scopes: 'read_products',
        installedAt: 1_700_000_000_000,
        refreshToken: 'shprt_y',
        expiresAt: 1_700_000_000_000 + 3600 * 1000,
        refreshTokenExpiresAt: 1_700_000_000_000 + 7_776_000 * 1000,
      },
    });
  });

  it('asks for an OFFLINE token', async () => {
    // An online token dies with the merchant's session. Webhooks, billing
    // reconciliation and background work all run with nobody logged in.
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    await exchangeSessionToken(SHOP, 'session-token', {
      ...DEPS,
      doFetch: fetchReturning(200, EXPIRING, cap),
    });
    const body = sent(cap);
    expect(body.get('requested_token_type')).toBe(
      'urn:shopify:params:oauth:token-type:offline-access-token',
    );
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
  });

  it('asks for an EXPIRING token, which the Admin API now requires', async () => {
    // Without `expiring=1` Shopify mints a non-expiring token that looks
    // entirely valid and is refused by every Admin API call:
    // "Non-expiring access tokens are no longer accepted for the Admin API."
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    await exchangeSessionToken(SHOP, 'session-token', {
      ...DEPS,
      doFetch: fetchReturning(200, EXPIRING, cap),
    });
    expect(sent(cap).get('expiring')).toBe('1');
  });

  it('refuses a non-expiring response instead of storing a token that cannot work', async () => {
    // Shopify answering without expires_in/refresh_token means a non-expiring
    // token. Storing it would look like a successful install and then fail
    // every API call, with nothing pointing back here.
    const r = await exchangeSessionToken(SHOP, 's', {
      ...DEPS,
      doFetch: fetchReturning(200, { access_token: 'shpat_x', scope: 'read_products' }),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/non-expiring/);
  });

  it('posts to the shop from the verified token, not an arbitrary host', async () => {
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    await exchangeSessionToken(SHOP, 'session-token', {
      ...DEPS,
      doFetch: fetchReturning(200, EXPIRING, cap),
    });
    expect(cap.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
  });

  it('sends the client secret to Shopify and nowhere else', async () => {
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    await exchangeSessionToken(SHOP, 'session-token', {
      ...DEPS,
      doFetch: fetchReturning(200, EXPIRING, cap),
    });
    expect(cap.url?.startsWith(`https://${SHOP}/`)).toBe(true);
    expect(sent(cap).get('client_secret')).toBe('shpss_secret');
  });

  it('renews with the refresh grant, carrying no session token', async () => {
    // This is what keeps webhooks and billing working on an hour-long token
    // with no merchant present.
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    const r = await refreshAccessToken(
      SHOP,
      'shprt_old',
      { ...DEPS, doFetch: fetchReturning(200, { ...EXPIRING, refresh_token: 'shprt_new' }, cap) },
      1_700_000_000_000,
    );
    const body = sent(cap);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('shprt_old');
    expect(body.get('subject_token')).toBeNull();
    // Shopify retires the old refresh token, so the new one must be kept.
    expect((r as { shop: { refreshToken: string } }).shop.refreshToken).toBe('shprt_new');
  });

  it('reports a rejection rather than throwing', async () => {
    const r = await exchangeSessionToken(SHOP, 'bad', {
      ...DEPS,
      doFetch: fetchReturning(400, {}),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toContain('400');
  });

  it('treats a missing access token as a failure, not an empty install', async () => {
    // Storing a record with an empty token would look installed and fail every
    // API call afterwards — worse than not being installed.
    for (const body of [{}, { access_token: '' }, { access_token: 123 }]) {
      const r = await exchangeSessionToken(SHOP, 's', { ...DEPS, doFetch: fetchReturning(200, body) });
      expect(r.ok).toBe(false);
    }
  });

  it('survives a network failure without claiming the shop is uninstalled', async () => {
    const doFetch = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const r = await exchangeSessionToken(SHOP, 's', { ...DEPS, doFetch });
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/request failed/);
  });

  it('survives malformed JSON', async () => {
    const doFetch = (async () =>
      ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) as unknown as Response) as unknown as typeof fetch;
    const r = await exchangeSessionToken(SHOP, 's', { ...DEPS, doFetch });
    expect(r).toMatchObject({ ok: false });
  });
});
