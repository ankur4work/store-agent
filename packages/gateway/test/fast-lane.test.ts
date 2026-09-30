import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway, money } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Telemetry } from '../src/observability/telemetry.js';
import { MemorySessionStore, newSession } from '../src/sessions.js';

/**
 * The deterministic lane, over real HTTP.
 *
 * The claim being tested is not "it produces nice text" — it is that these
 * turns cost **no model tokens and no upstream call**, and that the lane hands
 * back anything it cannot answer exactly. A fast wrong answer is worse than a
 * slow right one, because it arrives sounding certain and leaves no trace that
 * a model was skipped.
 *
 * There is no model stub here on purpose: the gateway is built with a key that
 * would fail if anything reached OpenAI, so a turn that tried would surface as
 * an error rather than as a silent pass.
 */

const blueTee = {
  id: 'gid://shopify/Product/1',
  title: 'Blue Tee',
  variants: [{ id: 'v1', price: 1500, available: true }],
};
const blueCoat = {
  id: 'gid://shopify/Product/2',
  title: 'Blue Coat',
  variants: [{ id: 'v2', price: 18000, available: true }],
};
const redTee = {
  id: 'gid://shopify/Product/3',
  title: 'Red Tee',
  variants: [{ id: 'v3', price: 1200, available: true }],
};

describe('turns that need no model', () => {
  let server: Server;
  let base: string;
  let telemetry: Telemetry;
  let sessions: MemorySessionStore;

  beforeEach(async () => {
    telemetry = new Telemetry();
    sessions = new MemorySessionStore();
    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-would-fail-if-used', PORT: '0' }),
      telemetry,
      sessions,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Seed a session that already has products on screen. */
  async function seed(products: unknown[], id = 'sess-1'): Promise<string> {
    const s = newSession(id, 'demo.local');
    s.products = products;
    await sessions.put(s);
    return id;
  }

  /** Drive a turn and collect the SSE events it emitted. */
  async function turn(message: string, sessionId?: string, voice = false) {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId, voice }),
    });
    const text = await res.text();
    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)/g)].map((m) => ({
      event: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }));
    return { status: res.status, events, raw: text };
  }

  it('narrows the products on screen without calling a model', async () => {
    const id = await seed([blueCoat, redTee, blueTee]);
    const { events } = await turn('just the blue ones', id);

    const done = events.find((e) => e.event === 'done');
    expect(done?.data['fast']).toBe('filter');
    expect(done?.data['grounded']).toBe(true);
    expect(done?.data['reply']).toBe('2 in blue.');

    const products = events.find((e) => e.event === 'products');
    const titles = (products?.data['products'] as { title: string }[]).map((p) => p.title);
    expect(titles).toEqual(['Blue Coat', 'Blue Tee']);

    // The whole point: no tokens were spent.
    expect(telemetry.tokens.total()).toBe(0);
    expect(telemetry.fastLane.get({ shop: 'demo.local', intent: 'filter' })).toBe(1);
  });

  it('is fast, because there is nothing upstream in the path', async () => {
    const id = await seed([blueCoat, redTee, blueTee]);
    const started = Date.now();
    await turn('just the blue ones', id);
    // Generous for a loaded CI box; a model turn is seconds, not milliseconds.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('ranks rather than cuts when asked for cheaper', async () => {
    const id = await seed([blueCoat, redTee, blueTee]);
    const { events } = await turn('cheaper ones', id);
    const titles = (
      events.find((e) => e.event === 'products')?.data['products'] as { title: string }[]
    ).map((p) => p.title);
    // Every option still visible, cheapest first.
    expect(titles).toEqual(['Red Tee', 'Blue Tee', 'Blue Coat']);
  });

  it('remembers the narrowed set, so narrowing composes', async () => {
    const id = await seed([blueCoat, redTee, blueTee]);
    await turn('just the blue ones', id);
    const { events } = await turn('only the ones under twenty', id);
    const titles = (
      events.find((e) => e.event === 'products')?.data['products'] as { title: string }[]
    ).map((p) => p.title);
    expect(titles).toEqual(['Blue Tee']);
  });

  /**
   * The case the lane must not get wrong.
   *
   * An empty filter means "I cannot answer from what is on screen", not "the
   * store has none" — the blue one may exist and simply not be among the six
   * results we showed. So the turn goes to the model, which here means it fails
   * on the unusable API key rather than confidently reporting nothing.
   */
  it('hands over rather than claiming nothing matches', async () => {
    const id = await seed([redTee]);
    const { events } = await turn('just the blue ones', id);

    const done = events.find((e) => e.event === 'done');
    // Whatever happened, it was NOT a fast-lane answer saying zero matched.
    expect(done?.data['fast']).toBeUndefined();
    expect(String(done?.data['reply'] ?? '')).not.toMatch(/0 in blue|no matches/i);
    expect(telemetry.fastLane.get({ shop: 'demo.local', intent: 'filter_declined' })).toBe(1);
  });

  it('counts a decline, so wrong patterns are visible', async () => {
    // A lane that keeps declining has patterns that are wrong, and counting only
    // its successes would make that look like idleness.
    const id = await seed([redTee]);
    await turn('just the blue ones', id);
    expect(telemetry.fastLane.get({ shop: 'demo.local', intent: 'filter_declined' })).toBe(1);
  });

  it('answers an empty cart exactly, with no round trip', async () => {
    const { events } = await turn('what is in my cart');
    const done = events.find((e) => e.event === 'done');
    expect(done?.data['fast']).toBe('cart');
    expect(done?.data['reply']).toBe('Your cart is empty.');
    expect(telemetry.tokens.total()).toBe(0);
  });

  it('speaks on a voice turn', async () => {
    /**
     * The degraded rung did not do this, and a voice turn there put text on a
     * panel the shopper is not necessarily looking at and said nothing. Both
     * model-free paths now speak.
     */
    const { events } = await turn('what is in my cart', undefined, true);
    expect(events.find((e) => e.event === 'speak')?.data['text']).toBe('Your cart is empty.');
  });

  it('does not intercept a real question', async () => {
    // "do you have these in blue" names a colour and is an existence question;
    // it needs a search, not a filter over six results.
    const id = await seed([redTee, blueTee]);
    await turn('do you have these in blue', id);
    expect(telemetry.fastLane.total()).toBe(0);
  });
});

