import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { Arm, ArmTotals, AttributionStore, CartLink, Conversion, Exposure } from '@storeagent/attribution';
import type { Message } from '@storeagent/orchestrator';
import type { Session, SessionStore } from '../sessions.js';
import type { NonceStore, Shop, ShopStore } from '../shopify/shops.js';
import { DEFAULT_SETTINGS, type SettingsStore, type ShopSettings } from '../admin/settings.js';
import { randomBytes } from 'node:crypto';

/**
 * Durable storage.
 *
 * Everything was in-memory, which is fine on a laptop and unacceptable in
 * production: a restart would drop every merchant's OAuth token — logging them
 * all out — and destroy the attribution experiment. A cache can be rebuilt; an
 * experiment cannot. That made persistence the one genuine blocker to
 * deploying at all.
 *
 * **SQLite via `node:sqlite`**, not Postgres, deliberately:
 *   - zero dependencies and no server to operate, so the deploy stays a single
 *     container plus a mounted volume
 *   - genuinely durable with WAL, which is the property we actually need
 *   - testable here and now, where a Postgres would not be
 *
 * The limit is real and worth stating: SQLite is one writer, so this is a
 * single-node design. `ARCHITECTURE §3` wants many gateway nodes, and at that
 * point this file gets a Postgres sibling. Every store interface is unchanged,
 * so that is an implementation swap, not a refactor.
 */

export interface SqliteOptions {
  /** File path, or `:memory:` for tests. */
  readonly path: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS shops (
  shop           TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  installed_at   INTEGER NOT NULL,
  uninstalled_at INTEGER
);

CREATE TABLE IF NOT EXISTS nonces (
  state   TEXT PRIMARY KEY,
  shop    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  shop          TEXT PRIMARY KEY,
  accent_color  TEXT NOT NULL,
  corner_radius INTEGER NOT NULL,
  position      TEXT NOT NULL,
  greeting      TEXT NOT NULL,
  enabled       INTEGER NOT NULL,
  holdout       REAL NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  shop        TEXT NOT NULL,
  history     TEXT NOT NULL,
  cart_id     TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS exposures (
  shop       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  arm        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  engaged    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop, session_id)
);
CREATE INDEX IF NOT EXISTS exposures_shop_time ON exposures(shop, created_at);

CREATE TABLE IF NOT EXISTS carts (
  shop       TEXT NOT NULL,
  cart_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (shop, cart_id)
);

CREATE TABLE IF NOT EXISTS conversions (
  shop         TEXT NOT NULL,
  order_id     TEXT NOT NULL,
  session_id   TEXT,
  cart_id      TEXT,
  revenue      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  matched_by   TEXT NOT NULL,
  PRIMARY KEY (shop, order_id)
);
CREATE INDEX IF NOT EXISTS conversions_shop_time ON conversions(shop, created_at);
`;

/**
 * Loaded through `createRequire` rather than a static import.
 *
 * Vite 5 strips the `node:` prefix and then asks `module.builtinModules`
 * whether `sqlite` exists. It does not — SQLite is reachable only as
 * `node:sqlite` — so Vite concludes it is an npm package and fails to resolve
 * it, which breaks the test runner. Node resolves it correctly at runtime, and
 * the type import above is erased at compile time, so this costs nothing.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: Database } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export function openDatabase(opts: SqliteOptions): DatabaseSync {
  const db = new Database(opts.path) as DatabaseSync;
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------

export class SqliteShopStore implements ShopStore {
  constructor(private readonly db: DatabaseSync) {}

  async get(shop: string): Promise<Shop | undefined> {
    const row = this.db
      .prepare('SELECT * FROM shops WHERE shop = ? AND uninstalled_at IS NULL')
      .get(shop) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      shop: String(row['shop']),
      accessToken: String(row['access_token']),
      scopes: String(row['scopes']),
      installedAt: Number(row['installed_at']),
    };
  }

  async put(shop: Shop): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO shops (shop, access_token, scopes, installed_at, uninstalled_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(shop) DO UPDATE SET
           access_token = excluded.access_token,
           scopes = excluded.scopes,
           installed_at = excluded.installed_at,
           uninstalled_at = NULL`,
      )
      .run(shop.shop, shop.accessToken, shop.scopes, shop.installedAt);
  }

  async markUninstalled(shop: string): Promise<void> {
    this.db.prepare('UPDATE shops SET uninstalled_at = ? WHERE shop = ?').run(Date.now(), shop);
  }

  /** GDPR shop/redact — everything for this shop, not just the token. */
  async purge(shop: string): Promise<void> {
    for (const t of ['shops', 'settings', 'sessions', 'exposures', 'carts', 'conversions']) {
      this.db.prepare(`DELETE FROM ${t} WHERE shop = ?`).run(shop);
    }
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM shops WHERE uninstalled_at IS NULL').get() as {
      n: number;
    };
    return Number(row.n);
  }
}

