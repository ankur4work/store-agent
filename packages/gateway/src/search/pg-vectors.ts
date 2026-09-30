import { blobToVector, vectorToBlob } from './embeddings.js';
import type { StoredVector, VectorStore } from './catalog-index.js';
import type { SqlClient } from '../store/postgres.js';

/**
 * Catalog vectors in Postgres.
 *
 * ## Why this exists, and why it is not switched on
 *
 * `ARCHITECTURE §11` calls for pgvector, and `CatalogIndex` explains at length
 * why that is the wrong FIRST step: an approximate-nearest-neighbour index earns
 * its keep at hundreds of thousands of vectors, a Shopify catalog is a few
 * hundred, and cosine over 5,000 stored vectors is about 10 ms in process. Adding
 * a network round trip to make a 10 ms operation faster than it needs to be is a
 * regression wearing an architecture diagram.
 *
 * What makes it worth writing now is that the reason to switch is not size — it
 * is **multiple nodes**. SQLite has one writer, so the deployment is pinned to a
 * single instance, and the moment a second is needed every store has to move.
 * This is the piece that would otherwise be missing at exactly that moment, and
 * `VectorStore` is four methods, so it is a file rather than a migration.
 *
 * ## Deliberately NOT using the pgvector extension
 *
 * The `vector` type would let Postgres compute similarity with an index. It also
 * requires an extension that a managed Postgres may not offer and a superuser may
 * have to enable — a deployment prerequisite for a capability we do not yet need,
 * on the exact path that must not fail.
 *
 * So the vectors are `BYTEA`, byte-identical to the SQLite encoding, and the
 * cosine still runs in process. That keeps this a pure storage swap: the same
 * arithmetic, the same results, no extension, and no behaviour that differs
 * between the two backends. When the catalog genuinely outgrows brute force, the
 * upgrade is a `vector` column and an index on THIS table — a change to one file
 * whose interface already has every caller behind it.
 *
 * `SELECT` on a few hundred rows of 6 KB each is the cost, and it is paid once
 * per search rather than per product.
 */
export class PgVectorStore implements VectorStore {
  constructor(private readonly sql: SqlClient) {}

