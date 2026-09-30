import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  PgAttributionStore,
  PgNonceStore,
  PgSessionStore,
  PgSettingsStore,
  PgShopStore,
  PgSpendStore,
  migrate,
  type SqlClient,
} from '../src/store/postgres.js';
import { PgVectorStore } from '../src/search/pg-vectors.js';
import { vectorToBlob } from '../src/search/embeddings.js';
import { newSession } from '../src/sessions.js';
import { newShop } from '../src/shopify/shops.js';
import { DEFAULT_SETTINGS } from '../src/admin/settings.js';

/**
 * These run against **real PostgreSQL** (18.3, compiled to WASM), not a mock.
 * The SQL is executed, so `ON CONFLICT`, `RETURNING`, `JSONB`, `GREATEST` and
 * the type coercions are genuinely verified rather than merely typechecked.
 *
 * What this cannot show is concurrency: PGlite is single-connection, so
 * multi-node contention remains untested. Every mutation below is a single
 * atomic statement precisely so that correctness does not depend on the
 * interleaving — but that is an argument, not a demonstration.
 */
function client(db: PGlite): SqlClient {
  return {
    async query(sql, params) {
      const res = await db.query(sql, params === undefined ? undefined : [...params]);
      return { rows: res.rows as never[] };
    },
  };
}

const SHOP = 'acme.myshopify.com';
let db: PGlite;
let sql: SqlClient;

const TABLES = ['shops', 'nonces', 'settings', 'sessions', 'exposures', 'carts', 'conversions', 'spend', 'funnel_steps', 'catalog_vectors', 'catalog_index_meta', 'product_vision'];

// One database for the file, truncated between tests. Booting a fresh WASM
// Postgres per test cost ~1.3s each and turned a 3s suite into a 43s one — a
// test suite slow enough to skip is a test suite that stops catching things.
beforeAll(async () => {
  db = await PGlite.create();
  sql = client(db);
  await migrate(sql);
  /**
   * The vector tables are created by `PgVectorStore.init()` and NOT by
   * `migrate()`, deliberately: that store is opt-in, and a deployment still on
   * SQLite for its vectors should not be carrying its tables. They are created
   * here so the truncation below has something to truncate.
   */
  await new PgVectorStore(sql).init();
});

beforeEach(async () => {
  await sql.query(`TRUNCATE ${TABLES.join(', ')}`);
});

describe('migration', () => {
  it('is idempotent, so a redeploy is not a migration event', async () => {
    await expect(migrate(sql)).resolves.toBeUndefined();
    await expect(migrate(sql)).resolves.toBeUndefined();
  });

  it('creates every table the gateway needs', async () => {
    const { rows } = await sql.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const VECTOR_TABLES = ['catalog_vectors', 'catalog_index_meta', 'product_vision'];
    expect(
      rows.map((r) => r['tablename']).filter((t) => !VECTOR_TABLES.includes(String(t))),
    ).toEqual([
      'carts',
      'conversions',
      'exposures',
      // The funnel: one row per session per step. Added with the merchant-facing
      // funnel card, and listed here because this test exists to notice exactly
      // that — a schema change nobody mentioned.
      'funnel_steps',
      'nonces',
      'sessions',
      'settings',
      'shops',
      'spend',
      // Note what is NOT here: catalog_vectors, catalog_index_meta and
      // product_vision. Those belong to PgVectorStore, which is opt-in and
      // creates them itself — a deployment still keeping its vectors in SQLite
      // should not be carrying their tables. The test harness creates them in
      // beforeAll, hence the filter below.
    ]);
  });
});