export class SqliteNonceStore implements NonceStore {
  constructor(private readonly db: DatabaseSync) {}

  async issue(shop: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO nonces (state, shop, expires) VALUES (?, ?, ?)')
      .run(state, shop, Date.now() + 10 * 60 * 1000);
    return state;
  }

  async consume(state: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT shop, expires FROM nonces WHERE state = ?').get(state) as
      | { shop: string; expires: number }
      | undefined;
    // Deleted whether or not it was valid: single use means single use.
    this.db.prepare('DELETE FROM nonces WHERE state = ?').run(state);
    if (row === undefined || Date.now() > Number(row.expires)) return undefined;
    return String(row.shop);
  }

  sweep(): number {
    return Number(this.db.prepare('DELETE FROM nonces WHERE expires < ?').run(Date.now()).changes);
  }
}

export class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  async get(shop: string): Promise<ShopSettings> {
    const row = this.db.prepare('SELECT * FROM settings WHERE shop = ?').get(shop) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return { shop, ...DEFAULT_SETTINGS, updatedAt: 0 };
    return {
      shop,
      accentColor: String(row['accent_color']),
      cornerRadius: Number(row['corner_radius']),
      position: row['position'] === 'left' ? 'left' : 'right',
      greeting: String(row['greeting']),
      enabled: Number(row['enabled']) === 1,
      holdoutFraction: Number(row['holdout']),
      updatedAt: Number(row['updated_at']),
    };
  }

  async put(s: ShopSettings): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO settings (shop, accent_color, corner_radius, position, greeting, enabled, holdout, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop) DO UPDATE SET
           accent_color = excluded.accent_color, corner_radius = excluded.corner_radius,
           position = excluded.position, greeting = excluded.greeting,
           enabled = excluded.enabled, holdout = excluded.holdout,
           updated_at = excluded.updated_at`,
      )
      .run(
        s.shop,
        s.accentColor,
        s.cornerRadius,
        s.position,
        s.greeting,
        s.enabled ? 1 : 0,
        s.holdoutFraction,
        Date.now(),
      );
  }
}

export class SqliteSessionStore implements SessionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly maxHistory = 24,
  ) {}

  async get(id: string): Promise<Session | undefined> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    if (Date.now() - Number(row['updated_at']) > this.ttlMs) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return undefined;
    }
    const cartId = row['cart_id'];
    return {
      id,
      shopDomain: String(row['shop']),
      history: JSON.parse(String(row['history'])) as Message[],
      ...(cartId === null || cartId === undefined ? {} : { cartId: String(cartId) }),
      updatedAt: Number(row['updated_at']),
    };
  }

  async put(session: Session): Promise<void> {
    session.updatedAt = Date.now();
    if (session.history.length > this.maxHistory) {
      session.history = session.history.slice(-this.maxHistory);
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id, shop, history, cart_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET history = excluded.history,
           cart_id = excluded.cart_id, updated_at = excluded.updated_at`,
      )
      .run(
        session.id,
        session.shopDomain,
        JSON.stringify(session.history),
        session.cartId ?? null,
        session.updatedAt,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  async size(): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE updated_at > ?')
      .get(Date.now() - this.ttlMs) as { n: number };
    return Number(row.n);
  }

  sweep(): number {
    return Number(
      this.db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(Date.now() - this.ttlMs).changes,
    );
  }
}

export class SqliteAttributionStore implements AttributionStore {
  constructor(private readonly db: DatabaseSync) {}

