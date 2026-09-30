import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CATALOG_TOPICS,
  CatalogRefreshQueue,
  isCatalogTopic,
  refreshCatalogIndex,
} from '../src/search/refresh.js';
import { handleWebhook, REQUIRED_TOPICS } from '../src/shopify/webhooks.js';
import { MemoryShopStore } from '../src/shopify/shops.js';
import type { CatalogIndex } from '../src/search/catalog-index.js';

/**
 * Keeping the semantic index level with the shop.
 *
 * It rebuilt on a six-hour TTL and nothing else, so a merchant who changed a
 * price or added a line was invisible to meaning-based search for up to six
 * hours — findable by keyword the entire time, which reads as an assistant that
 * does not know about products in the merchant's own admin. Shopify was already
 * telling us the moment it happened; we were not listening.
 *
 * The expensive half of these tests is the coalescing. A CSV import of four
 * hundred products sends four hundred webhooks in seconds, and rebuilding on
 * each would embed the whole catalog four hundred times — hundreds of API calls
 * and a bill — to arrive at the index one rebuild produces.
 */

/** A queue with time under the test's control rather than the clock's. */
function queueWithFakeTime(refresh: (shop: string) => Promise<void>, opts?: { maxWaitMs?: number }) {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;

  const queue = new CatalogRefreshQueue({
    refresh,
    debounceMs: 1000,
    ...(opts?.maxWaitMs === undefined ? {} : { maxWaitMs: opts.maxWaitMs }),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i !== -1) timers.splice(i, 1);
    },
  });

  /** Advance time and run whatever became due. */
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    // Let the detached refresh settle.
    await Promise.resolve();
    await Promise.resolve();
  };

  return { queue, advance, pendingTimers: () => timers.length };
}

