/**
 * One catalog browse, shared by every turn that needs it.
 *
 * ## Why this exists
 *
 * Measured against the live store, a page-fact turn spent ~450 ms before the
 * sentence existed, and none of it was a model — the lane answers with no model at
 * all. It was two UCP calls, both avoidable:
 *
 * | call | time | outcome |
 * |---|---:|---|
 * | `get_product` | 176-349 ms | **always fails** on this store |
 * | `search_catalog(limit 100)` | 203-1088 ms | 170 KB, 23 products, to find one |
 *
 * The first is handled by a capability breaker (see tool-executor.ts). This file
 * is about the second: re-downloading the whole catalog on every turn, for every
 * shopper, to pick one product out of it by id.
 *
 * The store offers no way to fetch a single product — `get_product` and
 * `lookup_catalog` both answer "Invalid params" to every shape we can construct,
 * so browsing really is the only route. What is avoidable is doing it per turn.
 *
 * ## Why a short TTL rather than the semantic index
 *
 * `CatalogIndex` already holds this shop's catalog, but as embeddings: a
 * `SemanticHit` is a product id and a score, with no product attached. It cannot
 * answer "what is this product's price", which is exactly what the page-fact lane
 * needs. Its 6-hour rebuild would also be far too stale to quote a price from.
 *
 * ## Why 60 seconds, and why that is safe to say a price from
 *
 * This caches prices, and a wrong price is the one failure that destroys the
 * product's whole claim — so the window is deliberately short, and it is not the
 * only defence. `invalidate()` is called from the `catalog_changed` webhook, so a
 * merchant editing a price clears this immediately rather than waiting out the
 * TTL. The residual exposure is a price that changed in the last minute with the
 * webhook still in flight — and in that minute the shopper is looking at a
 * storefront page that was itself rendered before the change.
 *
 * Deliberately NOT used for anything the merchant is shown, and not a substitute
 * for a cart: the cart is priced by Shopify at checkout, which is the only figure
 * that is ever authoritative.
 */

export interface CatalogSnapshotDeps {
  /** How long a browse may be reused. See the note above before raising this. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly log?: { info(event: string, fields?: Record<string, unknown>): void };
}

interface Entry {
  /** The in-flight or settled browse. Shared so concurrent turns make one call. */
  readonly products: Promise<readonly unknown[]>;
  readonly at: number;
}

/**
 * How many shops' catalogs may be held at once.
 *
 * There has to be a ceiling. Entries were only ever replaced or invalidated, never
 * dropped for being old, so one ~170 KB catalog per shop accumulated for the life
 * of the process — invisible on a dev store with two installs, and a leak
 * proportional to install count on a public app. Past the TTL an entry cannot be
 * served anyway, so sweeping is free; the cap is what bounds the pathological case
 * of many shops all active inside one window.
 */
const MAX_SHOPS = 64;

export class CatalogSnapshot {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  readonly stats = { fetches: 0, reuses: 0 };

  constructor(private readonly deps: CatalogSnapshotDeps = {}) {
    this.ttlMs = deps.ttlMs ?? 60_000;
    this.now = deps.now ?? Date.now;
  }

  /**
   * This shop's products, browsing only if the last one has aged out.
   *
   * `browse` is passed per call rather than held, because the UCP client is built
   * per shop and a cache that captured one would be a cache that could answer out
   * of the wrong store — the bug `ucpFor` exists to prevent.
   */
  async products(shop: string, browse: () => Promise<readonly unknown[]>): Promise<readonly unknown[]> {
    const existing = this.entries.get(shop);
    if (existing !== undefined && this.now() - existing.at < this.ttlMs) {
      this.stats.reuses++;
      return existing.products;
    }

    /**
     * Stored before it resolves, so turns that arrive during the browse await the
     * same one. Without this, the first shopper after an expiry and everyone
     * behind them each start their own 170 KB download.
     */
    this.stats.fetches++;
    this.sweep();
    const products = browse().catch((err: unknown) => {
      // A failed browse must not be remembered as this shop's catalog; the next
      // turn should be free to try again.
      this.entries.delete(shop);
      throw err;
    });
    this.entries.set(shop, { products, at: this.now() });
    return products;
  }

  /**
   * Drop what we hold for a shop.
   *
   * Called from the `catalog_changed` webhook. This is what keeps the TTL honest:
   * without it, 60 seconds would be a floor on how long a corrected price stayed
   * wrong, rather than a ceiling on how long an unchanged one stayed cached.
   */
  invalidate(shop: string): void {
    if (this.entries.delete(shop)) this.deps.log?.info('catalog_snapshot_cleared', { shop });
  }

  /**
   * Drop what can no longer be served, then the oldest if still over the cap.
   *
   * Run before each new browse rather than on a timer: a timer would hold the
   * process awake and there is no work to do when nobody is asking. An expired
   * entry is already unusable, so removing it loses nothing — which is why the
   * common case needs no cap at all.
   */
  private sweep(): void {
    const now = this.now();
    for (const [shop, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(shop);
    }
    // Room is left for the entry about to be inserted — this runs before it, so
    // stopping at the cap itself would settle one over.
    if (this.entries.size < MAX_SHOPS) return;
    // Still over: evict oldest-first. Insertion order is not age order once a
    // shop has been refreshed, so sort rather than trusting the Map's order.
    const byAge = [...this.entries].sort((a, b) => a[1].at - b[1].at);
    for (const [shop] of byAge) {
      if (this.entries.size < MAX_SHOPS) break;
      this.entries.delete(shop);
    }
  }

  /** How many shops' catalogs are currently held. For tests and `/metrics`. */
  get size(): number {
    return this.entries.size;
  }
}
