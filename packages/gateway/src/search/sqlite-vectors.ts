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
        products INTEGER NOT NULL,
        version  INTEGER NOT NULL DEFAULT 1
      );
      -- Keyed by image URL, not product: Shopify CDN URLs carry a version,
      -- so a re-uploaded photo is a new key and is re-read automatically,
      -- while re-indexing an unchanged catalog costs nothing. Not scoped to
      -- a shop for the same reason a URL is already unique.
      CREATE TABLE IF NOT EXISTS product_vision (
        image_url  TEXT PRIMARY KEY,
        attributes TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    /**
     * Add columns to a table that already exists.
     *
     * `CREATE TABLE IF NOT EXISTS` does nothing to a deployed table, so the
     * `version` column above reached no database that had already run this
     * code once — and every catalog search then failed with "no such
     * column: version", which the executor swallowed into keyword-only
     * search.
     *
     * The same mistake as the shops table earlier, in a file written after
     * that one was fixed. SQLite has no ADD COLUMN IF NOT EXISTS; the throw
     * on an existing column IS the check.
     */
    for (const [table, column, type] of [
      ['catalog_index_meta', 'version', 'INTEGER NOT NULL DEFAULT 1'],
    ] as const) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        // Already present.
      }
    }
  }

  /** Image descriptions, shared across rebuilds. See search/vision.ts. */
  readonly vision = {
    get: (imageUrl: string): string | undefined => {
      const row = this.db
        .prepare('SELECT attributes FROM product_vision WHERE image_url = ?')
        .get(imageUrl) as { attributes?: string } | undefined;
      return row?.attributes === undefined ? undefined : String(row.attributes);
    },
    put: (imageUrl: string, attributes: string): void => {
      this.db
        .prepare(
          `INSERT INTO product_vision (image_url, attributes, created_at) VALUES (?, ?, ?)
           ON CONFLICT(image_url) DO UPDATE SET attributes = excluded.attributes`,
        )
        .run(imageUrl, attributes, Date.now());
    },
  };

  /**
   * One transaction, so a failed rebuild cannot leave a shop with half a
   * catalog indexed — which would silently drop products out of search with
   * nothing to indicate it.
   */
  replace(
    shop: string,
    rows: readonly { productId: string; text: string; vector: Float32Array }[],
    now: number = Date.now(),
    version = 1,
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
          `INSERT INTO catalog_index_meta (shop, built_at, products, version) VALUES (?, ?, ?, ?)
           ON CONFLICT(shop) DO UPDATE SET built_at = excluded.built_at,
             products = excluded.products, version = excluded.version`,
        )
        .run(shop, now, rows.length, version);
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

  version(shop: string): number | undefined {
    const row = this.db
      .prepare('SELECT version FROM catalog_index_meta WHERE shop = ?')
      .get(shop) as { version?: number } | undefined;
    return row?.version === undefined ? undefined : Number(row.version);
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
