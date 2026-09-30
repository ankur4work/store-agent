import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MemoryAttributionStore, FUNNEL_STEPS, isFunnelStep } from '@storeagent/attribution';
import { openDatabase, SqliteAttributionStore } from '../src/store/sqlite.js';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';

/**
 * The funnel, which is the number that renews a subscription.
 *
 * Two properties matter more than the arithmetic:
 *
 *   1. It counts **people, not events**. A shopper who taps six cards is one
 *      person who tapped a card — otherwise the funnel widens in the middle,
 *      which is nonsense a merchant would rightly stop trusting.
 *   2. It is split by **arm**. A funnel alone is a shape with no scale: "18% of
 *      people shown cards bought something" could be the assistant working, or
 *      could be what this shop does anyway. The held-back group is the only
 *      thing that makes it a statement about us.
 */

const stores = [
  ['memory', () => new MemoryAttributionStore()],
  ['sqlite', () => new SqliteAttributionStore(openDatabase({ path: ':memory:' }))],
] as const;

for (const [name, make] of stores) {
  describe(`${name} store`, () => {
    it('counts a session once per step, however often it happens', async () => {
      const store = make();
      await store.recordExposure({
        shop: 's.myshopify.com',
        sessionId: 'a',
        arm: 'exposed',
        createdAt: 1,
        engaged: false,
      });
      // Six taps by one person.
      for (let i = 0; i < 6; i++) await store.recordStep('s.myshopify.com', 'a', 'card_tapped');

      const f = await store.funnel('s.myshopify.com');
      expect(f.exposed.cardTapped).toBe(1);
    });

    it('never counts a step for a session it never saw an exposure for', async () => {
      // That shopper is in neither arm, and the arms are the whole point.
      const store = make();
      await store.recordStep('s.myshopify.com', 'ghost', 'cart_add');
      const f = await store.funnel('s.myshopify.com');
      expect(f.exposed.sessions).toBe(0);
      expect(f.exposed.cartAdd).toBe(0);
    });

    it('splits every step by arm', async () => {
      const store = make();
      const shop = 's.myshopify.com';
      await store.recordExposure({ shop, sessionId: 'x', arm: 'exposed', createdAt: 1, engaged: true });
      await store.recordExposure({ shop, sessionId: 'y', arm: 'holdout', createdAt: 1, engaged: false });
      await store.recordStep(shop, 'x', 'cards_shown');
      await store.recordStep(shop, 'x', 'cart_add');

      const f = await store.funnel(shop);
      expect(f.exposed).toMatchObject({ sessions: 1, engaged: 1, cardsShown: 1, cartAdd: 1 });
      expect(f.holdout).toMatchObject({ sessions: 1, engaged: 0, cardsShown: 0, cartAdd: 0 });
    });

    it('counts a purchase in either arm, which is the comparison', async () => {
      /**
       * The holdout has no cards and no taps by definition — those shoppers never
       * saw the assistant. Sessions and purchases are the two rows it DOES have,
       * and they are the entire measurement.
       */
      const store = make();
      const shop = 's.myshopify.com';
      for (const [sessionId, arm] of [['x', 'exposed'], ['y', 'holdout']] as const) {
        await store.recordExposure({ shop, sessionId, arm, createdAt: 1, engaged: true });
        await store.recordConversion({
          shop,
          orderId: `o-${sessionId}`,
          sessionId,
          cartId: undefined,
          revenueMinor: 5000,
          createdAt: 2,
          matchedBy: 'pixel',
        });
      }
      const f = await store.funnel(shop);
      expect(f.exposed.converted).toBe(1);
      expect(f.holdout.converted).toBe(1);
    });

    it('counts one purchase per shopper, not per order', async () => {
      // Two orders in one session is one person who bought.
      const store = make();
      const shop = 's.myshopify.com';
      await store.recordExposure({ shop, sessionId: 'x', arm: 'exposed', createdAt: 1, engaged: true });
      for (const orderId of ['o1', 'o2']) {
        await store.recordConversion({
          shop,
          orderId,
          sessionId: 'x',
          cartId: undefined,
          revenueMinor: 1000,
          createdAt: 2,
          matchedBy: 'pixel',
        });
      }
      const f = await store.funnel(shop);
      expect(f.exposed.converted).toBe(1);
    });

    it('keeps shops apart', async () => {
      const store = make();
      await store.recordExposure({
        shop: 'a.myshopify.com',
        sessionId: 'x',
        arm: 'exposed',
        createdAt: 1,
        engaged: true,
      });
      await store.recordStep('a.myshopify.com', 'x', 'cart_add');
      const other = await store.funnel('b.myshopify.com');
      expect(other.exposed.sessions).toBe(0);
    });

    it('honours a time window', async () => {
      const store = make();
      const shop = 's.myshopify.com';
      await store.recordExposure({ shop, sessionId: 'old', arm: 'exposed', createdAt: 100, engaged: true });
      await store.recordExposure({ shop, sessionId: 'new', arm: 'exposed', createdAt: 900, engaged: true });
      const f = await store.funnel(shop, 500);
      expect(f.exposed.sessions).toBe(1);
    });

    it('reports zeroes rather than throwing on an untouched shop', async () => {
      const store = make();
      const f = await store.funnel('fresh.myshopify.com');
      expect(f.exposed.sessions).toBe(0);
      expect(f.holdout.converted).toBe(0);
    });
  });
}