describe('coalescing a burst of catalog changes', () => {
  it('rebuilds once for four hundred webhooks', async () => {
    /**
     * The whole reason this is a queue. Four hundred rebuilds would be hundreds
     * of embedding calls to reach exactly the index one rebuild produces.
     */
    const refreshed: string[] = [];
    const { queue, advance } = queueWithFakeTime(async (shop) => {
      refreshed.push(shop);
    });

    for (let i = 0; i < 400; i++) queue.touch('acme.myshopify.com');
    expect(refreshed).toEqual([]);

    await advance(1000);
    expect(refreshed).toEqual(['acme.myshopify.com']);
  });

  it('waits for the burst to stop rather than firing on the first change', async () => {
    const refreshed: string[] = [];
    const { queue, advance } = queueWithFakeTime(async (shop) => {
      refreshed.push(shop);
    });

    queue.touch('acme.myshopify.com');
    await advance(600);
    expect(refreshed).toEqual([]);
    // Another change extends the window.
    queue.touch('acme.myshopify.com');
    await advance(600);
    expect(refreshed).toEqual([]);
    await advance(400);
    expect(refreshed).toEqual(['acme.myshopify.com']);
  });

  it('refuses to be deferred forever by a steady stream of edits', async () => {
    /**
     * A merchant working through their catalog for an hour would extend the
     * timer for the whole hour, and the index would never refresh at all — the
     * exact failure the debounce was meant to prevent, arrived at from the other
     * direction.
     */
    const refreshed: string[] = [];
    const { queue, advance } = queueWithFakeTime(
      async (shop) => {
        refreshed.push(shop);
      },
      { maxWaitMs: 3000 },
    );

    queue.touch('acme.myshopify.com');
    for (let elapsed = 0; elapsed < 5000; elapsed += 500) {
      await advance(500);
      queue.touch('acme.myshopify.com');
    }
    expect(refreshed.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps one merchant’s import from delaying another’s price edit', async () => {
    // Per shop, not global.
    const refreshed: string[] = [];
    const { queue, advance } = queueWithFakeTime(async (shop) => {
      refreshed.push(shop);
    });

    for (let i = 0; i < 50; i++) queue.touch('bulk.myshopify.com');
    queue.touch('small.myshopify.com');
    await advance(1000);
    expect(refreshed.sort()).toEqual(['bulk.myshopify.com', 'small.myshopify.com']);
  });

  it('queues another rebuild when the catalog changes mid-rebuild', async () => {
    // Otherwise the index is quietly one version behind and nothing says so.
    let release!: () => void;
    const started: number[] = [];
    const { queue, advance } = queueWithFakeTime(async () => {
      started.push(1);
      if (started.length === 1) await new Promise<void>((r) => (release = r));
    });

    queue.touch('acme.myshopify.com');
    await advance(1000);
    expect(started).toHaveLength(1);

    queue.touch('acme.myshopify.com'); // arrives during the rebuild
    release();
    /**
     * Two advances, and the reason is the harness rather than the queue.
     *
     * `advance` collects due timers synchronously, so the first call lets the
     * settled refresh run its `finally` — which is where the deferred change
     * schedules the next rebuild — and the second call is what makes that new
     * timer due.
     */
    await advance(0);
    await advance(1000);
    expect(started).toHaveLength(2);
  });

  it('survives a refresh that throws', async () => {
    /**
     * This runs detached, so an unhandled rejection would take the process down
     * over a stale index. The next change retries, and the six-hour TTL is still
     * underneath.
     */
    const warns: string[] = [];
    const { queue, advance } = queueWithFakeTime(async () => {
      throw new Error('embeddings 429');
    });
    // Replace the log so the failure is observable.
    const loud = new CatalogRefreshQueue({
      refresh: async () => {
        throw new Error('embeddings 429');
      },
      debounceMs: 0,
      log: { info: () => {}, warn: (e) => warns.push(e) },
    });
    loud.touch('acme.myshopify.com');
    await loud.drain();
    expect(warns).toContain('catalog_refresh_failed');

    queue.touch('acme.myshopify.com');
    await expect(advance(1000)).resolves.toBeUndefined();
  });

  it('runs everything pending on shutdown', async () => {
    // A queue that drops a rebuild on deploy leaves the index stale until the
    // TTL, which is the thing this exists to avoid.
    const refreshed: string[] = [];
    const queue = new CatalogRefreshQueue({
      refresh: async (shop) => {
        refreshed.push(shop);
      },
      debounceMs: 60_000,
    });
    queue.touch('a.myshopify.com');
    queue.touch('b.myshopify.com');
    expect(queue.pending()).toBe(2);
    await queue.drain();
    expect(refreshed.sort()).toEqual(['a.myshopify.com', 'b.myshopify.com']);
    queue.stop();
  });

  it('accepts nothing after stopping', async () => {
    const refreshed: string[] = [];
    const queue = new CatalogRefreshQueue({
      refresh: async (shop) => {
        refreshed.push(shop);
      },
      debounceMs: 0,
    });
    queue.stop();
    queue.touch('a.myshopify.com');
    await queue.drain();
    expect(refreshed).toEqual([]);
  });
});

describe('the webhook that triggers it', () => {
  const SECRET = 'shpss_test_secret';
  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('base64');

  async function deliver(topic: string, onCatalogChange?: (shop: string, topic: string) => void) {
    const body = JSON.stringify({ id: 123 });
    return handleWebhook(
      {
        topic,
        shopHeader: 'acme.myshopify.com',
        hmacHeader: sign(body),
        rawBody: Buffer.from(body),
      },
      {
        apiSecret: SECRET,
        shops: new MemoryShopStore(),
        ...(onCatalogChange === undefined ? {} : { onCatalogChange }),
      },
    );
  }

  it('recognises every catalog topic', async () => {
    for (const topic of CATALOG_TOPICS) {
      const seen: string[] = [];
      const out = await deliver(topic, (_shop, t) => seen.push(t));
      expect(out.status, topic).toBe(200);
      expect(seen, topic).toEqual([topic]);
    }
  });

  it('acknowledges immediately rather than waiting for the rebuild', async () => {
    /**
     * Shopify expects a webhook acknowledged in seconds and re-embedding takes
     * longer than that. A slow 200 becomes a retry, and a retried topic
     * eventually has its subscription disabled — so the handler must not be
     * able to await the work.
     */
    let resolved = false;
    const out = await deliver('products/update', () => {
      // A synchronous callback: there is no promise here for the handler to
      // await even if someone later tried to.
      setTimeout(() => {
        resolved = true;
      }, 50);
    });
    expect(out.status).toBe(200);
    expect(resolved).toBe(false);
  });

  it('still verifies the signature', async () => {
    // An unverified webhook endpoint is an unauthenticated write endpoint, and
    // this one triggers spending on embeddings.
    const body = JSON.stringify({ id: 1 });
    const out = await handleWebhook(
      {
        topic: 'products/update',
        shopHeader: 'acme.myshopify.com',
        hmacHeader: 'not-the-signature',
        rawBody: Buffer.from(body),
      },
      { apiSecret: SECRET, shops: new MemoryShopStore(), onCatalogChange: () => {} },
    );
    expect(out.status).toBe(401);
  });

  it('leaves an unknown topic alone', async () => {
    const seen: string[] = [];
    const out = await deliver('themes/publish', (_s, t) => seen.push(t));
    expect(out.status).toBe(200);
    expect(seen).toEqual([]);
  });

  it('is registered at install time', () => {
    for (const topic of CATALOG_TOPICS) expect(REQUIRED_TOPICS).toContain(topic);
  });

  it('knows which topics are catalog topics', () => {
    expect(isCatalogTopic('products/update')).toBe(true);
    expect(isCatalogTopic('collections/update')).toBe(true);
    expect(isCatalogTopic('orders/create')).toBe(false);
    expect(isCatalogTopic('app/uninstalled')).toBe(false);
  });
});

describe('refreshCatalogIndex', () => {
  it('asks for one bounded page and builds from it', async () => {
    // 250 in one call is the most expensive request we make against a
    // complexity-budgeted endpoint; the limit is a decision with a cost.
    const asked: unknown[] = [];
    const built: { shop: string; count: number }[] = [];
    const count = await refreshCatalogIndex(
      'acme.myshopify.com',
      {
        searchCatalog: async (input) => {
          asked.push(input);
          return { products: [{ title: 'A' }, { title: 'B' }] };
        },
      },
      {
        build: async (shop: string, products: readonly unknown[]) => {
          built.push({ shop, count: products.length });
        },
      } as unknown as CatalogIndex,
    );

    expect(asked).toEqual([{ query: '', pagination: { limit: 100 } }]);
    expect(built).toEqual([{ shop: 'acme.myshopify.com', count: 2 }]);
    expect(count).toBe(2);
  });

  it('builds an empty index rather than throwing on an empty catalog', async () => {
    const built: number[] = [];
    const count = await refreshCatalogIndex(
      'acme.myshopify.com',
      { searchCatalog: async () => ({}) },
      { build: async (_s: string, p: readonly unknown[]) => void built.push(p.length) } as unknown as CatalogIndex,
    );
    expect(count).toBe(0);
    expect(built).toEqual([0]);
  });

  it('lets a fetch failure propagate to the caller that can log it', async () => {
    await expect(
      refreshCatalogIndex(
        'acme.myshopify.com',
        {
          searchCatalog: async () => {
            throw new Error('ucp 503');
          },
        },
        { build: vi.fn() } as unknown as CatalogIndex,
      ),
    ).rejects.toThrow(/ucp 503/);
  });
});
