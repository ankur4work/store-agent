import type { CatalogIndex } from './catalog-index.js';

/**
 * Rebuilding a shop's semantic index, and deciding when.
 *
 * ## The problem this solves
 *
 * The index rebuilds on a six-hour TTL. A merchant who changes a price, renames
 * a product, or adds a new line is therefore invisible to meaning-based search
 * for up to six hours — while keyword search finds it immediately, because that
 * goes straight to the live catalog. The result is a store that answers "show me
 * some shoes" with four pairs and then, one question later, cannot find the
 * trainers that went up this morning.
 *
 * Shopify already tells us the moment it happens. `products/update` is a webhook
 * we were not listening to.
 *
 * ## Why a queue rather than rebuilding on the webhook
 *
 * A CSV import of four hundred products sends four hundred webhooks in a few
 * seconds. Rebuilding on each would embed the entire catalog four hundred times —
 * hundreds of API calls and a bill — to arrive at the same index one rebuild
 * would have produced. So changes are coalesced: the first one starts a short
 * timer, each subsequent one extends it, and a hard ceiling stops a continuous
 * stream of edits from deferring the rebuild forever.
 */

/** The catalog fetch a rebuild needs. Narrow on purpose — see UcpLike. */
export interface CatalogSource {
  searchCatalog(input: { query: string; pagination?: { limit: number } }): Promise<unknown>;
}

/**
 * Fetch a shop's catalog and re-embed it.
 *
 * Shared by the shopper path (which warms a cold index in the background) and
 * the webhook worker, because two copies of "fetch 100 products and build"
 * drift — and the limit in particular is a decision with a cost attached.
 */
export async function refreshCatalogIndex(
  shop: string,
  source: CatalogSource,
  index: CatalogIndex,
): Promise<number> {
  const full = (await source.searchCatalog({
    query: '',
    // 250 in one call is the single most expensive request we make against a
    // complexity-budgeted endpoint. A catalog larger than this was always going
    // to be truncated anyway; taking less of the budget matters more.
    pagination: { limit: 100 },
  })) as { products?: readonly unknown[] };
  const products = full.products ?? [];
  await index.build(shop, products);
  return products.length;
}

export interface CatalogQueueDeps {
  /** Rebuild one shop. Throwing is expected and handled; it is retried later. */
  refresh(shop: string): Promise<void>;
  /**
   * How long to wait for the burst to finish. 30s by default: long enough that a
   * bulk import coalesces into one rebuild, short enough that a merchant editing
   * one price sees it reflected before they have finished looking.
   */
  debounceMs?: number;
  /**
   * The longest a rebuild may be deferred by continuing edits. Without it, a
   * merchant working steadily through their catalog for an hour would extend the
   * timer for the whole hour and the index would never refresh at all.
   */
  maxWaitMs?: number;
  readonly log?: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
  };
  /** Injected so tests can drive time instead of waiting for it. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

interface Waiting {
  timer: unknown;
  /** When the first change in this burst arrived. */
  firstAt: number;
  /** Changes coalesced into this rebuild, for the log. */
  changes: number;
}

/**
 * Coalesces catalog changes per shop into one rebuild.
 *
 * Per shop rather than globally: one merchant importing a spreadsheet must not
 * delay another merchant's single price edit.
 */
export class CatalogRefreshQueue {
  private readonly waiting = new Map<string, Waiting>();
  /** Shops currently rebuilding, so a change during a rebuild queues another. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private stopped = false;

  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly deps: CatalogQueueDeps) {
    this.debounceMs = deps.debounceMs ?? 30_000;
    this.maxWaitMs = deps.maxWaitMs ?? 5 * 60_000;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? (() => Date.now());
  }

  /** A catalog change arrived for this shop. */
  touch(shop: string): void {
    if (this.stopped) return;

    // Already rebuilding: remember that the data changed underneath it, so the
    // result is not quietly one version behind.
    if (this.running.has(shop)) {
      this.again.add(shop);
      return;
    }

    const existing = this.waiting.get(shop);
    if (existing === undefined) {
      this.waiting.set(shop, {
        timer: this.setTimer(() => void this.fire(shop), this.debounceMs),
        firstAt: this.now(),
        changes: 1,
      });
      return;
    }

    existing.changes++;
    const waitedFor = this.now() - existing.firstAt;
    const remaining = this.maxWaitMs - waitedFor;
    // Past the ceiling the burst stops being extendable: fire on the next tick
    // rather than waiting for a stream of edits to stop.
    if (remaining <= 0) return;

    this.clearTimer(existing.timer);
    existing.timer = this.setTimer(() => void this.fire(shop), Math.min(this.debounceMs, remaining));
  }

  private async fire(shop: string): Promise<void> {
    const entry = this.waiting.get(shop);
    this.waiting.delete(shop);
    if (this.stopped) return;

    const task = (async () => {
      try {
        await this.deps.refresh(shop);
        this.deps.log?.info('catalog_refreshed', { shop, changes: entry?.changes ?? 1 });
      } catch (err) {
        // Never rethrown: this runs detached, and an unhandled rejection here
        // would take the process down over a stale index. The next change
        // retries, and the six-hour TTL is still the backstop underneath.
        this.deps.log?.warn('catalog_refresh_failed', {
          shop,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })().finally(() => {
      this.running.delete(shop);
      if (this.again.delete(shop)) this.touch(shop);
    });

    this.running.set(shop, task);
    await task;
  }

  /** Shops with a rebuild pending. */
  pending(): number {
    return this.waiting.size;
  }

  /**
   * Run everything now and wait for it. For tests and for shutdown — a queue
   * that drops a rebuild on deploy leaves the index stale until the TTL.
   */
  async drain(): Promise<void> {
    for (const [shop, entry] of [...this.waiting]) {
      this.clearTimer(entry.timer);
      await this.fire(shop);
    }
    await Promise.all([...this.running.values()]);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.waiting.values()) this.clearTimer(entry.timer);
    this.waiting.clear();
  }
}

/**
 * Webhook topics that change what the catalog contains.
 *
 * `collections/update` is included because a collection change alters what a
 * product *means* in this shop — moving a jacket into "Sale" is exactly the kind
 * of thing a shopper asks about — even though the product row itself did not
 * change.
 */
export const CATALOG_TOPICS: readonly string[] = [
  'products/create',
  'products/update',
  'products/delete',
  'collections/update',
];

export function isCatalogTopic(topic: string): boolean {
  return CATALOG_TOPICS.includes(topic);
}
