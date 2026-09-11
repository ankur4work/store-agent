import type { DatabaseSync } from 'node:sqlite';
import { blobToVector, vectorToBlob } from './embeddings.js';
import type { StoredVector, VectorStore } from './catalog-index.js';

/**
 * Catalog vectors in SQLite.
 *
 * Vectors are BLOBs of little-endian float32 and the similarity is computed
 * in process — see the note on CatalogIndex for why that is the right shape
 * at a Shopify catalog's size, and what changes when it stops being.
 *
 * The rows are a CACHE. Losing them costs one rebuild, which is why there
 * is no migration ceremony here and why `replace` is free to delete first.
 */
export class SqliteVectorStore implements VectorStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_vectors (
        shop       TEXT NOT NULL,
        product_id TEXT NOT NULL,
        text       TEXT NOT NULL,
        vec        BLOB NOT NULL,
        PRIMARY KEY (shop, product_id)
      );
      CREATE TABLE IF NOT EXISTS catalog_index_meta (
        shop     TEXT PRIMARY KEY,
        built_at INTEGER NOT NULL,
        products INTEGER NOT NULL
      );
    `);
  }

  /**
   * One transaction, so a failed rebuild cannot leave a shop with half a
   * catalog indexed — which would silently drop products out of search with
   * nothing to indicate it.
   */
  replace(
    shop: string,
    rows: readonly { productId: string; text: string; vector: Float32Array }[],
    now: number = Date.now(),
  ): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM catalog_vectors WHERE shop = ?').run(shop);
      const insert = this.db.prepare(
        'INSERT INTO catalog_vectors (shop, product_id, text, vec) VALUES (?, ?, ?, ?)',
      );
      for (const row of rows) {
        insert.run(shop, row.productId, row.text, vectorToBlob(row.vector));
      }
      this.db
        .prepare(
          `INSERT INTO catalog_index_meta (shop, built_at, products) VALUES (?, ?, ?)
           ON CONFLICT(shop) DO UPDATE SET built_at = excluded.built_at, products = excluded.products`,
        )
        .run(shop, now, rows.length);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  all(shop: string): StoredVector[] {
    const rows = this.db
      .prepare('SELECT product_id, vec FROM catalog_vectors WHERE shop = ?')
      .all(shop) as { product_id: string; vec: Uint8Array }[];
    return rows.map((r) => ({ productId: String(r.product_id), vector: blobToVector(r.vec) }));
  }

  builtAt(shop: string): number | undefined {
    const row = this.db
      .prepare('SELECT built_at FROM catalog_index_meta WHERE shop = ?')
      .get(shop) as { built_at?: number } | undefined;
    return row?.built_at === undefined ? undefined : Number(row.built_at);
  }

  count(shop: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM catalog_vectors WHERE shop = ?')
      .get(shop) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** GDPR shop/redact — the index is derived data and must go with the rest. */
  purge(shop: string): void {
    this.db.prepare('DELETE FROM catalog_vectors WHERE shop = ?').run(shop);
    this.db.prepare('DELETE FROM catalog_index_meta WHERE shop = ?').run(shop);
  }
}
