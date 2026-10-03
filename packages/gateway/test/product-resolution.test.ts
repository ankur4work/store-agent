import { describe, expect, it } from 'vitest';
import { createToolExecutor } from '../src/tool-executor.js';
import { newSession } from '../src/sessions.js';

/**
 * Resolving the product a shopper is standing on, in a catalog bigger than one
 * browse page.
 *
 * ## The defect
 *
 * The store offers no working single-product fetch — `get_product` and
 * `lookup_catalog` both answer "Invalid params" to every shape we can construct —
 * so the id on the page is resolved by browsing the catalog and matching. That
 * browse asks for 100 products. A shopper on product #250 of a 300-product store
 * was therefore unresolvable: the page-fact lane declined and the model answered.
 *
 * Safe, and invisible on a dev store with 27 products. On a real one it meant the
 * ~300 ms path never fired for most of the catalog — the lane was built for a
 * store small enough not to need it.
 *
 * ## The safety property these tests are mostly about
 *
 * This lane quotes a price with no model in the loop, so a near miss is not a
 * worse answer, it is a confident wrong one: another product's price, in 300 ms,
 * in the merchant's voice. A keyword search for "One Piece Swimsuit" returns nine
 * other swimsuits. So the search only ever *locates* a product whose identity is
 * already known — the id from the page, or the handle from its URL. Anything else
 * must decline and let the model answer.
 */
