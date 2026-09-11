import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/store/sqlite.js';
import { CatalogIndex, MIN_SCORE } from '../src/search/catalog-index.js';
import { SqliteVectorStore } from '../src/search/sqlite-vectors.js';
import { EMBEDDING_DIMS, blobToVector, cosine, embed, vectorToBlob } from '../src/search/embeddings.js';
import { productText } from '../src/search/product-text.js';
import { describeAll, primaryImage } from '../src/search/vision.js';

/**
 * Keyword search answers "which product contains these words". A shopper
 * asks for "open-toe shoes" or "a black bag with a gold chain" — the word
 * overlap with the catalog is zero and the search returns nothing, in a
 * shop full of matching things.
 */

/** A unit vector pointing mostly along one axis, for predictable geometry. */
function axis(i: number, dims = EMBEDDING_DIMS): Float32Array {
  const v = new Float32Array(dims);
  v[i % dims] = 1;
  return v;
}

function fakeEmbedder(byText: Record<string, Float32Array>) {
  return (async (_url: unknown, init: { body: string }) => {
    const input = (JSON.parse(init.body) as { input: string[] }).input;
    return new Response(
      JSON.stringify({
        data: input.map((text, index) => ({
          index,
          embedding: Array.from(byText[text] ?? axis(999)),
        })),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function memoryCache() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k), put: (k: string, v: string) => void m.set(k, v) };
}

/** The stored indexed text for a shop's single product. */
function openDatabaseRow(store: SqliteVectorStore, shop: string): string | undefined {
  return (store as unknown as { db: { prepare(q: string): { get(s: string): { text?: string } | undefined } } }).db
    .prepare('SELECT text FROM catalog_vectors WHERE shop = ?')
    .get(shop)?.text;
}

describe('what a product looks like to the index', () => {
  /**
   * The highest-leverage decision in semantic search is what text goes in.
   * A vector of the title alone cannot match "open-toe", because the answer
   * lives in the description, the tags and the option values — which is
   * exactly what read_products gives us.
   */
  it('includes the words a shopper describes, not just the title', () => {
    const text = productText({
      id: 'p1',
      title: 'Riviera Sandal',
      product_type: 'Shoes',
      tags: ['open toe', 'summer'],
      options: [{ name: 'Colour', values: [{ label: 'Tan' }, { label: 'Black' }] }],
      description: { html: '<p>An <b>open-toe</b> slingback with a block heel.</p>' },
    });
    expect(text).toContain('open toe');
    expect(text).toContain('Colour: Tan, Black');
    expect(text).toContain('Shoes');
    expect(text).toContain('open-toe slingback');
    expect(text).not.toContain('<b>');
  });

  it('repeats the title, so a long description cannot drown the name', () => {
    const text = productText({ id: 'p', title: 'Hydrogen', description: 'x '.repeat(400) });
    expect(text.indexOf('Hydrogen')).toBeLessThan(text.indexOf('x x'));
    expect((text.match(/Hydrogen/g) ?? []).length).toBe(2);
  });

  it('skips the Default Title variant, which carries no meaning', () => {
    const text = productText({ id: 'p', title: 'Board', variants: [{ title: 'Default Title' }] });
    expect(text).not.toContain('Default Title');
  });
});

describe('vector storage', () => {
  it('round-trips a vector through a blob without losing precision', () => {
    const v = Float32Array.from([0.5, -0.25, 0.125, 0]);
    expect(Array.from(blobToVector(vectorToBlob(v)))).toEqual([0.5, -0.25, 0.125, 0]);
  });

  it('replaces a shop index atomically', () => {
    const store = new SqliteVectorStore(openDatabase({ path: ':memory:' }));
    store.replace('a.myshopify.com', [{ productId: 'p1', text: 't', vector: axis(1) }]);
    store.replace('a.myshopify.com', [{ productId: 'p2', text: 't', vector: axis(2) }]);
    // A rebuild must not leave the previous catalog behind.
    expect(store.all('a.myshopify.com').map((r) => r.productId)).toEqual(['p2']);
  });

  it('keeps shops apart', () => {
    const store = new SqliteVectorStore(openDatabase({ path: ':memory:' }));
    store.replace('a.myshopify.com', [{ productId: 'p1', text: 't', vector: axis(1) }]);
    store.replace('b.myshopify.com', [{ productId: 'p2', text: 't', vector: axis(2) }]);
    expect(store.count('a.myshopify.com')).toBe(1);
    expect(store.all('b.myshopify.com')[0]!.productId).toBe('p2');
  });

  it('purges the index with the shop, because it is derived data', () => {
    const store = new SqliteVectorStore(openDatabase({ path: ':memory:' }));
    store.replace('a.myshopify.com', [{ productId: 'p1', text: 't', vector: axis(1) }]);
    store.purge('a.myshopify.com');
    expect(store.count('a.myshopify.com')).toBe(0);
    expect(store.builtAt('a.myshopify.com')).toBeUndefined();
  });
});

describe('similarity', () => {
  it('scores identical meaning at 1 and orthogonal at 0', () => {
    expect(cosine(axis(3), axis(3))).toBeCloseTo(1, 5);
    expect(cosine(axis(3), axis(4))).toBeCloseTo(0, 5);
  });

  it('returns 0 rather than NaN for an empty vector', () => {
    // A product with no text must rank last, not poison the sort.
    expect(cosine(new Float32Array(8), axis(1))).toBe(0);
  });
});

/**
 * Text search finds only what a merchant typed, and they type "Riviera
 * Sandal" — not "open toe, ankle strap, tan leather". The words a shopper
 * uses are in the photograph.
 */
describe('reading the product photo', () => {
  const withImage = { id: 'p1', title: 'Riviera Sandal', media: [{ url: 'https://cdn/x.jpg?v=1' }] };

  function visionStub(text: string) {
    const calls: string[] = [];
    const doFetch = (async (_u: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: { content: { image_url?: { url: string } }[] }[] };
      const img = body.messages[0]!.content.find((c) => c.image_url)?.image_url?.url ?? '';
      calls.push(img);
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { doFetch, calls };
  }

  it('describes an image as the vocabulary a shopper would search', async () => {
    const { doFetch } = visionStub('tan leather, open toe, ankle strap, block heel');
    const out = await describeAll([primaryImage(withImage)], memoryCache(), { apiKey: 'k', doFetch });
    expect(out.get('https://cdn/x.jpg?v=1')).toContain('open toe');
  });

  it('reads each photo once, however often the catalog is rebuilt', async () => {
    const cache = memoryCache();
    const { doFetch, calls } = visionStub('tan leather, open toe');
    await describeAll(['https://cdn/x.jpg?v=1'], cache, { apiKey: 'k', doFetch });
    await describeAll(['https://cdn/x.jpg?v=1'], cache, { apiKey: 'k', doFetch });
    expect(calls).toHaveLength(1);
  });

  it('caches an unreadable image too, rather than paying for it every rebuild', async () => {
    const cache = memoryCache();
    const doFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await describeAll(['https://cdn/bad.jpg'], cache, { apiKey: 'k', doFetch });
    expect(cache.get('https://cdn/bad.jpg')).toBe('');
  });

  it('indexes the appearance alongside the merchant text, never instead of it', async () => {
    const store = new SqliteVectorStore(openDatabase({ path: ':memory:' }));
    const vision = visionStub('tan leather, open toe, ankle strap');
    const index = new CatalogIndex({
      store,
      embedding: { apiKey: 'k', doFetch: fakeEmbedder({}) },
      vision: { apiKey: 'k', doFetch: vision.doFetch },
      visionCache: memoryCache(),
    });
    await index.build('s.myshopify.com', [withImage]);

    const row = (openDatabaseRow(store, 's.myshopify.com') ?? '') as string;
    expect(row).toContain('Riviera Sandal'); // the merchant's words survive
    expect(row).toContain('open toe'); // the photo's words are added
  });

  it('still builds a text index when vision is unavailable', async () => {
    const store = new SqliteVectorStore(openDatabase({ path: ':memory:' }));
    const index = new CatalogIndex({
      store,
      embedding: { apiKey: 'k', doFetch: fakeEmbedder({}) },
      vision: { apiKey: 'k', doFetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch },
      visionCache: memoryCache(),
    });
    await index.build('s.myshopify.com', [withImage]);
    expect(store.count('s.myshopify.com')).toBe(1);
  });

  it('finds the first image wherever the payload puts it', () => {
    expect(primaryImage({ image: 'a.jpg' })).toBe('a.jpg');
    expect(primaryImage({ media: [{ url: 'b.jpg' }] })).toBe('b.jpg');
    expect(primaryImage({ variants: [{ media: [{ url: 'c.jpg' }] }] })).toBe('c.jpg');
    expect(primaryImage({ title: 'no photo' })).toBe('');
  });
});

describe('searching by meaning', () => {
  const SHOP = 'acme.myshopify.com';
  const sandal = { id: 'p-sandal', title: 'Riviera Sandal', tags: ['open toe'] };
  const boot = { id: 'p-boot', title: 'Winter Boot', tags: ['insulated'] };

  function indexWith(doFetch: typeof fetch) {
    const store = new SqliteVectorStore(openDatabase({ path: ':memory:' }));
    return {
      store,
      index: new CatalogIndex({ store, embedding: { apiKey: 'sk-test', doFetch } }),
    };
  }

  it('finds the product whose meaning matches, not its words', async () => {
    const near = axis(1);
    const far = axis(2);
    const doFetch = fakeEmbedder({
      [productText(sandal)]: near,
      [productText(boot)]: far,
      'open toe shoes': near, // the query lands beside the sandal
    });

    const { index } = indexWith(doFetch);
    await index.build(SHOP, [sandal, boot]);
    const hits = await index.search(SHOP, 'open toe shoes');

    expect(hits[0]!.productId).toBe('p-sandal');
    expect(hits[0]!.score).toBeGreaterThan(MIN_SCORE);
  });

  it('returns nothing rather than the least-bad product', async () => {
    // Without a floor the search always returns its k best, so asking a
    // snowboard shop for sandals yields snowboards ranked by how little they
    // differ — which reads as the assistant claiming they are sandals.
    const doFetch = fakeEmbedder({
      [productText(boot)]: axis(2),
      sandals: axis(700),
    });
    const { index } = indexWith(doFetch);
    await index.build(SHOP, [boot]);
    expect(await index.search(SHOP, 'sandals')).toEqual([]);
  });

  it('embeds the catalog once when several shoppers arrive together', async () => {
    const calls = { n: 0 };
    const inner = fakeEmbedder({ [productText(sandal)]: axis(1) });
    const doFetch = (async (u: unknown, i: { body: string }) => {
      calls.n++;
      return inner(u as never, i as never);
    }) as unknown as typeof fetch;

    const { index } = indexWith(doFetch);
    await Promise.all([
      index.build(SHOP, [sandal]),
      index.build(SHOP, [sandal]),
      index.build(SHOP, [sandal]),
    ]);
    // One build, not three catalogs' worth of embeddings.
    expect(calls.n).toBe(1);
  });

  it('treats a never-built index as stale and a fresh one as current', async () => {
    const { index } = indexWith(fakeEmbedder({ [productText(sandal)]: axis(1) }));
    expect(index.isStale(SHOP)).toBe(true);
    await index.build(SHOP, [sandal]);
    expect(index.isStale(SHOP)).toBe(false);
    // Six hours on, the catalog may have moved underneath it.
    expect(index.isStale(SHOP, Date.now() + 7 * 60 * 60 * 1000)).toBe(true);
  });

  it('embeds an empty description as a zero vector rather than failing the build', async () => {
    // The API rejects empty input, and one blank product would otherwise
    // take the whole catalog down with it.
    const doFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from(axis(1)) }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const vectors = await embed(['', 'real text'], { apiKey: 'sk-test', doFetch });
    expect(vectors).toHaveLength(2);
    expect(vectors[0]!.every((x) => x === 0)).toBe(true);
  });
});
