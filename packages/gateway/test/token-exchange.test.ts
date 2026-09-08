import { describe, expect, it } from 'vitest';
import { exchangeSessionToken } from '../src/shopify/token-exchange.js';

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
  it('returns a shop record with the offline token', async () => {
    const r = await exchangeSessionToken(
      SHOP,
      'session-token',
      { ...DEPS, doFetch: fetchReturning(200, { access_token: 'shpat_x', scope: 'read_products' }) },
      1_700_000_000_000,
    );
    expect(r).toEqual({
      ok: true,
      shop: {
        shop: SHOP,
        accessToken: 'shpat_x',
        scopes: 'read_products',
        installedAt: 1_700_000_000_000,
      },
    });
  });

  it('asks for an OFFLINE token', async () => {
    // An online token dies with the merchant's session. Webhooks, billing
    // reconciliation and background work all run with nobody logged in.
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    await exchangeSessionToken(SHOP, 'session-token', {
      ...DEPS,
      doFetch: fetchReturning(200, { access_token: 'shpat_x' }, cap),
    });
    const body = JSON.parse(String(cap.init?.body));
    expect(body.requested_token_type).toBe('urn:shopify:params:oauth:token-type:offline-access-token');
    expect(body.subject_token_type).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
  });

  it('posts to the shop from the verified token, not an arbitrary host', async () => {
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    await exchangeSessionToken(SHOP, 'session-token', {
      ...DEPS,
      doFetch: fetchReturning(200, { access_token: 'shpat_x' }, cap),
    });
    expect(cap.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
  });

  it('sends the client secret to Shopify and nowhere else', async () => {
    const cap: { url?: string | undefined; init?: RequestInit | undefined } = {};
    await exchangeSessionToken(SHOP, 'session-token', {
      ...DEPS,
      doFetch: fetchReturning(200, { access_token: 'shpat_x' }, cap),
    });
    expect(cap.url?.startsWith(`https://${SHOP}/`)).toBe(true);
    expect(JSON.parse(String(cap.init?.body)).client_secret).toBe('shpss_secret');
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