  async recordExposure(e: Exposure): Promise<void> {
    // DO NOTHING on conflict: an arm must never change once assigned, or the
    // session contaminates both groups.
    this.db
      .prepare(
        `INSERT INTO exposures (shop, session_id, arm, created_at, engaged) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(shop, session_id) DO NOTHING`,
      )
      .run(e.shop, e.sessionId, e.arm, e.createdAt, e.engaged ? 1 : 0);
  }

  async markEngaged(shop: string, sessionId: string): Promise<void> {
    this.db
      .prepare('UPDATE exposures SET engaged = 1 WHERE shop = ? AND session_id = ?')
      .run(shop, sessionId);
  }

  async linkCart(link: CartLink): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO carts (shop, cart_id, session_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(shop, cart_id) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(link.shop, link.cartId, link.sessionId, link.createdAt);
  }

  async sessionForCart(shop: string, cartId: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT session_id FROM carts WHERE shop = ? AND cart_id = ?')
      .get(shop, cartId) as { session_id: string } | undefined;
    return row === undefined ? undefined : String(row.session_id);
  }

  async armOf(shop: string, sessionId: string): Promise<Arm | undefined> {
    const row = this.db
      .prepare('SELECT arm FROM exposures WHERE shop = ? AND session_id = ?')
      .get(shop, sessionId) as { arm: string } | undefined;
    return row === undefined ? undefined : (String(row.arm) as Arm);
  }

  async recordConversion(c: Conversion): Promise<void> {
    // Webhooks retry; the primary key makes double-counting impossible rather
    // than merely unlikely.
    this.db
      .prepare(
        `INSERT INTO conversions (shop, order_id, session_id, cart_id, revenue, created_at, matched_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop, order_id) DO UPDATE SET
           session_id = COALESCE(conversions.session_id, excluded.session_id),
           revenue    = MAX(conversions.revenue, excluded.revenue),
           matched_by = CASE WHEN conversions.matched_by = 'unmatched'
                             THEN excluded.matched_by ELSE conversions.matched_by END`,
      )
      .run(
        c.shop,
        c.orderId,
        c.sessionId ?? null,
        c.cartId ?? null,
        c.revenueMinor,
        c.createdAt,
        c.matchedBy,
      );
  }

  async totals(shop: string, sinceMs = 0): Promise<{ exposed: ArmTotals; holdout: ArmTotals }> {
    const empty = (): ArmTotals => ({ sessions: 0, conversions: 0, revenueMinor: 0 });
    const out: Record<string, ArmTotals> = { exposed: empty(), holdout: empty() };

    for (const row of this.db
      .prepare('SELECT arm, COUNT(*) AS n FROM exposures WHERE shop = ? AND created_at >= ? GROUP BY arm')
      .all(shop, sinceMs) as { arm: string; n: number }[]) {
      const arm = out[String(row.arm)];
      if (arm) out[String(row.arm)] = { ...arm, sessions: Number(row.n) };
    }

    for (const row of this.db
      .prepare(
        `SELECT e.arm AS arm, COUNT(*) AS n, COALESCE(SUM(c.revenue), 0) AS revenue
           FROM conversions c
           JOIN exposures e ON e.shop = c.shop AND e.session_id = c.session_id
          WHERE c.shop = ? AND c.created_at >= ? AND c.session_id IS NOT NULL
          GROUP BY e.arm`,
      )
      .all(shop, sinceMs) as { arm: string; n: number; revenue: number }[]) {
      const arm = out[String(row.arm)];
      if (arm) {
        out[String(row.arm)] = { ...arm, conversions: Number(row.n), revenueMinor: Number(row.revenue) };
      }
    }

    return { exposed: out['exposed']!, holdout: out['holdout']! };
  }

  async unmatchedCount(shop: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM conversions WHERE shop = ? AND matched_by = 'unmatched'")
      .get(shop) as { n: number };
    return Number(row.n);
  }
}

/** All five stores over one database file. */
export function createSqliteStores(opts: SqliteOptions) {
  const db = openDatabase(opts);
  return {
    db,
    sessions: new SqliteSessionStore(db),
    shops: new SqliteShopStore(db),
    nonces: new SqliteNonceStore(db),
    settings: new SqliteSettingsStore(db),
    attribution: new SqliteAttributionStore(db),
  };
}
