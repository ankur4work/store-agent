import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { renderTurnContext } from '@storeagent/orchestrator';

/**
 * What the assistant knows about the page the shopper is standing on.
 *
 * ## What this replaced
 *
 * ```js
 * if (/\/products\//.test(p)) return { type: 'product', title: document.title };
 * ```
 *
 * A URL pattern and a browser tab caption. On Shopify that caption is "The
 * Complete Snowboard – test ankur", so the shop's own name was being fed into
 * product searches as part of what the shopper wanted. The `productId` field the
 * server has always accepted was never once populated.
 *
 * Shopify publishes all of it — `ShopifyAnalytics.meta` carries the page type,
 * the resource id, the product and its variants; `?variant=` names the one
 * actually selected. None of it was read.
 *
 * ## Executed, not read
 *
 * The reader is extracted from the widget and run against hand-built page
 * doubles, because the thing worth testing is what it does with a real theme's
 * metadata — and themes differ wildly, which is the whole reason it has layers.
 */

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/widget.js'),
  'utf8',
).replace(/\r\n/g, '\n');

function extractFn(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  expect(at, `function ${name} not found`).toBeGreaterThan(-1);
  const open = SRC.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

interface PageDouble {
  path?: string;
  search?: string;
  title?: string;
  analytics?: unknown;
  ogTitle?: string;
  jsonLd?: unknown;
}

/** Run the widget's own detectPage against a fabricated page. */
function detectPage(page: PageDouble): Record<string, unknown> {
  const nodes: { getAttribute?: unknown; content?: string; textContent?: string }[] = [];
  if (page.ogTitle !== undefined) nodes.push({ content: page.ogTitle });

  const ldNodes = page.jsonLd === undefined ? [] : [{ textContent: JSON.stringify(page.jsonLd) }];

  const ctx: Record<string, unknown> = {
    URLSearchParams,
    JSON,
    decodeURIComponent,
    location: { pathname: page.path ?? '/', search: page.search ?? '' },
    document: {
      title: page.title ?? '',
      querySelector: (sel: string) => (sel.includes('og:title') ? nodes[0] ?? null : null),
      querySelectorAll: () => ldNodes,
    },
    window: page.analytics === undefined ? {} : { ShopifyAnalytics: { meta: page.analytics } },
    out: {},
  };
  vm.createContext(ctx);
  const fns = ['detectPage', 'normalisePageType', 'pageTypeFromPath', 'handleFromPath', 'urlParam', 'cleanTitle'];
  vm.runInContext(`${fns.map(extractFn).join('\n')}\nout = detectPage();`, ctx);
  return ctx['out'] as Record<string, unknown>;
}

const PRODUCT_META = {
  page: { pageType: 'product', resourceType: 'product', resourceId: 8944748757044 },
  product: {
    id: 8944748757044,
    variants: [
      { id: 47747727786356, name: 'Ice' },
      { id: 47747727819124, name: 'Dawn' },
    ],
  },
};

describe('reading a product page', () => {
  it('names the product and its id, from Shopify metadata', () => {
    const p = detectPage({
      path: '/products/the-complete-snowboard',
      title: 'The Complete Snowboard – test ankur',
      analytics: PRODUCT_META,
      ogTitle: 'The Complete Snowboard',
    });
    expect(p['type']).toBe('product');
    expect(p['productId']).toBe('8944748757044');
    expect(p['handle']).toBe('the-complete-snowboard');
  });

  it('uses the product name, NOT the browser tab caption', () => {
    /**
     * The defect this fixes. "The Complete Snowboard – test ankur" fed the shop's
     * own name into the search query, so a refinement searched for a product that
     * does not exist.
     */
    const p = detectPage({
      path: '/products/the-complete-snowboard',
      title: 'The Complete Snowboard – test ankur',
      analytics: PRODUCT_META,
      ogTitle: 'The Complete Snowboard',
    });
    expect(p['title']).toBe('The Complete Snowboard');
    expect(String(p['title'])).not.toContain('test ankur');
  });

  it('identifies the variant the shopper actually selected', () => {
    // The whole question behind "does this come in my size" and "how much is it".
    const p = detectPage({
      path: '/products/the-complete-snowboard',
      search: '?variant=47747727819124',
      analytics: PRODUCT_META,
      ogTitle: 'The Complete Snowboard',
    });
    expect(p['variantId']).toBe('47747727819124');
    expect(p['variantName']).toBe('Dawn');
  });

  it('names the only variant when a product has just one', () => {
    const p = detectPage({
      path: '/products/single',
      analytics: {
        page: { pageType: 'product' },
        product: { id: 1, variants: [{ id: 9, name: 'Default Title' }] },
      },
    });
    expect(p['variantName']).toBe('Default Title');
  });

  it('falls back to JSON-LD for the name when there is no og:title', () => {
    const p = detectPage({
      path: '/products/x',
      title: 'X – shop',
      analytics: PRODUCT_META,
      jsonLd: { '@type': 'Product', name: 'Merino Wool Overcoat' },
    });
    expect(p['title']).toBe('Merino Wool Overcoat');
  });

  it('reads JSON-LD inside an @graph, which is how many themes emit it', () => {
    const p = detectPage({
      path: '/products/x',
      analytics: PRODUCT_META,
      jsonLd: { '@graph': [{ '@type': 'WebSite' }, { '@type': 'Product', name: 'Cashmere Scarf' }] },
    });
    expect(p['title']).toBe('Cashmere Scarf');
  });
});

describe('trusting Shopify over the URL', () => {
  it('uses the declared page type, which survives a markets prefix', () => {
    // /en-gb/products/... does not match a naive /products/ check on every theme,
    // and a translated storefront may not contain the word "products" at all.
    const p = detectPage({
      path: '/en-gb/produkte/schneebrett',
      analytics: { page: { pageType: 'product', resourceType: 'product', resourceId: 7 } },
    });
    expect(p['type']).toBe('product');
    expect(p['productId']).toBe('7');
  });

  it('falls back to the path when Shopify metadata is absent', () => {
    // An older theme, or a merchant who has stripped the analytics object.
    for (const [path, type] of [
      ['/products/x', 'product'],
      ['/collections/all', 'collection'],
      ['/cart', 'cart'],
      ['/pages/about', 'other'],
    ] as const) {
      expect(detectPage({ path }).type, path).toBe(type);
    }
  });

  it('reports a collection with its id', () => {
    const p = detectPage({
      path: '/collections/outerwear',
      analytics: { page: { pageType: 'collection', resourceType: 'collection', resourceId: 42 } },
      ogTitle: 'Outerwear',
    });
    expect(p['type']).toBe('collection');
    expect(p['collectionId']).toBe('42');
    expect(p['handle']).toBe('outerwear');
  });

  it('never throws on a storefront that makes no sense', () => {
    // We do not control these pages, and a page-metadata problem must not cost
    // the shopper their turn.
    expect(() => detectPage({ path: '/products/x', analytics: { page: null } })).not.toThrow();
    expect(() => detectPage({ path: '/products/x', jsonLd: 'not an object' })).not.toThrow();
    expect(() => detectPage({})).not.toThrow();
  });
});

describe('what is deliberately not sent', () => {
  it('sends no price and no availability', () => {
    /**
     * Both are on the page and it would be easy. It would also be wrong: this
     * object comes from the shopper's browser, so treating it as fact would let a
     * modified page put a price in the assistant's mouth — exactly what the
     * grounding layer exists to prevent.
     *
     * Identity is sent; facts come from the catalog.
     */
    const p = detectPage({
      path: '/products/x',
      analytics: {
        page: { pageType: 'product', resourceType: 'product', resourceId: 1 },
        product: { id: 1, variants: [{ id: 2, name: 'Ice', price: 69995 }] },
      },
    });
    expect(Object.keys(p).sort()).toEqual(
      ['handle', 'productId', 'title', 'type', 'variantName'].sort(),
    );
    expect(JSON.stringify(p)).not.toContain('69995');
  });
});

describe('what the model is told', () => {
  it('states which product "this" refers to', () => {
    /**
     * Without saying it, the model has to infer that "this" means the product in
     * the context block, and it does not reliably do so when the shopper's
     * sentence mentions anything else.
     */
    const block = renderTurnContext({
      sessionId: 's',
      page: { type: 'product', title: 'The Complete Snowboard', productId: '123', variantName: 'Ice' },
    });
    expect(block).toContain('The Complete Snowboard');
    expect(block).toContain('with Ice selected');
    expect(block).toMatch(/"this", "it" and "these" mean THAT product/);
  });

  it('gives the id for tools and forbids reading it aloud', () => {
    const block = renderTurnContext({
      sessionId: 's',
      page: { type: 'product', productId: '123', variantId: '456' },
    });
    expect(block).toContain('123');
    expect(block).toContain('456');
    expect(block).toMatch(/never read an id aloud/);
  });

  it('describes a collection as a collection', () => {
    const block = renderTurnContext({ sessionId: 's', page: { type: 'collection', title: 'Outerwear' } });
    expect(block).toContain('Outerwear');
    expect(block).toMatch(/"these" means things in it/);
  });

  it('says nothing about a page it knows nothing about', () => {
    expect(renderTurnContext({ sessionId: 's', page: { type: 'other' } })).toBe('');
  });
});
