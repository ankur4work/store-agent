import { describe, expect, it } from 'vitest';
import { assignArm, bucketOf, recommendedHoldout, sessionsNeeded } from '../src/holdout.js';
import {
  MemoryAttributionStore,
  decimalStringToMinor,
  parseOrderPayload,
} from '../src/store.js';

const SHOP = 'acme.myshopify.com';

describe('holdout assignment', () => {
  it('is deterministic — the same session always gets the same arm', () => {
    // A session that flips arms mid-visit contaminates both groups.
    const first = assignArm(SHOP, 'sess_abc', 0.2);
    for (let i = 0; i < 50; i++) expect(assignArm(SHOP, 'sess_abc', 0.2)).toBe(first);
  });

  it('is uniform across many sessions', () => {
    let holdout = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (assignArm(SHOP, `s${i}`, 0.2) === 'holdout') holdout++;
    // 20% ± 1.5pp — bias here invalidates the experiment before data arrives.
    expect(holdout / n).toBeGreaterThan(0.185);
    expect(holdout / n).toBeLessThan(0.215);
  });

  it('produces buckets spread across [0,1)', () => {
    const vals = Array.from({ length: 1_000 }, (_, i) => bucketOf(SHOP, `s${i}`));
    expect(Math.min(...vals)).toBeLessThan(0.02);
    expect(Math.max(...vals)).toBeGreaterThan(0.98);
    expect(vals.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('salts by shop so the same session is independent across merchants', () => {
    // Otherwise every merchant's experiment shares the same assignment and the
    // "independent" trials are correlated.
    let differ = 0;
    for (let i = 0; i < 500; i++) {
      if (assignArm('a.myshopify.com', `s${i}`, 0.5) !== assignArm('b.myshopify.com', `s${i}`, 0.5)) {
        differ++;
      }
    }
    expect(differ).toBeGreaterThan(180); // ~50% expected
  });

  it('honours the fraction', () => {
    const count = (f: number) =>
      Array.from({ length: 5_000 }, (_, i) => assignArm(SHOP, `s${i}`, f)).filter(
        (a) => a === 'holdout',
      ).length / 5_000;
    expect(count(0.05)).toBeLessThan(count(0.5));
    expect(count(0.5)).toBeGreaterThan(0.45);
  });

  it('disables the holdout at 0 and forces it at 1', () => {
    expect(assignArm(SHOP, 'x', 0)).toBe('exposed');
    expect(assignArm(SHOP, 'x', 1)).toBe('holdout');
  });
});

/**
 * The arithmetic vendors leave out: a 5% holdout is cheap in lost sales and
 * expensive in time, because the holdout arm is the bottleneck.
 */
describe('sizing the experiment', () => {
  it('needs far more traffic at a 5% holdout than at 20%', () => {
    const at5 = sessionsNeeded(0.03, 0.2, 0.05);
    const at20 = sessionsNeeded(0.03, 0.2, 0.2);
    expect(at5).toBeGreaterThan(at20 * 3);
  });

  it('needs more traffic to detect a smaller lift', () => {
    expect(sessionsNeeded(0.03, 0.1, 0.2)).toBeGreaterThan(sessionsNeeded(0.03, 0.4, 0.2));
  });

  it('shows a 5% holdout is impractical for a small store', () => {
    // Detecting +20% on a 3% base needs hundreds of thousands of sessions.
    expect(sessionsNeeded(0.03, 0.2, 0.05)).toBeGreaterThan(200_000);
  });

  it('recommends a bigger holdout for small stores and a smaller one at scale', () => {
    expect(recommendedHoldout(2_000)).toBeGreaterThan(recommendedHoldout(1_000_000));
    expect(recommendedHoldout(1_000_000)).toBe(0.05);
    expect(recommendedHoldout(2_000)).toBe(0.5);
  });

  it('returns Infinity for impossible parameters rather than a misleading number', () => {
    expect(sessionsNeeded(0, 0.2, 0.1)).toBe(Infinity);
    expect(sessionsNeeded(0.03, 0, 0.1)).toBe(Infinity);
    expect(sessionsNeeded(0.9, 0.5, 0.1)).toBe(Infinity);
  });
});

describe('attribution store', () => {
  it('counts sessions in both arms', async () => {
    const s = new MemoryAttributionStore();
    await s.recordExposure({ shop: SHOP, sessionId: 'a', arm: 'exposed', createdAt: 1, engaged: false });
    await s.recordExposure({ shop: SHOP, sessionId: 'b', arm: 'holdout', createdAt: 1, engaged: false });
    const t = await s.totals(SHOP);
    expect(t.exposed.sessions).toBe(1);
    expect(t.holdout.sessions).toBe(1);
  });

  it('never lets a session change arm', async () => {
    const s = new MemoryAttributionStore();
    await s.recordExposure({ shop: SHOP, sessionId: 'a', arm: 'exposed', createdAt: 1, engaged: false });
    await s.recordExposure({ shop: SHOP, sessionId: 'a', arm: 'holdout', createdAt: 2, engaged: false });
    expect(await s.armOf(SHOP, 'a')).toBe('exposed');
  });

  it('attributes a conversion to the right arm', async () => {
    const s = new MemoryAttributionStore();
    await s.recordExposure({ shop: SHOP, sessionId: 'h', arm: 'holdout', createdAt: 1, engaged: false });
    await s.recordConversion({
      shop: SHOP,
      orderId: '1',
      sessionId: 'h',
      cartId: undefined,
      revenueMinor: 18_900,
      createdAt: 2,
      matchedBy: 'pixel',
    });
    const t = await s.totals(SHOP);
    expect(t.holdout.conversions).toBe(1);
    expect(t.holdout.revenueMinor).toBe(18_900);
    expect(t.exposed.conversions).toBe(0);
  });

  it('counts a holdout conversion — the reason the pixel exists', async () => {
    // There is no cart of ours for a holdout session, so the pixel is the only
    // possible join. Without it the control arm is unmeasurable.
    const s = new MemoryAttributionStore();
    await s.recordExposure({ shop: SHOP, sessionId: 'h', arm: 'holdout', createdAt: 1, engaged: false });
    await s.recordConversion({
      shop: SHOP, orderId: 'o', sessionId: 'h', cartId: undefined,
      revenueMinor: 5_000, createdAt: 2, matchedBy: 'pixel',
    });
    expect((await s.totals(SHOP)).holdout.conversions).toBe(1);
  });

  it('ignores a webhook retry rather than double-counting revenue', async () => {
    const s = new MemoryAttributionStore();
    await s.recordExposure({ shop: SHOP, sessionId: 'a', arm: 'exposed', createdAt: 1, engaged: false });
    const c = {
      shop: SHOP, orderId: 'same', sessionId: 'a', cartId: undefined,
      revenueMinor: 10_000, createdAt: 2, matchedBy: 'pixel' as const,
    };
    await s.recordConversion(c);
    await s.recordConversion(c);
    expect((await s.totals(SHOP)).exposed.conversions).toBe(1);
  });

  it('resolves a cart back to its session', async () => {
    const s = new MemoryAttributionStore();
    await s.linkCart({ shop: SHOP, sessionId: 'a', cartId: 'cart_1', createdAt: 1 });
    expect(await s.sessionForCart(SHOP, 'cart_1')).toBe('a');
    expect(await s.sessionForCart('other.myshopify.com', 'cart_1')).toBeUndefined();
  });

  it('keeps shops isolated', async () => {
    const s = new MemoryAttributionStore();
    await s.recordExposure({ shop: 'a.myshopify.com', sessionId: 'x', arm: 'exposed', createdAt: 1, engaged: false });
    expect((await s.totals('b.myshopify.com')).exposed.sessions).toBe(0);
  });

  it('tracks orders it could not attribute', async () => {
    const s = new MemoryAttributionStore();
    await s.recordConversion({
      shop: SHOP, orderId: 'x', sessionId: undefined, cartId: undefined,
      revenueMinor: 100, createdAt: 1, matchedBy: 'unmatched',
    });
    expect(await s.unmatchedCount(SHOP)).toBe(1);
  });

  it('respects a since filter', async () => {
    const s = new MemoryAttributionStore();
    await s.recordExposure({ shop: SHOP, sessionId: 'old', arm: 'exposed', createdAt: 100, engaged: false });
    await s.recordExposure({ shop: SHOP, sessionId: 'new', arm: 'exposed', createdAt: 5_000, engaged: false });
    expect((await s.totals(SHOP, 1_000)).exposed.sessions).toBe(1);
  });
});

describe('order payload parsing', () => {
  it.each([
    ['189.00', 18_900],
    ['189.5', 18_950],
    ['189', 18_900],
    ['0.99', 99],
    ['1234.56', 123_456],
    ['-10.00', -1_000],
  ])('converts %s to %i minor units', (input, expected) => {
    expect(decimalStringToMinor(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', null, undefined, {}])('returns 0 for junk: %s', (v) => {
    expect(decimalStringToMinor(v)).toBe(0);
  });

  it('avoids float drift', () => {
    // 0.1 + 0.2 territory: parsing as float and multiplying loses cents.
    expect(decimalStringToMinor('19.99')).toBe(1_999);
    expect(decimalStringToMinor('0.07')).toBe(7);
  });

  it('extracts id, total and cart token', () => {
    expect(parseOrderPayload({ id: 12345, total_price: '189.00', cart_token: 'tok' })).toEqual({
      orderId: '12345',
      revenueMinor: 18_900,
      cartToken: 'tok',
    });
  });

  it('falls back to current_total_price', () => {
    expect(parseOrderPayload({ id: 1, current_total_price: '50.00' }).revenueMinor).toBe(5_000);
  });

  it('survives an empty payload', () => {
    expect(parseOrderPayload({})).toEqual({ orderId: undefined, revenueMinor: 0, cartToken: undefined });
  });
});
