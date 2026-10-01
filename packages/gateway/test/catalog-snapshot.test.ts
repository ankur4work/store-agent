import { describe, expect, it } from 'vitest';
import { CatalogSnapshot } from '../src/search/catalog-snapshot.js';

/**
 * The browse that stopped happening on every turn.
 *
 * Resolving the product a shopper is standing on meant downloading all 23
 * products — 170 KB — once per turn, per shopper, because the store offers no way
 * to fetch one by id. Measured at 203-1088 ms, which was half of the ~450 ms the
 * page-fact lane spent before its sentence existed.
 *
 * The risk this carries is that it caches **prices**, so the tests that matter
 * most here are the ones about letting go of them: the TTL, the webhook
 * invalidation, and never remembering a failed browse as a shop's catalog.
 */

describe('reusing one catalog browse', () => {
  it('browses once and reuses it within the window', async () => {
    let calls = 0;
    const snap = new CatalogSnapshot({ ttlMs: 1000, now: () => 0 });
    const browse = () => {
      calls++;
      return Promise.resolve([{ id: 'p1' }]);
    };

    expect(await snap.products('a.myshopify.com', browse)).toEqual([{ id: 'p1' }]);
    expect(await snap.products('a.myshopify.com', browse)).toEqual([{ id: 'p1' }]);
    expect(calls).toBe(1);
    expect(snap.stats.reuses).toBe(1);
  });

  it('browses again once the window has passed', async () => {
    let now = 0;
    let calls = 0;
    const snap = new CatalogSnapshot({ ttlMs: 1000, now: () => now });
    const browse = () => {
      calls++;
      return Promise.resolve([{ id: `p${calls}` }]);
    };

    await snap.products('a.myshopify.com', browse);
    now = 1001;
    // A price may not be quoted from an arbitrarily old read. The window is the
    // whole safety argument, so it has to actually expire.
    expect(await snap.products('a.myshopify.com', browse)).toEqual([{ id: 'p2' }]);
    expect(calls).toBe(2);
  });

  it('keeps each shop separate', async () => {
    const snap = new CatalogSnapshot({ now: () => 0 });
    await snap.products('a.myshopify.com', () => Promise.resolve([{ id: 'a' }]));
    // One merchant's assistant answering out of another's catalog is the exact
    // failure `ucpFor` exists to prevent; a shared cache must not reintroduce it.
    expect(await snap.products('b.myshopify.com', () => Promise.resolve([{ id: 'b' }]))).toEqual([
      { id: 'b' },
    ]);
    expect(await snap.products('a.myshopify.com', () => Promise.resolve([{ id: 'wrong' }]))).toEqual([
      { id: 'a' },
    ]);
  });

  it('collapses concurrent turns into a single browse', async () => {
    let calls = 0;
    let release: (v: readonly unknown[]) => void = () => {};
    const snap = new CatalogSnapshot({ now: () => 0 });
    const browse = () => {
      calls++;
      return new Promise<readonly unknown[]>((r) => {
        release = r;
      });
    };

    /**
     * Without storing the promise before it settles, the first shopper after an
     * expiry and everyone arriving behind them each start their own 170 KB
     * download — the stampede is the common case, not the rare one, because a
     * product page's visitors all ask about the same product.
     */
    const a = snap.products('a.myshopify.com', browse);
    const b = snap.products('a.myshopify.com', browse);
    expect(calls).toBe(1);
    release([{ id: 'p1' }]);
    expect(await a).toEqual([{ id: 'p1' }]);
    expect(await b).toEqual([{ id: 'p1' }]);
  });

  it('forgets a failed browse rather than caching the failure', async () => {
    let calls = 0;
    const snap = new CatalogSnapshot({ ttlMs: 60_000, now: () => 0 });
    const browse = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('storefront 503')) : Promise.resolve([{ id: 'p1' }]);
    };

    await expect(snap.products('a.myshopify.com', browse)).rejects.toThrow('storefront 503');
    // A cached rejection would make one bad second look like an empty catalog for
    // the whole window — and an empty catalog is answered as "we don't stock it".
    expect(await snap.products('a.myshopify.com', browse)).toEqual([{ id: 'p1' }]);
    expect(calls).toBe(2);
  });

  it('drops a shop the moment its catalog changes', async () => {
    let calls = 0;
    const snap = new CatalogSnapshot({ ttlMs: 60_000, now: () => 0 });
    const browse = () => {
      calls++;
      return Promise.resolve([{ id: `p${calls}` }]);
    };

    await snap.products('a.myshopify.com', browse);
    /**
     * This is what makes the TTL a ceiling on staleness rather than a floor on how
     * long a corrected price stays wrong. Called from the `catalog_changed`
     * webhook, and deliberately not on the index's 30 s debounce.
     */
    snap.invalidate('a.myshopify.com');
    expect(await snap.products('a.myshopify.com', browse)).toEqual([{ id: 'p2' }]);
  });

  it('does not hold a catalog per shop forever', async () => {
    /**
     * Entries were only ever replaced or invalidated, never dropped for being old.
     * One ~170 KB catalog per shop therefore accumulated for the life of the
     * process — nothing on a dev store with two installs, and a leak proportional
     * to install count on a public app.
     */
    let now = 0;
    const snap = new CatalogSnapshot({ ttlMs: 1000, now: () => now });
    for (let i = 0; i < 40; i++) {
      await snap.products(`shop-${i}.myshopify.com`, () => Promise.resolve([{ id: i }]));
      now += 100; // each arrives 100ms apart, so early ones age out
    }
    // Only the shops still inside the window are held.
    expect(snap.size).toBeLessThanOrEqual(10);
  });

  it('bounds itself even when every shop is active at once', async () => {
    // The pathological case the TTL alone does not cover: more shops busy inside
    // one window than we are willing to hold.
    const snap = new CatalogSnapshot({ ttlMs: 60_000, now: () => 0 });
    for (let i = 0; i < 200; i++) {
      await snap.products(`shop-${i}.myshopify.com`, () => Promise.resolve([{ id: i }]));
    }
    expect(snap.size).toBeLessThanOrEqual(64);
  });

  it('shrugs off invalidating a shop it has never seen', () => {
    // Webhooks arrive for shops this process has not served a turn for.
    const snap = new CatalogSnapshot();
    expect(() => snap.invalidate('never.myshopify.com')).not.toThrow();
  });
});