  /**
   * Create the tables. Call once at boot, like `migrate` for the other stores.
   *
   * Separate from the constructor because it is async and because a store that
   * silently ran DDL on construction would do it on every request that built one.
   */
  async init(): Promise<void> {
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS catalog_vectors (
         shop       TEXT NOT NULL,
         product_id TEXT NOT NULL,
         text       TEXT NOT NULL,
         vec        BYTEA NOT NULL,
         PRIMARY KEY (shop, product_id)
       )`,
      `CREATE TABLE IF NOT EXISTS catalog_index_meta (
         shop     TEXT PRIMARY KEY,
         built_at BIGINT NOT NULL,
         products INTEGER NOT NULL,
         version  INTEGER NOT NULL DEFAULT 1
       )`,
      // Keyed by image URL, not product: Shopify CDN urls carry a version, so a
      // re-uploaded photo is a new key and is re-read automatically, while
      // re-indexing an unchanged catalog costs nothing.
      `CREATE TABLE IF NOT EXISTS product_vision (
         image_url  TEXT PRIMARY KEY,
         attributes TEXT NOT NULL,
         created_at BIGINT NOT NULL
       )`,
    ]) {
      await this.sql.query(statement);
    }
  }

  /**
   * The whole index for a shop, replaced.
   *
   * `VectorStore.replace` is synchronous in the interface because the SQLite
   * implementation is, and callers treat it as fire-and-forget: `CatalogIndex`
   * awaits the embedding work and then hands over rows. Here the write is async,
   * so the promise is kept on the instance and awaited by the next read — which
   * is what `flush` is for. Losing a write costs one rebuild, because these rows
   * are a CACHE; losing *ordering* would mean serving a half-written index, and
   * that is what the chaining prevents.
   */
  private writing: Promise<void> = Promise.resolve();

  replace(
    shop: string,
    rows: readonly { productId: string; text: string; vector: Float32Array }[],
    now: number = Date.now(),
    version = 1,
  ): void {
    this.writing = this.writing.then(async () => {
      // Delete-then-insert rather than upsert: a product removed from the
      // catalog must LEAVE the index, and an upsert would leave it behind to be
      // returned by a search for something the shop no longer sells.
      await this.sql.query('DELETE FROM catalog_vectors WHERE shop = $1', [shop]);
      for (const row of rows) {
        await this.sql.query(
          `INSERT INTO catalog_vectors (shop, product_id, text, vec) VALUES ($1, $2, $3, $4)
           ON CONFLICT (shop, product_id) DO UPDATE SET text = EXCLUDED.text, vec = EXCLUDED.vec`,
          [shop, row.productId, row.text, vectorToBlob(row.vector)],
        );
      }
      await this.sql.query(
        `INSERT INTO catalog_index_meta (shop, built_at, products, version) VALUES ($1, $2, $3, $4)
         ON CONFLICT (shop) DO UPDATE SET built_at = EXCLUDED.built_at,
           products = EXCLUDED.products, version = EXCLUDED.version`,
        [shop, now, rows.length, version],
      );
    });
    // Swallowed here and reported by the caller's own logging: a failed cache
    // write must not become an unhandled rejection.
    void this.writing.catch(() => {});
  }

  /** Wait for pending writes. The reads below use it; tests use it too. */
  async flush(): Promise<void> {
    await this.writing.catch(() => {});
  }

  /**
   * Every vector for a shop.
   *
   * Synchronous in the interface, and genuinely cannot be here — so this returns
   * the last snapshot read, and `warm` is what refreshes it. `CatalogIndex.search`
   * calls `all()` and then awaits an embedding, so a caller that has not warmed
   * simply searches an empty index and falls back to keywords, which is the same
   * behaviour as a cold index.
   */
  private snapshot = new Map<string, StoredVector[]>();
  private meta = new Map<string, { builtAt: number; products: number; version: number }>();

  async warm(shop: string): Promise<void> {
    await this.flush();
    const { rows } = await this.sql.query(
      'SELECT product_id, vec FROM catalog_vectors WHERE shop = $1',
      [shop],
    );
    this.snapshot.set(
      shop,
      rows.map((r) => ({
        productId: String((r as { product_id: unknown }).product_id),
        vector: blobToVector(toBytes((r as { vec: unknown }).vec)),
      })),
    );

    const { rows: metaRows } = await this.sql.query(
      'SELECT built_at, products, version FROM catalog_index_meta WHERE shop = $1',
      [shop],
    );
    const m = metaRows[0] as { built_at: unknown; products: unknown; version: unknown } | undefined;
    if (m === undefined) this.meta.delete(shop);
    else {
      this.meta.set(shop, {
        builtAt: Number(m.built_at),
        products: Number(m.products),
        version: Number(m.version),
      });
    }
  }

  all(shop: string): StoredVector[] {
    return this.snapshot.get(shop) ?? [];
  }

  builtAt(shop: string): number | undefined {
    return this.meta.get(shop)?.builtAt;
  }

  version(shop: string): number | undefined {
    return this.meta.get(shop)?.version;
  }

  count(shop: string): number {
    return this.meta.get(shop)?.products ?? 0;
  }
}

/**
 * A `BYTEA` as bytes, whatever the driver handed back.
 *
 * `pg` returns a Buffer, PGlite returns a Uint8Array, and some poolers hand back
 * the `\x...` hex text form. Getting this wrong does not throw — it produces a
 * vector of garbage floats and a search that silently returns nonsense, which is
 * the worst available failure mode.
 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new TypeError('catalog_vectors.vec came back in a shape this driver does not support');
}
