import { SafeCart, UcpClient } from '@storeagent/ucp-client';
import type { ToolExecutor } from '@storeagent/orchestrator';
import { DEMO_POLICIES, searchDemoCatalog } from './catalog-fixture.js';
import { formatMinor } from '@storeagent/grounding';
import type { Session } from './sessions.js';
import type { CatalogIndex } from './search/catalog-index.js';
import { refreshCatalogIndex, type CatalogSource } from './search/refresh.js';

/**
 * Wires the model's tool calls to real systems.
 *
 * Two modes:
 *   - **live**   — a SHOP_DOMAIN is configured; catalog and cart go to UCP.
 *   - **demo**   — no shop configured; a fixture catalog stands in.
 *
 * Demo mode exists because the Shopify development store is still outstanding
 * and blocking the entire application on it would be a poor trade. The fixture
 * returns the exact UCP payload shape, so nothing downstream — grounding
 * included — can tell the difference.
 */

/**
 * What the storefront page knows about the product on it, beyond the id.
 *
 * Identity only, and treated as untrusted throughout: it arrives from the
 * shopper's browser, so it may name a product but may never carry a fact about
 * one. See `resolveByName` for the match that makes it safe to act on.
 */
export interface ProductHint {
  /** The product's own name, cleaned of the shop name the tab title carries. */
  readonly title?: string;
  /** From the URL path. Unique per store, and survives translation prefixes. */
  readonly handle?: string;
}

export interface ToolExecutorDeps {
  readonly session: Session;
  readonly ucp?: UcpClient | undefined;
  readonly onCartChange?: (cartId: string) => void;
  /** Absent until embeddings are configured; search then stays keyword-only. */
  readonly catalogIndex?: CatalogIndex;
  /**
   * Remembers that this storefront's `get_product` does not work.
   *
   * Keyed by shop and shared across turns, so it has to be owned by the gateway
   * rather than built per executor — a breaker rebuilt each turn has never seen a
   * failure and would admit the doomed call every time, which is precisely the
   * cost it exists to remove.
   */
  readonly productLookup?: {
    allow(key: string): boolean;
    succeed(key: string): void;
    fail(key: string): void;
  };
  /** Reuses one catalog browse across turns. See search/catalog-snapshot.ts. */
  readonly catalogSnapshot?: {
    products(shop: string, browse: () => Promise<readonly unknown[]>): Promise<readonly unknown[]>;
  };
  /**
   * The merchant's own policy pages. Absent means a live shop can quote none,
   * which is the safe direction — see the `get_policy` case.
   */
  readonly policies?: {
    get(
      shop: string,
      topic: string,
      signal?: AbortSignal,
    ): Promise<{ topic: string; text: string; sourceUrl: string } | undefined>;
  };
  readonly log?: { warn(event: string, fields?: Record<string, unknown>): void };
}

/**
 * Attach a ready-to-quote price string to every money object in a catalog
 * payload.
 *
 * The model was being handed minor units (78595) and asked to do the division
 * itself. It mostly did, and then wrote `$785.00` for a `$785.95` board on
 * roughly three turns in five — measured against the live catalog. The tripwire
 * caught every one, so no shopper ever saw a wrong price, but each catch threw
 * the generation away and re-ran the turn: ~5.6k input tokens became ~7.2k, and
 * one run in five gave up and handed off a question the store could answer.
 *
 * Prompting was tried first and reduced it without fixing it, because the ask
 * was still "do this arithmetic correctly every time". This removes the
 * arithmetic. `display` is the exact string to quote, so the model copies
 * rather than computes.
 *
 * Minor units stay in the payload untouched: grounding validates the model's
 * claims against source money, and `collectMoneyFromResult` reads both the
 * structured amount and money written inside strings, so the added field is
 * consistent with what the tripwire already accepts.
 */
function withDisplayPrices<T>(payload: T): T {
  // Both passes, always together: a display string per amount, and one
  // ready-to-quote line per product. See withPriceSummary for why the second
  // exists even though the first already removed the division.
  withPriceSummary(payload);
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj['amount'] === 'number' && typeof obj['currency'] === 'string' && obj['display'] === undefined) {
      const symbol = CURRENCY_SYMBOL[obj['currency']] ?? '';
      obj['display'] = `${symbol}${formatMinor(Math.round(obj['amount']))}`;
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(payload);
  return payload;
}

