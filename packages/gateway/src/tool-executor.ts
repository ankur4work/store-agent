import { SafeCart, UcpClient } from '@storeagent/ucp-client';
import type { ToolExecutor } from '@storeagent/orchestrator';
import { DEMO_POLICIES, searchDemoCatalog } from './catalog-fixture.js';
import { formatMinor } from '@storeagent/grounding';
import type { Session } from './sessions.js';
import type { CatalogIndex } from './search/catalog-index.js';

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

export interface ToolExecutorDeps {
  readonly session: Session;
  readonly ucp?: UcpClient | undefined;
  readonly onCartChange?: (cartId: string) => void;
  /** Absent until embeddings are configured; search then stays keyword-only. */
  readonly catalogIndex?: CatalogIndex;
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
const FORCE_REBUILD_COOLDOWN_MS = 10 * 60 * 1000;

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

  async function rebuildIndex(): Promise<void> {
    const full = (await ucp!.searchCatalog({
      query: '',
      pagination: { limit: 250 },
    })) as unknown as { products?: readonly unknown[] };
    await deps.catalogIndex!.build(session.shopDomain, full.products ?? []);
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
            const direct = (await ucp.searchCatalog({ query, pagination: { limit } }, signal)) as unknown as {
              products?: readonly unknown[];
            };
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
          if (ucp) return withDisplayPrices(await ucp.getProduct({ id }, signal));
          const found = searchDemoCatalog('', 100).products.find((p) => p.id === id);
          if (found === undefined) return { error: true, message: `No product with id ${id}` };
          return withDisplayPrices({ product: found });
        }

        case 'get_policy': {
          const topic = String(input['topic'] ?? 'faq');
          // The owned side of the grounding split (ARCHITECTURE.md §5.1). Small,
          // changes rarely — a per-merchant corpus, not a vector index over the
          // catalog. pgvector retrieval replaces this lookup in Phase 2.
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
