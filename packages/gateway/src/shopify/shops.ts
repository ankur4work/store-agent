import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Installed-shop records and OAuth nonces.
 *
 * Redis/Postgres-shaped (async, TTL) so the in-memory implementation can be
 * swapped without touching call sites. Access tokens live here and must never
 * be logged, echoed in a response, or included in an error message.
 */

export interface Shop {
  readonly shop: string;
  /** Offline access token. Secret. */
  readonly accessToken: string;
  readonly scopes: string;
  readonly installedAt: number;
  uninstalledAt?: number;
  /**
   * Renews `accessToken` without the merchant present. Secret.
   *
   * Absent on a legacy NON-EXPIRING token. Shopify no longer accepts those on
   * the Admin API — it answers 403 "Non-expiring access tokens are no longer
   * accepted" — so a record without this is not a working record, and the
   * absence is what marks it for re-provisioning.
   */
  readonly refreshToken?: string;
  /** Epoch ms. Absent means a legacy non-expiring token, not "never expires". */
  readonly expiresAt?: number;
  /** Epoch ms. Past this, only a merchant visit can re-provision. */
  readonly refreshTokenExpiresAt?: number;
}

/**
 * Whether this record predates expiring tokens.
 *
 * Shopify rejects non-expiring tokens on the Admin API, so these must be
 * replaced rather than used. Checked on `expiresAt` rather than the token
 * string, because the two token kinds are indistinguishable by value.
 */
export function isLegacyToken(shop: Shop): boolean {
  return shop.expiresAt === undefined;
}

/** Expired, or close enough that a call started now might land after it. */
export function isExpired(shop: Shop, now: number, skewMs = 60_000): boolean {
  return shop.expiresAt !== undefined && shop.expiresAt - skewMs <= now;
}

export interface ShopStore {
  get(shop: string): Promise<Shop | undefined>;
  put(shop: Shop): Promise<void>;
  markUninstalled(shop: string): Promise<void>;
  /** GDPR shop/redact — must actually destroy the record. */
  purge(shop: string): Promise<void>;
  count(): Promise<number>;
}

export class MemoryShopStore implements ShopStore {
  private readonly map = new Map<string, Shop>();

  async get(shop: string): Promise<Shop | undefined> {
    const s = this.map.get(shop);
    return s?.uninstalledAt === undefined ? s : undefined;
  }
  async put(shop: Shop): Promise<void> {
    this.map.set(shop.shop, shop);
  }
  async markUninstalled(shop: string): Promise<void> {
    const s = this.map.get(shop);
    if (s) s.uninstalledAt = Date.now();
  }
  async purge(shop: string): Promise<void> {
    this.map.delete(shop);
  }
  async count(): Promise<number> {
    return [...this.map.values()].filter((s) => s.uninstalledAt === undefined).length;
  }
}

/**
 * Single-use OAuth state nonces.
 *
 * Prevents CSRF on the callback: without it, an attacker can hand a merchant a
 * crafted callback URL and install the app against a shop of the attacker's
 * choosing. Consumed on first use so a captured callback cannot be replayed.
 */
export interface NonceStore {
  issue(shop: string): Promise<string>;
  /** Returns the shop the nonce was issued for, and invalidates it. */
  consume(state: string): Promise<string | undefined>;
}

const NONCE_TTL_MS = 10 * 60 * 1000;

export class MemoryNonceStore implements NonceStore {
  private readonly map = new Map<string, { shop: string; expires: number }>();

  async issue(shop: string): Promise<string> {
    // 32 bytes of CSPRNG. randomUUID would also do, but this is unambiguous
    // about entropy and is not a recognizable format worth guessing at.
    const state = randomBytes(32).toString('base64url');
    this.map.set(state, { shop, expires: Date.now() + NONCE_TTL_MS });
    return state;
  }

  async consume(state: string): Promise<string | undefined> {
    const entry = this.map.get(state);
    if (entry === undefined) return undefined;
    this.map.delete(state); // single use, even if expired
    if (Date.now() > entry.expires) return undefined;
    return entry.shop;
  }

  sweep(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, v] of this.map) {
      if (now > v.expires) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }
}

export function newShop(shop: string, accessToken: string, scopes: string): Shop {
  return { shop, accessToken, scopes, installedAt: Date.now() };
}

export { randomUUID };