/**
 * Give every product ONE ready-to-quote price line.
 *
 * ## Why
 *
 * `withDisplayPrices` removed the division. This removes the comparison, which is
 * the arithmetic that was actually reaching shoppers.
 *
 * Reproduced against the live store: "how much is the swimsuit" was aborted by the
 * tripwire with `uncited_price: 52.00` — the model had written $52.00 for a $52.99
 * costume — then retried and recovered. When the retry slips too, the turn ends as
 * "I can't confirm the price", which is what a merchant reported seeing.
 *
 * It is not a careless model. A three-product answer on that store hands it a
 * `price_range` plus eight to ten variants per product: **about thirty-six
 * separate figures**, from which it is expected to pick a lowest and a highest and
 * write them exactly. One slip in thirty-six is a good hit rate and still a wrong
 * price.
 *
 * So the range is computed here, once, and attached as a string to copy.
 *
 * ## Why the variants and not the store's own price_range
 *
 * They disagree. One product on that store reports a `price_range` minimum of
 * 3399 while its cheapest variant is 4699 — a list price against a selling price.
 * The variants are what a shopper can actually buy, so they win; `price_range` is
 * only used when there are no priced variants to read.
 *
 * Mixed currencies produce nothing at all: a range whose ends are in different
 * money is not a range, and silence sends the model back to the per-variant
 * prices, which are still right.
 */
/** Exported for tests; always applied through `withDisplayPrices`. */
export function withPriceSummary<T>(payload: T): T {
  const seen = new WeakSet<object>();

  const summarise = (product: Record<string, unknown>): void => {
    const variants = Array.isArray(product['variants']) ? product['variants'] : [];
    const money: { amount: number; currency: string }[] = [];
    for (const v of variants) {
      const price = (v as { price?: unknown }).price as
        | { amount?: unknown; currency?: unknown }
        | undefined;
      if (typeof price?.amount === 'number' && typeof price.currency === 'string') {
        money.push({ amount: price.amount, currency: price.currency });
      }
    }
    if (money.length === 0) {
      const range = product['price_range'] as
        | { min?: { amount?: unknown; currency?: unknown }; max?: { amount?: unknown; currency?: unknown } }
        | undefined;
      for (const end of [range?.min, range?.max]) {
        if (typeof end?.amount === 'number' && typeof end.currency === 'string') {
          money.push({ amount: end.amount, currency: end.currency });
        }
      }
    }
    if (money.length === 0) return;

    const currency = money[0]!.currency;
    if (money.some((m) => m.currency !== currency)) return;

    const symbol = CURRENCY_SYMBOL[currency] ?? '';
    const low = Math.min(...money.map((m) => m.amount));
    const high = Math.max(...money.map((m) => m.amount));
    const at = (n: number): string => `${symbol}${formatMinor(Math.round(n))}`;
    // An en dash, not a hyphen: it is read aloud as a range rather than a minus.
    product['price_display'] = low === high ? at(low) : `${at(low)} – ${at(high)}`;
  };

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    // A product is the thing with a title and variants or a price range.
    if (typeof obj['title'] === 'string' && (obj['variants'] !== undefined || obj['price_range'] !== undefined)) {
      summarise(obj);
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };

  walk(payload);
  return payload;
}

/** Only the symbols we can render unambiguously; anything else falls back to the bare amount. */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  CAD: '$',
  AUD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  JPY: '¥',
};

/**
 * Words that carry no catalog signal.
 *
 * Catalog search matches words against product text. A shopper's sentence is
 * mostly words that describe the *asking*, not the product — "do you have any
 * boards for my kid he's 12" is one useful token and eleven that match
 * nothing. Passed through whole, the search returns nothing and the assistant
 * truthfully reports it has no boards, in a store full of boards.
 */
