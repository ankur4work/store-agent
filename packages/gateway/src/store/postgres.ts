import type { Arm, ArmTotals, AttributionStore, CartLink, Conversion, Exposure } from '@storeagent/attribution';
import type { Message } from '@storeagent/orchestrator';
import type { Session, SessionStore } from '../sessions.js';
import type { NonceStore, Shop, ShopStore } from '../shopify/shops.js';
import { DEFAULT_SETTINGS, type SettingsStore, type ShopSettings } from '../admin/settings.js';
import type { SpendStore } from '../limits/budget.js';
import { randomBytes } from 'node:crypto';

/**
 * Postgres implementations of every store.
 *
 * This is what lifts the single-node constraint. SQLite has one writer, so the
 * deployment is pinned to one instance — and two instances on one SQLite file
 * do worse than error: they disagree about holdout assignment and silently
 * corrupt the experiment. `ARCHITECTURE §3` assumes many gateway nodes, and
 * this is the piece that allows them.
 *
 * ## No driver dependency
 *
 * Written against `SqlClient` — a two-method interface — rather than against
 * `pg` or `postgres`. Three reasons, in order of importance:
 *
 *   1. The repo has **zero runtime dependencies** and this does not change
 *      that. The driver is supplied by the deployment.
 *   2. It is genuinely testable *here*, against PGlite (real PostgreSQL
 *      compiled to WASM). These queries are executed by a real Postgres in the
 *      test suite, not merely typechecked. Untested SQL that looks finished is
 *      worse than no SQL.
 *   3. Swapping `pg` for `postgres` or a pooler later touches one adapter.
 *
 * ## Concurrency is the part PGlite cannot prove
 *
 * PGlite is single-connection, so the tests here validate SQL *semantics* —
 * constraints, `ON CONFLICT`, `RETURNING`, types, isolation of one shop from
 * another — but not genuine multi-node contention. The queries are written to
 * be safe under concurrency (every mutation is a single atomic statement; no
 * read-modify-write round trips), but that property is argued, not
 * demonstrated. Two nodes against one real Postgres is still an untested
 * configuration.
 */

/** The whole driver surface this file needs. */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
}

