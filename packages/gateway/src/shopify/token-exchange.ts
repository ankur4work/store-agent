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

/**
 * EXPIRING, and not optional.
 *
 * Offline used to mean permanent. It no longer does: Shopify rejects
 * non-expiring tokens on the Admin API outright —
 *
 *   403 [API] Non-expiring access tokens are no longer accepted for the
 *       Admin API. Start using expiring offline tokens.
 *
 * — and a token minted without this reads as perfectly valid right up to the
 * point every API call fails. That is precisely how it failed here: the
 * exchange succeeded, the token looked fine, and nothing worked. Public apps
 * must be on expiring tokens for the Admin API; the deadline for existing apps
 * is 2027-01-01, but new apps are already past it.
 *
 * The cost is a token that lives an hour and a `refresh_token` that must be
 * stored and rotated. See `refreshAccessToken`.
 */
const EXPIRING = '1';

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
  return postForToken(
    shopDomain,
    {
      client_id: deps.apiKey,
      client_secret: deps.apiSecret,
      grant_type: GRANT_TYPE,
      subject_token: sessionToken,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      requested_token_type: REQUESTED_TOKEN_TYPE,
      expiring: EXPIRING,
    },
    deps,
    now,
    'token exchange',
  );
}

/**
 * Trade a legacy non-expiring token for an expiring one.
 *
 * The migration path for a shop that installed before Shopify required
 * expiring tokens. It authenticates with the stored token ITSELF rather than a
 * session token, which is the whole point: there is no merchant, no browser
 * and no ID token involved, so a wedged install can be repaired server-side
 * instead of waiting for someone to open the app.
 *
 * **Irreversible, and unsafe to replay.** Shopify destroys the non-expiring
 * token in the same transaction that issues the expiring pair. If the response
 * is lost, that shop has no usable token at all and the merchant must
 * reauthorize. So the result is persisted before anything else happens, and a
 * failure leaves the old record untouched.
 */
export async function cycleLegacyToken(
  shopDomain: string,
  nonExpiringToken: string,
  deps: TokenExchangeDeps,
  now: number = Date.now(),
): Promise<TokenExchangeResult> {
  return postForToken(
    shopDomain,
    {
      client_id: deps.apiKey,
      client_secret: deps.apiSecret,
      grant_type: GRANT_TYPE,
      subject_token: nonExpiringToken,
      // The subject is an offline token, not an id_token — this is what makes
      // the call possible without a merchant session.
      subject_token_type: REQUESTED_TOKEN_TYPE,
      requested_token_type: REQUESTED_TOKEN_TYPE,
      expiring: EXPIRING,
    },
    deps,
    now,
    'token cycle',
  );
}

/**
 * Renew an expiring offline token, with no merchant present.
 *
 * This is what makes hour-long tokens workable: webhooks, billing
 * reconciliation and background jobs run with nobody logged in, and none of
 * them can send a merchant through authorization.
 *
 * Shopify returns a NEW refresh token each time and retires the old one, so
 * the result must be stored whole. Keeping the previous refresh token — the
 * obvious shortcut, since it "still looks valid" — breaks the next renewal and
 * strands the shop until a merchant happens to open the app.
 */
export async function refreshAccessToken(
  shopDomain: string,
  refreshToken: string,
  deps: TokenExchangeDeps,
  now: number = Date.now(),
): Promise<TokenExchangeResult> {
  return postForToken(
    shopDomain,
    {
      client_id: deps.apiKey,
      client_secret: deps.apiSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    deps,
    now,
    'token refresh',
  );
}

/**
 * Form-encoded, matching Shopify's documented contract for this endpoint.
 */
async function postForToken(
  shopDomain: string,
  params: Record<string, string>,
  deps: TokenExchangeDeps,
  now: number,
  what: string,
): Promise<TokenExchangeResult> {
  const doFetch = deps.doFetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    // A network failure must not read as "this shop is not installed" — the
    // caller keeps whatever record it already had.
    return { ok: false, reason: `${what} request failed` };
  }

  if (!res.ok) {
    return { ok: false, reason: `${what} rejected with ${res.status}` };
  }

  let body: {
    access_token?: unknown;
    scope?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
    refresh_token_expires_in?: unknown;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: `${what} returned malformed JSON` };
  }

  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, reason: `${what} returned no access token` };
  }

  // A response without these is a NON-EXPIRING token, which the Admin API
  // refuses. Better to fail here, where the reason is legible, than to store it
  // and have every later call fail with nothing pointing back to this moment.
  const expiresIn = seconds(body.expires_in);
  const refresh = body.refresh_token;
  if (expiresIn === undefined || typeof refresh !== 'string' || refresh === '') {
    return { ok: false, reason: `${what} returned a non-expiring token` };
  }

  const refreshExpiresIn = seconds(body.refresh_token_expires_in);

  return {
    ok: true,
    shop: {
      shop: shopDomain,
      accessToken,
      scopes: typeof body.scope === 'string' ? body.scope : '',
      installedAt: now,
      refreshToken: refresh,
      expiresAt: now + expiresIn * 1000,
      ...(refreshExpiresIn === undefined
        ? {}
        : { refreshTokenExpiresAt: now + refreshExpiresIn * 1000 }),
    },
  };
}

function seconds(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}