const NOISE = new Set([
  'a', 'an', 'the', 'any', 'some', 'this', 'that', 'these', 'those',
  'i', 'im', 'me', 'my', 'we', 'our', 'you', 'your', 'u', 'ur', 'he', 'she', 'his', 'her', 'they',
  'do', 'does', 'did', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'have', 'has', 'had', 'got', 'get', 'want', 'need', 'looking', 'look', 'find', 'show', 'tell',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
  'what', 'whats', 'which', 'who', 'where', 'when', 'why', 'how',
  'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'about', 'from', 'and', 'or', 'but', 'if',
  'please', 'hi', 'hey', 'hello', 'yo', 'thanks', 'thank',
  'good', 'best', 'nice', 'cool', 'great', 'something', 'anything', 'stuff', 'thing', 'things',
  'much', 'many', 'cost', 'costs', 'price', 'priced', 'pricing',
  'stock', 'available', 'availability', 'sell', 'sells', 'buy', 'order', 'store', 'shop',
  'old', 'year', 'years', 'kid', 'kids', 'son', 'daughter', 'wife', 'husband', 'friend',
  'rn', 'now', 'today', 'deal', 'deals', 'sale', 'discount', 'cheap', 'cheapest', 'expensive',
  'difference', 'between', 'compare', 'vs', 'versus', 'like', 'it', 'one', 'ones',
  // Shorthand a shopper types instead of the word. "avl products" is not a
  // product name, and treating it as one made the assistant apologise for
  // failing to find a board called "avl" rather than simply listing what is
  // in stock.
  'avl', 'avail', 'av', 'prod', 'prods', 'product', 'products', 'item', 'items',
  'pls', 'plz', 'please', 'options', 'option', 'other', 'others', 'more', 'all', 'everything',
]);

/**
 * The shopper's words reduced to the ones a catalog can match.
 * Returns '' when nothing survives, which is the signal to browse instead.
 */
export function catalogTerms(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    // Contractions are checked on their stem too, so "he's" is dropped for the
    // same reason "he" is rather than being searched for as a product word.
    .filter((w) => {
      if (w === '' || /^\d+$/.test(w)) return false;
      const stem = w.replace(/'(?:s|re|m|ve|ll|d)$/, '');
      return !NOISE.has(w) && !NOISE.has(stem);
    })
    .join(' ');
}

/**
 * Give a referential follow-up its subject back.
 *
 * A shopper was shown four pairs of shoes, said "best one", and was offered a
 * snowboard — with "I couldn't find shoes in the live catalog" above it, in a
 * store that had just listed four. Same failure for "cheapest one".
 *
 * The cause is one line up: `catalogTerms('best one')` is EMPTY, because
 * "best" and "one" are both noise, correctly. Empty terms mean "the shopper
 * named nothing", whose fallback is to browse the catalog — so a follow-up
 * that referred to the previous answer was treated as an opening request to
 * see anything at all, and the browse fallback in a snowboard shop returns
 * snowboards.
 *
 * The subject is sitting in the conversation the model can already see; it
 * simply was not reaching the search. Carrying it forward here is
 * deterministic, which is what this needs to be — asking the model to always
 * write self-contained queries makes the right behaviour likely rather than
 * certain, and one wrong picture undoes the whole answer.
 *
 * Only the subject is carried, never the qualifier: searching "shoes" and
 * letting the model pick the best of them is right, while searching "best
 * shoes" asks the catalog a question it cannot answer.
 */
export function carryForward(
  query: string,
  history: readonly { readonly role: string; readonly content: unknown }[],
): string {
  // Something concrete was named — nothing to resolve.
  if (catalogTerms(query) !== '') return query;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m === undefined || m.role !== 'user') continue;
    // Tool results and content blocks are not things the shopper said.
    if (typeof m.content !== 'string') continue;
    const subject = catalogTerms(m.content);
    if (subject !== '') return subject;
  }
  // A first turn with no subject anywhere really is a browse.
  return query;
}

/**
 * When each shop last had its index rebuilt by a search miss.
 *
 * Module scope deliberately: a tool executor is built per turn, so a counter
 * held inside one would reset on every message and the cooldown it exists to
 * enforce would never once fire.
 */
const lastForcedBuild = new Map<string, number>();
const FORCE_REBUILD_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * When the storefront last refused us, per shop.
 *
 * The UCP endpoint bills on a complexity budget, not a request count, and a
 * rebuild is the most expensive thing we do — 250 products in one call. A
 * rebuild is also triggered by a search finding nothing, and a rate-limited
 * search finds nothing. So the recovery fed the failure: 429, rebuild, more
 * budget spent, more 429, and every turn ending in "the product catalog
 * isn't available right now" while turns crept to twenty seconds.
 *
 * While the storefront is refusing us, the one thing not to do is spend
 * more of the budget on speculative work.
 */