describe('shops', () => {
  it('round-trips and hides uninstalled shops', async () => {
    const store = new PgShopStore(sql);
    await store.put(newShop(SHOP, 'shpat_x', 'read_products'));
    expect((await store.get(SHOP))?.accessToken).toBe('shpat_x');
    expect(await store.count()).toBe(1);

    await store.markUninstalled(SHOP);
    expect(await store.get(SHOP)).toBeUndefined();
    expect(await store.count()).toBe(0);
  });

  it('reinstall clears the uninstall marker', async () => {
    const store = new PgShopStore(sql);
    await store.put(newShop(SHOP, 'old', 's'));
    await store.markUninstalled(SHOP);
    await store.put(newShop(SHOP, 'new', 's'));
    expect((await store.get(SHOP))?.accessToken).toBe('new');
  });

  it('purge destroys every trace across tables', async () => {
    const shops = new PgShopStore(sql);
    const attribution = new PgAttributionStore(sql);
    const settings = new PgSettingsStore(sql);
    await shops.put(newShop(SHOP, 'shpat_x', 's'));
    await settings.put({ shop: SHOP, ...DEFAULT_SETTINGS, updatedAt: 0 });
    await attribution.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });

    await shops.purge(SHOP);

    expect(await shops.get(SHOP)).toBeUndefined();
    expect(await attribution.armOf(SHOP, 's1')).toBeUndefined();
    expect((await settings.get(SHOP)).updatedAt).toBe(0);
  });

  it('stores installedAt as a bigint without precision loss', async () => {
    const store = new PgShopStore(sql);
    const now = 1_767_225_600_000; // well past 2^31 ms
    await store.put({ shop: SHOP, accessToken: 't', scopes: 's', installedAt: now });
    // An INTEGER column would have overflowed here.
    expect((await store.get(SHOP))?.installedAt).toBe(now);
  });
});

describe('nonces', () => {
  it('is single-use', async () => {
    const store = new PgNonceStore(sql);
    const state = await store.issue(SHOP);
    expect(await store.consume(state)).toBe(SHOP);
    expect(await store.consume(state)).toBeUndefined();
  });

  it('consumes atomically, so two nodes cannot both win', async () => {
    const store = new PgNonceStore(sql);
    const state = await store.issue(SHOP);
    // DELETE ... RETURNING in one statement. A SELECT-then-DELETE would let
    // both racers through, which is the replay the nonce exists to stop.
    const [a, b] = await Promise.all([store.consume(state), store.consume(state)]);
    expect([a, b].filter((v) => v !== undefined)).toHaveLength(1);
  });

  it('rejects an expired nonce and still consumes it', async () => {
    const store = new PgNonceStore(sql);
    const state = await store.issue(SHOP);
    await sql.query('UPDATE nonces SET expires = $1 WHERE state = $2', [Date.now() - 1, state]);
    expect(await store.consume(state)).toBeUndefined();
    expect((await sql.query('SELECT * FROM nonces')).rows).toHaveLength(0);
  });

  it('sweeps expired nonces', async () => {
    const store = new PgNonceStore(sql);
    await store.issue('a.myshopify.com');
    const stale = await store.issue('b.myshopify.com');
    await sql.query('UPDATE nonces SET expires = $1 WHERE state = $2', [Date.now() - 1, stale]);
    expect(await store.sweep()).toBe(1);
  });
});

describe('settings', () => {
  it('returns defaults for an unknown shop', async () => {
    const s = await new PgSettingsStore(sql).get('new.myshopify.com');
    expect(s.accentColor).toBe(DEFAULT_SETTINGS.accentColor);
  });

  it('round-trips every field through Postgres typing', async () => {
    const store = new PgSettingsStore(sql);
    await store.put({
      shop: SHOP,
      accentColor: '#aa0000',
      cornerRadius: 4,
      position: 'left',
      greeting: 'Hi there',
      enabled: false,
      holdoutFraction: 0.35, voiceLanguage: 'en', onDeviceSpeech: 'auto', brandVoice: '', policyNotes: '', promoteProducts: '', neverRecommend: '',
      updatedAt: 0,
    });
    const s = await store.get(SHOP);
    expect(s.enabled).toBe(false);
    // DOUBLE PRECISION, not INTEGER — an integer column would round this to 0.
    expect(s.holdoutFraction).toBe(0.35);
    expect(s.position).toBe('left');
  });
});