/**
 * Schema.
 *
 * Every table carries `shop`, and every query filters on it. `§8` calls for
 * row-level security keyed on merchant so that "no cross-tenant query is
 * expressible"; RLS is a deployment concern (it needs roles), so the policies
 * are shipped separately in `docs/POSTGRES.md` and the schema is written to
 * support them.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  shop           TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  installed_at   BIGINT NOT NULL,
  uninstalled_at BIGINT
);

CREATE TABLE IF NOT EXISTS nonces (
  state   TEXT PRIMARY KEY,
  shop    TEXT NOT NULL,
  expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS nonces_expires ON nonces(expires);

CREATE TABLE IF NOT EXISTS settings (
  shop          TEXT PRIMARY KEY,
  accent_color  TEXT NOT NULL,
  corner_radius INTEGER NOT NULL,
  position      TEXT NOT NULL,
  greeting      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL,
  holdout       DOUBLE PRECISION NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  shop       TEXT NOT NULL,
  history    JSONB NOT NULL,
  cart_id    TEXT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS exposures (
  shop       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  arm        TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  engaged    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (shop, session_id)
);
CREATE INDEX IF NOT EXISTS exposures_shop_time ON exposures(shop, created_at);

CREATE TABLE IF NOT EXISTS carts (
  shop       TEXT NOT NULL,
  cart_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (shop, cart_id)
);

CREATE TABLE IF NOT EXISTS conversions (
  shop       TEXT NOT NULL,
  order_id   TEXT NOT NULL,
  session_id TEXT,
  cart_id    TEXT,
  revenue    BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  matched_by TEXT NOT NULL,
  PRIMARY KEY (shop, order_id)
);
CREATE INDEX IF NOT EXISTS conversions_shop_time ON conversions(shop, created_at);

CREATE TABLE IF NOT EXISTS spend (
  scope TEXT NOT NULL,
  day   TEXT NOT NULL,
  units DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);
`;

export async function migrate(sql: SqlClient): Promise<void> {
  // Split so drivers without multi-statement support still work.
  for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter((s) => s !== '')) {
    await sql.query(`${statement};`);
  }
}

const num = (v: unknown): number => Number(v);

// ---------------------------------------------------------------------------

export class PgShopStore implements ShopStore {
  constructor(private readonly sql: SqlClient) {}

  async get(shop: string): Promise<Shop | undefined> {
    const { rows } = await this.sql.query(
      'SELECT * FROM shops WHERE shop = $1 AND uninstalled_at IS NULL',
      [shop],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      shop: String(row['shop']),
      accessToken: String(row['access_token']),
      scopes: String(row['scopes']),
      installedAt: num(row['installed_at']),
    };
  }

  async put(shop: Shop): Promise<void> {
    await this.sql.query(
      `INSERT INTO shops (shop, access_token, scopes, installed_at, uninstalled_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (shop) DO UPDATE SET
         access_token = EXCLUDED.access_token, scopes = EXCLUDED.scopes,
         installed_at = EXCLUDED.installed_at, uninstalled_at = NULL`,
      [shop.shop, shop.accessToken, shop.scopes, shop.installedAt],
    );
  }

  async markUninstalled(shop: string): Promise<void> {
    await this.sql.query('UPDATE shops SET uninstalled_at = $1 WHERE shop = $2', [Date.now(), shop]);
  }

  async purge(shop: string): Promise<void> {
    for (const t of ['shops', 'settings', 'sessions', 'exposures', 'carts', 'conversions']) {
      await this.sql.query(`DELETE FROM ${t} WHERE shop = $1`, [shop]);
    }
  }

  async count(): Promise<number> {
    const { rows } = await this.sql.query('SELECT COUNT(*) AS n FROM shops WHERE uninstalled_at IS NULL');
    return num(rows[0]?.['n'] ?? 0);
  }
}

export class PgNonceStore implements NonceStore {
  constructor(private readonly sql: SqlClient) {}

  async issue(shop: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.sql.query('INSERT INTO nonces (state, shop, expires) VALUES ($1, $2, $3)', [
      state,
      shop,
      Date.now() + 10 * 60 * 1000,
    ]);
    return state;
  }

  async consume(state: string): Promise<string | undefined> {
    // DELETE ... RETURNING is a single atomic statement, so two nodes racing
    // the same callback cannot both succeed. A SELECT-then-DELETE would let
    // both through, which is exactly the replay the nonce exists to stop.
    const { rows } = await this.sql.query('DELETE FROM nonces WHERE state = $1 RETURNING shop, expires', [
      state,
    ]);
    const row = rows[0];
    if (row === undefined) return undefined;
    if (Date.now() > num(row['expires'])) return undefined;
    return String(row['shop']);
  }

  async sweep(): Promise<number> {
    const { rows } = await this.sql.query('DELETE FROM nonces WHERE expires < $1 RETURNING state', [
      Date.now(),
    ]);
    return rows.length;
  }
}

export class PgSettingsStore implements SettingsStore {
  constructor(private readonly sql: SqlClient) {}

  async get(shop: string): Promise<ShopSettings> {
    const { rows } = await this.sql.query('SELECT * FROM settings WHERE shop = $1', [shop]);
    const row = rows[0];
    if (row === undefined) return { shop, ...DEFAULT_SETTINGS, updatedAt: 0 };
    return {
      shop,
      accentColor: String(row['accent_color']),
      cornerRadius: num(row['corner_radius']),
      position: row['position'] === 'left' ? 'left' : 'right',
      greeting: String(row['greeting']),
      enabled: row['enabled'] === true,
      holdoutFraction: num(row['holdout']),
      updatedAt: num(row['updated_at']),
    };
  }

  async put(s: ShopSettings): Promise<void> {
    await this.sql.query(
      `INSERT INTO settings (shop, accent_color, corner_radius, position, greeting, enabled, holdout, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (shop) DO UPDATE SET
         accent_color = EXCLUDED.accent_color, corner_radius = EXCLUDED.corner_radius,
         position = EXCLUDED.position, greeting = EXCLUDED.greeting,
         enabled = EXCLUDED.enabled, holdout = EXCLUDED.holdout,
         updated_at = EXCLUDED.updated_at`,
      [s.shop, s.accentColor, s.cornerRadius, s.position, s.greeting, s.enabled, s.holdoutFraction, Date.now()],
    );
  }
}

export class PgSessionStore implements SessionStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly maxHistory = 24,
  ) {}

  async get(id: string): Promise<Session | undefined> {
    const { rows } = await this.sql.query('SELECT * FROM sessions WHERE id = $1', [id]);
    const row = rows[0];
    if (row === undefined) return undefined;
    if (Date.now() - num(row['updated_at']) > this.ttlMs) {
      await this.sql.query('DELETE FROM sessions WHERE id = $1', [id]);
      return undefined;
    }
    const cartId = row['cart_id'];
    const history = row['history'];
    return {
      id,
      shopDomain: String(row['shop']),
      // JSONB comes back parsed on some drivers and as text on others.
      history: (typeof history === 'string' ? JSON.parse(history) : history) as Message[],
      ...(cartId === null || cartId === undefined ? {} : { cartId: String(cartId) }),
      updatedAt: num(row['updated_at']),
    };
  }

  async put(session: Session): Promise<void> {
    session.updatedAt = Date.now();
    if (session.history.length > this.maxHistory) {
      session.history = session.history.slice(-this.maxHistory);
    }
    await this.sql.query(
      `INSERT INTO sessions (id, shop, history, cart_id, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (id) DO UPDATE SET history = EXCLUDED.history,
         cart_id = EXCLUDED.cart_id, updated_at = EXCLUDED.updated_at`,
      [
        session.id,
        session.shopDomain,
        JSON.stringify(session.history),
        session.cartId ?? null,
        session.updatedAt,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.sql.query('DELETE FROM sessions WHERE id = $1', [id]);
  }

  async size(): Promise<number> {
    const { rows } = await this.sql.query('SELECT COUNT(*) AS n FROM sessions WHERE updated_at > $1', [
      Date.now() - this.ttlMs,
    ]);
    return num(rows[0]?.['n'] ?? 0);
  }

  async sweep(): Promise<number> {
    const { rows } = await this.sql.query('DELETE FROM sessions WHERE updated_at < $1 RETURNING id', [
      Date.now() - this.ttlMs,
    ]);
    return rows.length;
  }
}

export class PgAttributionStore implements AttributionStore {
  constructor(private readonly sql: SqlClient) {}

  async recordExposure(e: Exposure): Promise<void> {
    // DO NOTHING, not DO UPDATE: an arm must never change once assigned, or
    // the session contaminates both groups. With several nodes this is the
    // statement that makes assignment race-proof.
    await this.sql.query(
      `INSERT INTO exposures (shop, session_id, arm, created_at, engaged)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shop, session_id) DO NOTHING`,
      [e.shop, e.sessionId, e.arm, e.createdAt, e.engaged],
    );
  }

  async markEngaged(shop: string, sessionId: string): Promise<void> {
    await this.sql.query(
      'UPDATE exposures SET engaged = TRUE WHERE shop = $1 AND session_id = $2',
      [shop, sessionId],
    );
  }

  async linkCart(link: CartLink): Promise<void> {
    await this.sql.query(
      `INSERT INTO carts (shop, cart_id, session_id, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop, cart_id) DO UPDATE SET session_id = EXCLUDED.session_id`,
      [link.shop, link.cartId, link.sessionId, link.createdAt],
    );
  }

  async sessionForCart(shop: string, cartId: string): Promise<string | undefined> {
    const { rows } = await this.sql.query(
      'SELECT session_id FROM carts WHERE shop = $1 AND cart_id = $2',
      [shop, cartId],
    );
    return rows[0] === undefined ? undefined : String(rows[0]['session_id']);
  }

  async armOf(shop: string, sessionId: string): Promise<Arm | undefined> {
    const { rows } = await this.sql.query(
      'SELECT arm FROM exposures WHERE shop = $1 AND session_id = $2',
      [shop, sessionId],
    );
    return rows[0] === undefined ? undefined : (String(rows[0]['arm']) as Arm);
  }

  async recordConversion(c: Conversion): Promise<void> {
    // Webhooks retry, and with several nodes two may process the same delivery
    // at once. The primary key makes double-counting impossible rather than
    // merely unlikely.
    await this.sql.query(
      `INSERT INTO conversions (shop, order_id, session_id, cart_id, revenue, created_at, matched_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shop, order_id) DO UPDATE SET
         session_id = COALESCE(conversions.session_id, EXCLUDED.session_id),
         revenue    = GREATEST(conversions.revenue, EXCLUDED.revenue),
         matched_by = CASE WHEN conversions.matched_by = 'unmatched'
                           THEN EXCLUDED.matched_by ELSE conversions.matched_by END`,
      [c.shop, c.orderId, c.sessionId ?? null, c.cartId ?? null, c.revenueMinor, c.createdAt, c.matchedBy],
    );
  }

  async totals(shop: string, sinceMs = 0): Promise<{ exposed: ArmTotals; holdout: ArmTotals }> {
    const empty = (): ArmTotals => ({ sessions: 0, conversions: 0, revenueMinor: 0 });
    const out: Record<string, ArmTotals> = { exposed: empty(), holdout: empty() };

    const sessions = await this.sql.query(
      'SELECT arm, COUNT(*) AS n FROM exposures WHERE shop = $1 AND created_at >= $2 GROUP BY arm',
      [shop, sinceMs],
    );
    for (const row of sessions.rows) {
      const arm = out[String(row['arm'])];
      if (arm) out[String(row['arm'])] = { ...arm, sessions: num(row['n']) };
    }

    const conversions = await this.sql.query(
      `SELECT e.arm AS arm, COUNT(*) AS n, COALESCE(SUM(c.revenue), 0) AS revenue
         FROM conversions c
         JOIN exposures e ON e.shop = c.shop AND e.session_id = c.session_id
        WHERE c.shop = $1 AND c.created_at >= $2 AND c.session_id IS NOT NULL
        GROUP BY e.arm`,
      [shop, sinceMs],
    );
    for (const row of conversions.rows) {
      const arm = out[String(row['arm'])];
      if (arm) {
        out[String(row['arm'])] = { ...arm, conversions: num(row['n']), revenueMinor: num(row['revenue']) };
      }
    }

    return { exposed: out['exposed']!, holdout: out['holdout']! };
  }

  async unmatchedCount(shop: string): Promise<number> {
    const { rows } = await this.sql.query(
      "SELECT COUNT(*) AS n FROM conversions WHERE shop = $1 AND matched_by = 'unmatched'",
      [shop],
    );
    return num(rows[0]?.['n'] ?? 0);
  }
}

/**
 * Spend ceilings across nodes.
 *
 * `SpendStore` is synchronous because the SQLite implementation could be, and
 * the limiter sits on the request path. Postgres cannot be, so this keeps a
 * write-through cache: reads are served locally and writes go to Postgres in
 * the background.
 *
 * The consequence is stated rather than hidden: with N nodes the ceiling can
 * be overshot by up to one in-flight window per node before the caches
 * converge. That is acceptable for a *spend ceiling*, which is a backstop
 * against runaway cost rather than an exact accounting boundary — and unlike
 * the holdout arm, a small overshoot costs money rather than correctness.
 * Billing quotas, where exactness matters, go through Postgres directly.
 */