const lastRefusal = new Map<string, number>();
const REFUSAL_QUIET_MS = 5 * 60 * 1000;

/** Note that the storefront refused us, so speculative work stands down. */
export function noteCatalogRefusal(shop: string, err: unknown, now = Date.now()): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Rate limit or upstream failure. A 404 on one product is not a reason to
  // stop indexing.
  if (!/HTTP (?:429|5\d\d)/.test(msg)) return false;
  lastRefusal.set(shop, now);
  return true;
}

function recentlyRefused(shop: string, now = Date.now()): boolean {
  return now - (lastRefusal.get(shop) ?? 0) < REFUSAL_QUIET_MS;
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const { session, ucp } = deps;
  const safeCart = ucp ? new SafeCart(ucp) : undefined;

  /**
   * Search, and if it finds nothing, ask a broader question.
   *
   * A single miss used to end the turn: the model asked for exactly what the
   * shopper said, got zero products, and reported honestly that the store had
   * none. That is the correct response to an empty result and the wrong answer
   * to the shopper — "what's your most expensive product", "a board for my
   * kid", "what do you sell" all returned nothing while the catalog was full.
   *
   * So an empty result is retried with the noise stripped, and then with no
   * query at all, which lists the catalog. Every fallback is labelled: the
   * model is told the search was broadened and what it actually ran, so it
   * says "I didn't find X — here's what we do have" instead of presenting a
   * browse as a match. Grounding is unaffected either way, since the products
   * are real catalog rows whichever query produced them.
   */
  /**
   * Rank the catalog by MEANING, for the queries keywords cannot reach.
   *
   * Tried before the broadening fallbacks, because "open-toe shoes" and "a
   * black bag with a gold chain" are not thin keyword matches — they are
   * zero keyword matches, and the fallback would answer them by listing the
   * shop. Semantic search either finds something genuinely close or returns
   * nothing, which is a better answer than an arbitrary browse.
   *
   * Never blocks the turn: an index that is cold, stale or failing falls
   * straight through to keyword search.
   */
  /**
   * Warm the index in the BACKGROUND, on any search.
   *
   * Two things this must not do, both learned the hard way.
   *
   * It must not block: embedding a catalog took 12.8s against the live
   * store, and awaiting it put that in front of a shopper who asked one
   * question. No search result is worth thirteen seconds of a spinner.
   *
   * And it must not wait for a keyword MISS to trigger. Building only when
   * keyword search came back empty meant the index stayed cold through
   * every successful search — so it was never warm at the moment it was
   * finally needed, which is exactly the moment the shopper asked for
   * something the words could not find.
   *
   * `build` de-duplicates concurrent callers, so a burst embeds once.
   */
  function warmIndex(): void {
    const index = deps.catalogIndex;
    if (index === undefined || ucp === undefined) return;
    if (recentlyRefused(session.shopDomain)) return;
    if (!index.isStale(session.shopDomain)) return;
    void rebuildIndex().catch((err: unknown) => {
      // Swallowed so a shopper's turn is never affected, but reported —
      // CatalogIndex logs the reason, and this covers the catalog fetch
      // that happens before it.
      deps.log?.warn('catalog_warm_failed', {
        shop: session.shopDomain,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Fetch one product by id, on a storefront that may not implement it.
   *
   * ## Measured against a real store
   *
   * `tools/list` advertises `get_product` and `lookup_catalog` with exactly the
   * schema we send. `tools/call` then answers **"Tool not found: get_product"**
   * for both. Only `search_catalog` is actually callable.
   *
   * That makes the model's `get_product` tool a trap rather than a capability:
   * its own description tells the model when to reach for it, and every time it
   * did, the tool errored. Observed live — a shopper on a product page asked what
   * sizes it came in, `get_product` failed, and the turn escalated to a human for
   * a question the catalog could answer.
   *
   * ## Why a fallback rather than removing the tool
   *
   * Removing it would edit the cached prompt prefix on every merchant, and would
   * give up a capability on the stores where it does work. UCP is also mid-rollout,
   * so "not found today" is not "never". A fallback is correct on both kinds of
   * store and needs no per-shop configuration.
   *
   * The fallback browses the catalog and picks the matching id. One extra call,
   * authoritative data, and `search_catalog` returns whole products with their
   * variants — which is all `get_product` was being asked for.
   */
  /**
   * Two spellings of the same product.
   *
   * The catalog speaks in gids — `gid://shopify/Product/8944748757044` — and a
   * storefront page reports `ShopifyAnalytics.meta.page.resourceId`, which is the
   * bare number. They are the same product and a string compare says they are
   * not, so the id the page is certain about resolved to nothing and every
   * page-grounded answer silently fell back to the model.
   *
   * Compared on the trailing segment, and only when that segment is all digits:
   * an opaque id that merely happens to contain a slash must still be matched
   * exactly.
   */
  function sameProductId(a: string, b: string): boolean {
    if (a === b) return true;
    const tail = (s: string): string => {
      const last = s.slice(s.lastIndexOf('/') + 1);
      return /^\d+$/.test(last) ? last : s;
    };
    const ta = tail(a);
    const tb = tail(b);
    return ta === tb && /^\d+$/.test(ta);
  }

  async function getProductResilient(
    id: string,
    signal?: AbortSignal,
    hint?: ProductHint,
  ): Promise<unknown> {
    const shop = session.shopDomain;

    /**
     * Ask the store's own `get_product` only while there is reason to think it
     * works.
     *
     * Measured on the dev store, it answers "Invalid params" to every shape we can
     * construct — `{catalog:{id}}`, `{catalog:{product_id}}`, a bare `{id}` — and
     * so does `lookup_catalog`. That is a capability the store does not have, and
     * attempting it cost **176-349 ms of every page-grounded turn** on the way to
     * the fallback that was always going to answer.
     *
     * A breaker rather than a permanent latch, because UCP is mid-rollout and
     * "absent today" is not "absent for good": after the reset window one probe
     * goes through, and a store that has gained the capability starts using it
     * without anyone redeploying. The cost of being wrong in that direction is one
     * slow turn per window.
     */
    if (deps.productLookup === undefined || deps.productLookup.allow(shop)) {
      try {
        const direct = await ucp!.getProduct({ id }, signal);
        deps.productLookup?.succeed(shop);
        return direct;
      } catch (err) {
        deps.productLookup?.fail(shop);
        deps.log?.warn('get_product_unavailable', {
          shop,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    /**
     * Browse and resolve locally, reusing a recent browse where there is one.
     *
     * Bounded at the same 100 the index build uses: a catalog larger than that
     * would have been truncated there too, and this is the cheaper of the two
     * failures. The snapshot is what stops this being 170 KB on every turn for
     * every shopper — see search/catalog-snapshot.ts for why its TTL is short.
     *
     * A failure here is left to propagate, as before: by this point there is no
     * further fallback, and the caller turns it into an honest "I could not read
     * the catalog" rather than a guess.
     */
    const fetchAll = async (): Promise<readonly unknown[]> => {
      const browse = (await ucp!.searchCatalog(
        { query: '', pagination: { limit: 100 } },
        signal,
      )) as unknown as { products?: readonly unknown[] };
      return browse.products ?? [];
    };
    const products =
      deps.catalogSnapshot === undefined
        ? await fetchAll()
        : await deps.catalogSnapshot.products(shop, fetchAll);

    const found = products.find((p) => {
      const pid = (p as { id?: unknown }).id;
      return pid !== undefined && sameProductId(String(pid), id);
    });
    if (found !== undefined) return { product: found };

    // The browse is one page deep, so on any catalog past that the product the
    // shopper is standing on is simply not in it. Ask for it by name.
    const byName = await resolveByName(id, hint, signal);
    if (byName !== undefined) return { product: byName };

    // Honest, and specific enough to be actionable: the model should search
    // by name rather than retry an id that cannot be resolved.
    return {
      error: true,
      message: `Could not resolve product ${id}. Use search_catalog by name instead.`,
    };
  }

  /**
   * Resolve the page's product by searching for its name, for catalogs the
   * one-page browse cannot cover.
   *
   * ## Why this tier exists
   *
   * The browse above asks for 100 products. A shopper standing on product #250 of
   * a 300-product store was therefore unresolvable: the page-fact lane declined
   * and the model answered instead. Safe, but it meant the 300 ms path never fired
   * for most products of any store large enough to matter — and the dev store has
   * 27 products, so nothing here ever showed it.
   *
   * Paginating to find one product is the obvious alternative and the wrong one:
   * it costs up to ten sequential round trips, which is slower than the model path
   * it exists to beat, and it would hold a 1000-product catalog in the snapshot
   * for every shop. The store's keyword search already goes straight to the live
   * catalog, so one call finds the product wherever it sits.
   *
   * ## Why only an exact id or handle match is accepted
   *
   * This lane quotes prices with no model in the loop, so a near miss is not a
   * degraded answer, it is a confident wrong one — the price of a different
   * swimsuit, in 300 ms, in the merchant's voice. A keyword search for "One Piece
   * Swimsuit" will happily return nine other swimsuits. So the search is used only
   * to *locate* a product whose identity is already known: the id from the page,
   * or the handle from its URL, which is unique per store and is the one thing the
   * shopper's address bar proves. Anything else declines and lets the model answer.
   */
  async function resolveByName(
    id: string,
    hint: ProductHint | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const query = (hint?.title ?? '').trim();
    if (query === '') return undefined;

    let candidates: readonly unknown[];
    try {
      const page = (await ucp!.searchCatalog(
        { query, pagination: { limit: 10 } },
        signal,
      )) as unknown as { products?: readonly unknown[] };
      candidates = page.products ?? [];
    } catch (err) {
      // Not fatal: the caller still has an honest decline, and a search that
      // failed says nothing about whether the product exists.
      deps.log?.warn('product_name_resolve_failed', {
        shop: session.shopDomain,
        reason: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }

    const byId = candidates.find((p) => {
      const pid = (p as { id?: unknown }).id;
      return pid !== undefined && sameProductId(String(pid), id);
    });
    if (byId !== undefined) return byId;

    const handle = (hint?.handle ?? '').trim().toLowerCase();
    if (handle === '') return undefined;
    return candidates.find(
      (p) => String((p as { handle?: unknown }).handle ?? '').toLowerCase() === handle,
    );
  }

  async function rebuildIndex(): Promise<void> {
    // Shared with the webhook worker in search/refresh.ts. Two copies of "fetch
    // the catalog and build" drift, and the page ceiling in particular is a
    // decision with a cost attached that should only be made in one place.
    await refreshCatalogIndex(
      session.shopDomain,
      ucp as unknown as CatalogSource,
      deps.catalogIndex!,
      deps.log,
    );
  }

  /**
   * A semantic miss might mean the index has never seen the product.
   *
   * The index rebuilds on a six-hour TTL, so a product added after the last
   * build is invisible to meaning-based search until that elapses — while
   * keyword search finds it immediately, because that goes straight to the
   * live catalog. The result is a store that answers "can you show me some
   * shoes" with four pairs of shoes and then, one question later, "I
   * couldn't find any open-toe shoes in the catalog — this store may not
   * carry footwear." Both answers from the same catalog, seconds apart.
   *
   * A merchant who adds a product and immediately asks about it is the
   * normal case, not an edge one, and "wait six hours" is not an answer. So
   * a miss triggers one rebuild and one retry: if the product was simply
   * missing from the index, the retry finds it.
   *
   * Rate-limited, because a genuine miss ("do you sell cars") must not
   * re-embed the catalog on every turn. One rebuild per window at worst.
   */
  async function refreshedAfterMiss(): Promise<boolean> {
    const index = deps.catalogIndex;
    if (index === undefined || ucp === undefined) return false;
    const now = Date.now();
    const shop = session.shopDomain;
    // A miss during a rate limit says nothing about the index, and paying
    // to rebuild it is what turned one 429 into every turn failing.
    if (recentlyRefused(shop, now)) return false;
    if (now - (lastForcedBuild.get(shop) ?? 0) < FORCE_REBUILD_COOLDOWN_MS) return false;
    lastForcedBuild.set(shop, now);
    try {
      await rebuildIndex();
      deps.log?.warn('catalog_index_rebuilt_on_miss', { shop: session.shopDomain });
      return true;
    } catch (err: unknown) {
      deps.log?.warn('catalog_warm_failed', {
        shop: session.shopDomain,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async function semanticSearch(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const index = deps.catalogIndex;
    const shop = session.shopDomain;
    if (index === undefined || query.trim() === '') return undefined;

    try {
      if (index.isStale(shop)) return undefined;
      const hits = await index.search(shop, query, limit);
      if (hits.length === 0) return undefined;

      // Resolve ids back to live catalog rows rather than serving a copy
      // from the index — prices and availability must never come from a
      // cache that is up to six hours old.
      const resolved = await ucp!.lookupCatalogChunked(
        hits.map((h) => h.productId),
        undefined,
        signal,
      );
      const products = (resolved as unknown as { products?: readonly unknown[] }).products ?? [];
      if (products.length === 0) return undefined;

      // Back into relevance order; lookup returns them however it likes.
      const rank = new Map(hits.map((h, i) => [h.productId, i]));
      const ordered = [...products].sort(
        (a, b) =>
          (rank.get(String((a as { id?: unknown }).id)) ?? 99) -
          (rank.get(String((b as { id?: unknown }).id)) ?? 99),
      );

      return {
        products: ordered,
        matched_by: 'meaning',
        note:
          'Matched on meaning rather than wording, so the shopper\'s words may appear nowhere in ' +
          'these products. Check each one really answers what they asked before recommending it.',
      };
    } catch {
      // Cold, stale, rate-limited or misconfigured — keyword search still works.
      return undefined;
    }
  }

  async function searchBroadening(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const attempts = [query];
    const terms = catalogTerms(query);
    if (terms !== '' && terms !== query.trim().toLowerCase()) attempts.push(terms);
    // Last resort: no query lists the catalog, so a vague or unmatchable ask
    // still gets real products to talk about rather than a dead end.
    attempts.push('');

    let last: { products?: readonly unknown[] } = { products: [] };
    for (const attempt of attempts) {
      const result = (await ucp!.searchCatalog(
        { query: attempt, pagination: { limit } },
        signal,
      )) as unknown as { products?: readonly unknown[] };
      last = result;
      if ((result.products?.length ?? 0) > 0) {
        if (attempt === query) return result as Record<string, unknown>;
        return {
          ...(result as Record<string, unknown>),
          broadened: true,
          requested_query: query,
          query_used: attempt,
          note:
            attempt !== ''
              ? `No product matched "${query}". These matched the broader search "${attempt}".`
              : terms === ''
                ? // The shopper named no product at all — "what do you sell",
                  // "avl products", "other options". There is nothing to
                  // apologise for, and apologising is what made the assistant
                  // answer a browse request by regretting it could not find a
                  // product called "avl". Just show them the store.
                  'The shopper did not name a specific product, so this is the catalog. Answer their question directly with these — do not say you could not find a match.'
                : 'No product matched the shopper\'s wording. These are real products from the catalog but NOT matches. ' +
                  'Say briefly that the exact thing is not there, then recommend the closest of these and why it works. ' +
                  'Do not escalate — not stocking something is an answer, not a failure.',
        };
      }
    }
    return last as Record<string, unknown>;
  }

  return {
    async execute(name, input, signal) {
      switch (name) {
        case 'search_catalog': {
          const asked = String(input['query'] ?? '');
          const query = carryForward(asked, session.history);
          if (query !== asked) {
            // Worth a line: a follow-up answered against the wrong subject
            // looks like a search failure, and this is where that is decided.
            deps.log?.warn('search_subject_carried', { from: asked, to: query });
          }
          const limit = typeof input['limit'] === 'number' ? input['limit'] : 6;
          if (ucp) {
            // Kick the index along on every search, never on the miss alone.
            warmIndex();
            // Keyword first: when the shopper names a product it is exact,
            // cheaper, and needs no index. Meaning is the fallback for the
            // descriptions keywords cannot reach.
            let direct: { products?: readonly unknown[] };
            try {
              direct = (await ucp.searchCatalog({ query, pagination: { limit } }, signal)) as unknown as {
                products?: readonly unknown[];
              };
            } catch (err: unknown) {
              // A refusal has to be recorded before it propagates, or the
              // next turn cheerfully spends more of the budget that just ran
              // out — which is how one rate limit became every turn failing.
              if (noteCatalogRefusal(session.shopDomain, err)) {
                deps.log?.warn('catalog_refused', {
                  shop: session.shopDomain,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
              throw err;
            }
            if ((direct.products?.length ?? 0) > 0) return withDisplayPrices(direct);
            const bymeaning = await semanticSearch(query, limit, signal);
            if (bymeaning !== undefined) return withDisplayPrices(bymeaning);
            // Nothing by wording, nothing by meaning. Before telling the
            // shopper the store does not stock it, make sure the index has
            // actually seen the catalog as it is now.
            if (await refreshedAfterMiss()) {
              const retry = await semanticSearch(query, limit, signal);
              if (retry !== undefined) return withDisplayPrices(retry);
            }
            return withDisplayPrices(await searchBroadening(query, limit, signal));
          }
          return withDisplayPrices(searchDemoCatalog(query, limit));
        }

        case 'get_product': {
          const id = String(input['id'] ?? '');
          /**
           * Identity the page already knows, for the resolution tier that needs it.
           *
           * Both are untrusted — they come from the shopper's browser — and both
           * are safe to pass, because `resolveByName` uses them only to search and
           * then insists on an exact id or handle match before believing anything.
           * A forged title finds nothing; it cannot substitute one product's price
           * for another's.
           */
          const hint: ProductHint = {
            ...(typeof input['title'] === 'string' ? { title: input['title'] } : {}),
            ...(typeof input['handle'] === 'string' ? { handle: input['handle'] } : {}),
          };
          if (ucp) return withDisplayPrices(await getProductResilient(id, signal, hint));
          const found = searchDemoCatalog('', 100).products.find((p) => p.id === id);
          if (found === undefined) return { error: true, message: `No product with id ${id}` };
          return withDisplayPrices({ product: found });
        }

        case 'get_policy': {
          const topic = String(input['topic'] ?? 'faq');

          /**
           * A real shop is answered from ITS OWN policy pages, or not at all.
           *
           * This used to read `DEMO_POLICIES` unconditionally. Verified against the
           * live dev store, a shopper asking about returns was told "within 30 days
           * … return shipping is free, refunds within 5 business days" — the
           * fixture, quoted as this merchant's policy, sourced to `example.test`,
           * and reported `grounded: true` because a tool result did back it. The
           * tripwire checks that a claim has a source; it cannot check that the
           * source was telling the truth.
           *
           * So in live mode there is no fallback. If the merchant's page cannot be
           * read — password-protected storefront, or a policy they never wrote —
           * the model is told so plainly and takes the honest route it already has
           * for missing data. A plausible answer standing in for an absent one is
           * the entire failure being fixed here.
           */
          if (ucp) {
            const found = await deps.policies?.get(session.shopDomain, topic, signal);
            if (found === undefined) {
              return {
                error: true,
                message:
                  `This store's ${topic} policy is not available to quote. Say you ` +
                  `cannot confirm it and offer to put the shopper in touch with the team.`,
              };
            }
            return { topic: found.topic, text: found.text, source_url: found.sourceUrl };
          }

          // Demo mode only: no merchant exists, so the fixture misrepresents nobody.
          const text = DEMO_POLICIES[topic];
          if (text === undefined) return { error: true, message: `No policy for topic ${topic}` };
          return { topic, text, source_url: `https://example.test/policies/${topic}` };
        }

        case 'add_to_cart': {
          const variantId = String(input['variant_id'] ?? '');
          const quantity = typeof input['quantity'] === 'number' ? input['quantity'] : 1;
          if (!safeCart || !ucp) {
            // Demo mode: acknowledge without inventing cart totals, so the
            // model has nothing ungrounded to quote.
            return { ok: true, added: { variant_id: variantId, quantity }, demo: true };
          }
          if (session.cartId === undefined) {
            const created = await ucp.createCart(
              {
                line_items: [{ variant_id: variantId, quantity }],
                attribution: { source: 'storeagent', session_id: session.id },
              },
              signal,
            );
            session.cartId = created.cart.id;
            deps.onCartChange?.(created.cart.id);
            return created;
          }
          return safeCart.addLine(session.cartId, { variant_id: variantId, quantity }, signal);
        }

        case 'escalate_to_human': {
          // Phase 2 turns this into a real ticket + email capture. Recording it
          // as a successful outcome matters: an escalation that captures a lead
          // beats a confident wrong answer.
          return { ok: true, escalated: true, reason: String(input['reason'] ?? '') };
        }

        default:
          return { error: true, message: `Unknown tool: ${name}` };
      }
    },
  };
}