describe('sessions', () => {
  it('round-trips history through JSONB', async () => {
    const store = new PgSessionStore(sql);
    const s = newSession('sess1', SHOP);
    s.history = [{ role: 'user', content: 'hello' }];
    s.cartId = 'gid://cart/1';
    await store.put(s);

    const got = await store.get('sess1');
    expect(got?.history).toEqual([{ role: 'user', content: 'hello' }]);
    expect(got?.cartId).toBe('gid://cart/1');
  });

  it('omits cartId rather than returning null', async () => {
    const store = new PgSessionStore(sql);
    await store.put(newSession('sess1', SHOP));
    const got = await store.get('sess1');
    expect(got && 'cartId' in got).toBe(false);
  });

  it('caps history the same way every other store does', async () => {
    const store = new PgSessionStore(sql);
    const s = newSession('sess1', SHOP);
    s.history = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    await store.put(s);
    const got = await store.get('sess1');
    expect(got?.history).toHaveLength(24);
    expect(got?.history[23]?.content).toBe('m39');
  });

  it('survives content that would break naive SQL', async () => {
    const store = new PgSessionStore(sql);
    const s = newSession('sess1', SHOP);
    // Parameterised throughout; this is the shape of an injection attempt.
    s.history = [{ role: 'user', content: "'; DROP TABLE sessions; -- \\ \"quoted\"" }];
    await store.put(s);
    expect((await store.get('sess1'))?.history[0]?.content).toContain('DROP TABLE');
    expect((await sql.query('SELECT COUNT(*) AS n FROM sessions')).rows[0]!['n']).toBeDefined();
  });

  it('expires past the TTL', async () => {
    const store = new PgSessionStore(sql, 50);
    await store.put(newSession('sess1', SHOP));
    await sql.query('UPDATE sessions SET updated_at = $1 WHERE id = $2', [Date.now() - 1000, 'sess1']);
    expect(await store.get('sess1')).toBeUndefined();
    expect(await store.size()).toBe(0);
  });
});

describe('attribution', () => {
  it('never lets an arm change once assigned', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'holdout', createdAt: 1, engaged: false });
    await store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 2, engaged: false });
    // With several nodes this is the statement that makes assignment
    // race-proof; a flipped arm contaminates both groups.
    expect(await store.armOf(SHOP, 's1')).toBe('holdout');
  });

  it('is race-proof on concurrent exposure writes', async () => {
    const store = new PgAttributionStore(sql);
    await Promise.all([
      store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'holdout', createdAt: 1, engaged: false }),
      store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: false }),
    ]);
    const { rows } = await sql.query('SELECT COUNT(*) AS n FROM exposures WHERE session_id = $1', ['s1']);
    expect(Number(rows[0]!['n'])).toBe(1);
  });

  it('counts a retried order webhook exactly once', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    const order = {
      shop: SHOP, orderId: 'o1', sessionId: 's1', cartId: undefined,
      revenueMinor: 18900, createdAt: 5, matchedBy: 'pixel' as const,
    };
    await store.recordConversion(order);
    await store.recordConversion(order);

    const { exposed } = await store.totals(SHOP);
    expect(exposed.conversions).toBe(1);
    expect(exposed.revenueMinor).toBe(18900);
  });

  it('upgrades an unmatched order when the session later arrives', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    await store.recordConversion({
      shop: SHOP, orderId: 'o1', sessionId: undefined, cartId: 'c1',
      revenueMinor: 18900, createdAt: 5, matchedBy: 'unmatched',
    });
    expect(await store.unmatchedCount(SHOP)).toBe(1);

    await store.recordConversion({
      shop: SHOP, orderId: 'o1', sessionId: 's1', cartId: 'c1',
      revenueMinor: 18900, createdAt: 5, matchedBy: 'cart',
    });
    expect(await store.unmatchedCount(SHOP)).toBe(0);
    expect((await store.totals(SHOP)).exposed.conversions).toBe(1);
  });

  it('splits totals by arm', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 'e1', arm: 'exposed', createdAt: 1, engaged: true });
    await store.recordExposure({ shop: SHOP, sessionId: 'e2', arm: 'exposed', createdAt: 1, engaged: true });
    await store.recordExposure({ shop: SHOP, sessionId: 'h1', arm: 'holdout', createdAt: 1, engaged: false });
    await store.recordConversion({
      shop: SHOP, orderId: 'o1', sessionId: 'e1', cartId: undefined,
      revenueMinor: 10000, createdAt: 2, matchedBy: 'pixel',
    });
    await store.recordConversion({
      shop: SHOP, orderId: 'o2', sessionId: 'h1', cartId: undefined,
      revenueMinor: 5000, createdAt: 2, matchedBy: 'pixel',
    });

    const { exposed, holdout } = await store.totals(SHOP);
    expect(exposed).toEqual({ sessions: 2, conversions: 1, revenueMinor: 10000 });
    // The holdout arm must be countable — the whole point of the pixel.
    expect(holdout).toEqual({ sessions: 1, conversions: 1, revenueMinor: 5000 });
  });

  it('keeps shops isolated', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    await store.recordExposure({
      shop: 'other.myshopify.com', sessionId: 's1', arm: 'holdout', createdAt: 1, engaged: false,
    });
    expect(await store.armOf(SHOP, 's1')).toBe('exposed');
    expect(await store.armOf('other.myshopify.com', 's1')).toBe('holdout');
  });

  it('ignores orders from sessions it never saw', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    await store.recordConversion({
      shop: SHOP, orderId: 'o1', sessionId: 'ghost', cartId: undefined,
      revenueMinor: 9999, createdAt: 2, matchedBy: 'pixel',
    });
    const { exposed, holdout } = await store.totals(SHOP);
    expect(exposed.conversions).toBe(0);
    expect(holdout.conversions).toBe(0);
  });

  it('honours the since filter', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 'old', arm: 'exposed', createdAt: 100, engaged: true });
    await store.recordExposure({ shop: SHOP, sessionId: 'new', arm: 'exposed', createdAt: 900, engaged: true });
    expect((await store.totals(SHOP, 500)).exposed.sessions).toBe(1);
  });

  it('keeps revenue exact at large totals', async () => {
    const store = new PgAttributionStore(sql);
    await store.recordExposure({ shop: SHOP, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    // 50 million cents; a float column would start losing pennies.
    await store.recordConversion({
      shop: SHOP, orderId: 'o1', sessionId: 's1', cartId: undefined,
      revenueMinor: 5_000_000_099, createdAt: 2, matchedBy: 'pixel',
    });
    expect((await store.totals(SHOP)).exposed.revenueMinor).toBe(5_000_000_099);
  });
});

