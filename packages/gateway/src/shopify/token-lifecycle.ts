import { isExpired, isLegacyToken, type Shop, type ShopStore } from './shops.js';
import { refreshAccessToken, type TokenExchangeDeps } from './token-exchange.js';

/**
 * Keeping an expiring offline token usable.
 *
 * Offline access tokens used to be permanent, and the app was built on that:
 * store one at install, use it forever. Shopify now rejects non-expiring
 * tokens on the Admin API and issues tokens that live one hour, so "the token
 * we stored" and "a token that works" are no longer the same thing.
 *
 * Every Admin API caller goes through here first. The alternative — refreshing
 * at the call sites — means each new caller is one forgotten check away from
 * failing an hour after install, which is late enough that nobody connects the
 * failure to the omission.
 */

export interface TokenLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface FreshTokenDeps extends TokenExchangeDeps {
  readonly shops: ShopStore;
  readonly log?: TokenLogger;
}

/**
 * The shop record with a currently-valid access token, or `undefined`.
 *
 * `undefined` means no usable token exists and only a merchant visit can fix
 * it — the caller should behave exactly as it does for an uninstalled shop
 * rather than trying an API call that cannot succeed.
 *
 * Refreshes in place when the token has expired, and stores the whole new pair:
 * Shopify retires the old refresh token on every renewal, so keeping the
 * previous one would work once and then strand the shop.
 */
export async function freshShop(
  shopDomain: string,
  deps: FreshTokenDeps,
  now: number = Date.now(),
): Promise<Shop | undefined> {
  const record = await deps.shops.get(shopDomain);
  if (record === undefined) return undefined;

  // A legacy non-expiring token. It cannot be refreshed — there is no refresh
  // token — and the Admin API refuses it, so it is worth nothing. Returning it
  // would produce a 403 the caller cannot act on. Re-provisioning needs a
  // session token, so it happens on the next admin load.
  if (isLegacyToken(record)) {
    deps.log?.warn('token_needs_reprovisioning', {
      shop: shopDomain,
      reason: 'non-expiring token, no longer accepted by the Admin API',
    });
    return undefined;
  }

  if (!isExpired(record, now)) return record;

  if (record.refreshToken === undefined) return undefined;
  if (record.refreshTokenExpiresAt !== undefined && record.refreshTokenExpiresAt <= now) {
    // 90 days without a merchant opening the app. Only a visit recovers this.
    deps.log?.warn('refresh_token_expired', { shop: shopDomain });
    return undefined;
  }

  const refreshed = await refreshAccessToken(shopDomain, record.refreshToken, deps, now);
  if (!refreshed.ok) {
    deps.log?.warn('token_refresh_failed', { shop: shopDomain, reason: refreshed.reason });
    return undefined;
  }

  // `installedAt` belongs to the install, not to this token. Refreshing is not
  // a reinstall, and overwriting it would quietly rewrite install history.
  const stored: Shop = { ...refreshed.shop, installedAt: record.installedAt };
  await deps.shops.put(stored);
  deps.log?.info('token_refreshed', { shop: shopDomain, expiresAt: stored.expiresAt });
  return stored;
}
