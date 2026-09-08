import type { Shop } from './shops.js';

/**
 * Shopify token exchange.
 *
 * ## Why this exists
 *
 * An app config that declares `[access_scopes]` without
 * `use_legacy_install_flow` is on **Shopify managed installation**: Shopify
 * grants the scopes itself when the merchant installs, and never redirects
 * through the app's OAuth callback. The app is genuinely installed — its theme
 * extension renders, its admin page loads — while the gateway holds no access
 * token at all.
 *
 * That is exactly the state this store was found in: `installedShops: 0` with a
 * working embed and a completed Plus subscription, because every server-side
 * call short-circuited on a missing token. Nothing was broken; the token simply
 * arrives by a different route now.
 *
 * That route is this: the embedded admin page already carries a session token
 * (`id_token`) that we verify against the API secret on every request. Exchange
 * it for an offline access token and the app is provisioned on first load,
 * however it was installed.
 *
 * The legacy OAuth callback is kept alongside — it still works, still stores
 * the same record, and is what a merchant gets if they hit `/shopify/auth`
 * directly. Both paths converge on one `Shop`.
 */

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
/**
 * OFFLINE, not online. An online token is scoped to the logged-in user and
 * expires with their session; webhooks, billing reconciliation and background
 * work all run with no user present and need a token that outlives the visit.
 */
const REQUESTED_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';

export interface TokenExchangeDeps {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly doFetch?: typeof fetch;
}

export type TokenExchangeResult =
  | { readonly ok: true; readonly shop: Shop }
  | { readonly ok: false; readonly reason: string };

/**
 * Exchange a verified session token for an offline access token.
 *
 * `sessionToken` MUST already have been verified — this function does not
 * check the signature, and handing Shopify an unverified token would let a
 * caller provision a shop record they have no claim to. `shopDomain` likewise
 * comes from the verified token's `dest`, never from a query parameter.
 */
export async function exchangeSessionToken(
  shopDomain: string,
  sessionToken: string,
  deps: TokenExchangeDeps,
  now: number = Date.now(),
): Promise<TokenExchangeResult> {
  const doFetch = deps.doFetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: deps.apiKey,
        client_secret: deps.apiSecret,
        grant_type: GRANT_TYPE,
        subject_token: sessionToken,
        subject_token_type: SUBJECT_TOKEN_TYPE,
        requested_token_type: REQUESTED_TOKEN_TYPE,
      }),
    });
  } catch {
    // A network failure must not read as "this shop is not installed" — the
    // caller keeps whatever record it already had.
    return { ok: false, reason: 'token exchange request failed' };
  }

  if (!res.ok) {
    return { ok: false, reason: `token exchange rejected with ${res.status}` };
  }

  let body: { access_token?: unknown; scope?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: 'token exchange returned malformed JSON' };
  }

  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, reason: 'token exchange returned no access token' };
  }

  return {
    ok: true,
    shop: {
      shop: shopDomain,
      accessToken,
      scopes: typeof body.scope === 'string' ? body.scope : '',
      installedAt: now,
    },
  };
}