describe('spend across nodes', () => {
  it('accumulates through Postgres', async () => {
    const store = new PgSpendStore(sql);
    store.add('global', '2026-09-04', 5);
    await new Promise((r) => setTimeout(r, 50));
    const { rows } = await sql.query('SELECT units FROM spend WHERE scope = $1', ['global']);
    expect(Number(rows[0]!['units'])).toBe(5);
  });

  it('adopts other nodes spend on refresh', async () => {
    // Simulate a second node having already written.
    await sql.query('INSERT INTO spend (scope, day, units) VALUES ($1, $2, $3)', [
      'shop:acme', '2026-09-04', 900,
    ]);
    const store = new PgSpendStore(sql);
    expect(store.total('shop:acme', '2026-09-04')).toBe(0);
    await store.refresh('2026-09-04');
    // Without this a fresh node would grant a full budget all over again.
    expect(store.total('shop:acme', '2026-09-04')).toBe(900);
  });

  it('accumulates fractional units', async () => {
    const store = new PgSpendStore(sql);
    store.add('global', '2026-09-04', 0.5);
    store.add('global', '2026-09-04', 0.5);
    expect(store.total('global', '2026-09-04')).toBe(1);
  });

  it('prunes old days but keeps today', async () => {
    const store = new PgSpendStore(sql);
    await sql.query('INSERT INTO spend (scope, day, units) VALUES ($1,$2,$3),($4,$5,$6)', [
      'global', '2026-01-01', 5, 'global', '2026-09-04', 5,
    ]);
    expect(await store.prune(Date.parse('2026-09-04T00:00:00Z'), 7)).toBe(1);
  });

  it('does not reject the request path when Postgres is down', () => {
    const broken: SqlClient = {
      async query() {
        throw new Error('connection refused');
      },
    };
    const errors: unknown[] = [];
    const store = new PgSpendStore(broken, (e) => errors.push(e));
    // A database blip must not take the limiter — and therefore the site —
    // down with it. The local cache keeps answering.
    expect(() => store.add('global', '2026-09-04', 1)).not.toThrow();
    expect(store.total('global', '2026-09-04')).toBe(1);
  });
});

/**
 * The funnel, executed by a real Postgres.
 *
 * Its query is the most complex SQL in this file — four LEFT JOINs and five
 * `COUNT(... ) FILTER` clauses — and `FILTER` in particular is Postgres-specific
 * syntax that a typechecker cannot verify at all. The SQLite implementation of
 * the same interface is tested separately; this is here because the two are
 * different queries and only one of them is exercised by the other suite.
 */
