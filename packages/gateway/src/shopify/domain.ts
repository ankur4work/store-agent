/**
 * Shop domain validation.
 *
 * This is the single most security-critical function in the install flow.
 *
 * The `shop` parameter arrives from an untrusted query string and is then used
 * to (a) build a redirect the merchant's browser follows and (b) build a URL we
 * make a server-side POST to with our client secret. A permissive check here is
 * simultaneously an open redirect and an SSRF that leaks credentials.
 *
 * So: strict allowlist, never a blocklist. Only `{name}.myshopify.com`, where
 * `name` follows Shopify's own subdomain rules. Anything else is rejected —
 * including inputs that merely *contain* a valid domain.
 */

/**
 * Shopify store subdomains: lowercase alphanumeric and hyphens, must start and
 * end alphanumeric, 1-60 chars. Anchored at both ends.
 */
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.myshopify\.com$|^[a-z0-9]\.myshopify\.com$/;

export interface ShopDomainResult {
  readonly ok: boolean;
  readonly shop?: string;
  readonly reason?: string;
}

/**
 * Validate and normalize a shop domain.
 *
 * Returns the canonical lowercase domain, or a reason it was rejected.
 * Never throws — callers handle rejection as a 400.
 */
export function parseShopDomain(raw: unknown): ShopDomainResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'shop parameter missing' };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'shop parameter empty' };
  if (trimmed.length > 100) return { ok: false, reason: 'shop parameter too long' };

  // Reject anything non-ASCII outright. Unicode homoglyphs (Cyrillic 'о',
  // fullwidth characters) can render as "shop.myshopify.com" while resolving
  // somewhere else entirely.
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7e]/.test(trimmed)) return { ok: false, reason: 'shop contains non-ascii characters' };

  // Reject any URL structure. We want a bare hostname and nothing else: no
  // scheme, no credentials, no port, no path, no query, no fragment.
  if (/[/\\?#@:]/.test(trimmed)) return { ok: false, reason: 'shop must be a bare hostname' };

  const lower = trimmed.toLowerCase();

  // Guard against a trailing dot making an FQDN that bypasses the suffix check.
  if (lower.endsWith('.')) return { ok: false, reason: 'shop must not end with a dot' };
  if (lower.includes('..')) return { ok: false, reason: 'shop contains an empty label' };

  if (!SHOP_RE.test(lower)) return { ok: false, reason: 'shop must be a {name}.myshopify.com domain' };

  return { ok: true, shop: lower };
}

/** Convenience for call sites that only need a boolean. */
export function isValidShopDomain(raw: unknown): boolean {
  return parseShopDomain(raw).ok;
}

/**
 * Build a URL on the shop's own origin.
 *
 * Takes a validated shop domain only — passing an unvalidated string is the
 * bug this whole module exists to prevent, so it validates again rather than
 * trusting the caller.
 */
export function shopUrl(shop: string, path: string): string {
  const parsed = parseShopDomain(shop);
  if (!parsed.ok) throw new Error(`refusing to build a URL for an invalid shop domain: ${parsed.reason}`);
  if (!path.startsWith('/')) throw new Error('path must start with /');
  return `https://${parsed.shop}${path}`;
}
