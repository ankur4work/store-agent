import { parseShopDomain, shopUrl } from './domain.js';
import { verifyQueryHmac } from './hmac.js';
import { newShop, type NonceStore, type Shop, type ShopStore } from './shops.js';

/**
 * Shopify OAuth (offline access token).
 *
 * Flow:
 *   1. GET /shopify/auth?shop=x.myshopify.com
 *      → validate shop, issue a single-use state nonce, 302 to Shopify
 *   2. Merchant approves on Shopify
 *   3. GET /shopify/auth/callback?shop=&code=&state=&hmac=
 *      → verify HMAC, consume state, confirm state's shop matches, exchange
 *        code for a token, store it
 *
 * Every step fails closed. There is no path that installs a shop without a
 * valid HMAC and a matching, unexpired, single-use nonce.
 */

export interface OAuthConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly scopes: string;
  /** Public HTTPS origin of this app, e.g. https://abc.trycloudflare.com */
  readonly appUrl: string;
}

export interface OAuthDeps {
  readonly config: OAuthConfig;
  readonly shops: ShopStore;
  readonly nonces: NonceStore;
  readonly fetch?: typeof globalThis.fetch;
}

export type BeginResult =
  | { readonly ok: true; readonly redirectTo: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

export type CallbackResult =
  | { readonly ok: true; readonly shop: Shop; readonly redirectTo: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

export function callbackUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/shopify/auth/callback`;
}

/** Step 1 — begin the install. */
export async function beginInstall(rawShop: unknown, deps: OAuthDeps): Promise<BeginResult> {
  const parsed = parseShopDomain(rawShop);
  if (!parsed.ok) return { ok: false, status: 400, reason: parsed.reason ?? 'invalid shop' };

  const state = await deps.nonces.issue(parsed.shop!);
  const params = new URLSearchParams({
    client_id: deps.config.apiKey,
    scope: deps.config.scopes,
    redirect_uri: callbackUrl(deps.config.appUrl),
    state,
    // Offline token: a long-lived token for background work (webhooks,
    // catalog reads) rather than one scoped to a logged-in user session.
    'grant_options[]': '',
  });

  return { ok: true, redirectTo: shopUrl(parsed.shop!, `/admin/oauth/authorize?${params.toString()}`) };
}

/** Step 3 — handle the callback. */
export async function completeInstall(query: URLSearchParams, deps: OAuthDeps): Promise<CallbackResult> {
  // 1. HMAC first. If the query is not authentically from Shopify, nothing
  //    else in it is worth reading.
  if (!verifyQueryHmac(query, deps.config.apiSecret)) {
    return { ok: false, status: 401, reason: 'hmac verification failed' };
  }

  const parsed = parseShopDomain(query.get('shop'));
  if (!parsed.ok) return { ok: false, status: 400, reason: parsed.reason ?? 'invalid shop' };
  const shop = parsed.shop!;

  const state = query.get('state');
  if (state === null || state === '') return { ok: false, status: 400, reason: 'missing state' };

  // 2. Single-use nonce, and it must have been issued for THIS shop. Checking
  //    only that the nonce exists would let a valid nonce for shop A authorize
  //    an install against shop B.
  const issuedFor = await deps.nonces.consume(state);
  if (issuedFor === undefined) return { ok: false, status: 403, reason: 'invalid or expired state' };
  if (issuedFor !== shop) return { ok: false, status: 403, reason: 'state does not match shop' };

  const code = query.get('code');
  if (code === null || code === '') return { ok: false, status: 400, reason: 'missing code' };

  // 3. Exchange the code. This POST carries our client secret, which is
  //    precisely why `shop` had to be validated before we got here.
  const doFetch = deps.fetch ?? globalThis.fetch;
  const res = await doFetch(shopUrl(shop, '/admin/oauth/access_token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: deps.config.apiKey,
      client_secret: deps.config.apiSecret,
      code,
    }),
  });

  if (!res.ok) {
    // Deliberately does not include the response body — it can echo the code
    // or secret back into our logs.
    return { ok: false, status: 502, reason: `token exchange failed (${res.status})` };
  }

  const body = (await res.json()) as { access_token?: unknown; scope?: unknown };
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    return { ok: false, status: 502, reason: 'token exchange returned no access_token' };
  }

  const record = newShop(shop, body.access_token, typeof body.scope === 'string' ? body.scope : deps.config.scopes);
  await deps.shops.put(record);

  return {
    ok: true,
    shop: record,
    // Back into the Shopify admin, where an embedded app belongs.
    redirectTo: shopUrl(shop, `/admin/apps/${encodeURIComponent(deps.config.apiKey)}`),
  };
}
