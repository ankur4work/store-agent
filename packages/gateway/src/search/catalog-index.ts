import { EMBEDDING_DIMS, cosine, embed, type EmbeddingConfig } from './embeddings.js';
import { productId, productText } from './product-text.js';
import { describeAll, primaryImage, type VisionCache, type VisionConfig } from './vision.js';

/**
 * Semantic product search.
 *
 * ## Why brute force, and not an ANN index
 *
 * The obvious build is Postgres with pgvector, and the architecture notes
 * call for it. It is the wrong first step here, for a reason worth writing
 * down: an approximate-nearest-neighbour index earns its keep at hundreds
 * of thousands of vectors. A Shopify catalog is a few hundred products, and
 * the large ones are a few thousand.
 *
 * Cosine over 5,000 stored vectors is 7.7M multiply-adds — about 10ms, once
 * per search, with no index to build, no recall to tune, and no extra
 * service to run. This deployment is single-node SQLite by deliberate
 * choice (the holdout experiment cannot survive two writers), so pgvector
 * would mean standing up and migrating to Postgres to make a 10ms operation
 * faster than it needs to be.
 *
 * So the maths lives here and the storage is behind `VectorStore`. When
 * this app moves to Postgres — which is where multi-node leads — a pgvector
 * implementation of that interface replaces the SQLite one and nothing else
 * changes. The interface is the part that matters; the index is a detail
 * that should be chosen at the scale that justifies it.
 */

export interface StoredVector {
  readonly productId: string;
  readonly vector: Float32Array;
}

export interface VectorStore {
  /** Replace the whole index for a shop, atomically. */
  replace(shop: string, rows: readonly { productId: string; text: string; vector: Float32Array }[]): void;
  all(shop: string): StoredVector[];
  /** Epoch ms of the last successful build, or undefined if never built. */
  builtAt(shop: string): number | undefined;
  count(shop: string): number;
}

export interface CatalogIndexDeps {
  readonly store: VectorStore;
  readonly embedding: EmbeddingConfig;
  /** Rebuild when the index is older than this. Default 6 hours. */
  readonly maxAgeMs?: number;
  /**
   * Read product photos and index what they show. Absent leaves the index
   * built from merchant text alone — see the note in build().
   */
  readonly vision?: VisionConfig;
  readonly visionCache?: VisionCache;
  readonly log?: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
  };
}

export interface SemanticHit {
  readonly productId: string;
  readonly score: number;
}

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Below this a "match" is noise.
 *
 * Cosine over this model puts genuinely unrelated text around 0.1–0.25, and
 * a real match well above 0.3. Without a floor the search always returns
 * its k best, so asking a snowboard shop for open-toe shoes produces
 * snowboards ranked by how little they differ — which reads as the
 * assistant claiming they are sandals.
 */
export const MIN_SCORE = 0.3;

export class CatalogIndex {
  /** One build per shop at a time; a second caller waits on the first. */
  private readonly building = new Map<string, Promise<void>>();

  constructor(private readonly deps: CatalogIndexDeps) {}

  isStale(shop: string, now: number = Date.now()): boolean {
    const built = this.deps.store.builtAt(shop);
    if (built === undefined) return true;
    return now - built > (this.deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  }

  /**
   * Embed a catalog and store it, replacing whatever was there.
   *
   * Concurrent callers share one build. Without that, three shoppers
   * arriving together on a cold index would each embed the entire catalog.
   */
  async build(shop: string, products: readonly unknown[]): Promise<void> {
    const inFlight = this.building.get(shop);
    if (inFlight !== undefined) return inFlight;

    const task = (async () => {
      /**
       * Read the photos first, and index what they show.
       *
       * Text search finds only what a merchant typed, and they type
       * "Riviera Sandal", not "open toe, ankle strap, tan leather". The
       * words a shopper uses are in the picture. Cached per image URL, so
       * this is paid once per photo and not once per rebuild.
       *
       * Optional throughout: with no vision config the index is exactly
       * what it was, built from text alone.
       */
      let seen = new Map<string, string>();
      if (this.deps.vision !== undefined && this.deps.visionCache !== undefined) {
        try {
          seen = await describeAll(
            products.map((p) => primaryImage(p)),
            this.deps.visionCache,
            this.deps.vision,
          );
        } catch {
          // A vision outage degrades the index to text. It must never stop
          // the catalog being searchable at all.
        }
      }

      const rows = products
        .map((p) => {
          const described = seen.get(primaryImage(p)) ?? '';
          const text = productText(p);
          return {
            productId: productId(p),
            // Appended, never substituted: the merchant's own words stay
            // authoritative, and the photo adds the vocabulary they omitted.
            text: described === '' ? text : `${text}. Appearance: ${described}`,
          };
        })
        .filter((r) => r.productId !== '' && r.text !== '');
      if (rows.length === 0) {
        this.deps.log?.warn('catalog_index_empty', { shop });
        return;
      }
      const vectors = await embed(
        rows.map((r) => r.text),
        this.deps.embedding,
      );
      this.deps.store.replace(
        shop,
        rows.map((r, i) => ({ ...r, vector: vectors[i]! })),
      );
      this.deps.log?.info('catalog_indexed', { shop, products: rows.length });
    })().finally(() => this.building.delete(shop));

    this.building.set(shop, task);
    return task;
  }

  /**
   * The products whose meaning is closest to the query.
   *
   * Returns ids and scores, never products: the index holds vectors, and
   * the caller already has the catalog rows. Resolving them here would mean
   * storing a second copy of the catalog that can go stale independently.
   */
  async search(shop: string, query: string, k = 8): Promise<SemanticHit[]> {
    const stored = this.deps.store.all(shop);
    if (stored.length === 0) return [];

    const [queryVector] = await embed([query], this.deps.embedding);
    if (queryVector === undefined || queryVector.length !== EMBEDDING_DIMS) return [];

    return stored
      .map((row) => ({ productId: row.productId, score: cosine(queryVector, row.vector) }))
      .filter((hit) => hit.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