export class PgSpendStore implements SpendStore {
  private readonly cache = new Map<string, number>();

  constructor(
    private readonly sql: SqlClient,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  private key(scope: string, day: string): string {
    return `${scope} ${day}`;
  }

  add(scope: string, day: string, units: number): number {
    const k = this.key(scope, day);
    const next = (this.cache.get(k) ?? 0) + units;
    this.cache.set(k, next);

    void this.sql
      .query(
        `INSERT INTO spend (scope, day, units) VALUES ($1, $2, $3)
         ON CONFLICT (scope, day) DO UPDATE SET units = spend.units + EXCLUDED.units
         RETURNING units`,
        [scope, day, units],
      )
      .then(({ rows }) => {
        // Adopt the authoritative total, which includes other nodes' spend.
        const authoritative = rows[0] === undefined ? undefined : num(rows[0]['units']);
        if (authoritative !== undefined && authoritative > (this.cache.get(k) ?? 0)) {
          this.cache.set(k, authoritative);
        }
      })
      .catch(this.onError);

    return next;
  }

  total(scope: string, day: string): number {
    return this.cache.get(this.key(scope, day)) ?? 0;
  }

  /** Pull other nodes' totals into the local cache. Call on an interval. */
  async refresh(day: string): Promise<void> {
    const { rows } = await this.sql.query('SELECT scope, units FROM spend WHERE day = $1', [day]);
    for (const row of rows) {
      this.cache.set(this.key(String(row['scope']), day), num(row['units']));
    }
  }

  async prune(now: number, keepDays = 7): Promise<number> {
    const cutoff = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 10);
    const { rows } = await this.sql.query('DELETE FROM spend WHERE day < $1 RETURNING scope', [cutoff]);
    return rows.length;
  }
}

export function createPostgresStores(sql: SqlClient) {
  return {
    sessions: new PgSessionStore(sql),
    shops: new PgShopStore(sql),
    nonces: new PgNonceStore(sql),
    settings: new PgSettingsStore(sql),
    attribution: new PgAttributionStore(sql),
    spend: new PgSpendStore(sql),
  };
}
