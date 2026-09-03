import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteStores,
  SqliteAttributionStore,
  SqliteNonceStore,
  SqliteSessionStore,
  SqliteSettingsStore,
  SqliteShopStore,
  openDatabase,
} from '../src/store/sqlite.js';
import { newSession } from '../src/sessions.js';
import { newShop } from '../src/shopify/shops.js';
import { DEFAULT_SETTINGS } from '../src/admin/settings.js';

function stores() {
  return createSqliteStores({ path: ':memory:' });
}

/** A real file, so we can close it and reopen to prove durability. */
function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'storeagent-'));
  return { path: join(dir, 'test.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('durability', () => {
  it('survives a restart — the entire reason this package exists', async () => {
    const { path, cleanup } = tempFile();
    try {
      // First "process".
      {
        const db = openDatabase({ path });
        await new SqliteShopStore(db).put(
          newShop('acme.myshopify.com', 'shpat_secret', 'read_products'),
        );
        await new SqliteAttributionStore(db).recordExposure({
          shop: 'acme.myshopify.com',
          sessionId: 's1',
          arm: 'holdout',
          createdAt: 1000,
          engaged: false,
        });
        db.close();
      }

      // Second "process" — a deploy, a crash, a restart.
      {
        const db = openDatabase({ path });
        // The merchant is still installed. In-memory, they would have been
        // silently logged out by a routine deploy.
        const shop = await new SqliteShopStore(db).get('acme.myshopify.com');
        expect(shop?.accessToken).toBe('shpat_secret');
        // And the experiment still knows which arm this session was in — an
        // arm that is lost cannot be reconstructed from anything.
        const arm = await new SqliteAttributionStore(db).armOf('acme.myshopify.com', 's1');
        expect(arm).toBe('holdout');
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe('shops', () => {
  it('round-trips and hides uninstalled shops', async () => {
    const { shops } = stores();
    await shops.put(newShop('acme.myshopify.com', 'shpat_x', 'read_products'));

    const got = await shops.get('acme.myshopify.com');
    expect(got?.accessToken).toBe('shpat_x');
    expect(await shops.count()).toBe(1);

    await shops.markUninstalled('acme.myshopify.com');
    expect(await shops.get('acme.myshopify.com')).toBeUndefined();
    expect(await shops.count()).toBe(0);
  });

  it('reinstall clears the uninstall marker', async () => {
    const { shops } = stores();
    await shops.put(newShop('acme.myshopify.com', 'old', 's'));
    await shops.markUninstalled('acme.myshopify.com');
    await shops.put(newShop('acme.myshopify.com', 'new', 's'));

    const got = await shops.get('acme.myshopify.com');
    expect(got?.accessToken).toBe('new');
  });

  it('purge destroys every trace of the shop, not just the token', async () => {
    const { shops, settings, attribution } = stores();
    await shops.put(newShop('acme.myshopify.com', 'shpat_x', 's'));
    await settings.put({ shop: 'acme.myshopify.com', ...DEFAULT_SETTINGS, updatedAt: 0 });
    await attribution.recordExposure({
      shop: 'acme.myshopify.com',
      sessionId: 's1',
      arm: 'exposed',
      createdAt: 1,
      engaged: true,
    });

    // GDPR shop/redact is a real deletion obligation across every table.
    await shops.purge('acme.myshopify.com');

    expect(await shops.get('acme.myshopify.com')).toBeUndefined();
    expect(await attribution.armOf('acme.myshopify.com', 's1')).toBeUndefined();
    const s = await settings.get('acme.myshopify.com');
    expect(s.updatedAt).toBe(0); // back to defaults, i.e. no stored row
  });
});

describe('nonces', () => {
  it('is single-use', async () => {
    const { nonces } = stores();
    const state = await nonces.issue('acme.myshopify.com');
    expect(await nonces.consume(state)).toBe('acme.myshopify.com');
    // A captured callback URL must not be replayable.
    expect(await nonces.consume(state)).toBeUndefined();
  });

  it('rejects an unknown state', async () => {
    const { nonces } = stores();
    expect(await nonces.consume('never-issued')).toBeUndefined();
  });

  it('rejects an expired nonce and still consumes it', async () => {
    const { db } = stores();
    const nonces = new SqliteNonceStore(db);
    const state = await nonces.issue('acme.myshopify.com');
    db.prepare('UPDATE nonces SET expires = ? WHERE state = ?').run(Date.now() - 1, state);
    expect(await nonces.consume(state)).toBeUndefined();
  });

  it('sweeps expired nonces', async () => {
    const { db } = stores();
    const nonces = new SqliteNonceStore(db);
    await nonces.issue('a.myshopify.com');
    const stale = await nonces.issue('b.myshopify.com');
    db.prepare('UPDATE nonces SET expires = ? WHERE state = ?').run(Date.now() - 1, stale);
    expect(nonces.sweep()).toBe(1);
  });
});

describe('settings', () => {
  it('returns defaults for an unknown shop', async () => {
    const { settings } = stores();
    const s = await settings.get('new.myshopify.com');
    expect(s.accentColor).toBe(DEFAULT_SETTINGS.accentColor);
    expect(s.holdoutFraction).toBe(DEFAULT_SETTINGS.holdoutFraction);
  });

  it('round-trips every field through SQLite typing', async () => {
    const { settings } = stores();
    await settings.put({
      shop: 'acme.myshopify.com',
      accentColor: '#aa0000',
      cornerRadius: 4,
      position: 'left',
      greeting: 'Hi there',
      enabled: false,
      holdoutFraction: 0.35,
      updatedAt: 0,
    });

    const s = await settings.get('acme.myshopify.com');
    expect(s.accentColor).toBe('#aa0000');
    expect(s.cornerRadius).toBe(4);
    expect(s.position).toBe('left');
    expect(s.greeting).toBe('Hi there');
    // SQLite has no boolean type; the 0/1 mapping has to survive the trip.
    expect(s.enabled).toBe(false);
    // ...and the fraction must not be rounded to an integer.
    expect(s.holdoutFraction).toBe(0.35);
  });
});

describe('sessions', () => {
  it('round-trips history and cart id', async () => {
    const { sessions } = stores();
    const s = newSession('sess1', 'acme.myshopify.com');
    s.history = [{ role: 'user', content: 'hello' }];
    s.cartId = 'gid://cart/1';
    await sessions.put(s);

    const got = await sessions.get('sess1');
    expect(got?.history).toEqual([{ role: 'user', content: 'hello' }]);
    expect(got?.cartId).toBe('gid://cart/1');
  });

  it('omits cartId rather than setting it to null', async () => {
    const { sessions } = stores();
    await sessions.put(newSession('sess1', 'acme.myshopify.com'));
    const got = await sessions.get('sess1');
    // exactOptionalPropertyTypes: absent, not `undefined`, not `null`.
    expect(got && 'cartId' in got).toBe(false);
  });

  it('caps history the same way the memory store does', async () => {
    const { sessions } = stores();
    const s = newSession('sess1', 'acme.myshopify.com');
    s.history = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    await sessions.put(s);

    const got = await sessions.get('sess1');
    expect(got?.history).toHaveLength(24);
    expect(got?.history[23]?.content).toBe('m39'); // kept the newest
  });

  it('expires past the TTL', async () => {
    const { db } = stores();
    const sessions = new SqliteSessionStore(db, 50);
    await sessions.put(newSession('sess1', 'acme.myshopify.com'));
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now() - 1000, 'sess1');

    expect(await sessions.get('sess1')).toBeUndefined();
    expect(await sessions.size()).toBe(0);
  });
});

describe('attribution', () => {
  const shop = 'acme.myshopify.com';

  it('never lets an arm change once assigned', async () => {
    const { attribution } = stores();
    await attribution.recordExposure({ shop, sessionId: 's1', arm: 'holdout', createdAt: 1, engaged: false });
    await attribution.recordExposure({ shop, sessionId: 's1', arm: 'exposed', createdAt: 2, engaged: false });

    // A session that flips arms contaminates both groups and silently
    // invalidates the experiment.
    expect(await attribution.armOf(shop, 's1')).toBe('holdout');
  });

  it('counts a retried order webhook exactly once', async () => {
    const { attribution } = stores();
    await attribution.recordExposure({ shop, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    const order = {
      shop,
      orderId: 'order-1',
      sessionId: 's1',
      cartId: undefined,
      revenueMinor: 18900,
      createdAt: 5,
      matchedBy: 'pixel' as const,
    };
    await attribution.recordConversion(order);
    await attribution.recordConversion(order); // Shopify retries

    const { exposed } = await attribution.totals(shop);
    expect(exposed.conversions).toBe(1);
    expect(exposed.revenueMinor).toBe(18900);
  });

  it('upgrades an unmatched order when the session later arrives', async () => {
    const { attribution } = stores();
    await attribution.recordExposure({ shop, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    // The webhook can beat the pixel; the order lands unattributed first.
    await attribution.recordConversion({
      shop, orderId: 'order-1', sessionId: undefined, cartId: 'c1',
      revenueMinor: 18900, createdAt: 5, matchedBy: 'unmatched',
    });
    expect(await attribution.unmatchedCount(shop)).toBe(1);

    await attribution.recordConversion({
      shop, orderId: 'order-1', sessionId: 's1', cartId: 'c1',
      revenueMinor: 18900, createdAt: 5, matchedBy: 'cart',
    });

    expect(await attribution.unmatchedCount(shop)).toBe(0);
    const { exposed } = await attribution.totals(shop);
    expect(exposed.conversions).toBe(1);
  });

  it('splits totals by arm', async () => {
    const { attribution } = stores();
    await attribution.recordExposure({ shop, sessionId: 'e1', arm: 'exposed', createdAt: 1, engaged: true });
    await attribution.recordExposure({ shop, sessionId: 'e2', arm: 'exposed', createdAt: 1, engaged: true });
    await attribution.recordExposure({ shop, sessionId: 'h1', arm: 'holdout', createdAt: 1, engaged: false });
    await attribution.recordConversion({
      shop, orderId: 'o1', sessionId: 'e1', cartId: undefined,
      revenueMinor: 10000, createdAt: 2, matchedBy: 'pixel',
    });
    await attribution.recordConversion({
      shop, orderId: 'o2', sessionId: 'h1', cartId: undefined,
      revenueMinor: 5000, createdAt: 2, matchedBy: 'pixel',
    });

    const { exposed, holdout } = await attribution.totals(shop);
    expect(exposed).toEqual({ sessions: 2, conversions: 1, revenueMinor: 10000 });
    // The holdout arm must be countable — it is the whole point of the pixel.
    expect(holdout).toEqual({ sessions: 1, conversions: 1, revenueMinor: 5000 });
  });

  it('ignores orders from sessions it never saw', async () => {
    const { attribution } = stores();
    await attribution.recordExposure({ shop, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    await attribution.recordConversion({
      shop, orderId: 'o1', sessionId: 'ghost', cartId: undefined,
      revenueMinor: 9999, createdAt: 2, matchedBy: 'pixel',
    });

    const { exposed, holdout } = await attribution.totals(shop);
    expect(exposed.conversions).toBe(0);
    expect(holdout.conversions).toBe(0);
  });

  it('keeps shops isolated from each other', async () => {
    const { attribution } = stores();
    await attribution.recordExposure({ shop, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: true });
    await attribution.recordExposure({
      shop: 'other.myshopify.com', sessionId: 's1', arm: 'holdout', createdAt: 1, engaged: false,
    });

    expect(await attribution.armOf(shop, 's1')).toBe('exposed');
    expect(await attribution.armOf('other.myshopify.com', 's1')).toBe('holdout');
    expect((await attribution.totals(shop)).exposed.sessions).toBe(1);
  });

  it('resolves a cart back to its session', async () => {
    const { attribution } = stores();
    await attribution.linkCart({ shop, sessionId: 's1', cartId: 'c1', createdAt: 1 });
    expect(await attribution.sessionForCart(shop, 'c1')).toBe('s1');
    expect(await attribution.sessionForCart(shop, 'nope')).toBeUndefined();
  });

  it('honours the since filter', async () => {
    const { attribution } = stores();
    await attribution.recordExposure({ shop, sessionId: 'old', arm: 'exposed', createdAt: 100, engaged: true });
    await attribution.recordExposure({ shop, sessionId: 'new', arm: 'exposed', createdAt: 900, engaged: true });
    expect((await attribution.totals(shop, 500)).exposed.sessions).toBe(1);
  });
});

describe('parity with the in-memory stores', () => {
  it('markEngaged records engagement without changing the arm', async () => {
    const { attribution } = stores();
    const shop = 'acme.myshopify.com';
    await attribution.recordExposure({ shop, sessionId: 's1', arm: 'exposed', createdAt: 1, engaged: false });
    await attribution.markEngaged(shop, 's1');
    expect(await attribution.armOf(shop, 's1')).toBe('exposed');
  });

  it('settings put stamps updatedAt', async () => {
    const { db } = stores();
    const settings = new SqliteSettingsStore(db);
    await settings.put({ shop: 'a.myshopify.com', ...DEFAULT_SETTINGS, updatedAt: 0 });
    expect((await settings.get('a.myshopify.com')).updatedAt).toBeGreaterThan(0);
  });
});