describe('PgAttributionStore funnel', () => {
  const store = (): PgAttributionStore => new PgAttributionStore(sql);

  async function expose(sessionId: string, arm: 'exposed' | 'holdout', engaged = false) {
    await store().recordExposure({ shop: SHOP, sessionId, arm, createdAt: 1000, engaged });
  }

  it('counts a session once per step however often it is recorded', async () => {
    await expose('a', 'exposed');
    for (let i = 0; i < 5; i++) await store().recordStep(SHOP, 'a', 'card_tapped');
    const f = await store().funnel(SHOP);
    expect(f.exposed.cardTapped).toBe(1);
  });

  it('fills every step for the exposed arm', async () => {
    await expose('a', 'exposed', true);
    await store().recordStep(SHOP, 'a', 'cards_shown');
    await store().recordStep(SHOP, 'a', 'card_tapped');
    await store().recordStep(SHOP, 'a', 'cart_add');
    await store().recordConversion({
      shop: SHOP,
      orderId: 'o1',
      sessionId: 'a',
      cartId: undefined,
      revenueMinor: 9900,
      createdAt: 2000,
      matchedBy: 'pixel',
    });

    const f = await store().funnel(SHOP);
    expect(f.exposed).toEqual({
      sessions: 1,
      engaged: 1,
      cardsShown: 1,
      cardTapped: 1,
      cartAdd: 1,
      converted: 1,
    });
  });

  it('leaves the holdout arm with only the rows it can have', async () => {
    // Those shoppers never saw the assistant, so no cards and no taps — and
    // sessions and purchases are exactly the comparison.
    await expose('h', 'holdout', false);
    await store().recordConversion({
      shop: SHOP,
      orderId: 'o2',
      sessionId: 'h',
      cartId: undefined,
      revenueMinor: 5000,
      createdAt: 2000,
      matchedBy: 'pixel',
    });
    const f = await store().funnel(SHOP);
    expect(f.holdout).toMatchObject({ sessions: 1, cardsShown: 0, cardTapped: 0, converted: 1 });
  });

  it('does not multiply a session by its orders', async () => {
    // The LEFT JOIN on conversions is DISTINCT for exactly this reason: two
    // orders in one session would otherwise double every count on that row.
    await expose('a', 'exposed', true);
    await store().recordStep(SHOP, 'a', 'cards_shown');
    for (const orderId of ['o1', 'o2', 'o3']) {
      await store().recordConversion({
        shop: SHOP,
        orderId,
        sessionId: 'a',
        cartId: undefined,
        revenueMinor: 1000,
        createdAt: 2000,
        matchedBy: 'pixel',
      });
    }
    const f = await store().funnel(SHOP);
    expect(f.exposed.sessions).toBe(1);
    expect(f.exposed.cardsShown).toBe(1);
    expect(f.exposed.converted).toBe(1);
  });

  it('ignores a step with no exposure behind it', async () => {
    await store().recordStep(SHOP, 'ghost', 'cart_add');
    expect((await store().funnel(SHOP)).exposed.sessions).toBe(0);
  });

  it('honours the time window', async () => {
    await expose('old', 'exposed');
    await store().recordExposure({
      shop: SHOP,
      sessionId: 'new',
      arm: 'exposed',
      createdAt: 9000,
      engaged: false,
    });
    expect((await store().funnel(SHOP, 5000)).exposed.sessions).toBe(1);
  });

  it('is idempotent on a repeated step, as the primary key requires', async () => {
    await expose('a', 'exposed');
    await store().recordStep(SHOP, 'a', 'cart_add', 1);
    await store().recordStep(SHOP, 'a', 'cart_add', 2);
    const { rows } = await sql.query('SELECT COUNT(*) AS n, MIN(at) AS first FROM funnel_steps');
    // ON CONFLICT DO NOTHING: one row, and the FIRST time is what is kept.
    expect(Number((rows[0] as { n: unknown }).n)).toBe(1);
    expect(Number((rows[0] as { first: unknown }).first)).toBe(1);
  });
});

/**
 * Catalog vectors in Postgres, executed by a real Postgres.
 *
 * Written and deliberately NOT switched on: the reason to move is multiple
 * nodes, not catalog size, and `CatalogIndex` explains at length why brute-force
 * cosine over a few hundred products is the right shape today. This is the piece
 * that would otherwise be missing at the moment a second node is needed.
 *
 * The property that matters most is that it is a pure STORAGE swap — the same
 * bytes, the same arithmetic, the same results as SQLite — so these tests
 * compare the two rather than restating expected values.
 */