describe('money', () => {
  it('never rounds, and always shows both decimal places', () => {
    /**
     * The exact mistake that retracted live answers twice: the model wrote $785
     * for a price of 78595 minor and the tripwire killed the stream. There is no
     * model on the fast-lane path, so nothing downstream would catch a rounding
     * bug here.
     */
    expect(money(78595, 'USD')).toBe('$785.95');
    expect(money(78500, 'USD')).toBe('$785.00');
    expect(money(5, 'USD')).toBe('$0.05');
  });

  it('uses the symbol where there is one', () => {
    expect(money(1000, 'GBP')).toBe('£10.00');
    expect(money(1000, 'EUR')).toBe('€10.00');
    expect(money(1000, 'INR')).toBe('₹10.00');
  });

  it('prints the code rather than guessing a symbol', () => {
    // "$974.95" for kronor is wrong; "974.95 SEK" is merely plain.
    expect(money(97495, 'SEK')).toBe('974.95 SEK');
    expect(money(100, 'ZAR')).toBe('1.00 ZAR');
  });

  it('defaults to dollars when the cart did not say', () => {
    expect(money(1234)).toBe('$12.34');
  });
});

/**
 * Chips, which are the visible half of the deterministic lane.
 *
 * They are derived from the products actually on screen and written so that
 * tapping one is answered without a model. That makes them the one part of the
 * interface where "what should I ask next" and "what can be answered for free"
 * are the same question.
 */
describe('the next narrowing it offers', () => {
  let server: Server;
  let base: string;
  let telemetry: Telemetry;
  let sessions: MemorySessionStore;

  beforeEach(async () => {
    telemetry = new Telemetry();
    sessions = new MemorySessionStore();
    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-would-fail-if-used', PORT: '0' }),
      telemetry,
      sessions,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function chipsFor(products: unknown[], message: string) {
    const s = newSession('chips-1', 'demo.local');
    s.products = products;
    await sessions.put(s);
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId: 'chips-1' }),
    });
    const text = await res.text();
    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)/g)].map((m) => ({
      event: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }));
    const chips = events.find((e) => e.event === 'chips');
    return (chips?.data['chips'] ?? []) as { label: string; message: string }[];
  }

  it('offers narrowing derived from what is on screen', async () => {
    const chips = await chipsFor([blueCoat, redTee, blueTee], 'cheaper ones');
    expect(chips.length).toBeGreaterThan(0);
    // Every label is readable; every message is what gets sent back.
    for (const c of chips) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.message.length).toBeGreaterThan(0);
    }
  });

  it('labels a price threshold in the shop’s own currency, unrounded', async () => {
    const priced = [
      { title: 'A', variants: [{ price: { amount: 1250, currency: 'GBP' } }] },
      { title: 'B', variants: [{ price: { amount: 9900, currency: 'GBP' } }] },
    ];
    const chips = await chipsFor(priced, 'cheaper ones');
    const under = chips.find((c) => c.label.startsWith('Under'));
    expect(under?.label).toBe('Under £12.50');
  });

  it('every chip it offers can be answered without a model', async () => {
    // The contract that makes them free. A chip that stopped classifying would
    // silently start costing a turn.
    const chips = await chipsFor([blueCoat, redTee, blueTee], 'cheaper ones');
    const before = telemetry.fastLane.total();
    // 'More like this' is deliberately a search, and only appears for a single
    // product; this set has three, so every chip here narrows.
    for (const chip of chips) {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: chip.message, sessionId: 'chips-1' }),
      });
      await res.text();
    }
    expect(telemetry.fastLane.total()).toBe(before + chips.length);
    expect(telemetry.tokens.total()).toBe(0);
  });

  it('offers to widen when a single product leaves nothing to narrow', async () => {
    // The chip row was empty exactly where a shopper most needs a next step.
    const chips = await chipsFor([blueTee], 'cheaper ones');
    expect(chips).toEqual([{ label: 'More like this', message: 'something like the Blue Tee' }]);
  });
});