describe('resolving a product past the first browse page', () => {
  const SHOP = 'acme.myshopify.com';

  /** The real store's shape: 300 products, paged, and no working get_product. */
  function store(opts: {
    /** Products the bare browse returns — the first page only. */
    firstPage: unknown[];
    /** What a keyword search returns for a given query. */
    search?: (query: string) => unknown[];
  }) {
    const calls: { tool: string; query?: string }[] = [];
    const ucp = {
      getProduct: async () => {
        // Every real call to this on the dev store fails this way.
        throw new Error('Invalid params');
      },
      searchCatalog: async (input: { query: string }) => {
        calls.push({ tool: 'search_catalog', query: input.query });
        return {
          products: input.query === '' ? opts.firstPage : (opts.search?.(input.query) ?? []),
        };
      },
    };
    return { ucp, calls };
  }

  function executorFor(ucp: unknown) {
    return createToolExecutor({
      session: newSession('s1', SHOP),
      ucp: ucp as never,
      // The breaker has already learned this store's get_product does not work,
      // which is the state every turn after the first one runs in.
      productLookup: { allow: () => false, succeed: () => {}, fail: () => {} },
    });
  }

  const PRODUCT_250 = {
    id: 'gid://shopify/Product/15398200377396',
    handle: 'cupshe-one-piece-swimsuit-plunging-neck',
    title: "CUPSHE Women's One Piece Swimsuit",
  };

  it('finds a product the one-page browse cannot reach', async () => {
    const { ucp, calls } = store({
      firstPage: [{ id: 'gid://shopify/Product/1', title: 'Something else' }],
      search: () => [PRODUCT_250],
    });

    const result = (await executorFor(ucp).execute('get_product', {
      id: PRODUCT_250.id,
      title: PRODUCT_250.title,
      handle: PRODUCT_250.handle,
    })) as { product?: { id?: string }; error?: unknown };

    expect(result.error).toBeUndefined();
    expect(result.product?.id).toBe(PRODUCT_250.id);
    // The browse first, then one targeted search. Not a walk of the catalog.
    expect(calls).toEqual([
      { tool: 'search_catalog', query: '' },
      { tool: 'search_catalog', query: PRODUCT_250.title },
    ]);
  });

  it('matches the bare id the page reports against the catalog gid', async () => {
    // A storefront reports `ShopifyAnalytics.meta.page.resourceId` — a bare
    // number — while the catalog returns a gid. That mismatch is why this lane
    // silently declined once before.
    const { ucp } = store({ firstPage: [], search: () => [PRODUCT_250] });
    const result = (await executorFor(ucp).execute('get_product', {
      id: '15398200377396',
      title: PRODUCT_250.title,
    })) as { product?: { id?: string }; error?: unknown };
    expect(result.product?.id).toBe(PRODUCT_250.id);
  });

  it('falls back to the handle from the URL when the ids disagree', async () => {
    // The page can report a variant id, or a theme can report something odd.
    // The handle is in the shopper's address bar and is unique per store, so it
    // identifies the product as well as the id does.
    const { ucp } = store({ firstPage: [], search: () => [PRODUCT_250] });
    const result = (await executorFor(ucp).execute('get_product', {
      id: 'gid://shopify/Product/99999999',
      title: PRODUCT_250.title,
      handle: PRODUCT_250.handle,
    })) as { product?: { id?: string }; error?: unknown };
    expect(result.product?.id).toBe(PRODUCT_250.id);
  });

  it('refuses a product that merely has a similar name', async () => {
    /**
     * The test this whole tier is built around. A search for a swimsuit returns
     * other swimsuits; taking the first would quote the wrong price with total
     * confidence and no model to temper it. Neither id nor handle matches here,
     * so the only acceptable outcome is the decline.
     */
    const { ucp } = store({
      firstPage: [],
      search: () => [
        { id: 'gid://shopify/Product/111', handle: 'heekpek-v-neck', title: 'One Piece Swimsuit' },
        { id: 'gid://shopify/Product/222', handle: 'other-swimsuit', title: 'One Piece Swimsuit' },
      ],
    });

    const result = (await executorFor(ucp).execute('get_product', {
      id: PRODUCT_250.id,
      title: PRODUCT_250.title,
      handle: PRODUCT_250.handle,
    })) as { product?: unknown; error?: unknown; message?: string };

    expect(result.product).toBeUndefined();
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/Could not resolve product/);
  });

  it('does not pay for a search when the browse already had it', async () => {
    // Most stores are small and most products are on the first page. The cached
    // browse must stay the fast path; this tier is for when it misses.
    const { ucp, calls } = store({ firstPage: [PRODUCT_250], search: () => [PRODUCT_250] });

    const result = (await executorFor(ucp).execute('get_product', {
      id: PRODUCT_250.id,
      title: PRODUCT_250.title,
    })) as { product?: { id?: string } };

    expect(result.product?.id).toBe(PRODUCT_250.id);
    expect(calls).toEqual([{ tool: 'search_catalog', query: '' }]);
  });

  it('declines without searching when the page never named the product', async () => {
    // No title means no query worth making. A blank search is the browse that
    // already missed.
    const { ucp, calls } = store({ firstPage: [], search: () => [PRODUCT_250] });

    const result = (await executorFor(ucp).execute('get_product', {
      id: PRODUCT_250.id,
    })) as { error?: unknown };

    expect(result.error).toBe(true);
    expect(calls).toEqual([{ tool: 'search_catalog', query: '' }]);
  });

  it('declines honestly when the targeted search itself fails', async () => {
    // A search that failed says nothing about whether the product exists, and
    // the caller already has an honest decline to fall back on.
    const ucp = {
      getProduct: async () => {
        throw new Error('Invalid params');
      },
      searchCatalog: async (input: { query: string }) => {
        if (input.query === '') return { products: [] };
        throw new Error('ucp 503');
      },
    };

    const result = (await executorFor(ucp).execute('get_product', {
      id: PRODUCT_250.id,
      title: PRODUCT_250.title,
    })) as { error?: unknown; message?: string };

    expect(result.error).toBe(true);
    expect(result.message).toMatch(/Could not resolve product/);
  });

  it('still carries the price summary a resolved product needs', async () => {
    // The resolution tier returns through withDisplayPrices like every other
    // path, so a product found this way is quotable without arithmetic.
    const { ucp } = store({
      firstPage: [],
      search: () => [
        {
          ...PRODUCT_250,
          variants: [{ price: { amount: 3359, currency: 'USD' } }, { price: { amount: 5299, currency: 'USD' } }],
        },
      ],
    });

    const result = (await executorFor(ucp).execute('get_product', {
      id: PRODUCT_250.id,
      title: PRODUCT_250.title,
    })) as { product?: { price_display?: string } };

    expect(result.product?.price_display).toBe('$33.59 – $52.99');
  });
});