describe('PgVectorStore', () => {
  const vec = (...xs: number[]): Float32Array => Float32Array.from(xs);

  async function store(): Promise<PgVectorStore> {
    const s = new PgVectorStore(sql);
    await s.init();
    return s;
  }

  it('round-trips a vector byte-for-byte', async () => {
    /**
     * A BYTEA read back in the wrong shape does not throw — it produces a vector
     * of garbage floats and a search that silently returns nonsense, which is
     * the worst failure mode available here.
     */
    const s = await store();
    const original = vec(0.5, -0.25, 0, 1, -1, 0.123456);
    s.replace(SHOP, [{ productId: 'p1', text: 'a tee', vector: original }]);
    await s.warm(SHOP);

    const back = s.all(SHOP);
    expect(back).toHaveLength(1);
    expect(back[0]!.productId).toBe('p1');
    for (let i = 0; i < original.length; i++) {
      expect(back[0]!.vector[i]).toBeCloseTo(original[i]!, 6);
    }
  });

  it('stores bytes identical to the SQLite encoding', async () => {
    // What makes this a storage swap rather than a second implementation.
    const s = await store();
    const v = vec(0.1, 0.2, 0.3);
    s.replace(SHOP, [{ productId: 'p1', text: 't', vector: v }]);
    await s.flush();
    const { rows } = await sql.query('SELECT vec FROM catalog_vectors WHERE shop = $1', [SHOP]);
    const stored = (rows[0] as { vec: Uint8Array }).vec;
    expect([...new Uint8Array(stored)]).toEqual([...new Uint8Array(vectorToBlob(v))]);
  });

  it('REMOVES a product that left the catalog', async () => {
    /**
     * Delete-then-insert rather than upsert. An upsert would leave a deleted
     * product in the index, to be returned by a search for something the shop no
     * longer sells — and the shopper would be shown it.
     */
    const s = await store();
    s.replace(SHOP, [
      { productId: 'p1', text: 'a', vector: vec(1, 0) },
      { productId: 'p2', text: 'b', vector: vec(0, 1) },
    ]);
    s.replace(SHOP, [{ productId: 'p1', text: 'a', vector: vec(1, 0) }]);
    await s.warm(SHOP);
    expect(s.all(SHOP).map((r) => r.productId)).toEqual(['p1']);
  });

  it('keeps shops apart', async () => {
    const s = await store();
    s.replace(SHOP, [{ productId: 'p1', text: 'a', vector: vec(1, 0) }]);
    s.replace('other.myshopify.com', [{ productId: 'q1', text: 'b', vector: vec(0, 1) }]);
    await s.warm(SHOP);
    expect(s.all(SHOP).map((r) => r.productId)).toEqual(['p1']);
    await s.warm('other.myshopify.com');
    expect(s.all('other.myshopify.com').map((r) => r.productId)).toEqual(['q1']);
  });

  it('records when it was built and to which recipe', async () => {
    // INDEX_VERSION is what makes a changed embedding recipe invalidate a fresh
    // index; without it a rebuild would be skipped and the new feature would
    // look switched off.
    const s = await store();
    s.replace(SHOP, [{ productId: 'p1', text: 'a', vector: vec(1, 0) }], 1700, 7);
    await s.warm(SHOP);
    expect(s.builtAt(SHOP)).toBe(1700);
    expect(s.version(SHOP)).toBe(7);
    expect(s.count(SHOP)).toBe(1);
  });

  it('reports an unbuilt shop as unbuilt rather than as empty', async () => {
    // `undefined` means "never built" and drives a rebuild; 0 would mean "built
    // and contains nothing", which would leave search permanently cold.
    const s = await store();
    await s.warm('fresh.myshopify.com');
    expect(s.builtAt('fresh.myshopify.com')).toBeUndefined();
    expect(s.version('fresh.myshopify.com')).toBeUndefined();
    expect(s.all('fresh.myshopify.com')).toEqual([]);
  });

  it('applies writes in order, so a search never sees half an index', async () => {
    const s = await store();
    s.replace(SHOP, [
      { productId: 'old1', text: 'a', vector: vec(1, 0) },
      { productId: 'old2', text: 'b', vector: vec(0, 1) },
    ]);
    s.replace(SHOP, [{ productId: 'new1', text: 'c', vector: vec(1, 1) }]);
    await s.warm(SHOP);
    expect(s.all(SHOP).map((r) => r.productId)).toEqual(['new1']);
  });

  it('searches nothing rather than throwing before it is warmed', async () => {
    // Same behaviour as a cold index: the caller falls back to keyword search.
    const s = await store();
    s.replace(SHOP, [{ productId: 'p1', text: 'a', vector: vec(1, 0) }]);
    expect(s.all(SHOP)).toEqual([]);
  });
});