describe('the step a client is allowed to report', () => {
  let server: Server;
  let base: string;
  let attribution: MemoryAttributionStore;

  beforeEach(async () => {
    attribution = new MemoryAttributionStore();
    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-test', PORT: '0' }),
      attribution,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const send = (body: unknown) =>
    fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function seed(sessionId: string) {
    await attribution.recordExposure({
      shop: 'demo.local',
      sessionId,
      arm: 'exposed',
      createdAt: 1,
      engaged: true,
    });
  }

  it('accepts a card tap, which the server cannot observe', async () => {
    // Following a card is a navigation away from us.
    await seed('s1');
    const res = await send({ sessionId: 's1', step: 'card_tapped' });
    expect(res.status).toBe(204);
    expect((await attribution.funnel('demo.local')).exposed.cardTapped).toBe(1);
  });

  it('refuses the steps the server records for itself', async () => {
    /**
     * `cards_shown` and `cart_add` are recorded from things the server DID.
     * Accepting them here would let a client inflate its own funnel, and a
     * merchant would be making decisions on a number a script wrote.
     */
    await seed('s1');
    for (const step of ['cards_shown', 'cart_add']) {
      expect((await send({ sessionId: 's1', step })).status).toBe(204);
    }
    const f = await attribution.funnel('demo.local');
    expect(f.exposed.cardsShown).toBe(0);
    expect(f.exposed.cartAdd).toBe(0);
  });

  it('ignores a step name that is not one of ours', async () => {
    await seed('s1');
    for (const step of ['bought_everything', '../../admin', '', null, 42]) {
      expect((await send({ sessionId: 's1', step })).status).toBe(204);
    }
    expect((await attribution.funnel('demo.local')).exposed.cardTapped).toBe(0);
  });

  it('needs a session, because a step with no shopper is not a step', async () => {
    expect((await send({ step: 'card_tapped' })).status).toBe(204);
    expect((await send({ sessionId: '', step: 'card_tapped' })).status).toBe(204);
    expect((await attribution.funnel('demo.local')).exposed.cardTapped).toBe(0);
  });

  it('answers a malformed beacon without an error', async () => {
    // Analytics must never cost a shopper anything, including an error.
    const res = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(204);
  });
});

describe('the closed list of steps', () => {
  it('recognises exactly what it should', () => {
    for (const s of FUNNEL_STEPS) expect(isFunnelStep(s)).toBe(true);
    for (const s of ['exposed', 'engaged', 'converted', 'anything', 42, null, undefined]) {
      expect(isFunnelStep(s)).toBe(false);
    }
  });

  it('does not duplicate what the exposure row already holds', () => {
    // `exposed` and `engaged` live on the exposure, so there is one definition of
    // each rather than two that can disagree.
    expect(FUNNEL_STEPS).not.toContain('exposed');
    expect(FUNNEL_STEPS).not.toContain('engaged');
  });
});
