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

const TABLES = ['shops', 'nonces', 'settings', 'sessions', 'exposures', 'carts', 'conversions', 'spend'];

// One database for the file, truncated between tests. Booting a fresh WASM
// Postgres per test cost ~1.3s each and turned a 3s suite into a 43s one — a
// test suite slow enough to skip is a test suite that stops catching things.
beforeAll(async () => {
  db = await PGlite.create();
  sql = client(db);
  await migrate(sql);
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
    expect(rows.map((r) => r['tablename'])).toEqual([
      'carts',
      'conversions',
      'exposures',
      'nonces',
      'sessions',
      'settings',
      'shops',
      'spend',
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
      holdoutFraction: 0.35,
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
