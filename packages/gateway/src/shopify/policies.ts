/**
 * The merchant's own policy pages, read from their storefront.
 *
 * ## Why this exists
 *
 * `get_policy` served `DEMO_POLICIES` — a hardcoded fixture — to every shop,
 * live or not. Verified against the real dev store, a shopper asking "what is
 * your return policy?" was told:
 *
 * > "Returns are accepted within 30 days of delivery if items are unworn with
 * > tags attached. Return shipping is free, and refunds are issued within 5
 * > business days of receipt."
 *
 * None of that came from the merchant. It is the fixture, quoted as fact, with a
 * `source_url` of `example.test`, and the turn reported `grounded: true` — because
 * the tripwire's job is to check that a claim is backed by a tool result, and it
 * was. The tool was the liar.
 *
 * A shopper acts on that. They buy expecting free returns inside 30 days, and the
 * merchant either honours a promise they never made or takes the dispute. It is
 * also, plainly, a failed app review.
 *
 * ## Why the storefront and not an API
 *
 * The obvious route is `search_shop_policies_and_faqs`, and it is gone — a legacy
 * Storefront MCP tool whose support ended 2026-08-31, listed in
 * `FORBIDDEN_LEGACY_TOOLS` so it cannot creep back. Current UCP has no policy
 * capability at all.
 *
 * Every Shopify storefront publishes its policies at stable public paths, which
 * is the same kind of source UCP already is: unauthenticated public storefront
 * data, no token, no scope, nothing to install. A merchant who has written a
 * refund policy has one at `/policies/refund-policy`, and that page IS the
 * authority — it is what the shopper would read themselves.
 *
 * ## When it is not available
 *
 * A password-protected store (every development store, including ours) redirects
 * these to `/password`, and a merchant who has not written a policy has no page.
 * Both cases return `undefined`, and the caller must say it cannot confirm rather
 * than fall back to anything. There is no safe fixture: the whole failure being
 * fixed here was a plausible answer standing in for an absent one.
 */

export interface StorePoliciesDeps {
  readonly fetch?: typeof globalThis.fetch;
  /** Policies change rarely; this is about not refetching per turn. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly log?: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
  };
}

export interface PolicyText {
  readonly topic: string;
  readonly text: string;
  readonly sourceUrl: string;
}

/**
 * The topics the model may ask for, mapped to Shopify's own page handles.
 *
 * A closed set on purpose. The topic arrives from a model tool call, and
 * interpolating that into a URL unchecked is a request forgery against the
 * merchant's own domain.
 */
const HANDLES: Readonly<Record<string, string>> = {
  shipping: 'shipping-policy',
  returns: 'refund-policy',
  refunds: 'refund-policy',
  privacy: 'privacy-policy',
  terms: 'terms-of-service',
  contact: 'contact-information',
};

/** Longest policy text handed to a model. Enough for a full refund policy. */
const MAX_CHARS = 4_000;

interface Entry {
  readonly value: PolicyText | undefined;
  readonly at: number;
}

export class StorePolicies {
  private readonly cache = new Map<string, Entry>();
  private readonly doFetch: typeof globalThis.fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: StorePoliciesDeps = {}) {
    this.doFetch = deps.fetch ?? globalThis.fetch;
    this.ttlMs = deps.ttlMs ?? 6 * 60 * 60 * 1000;
    this.timeoutMs = deps.timeoutMs ?? 4_000;
    this.now = deps.now ?? Date.now;
  }

  /** Which topics can be asked for. */
  static topics(): readonly string[] {
    return Object.keys(HANDLES);
  }

  /**
   * This shop's text for a topic, or `undefined` if there is none to be had.
   *
   * `undefined` covers "no such topic", "the merchant never wrote one", "the
   * storefront is password-protected" and "the fetch failed". The caller treats
   * them identically, because they are identical: we do not know this merchant's
   * policy, and the only honest thing to do is say so.
   */
  async get(shop: string, topic: string, signal?: AbortSignal): Promise<PolicyText | undefined> {
    const handle = HANDLES[topic.trim().toLowerCase()];
    if (handle === undefined) return undefined;

    const key = `${shop}|${handle}`;
    const hit = this.cache.get(key);
    if (hit !== undefined && this.now() - hit.at < this.ttlMs) return hit.value;

    const url = `https://${shop}/policies/${handle}`;
    let value: PolicyText | undefined;
    try {
      const res = await this.withTimeout(url, signal);
      /**
       * `redirect: 'manual'` matters. A password-protected storefront answers 302
       * to `/password`, and following it yields a 200 with a login page in it —
       * which, stripped of tags, is prose that looks like a policy. Refusing to
       * follow turns that into the absence it actually is.
       */
      if (res.status === 200) {
        const text = extractPolicyText(await res.text());
        if (text !== '') value = { topic, text, sourceUrl: url };
      }
      if (value === undefined) {
        this.deps.log?.info('policy_unavailable', { shop, topic, status: res.status });
      }
    } catch (err) {
      this.deps.log?.warn('policy_fetch_failed', {
        shop,
        topic,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    /**
     * Absence is cached too, for the same TTL.
     *
     * Otherwise a password-protected store pays a failed round trip on every
     * policy question a shopper asks, and the shopper waits for it each time.
     */
    this.cache.set(key, { value, at: this.now() });
    return value;
  }

  private async withTimeout(url: string, outer?: AbortSignal): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const onAbort = (): void => ctl.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.doFetch(url, {
        redirect: 'manual',
        headers: { accept: 'text/html' },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * The readable policy out of a Shopify policy page.
 *
 * Shopify wraps the merchant's text in `shopify-policy__body`; that is preferred
 * when present and the whole document is the fallback, because themes are free to
 * render it differently. Script and style contents are dropped first — otherwise
 * a theme's inline JSON ends up in the model's context looking like prose.
 */
export function extractPolicyText(html: string): string {
  const body =
    /<div[^>]*class="[^"]*shopify-policy__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html)?.[1] ??
    /<main[\s\S]*?>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    html;

  const text = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();

  /**
   * A handful of words is a cookie banner or a redirect stub, not a policy.
   * Treated as nothing at all, so the caller says it cannot confirm.
   */
  if (text.split(/\s+/).filter(Boolean).length < 15) return '';
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS).trimEnd()}…` : text;
}
