import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Telemetry } from '../src/observability/telemetry.js';
import { MemorySessionStore } from '../src/sessions.js';

/**
 * The page-fact lane, wired up, over real HTTP.
 *
 * `page-facts.test.ts` in the orchestrator proves the sentences are right. This
 * file proves the thing the unit tests structurally cannot: that the lane is
 * actually *reached*, that what it claims about its own answer is true, and —
 * most importantly — that **declining hands the turn to the model** rather than
 * dropping it. Every guard in page-facts.ts is worthless if the caller treats
 * `undefined` as "say nothing".
 *
 * ## Why the storefront is stubbed at `fetch`
 *
 * The lane needs a UCP client, and `ucpFor()` builds one per shop from the
 * domain — there is no injection seam, by design: the endpoint is derived public
 * storefront data and a seam would be a way to point a merchant's assistant at
 * someone else's catalog. So the stub goes where the real boundary is, at the
 * transport's `fetch`, which means these tests exercise the whole chain the live
 * store does: UcpTransport, the `get_product` fallback, and `sameProductId`.
 *
 * The stub also **blocks every other host**, which is what makes "no model was
 * called" an assertion rather than a hope: a turn that reaches OpenAI is counted
 * here, not quietly answered off a real network.
 *
 * A side effect worth keeping: because the blocked model fails in microseconds,
 * the decline cases reliably lose the race between the turn ending and the
 * parallel speculative catalog search landing. That race wrote to a finished
 * response and crashed the process, and vitest fails a file on unhandled errors —
 * so these tests hold the guard in `send` in place. Against a real key the window
 * is too narrow to catch on purpose.
 */

const SHOP = 'page-facts.myshopify.com';
const UCP = `https://${SHOP}/api/ucp/mcp`;

/**
 * The product as the live store sends it, not as the spec describes it.
 *
 * A gid for an id, the store's own `display` string for the price, availability
 * nested under `availability`, and options as `[{name, label}]`. Every one of
 * those diverges from the declared UCP type, and the page-fact reader has to
 * cope with all four at once or it copes with no real store. The id matters most:
 * the page will report the bare `8944748757044`.
 */
const snowboard = {
  id: 'gid://shopify/Product/8944748757044',
  title: 'The Complete Snowboard',
  variants: [
    {
      id: 'gid://shopify/ProductVariant/1',
      title: 'Ice',
      price: { amount: 69995, currency: 'USD', display: '$699.95' },
      availability: { available: true },
      options: [{ name: 'Color', label: 'Ice' }],
    },
    {
      id: 'gid://shopify/ProductVariant/2',
      title: 'Dawn',
      price: { amount: 74995, currency: 'USD', display: '$749.95' },
      availability: { available: true },
      options: [{ name: 'Color', label: 'Dawn' }],
    },
    {
      id: 'gid://shopify/ProductVariant/3',
      title: 'Powder',
      price: { amount: 89995, currency: 'USD', display: '$899.95' },
      availability: { available: false },
      options: [{ name: 'Color', label: 'Powder' }],
    },
  ],
};

/** The same product with availability stripped, to force the honest decline. */
const noAvailability = {
  ...snowboard,
  variants: snowboard.variants.map(({ availability: _availability, ...rest }) => rest),
};

/**
 * The shape the dev store really returns, confirmed off the wire.
 *
 * `availability.available` is there — the stock question declining against this
 * store was the flat-`available` read, not missing data — but there is **no
 * `price.display`**, so every figure has to come from our own formatter. That
 * makes `money()` load-bearing on the live path, which is worth a test here and
 * not only in the orchestrator: a rounding bug would be spoken aloud with no
 * model and no tripwire in the way.
 */
const liveShape = {
  id: 'gid://shopify/Product/8944748757044',
  title: 'The Complete Snowboard',
  variants: [
    {
      id: 'gid://shopify/ProductVariant/1',
      title: 'Ice',
      price: { amount: 69995, currency: 'USD' },
      availability: { available: true },
      options: [{ name: 'Color', label: 'Ice' }],
    },
    {
      id: 'gid://shopify/ProductVariant/2',
      title: 'Dawn',
      price: { amount: 78595, currency: 'USD' },
      availability: { available: true },
      options: [{ name: 'Color', label: 'Dawn' }],
    },
  ],
};

/** What the widget reads off a product page. Identity only, and a bare id. */
const PAGE = {
  type: 'product' as const,
  title: 'The Complete Snowboard',
  productId: '8944748757044',
};

interface StoreBehaviour {
  /** The catalog `search_catalog` browses. */
  products: unknown[];
  /** Whether the store's own `get_product` works. The dev store's does not. */
  getProductWorks: boolean;
}

describe('answering about the product on the page, without a model', () => {
  let server: Server;
  let base: string;
  let telemetry: Telemetry;
  let store: StoreBehaviour;
  let ucpCalls: string[];
  let blockedHosts: string[];
  let realFetch: typeof globalThis.fetch;

  function rpc(result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(async () => {
    telemetry = new Telemetry();
    store = { products: [snowboard], getProductWorks: false };
    ucpCalls = [];
    blockedHosts = [];
    realFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.startsWith(UCP)) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          params?: { name?: string };
        };
        const tool = body.params?.name ?? '';
        ucpCalls.push(tool);

        if (tool === 'get_product') {
          if (!store.getProductWorks) {
            // Exactly how the dev store refuses: a tool-level error carried in
            // `content`, not a JSON-RPC error. See UcpTransport.once.
            return rpc({ isError: true, content: [{ type: 'text', text: 'Tool not found' }] });
          }
          return rpc({ structuredContent: { product: store.products[0] } });
        }
        if (tool === 'search_catalog') {
          return rpc({ structuredContent: { products: store.products } });
        }
        return rpc({ isError: true, content: [{ type: 'text', text: `no ${tool}` }] });
      }

      // The gateway under test.
      if (url.includes('127.0.0.1') || url.includes('localhost')) return realFetch(input, init);

      /**
       * Anything else is the model, and reaching it is the fact under test in
       * the decline cases. Thrown rather than allowed: a real call would spend
       * a second on a key that cannot work, and would make these tests depend
       * on the network to prove something about our own routing.
       */
      blockedHosts.push(new URL(url).host);
      throw new Error('blocked by test');
    }) as typeof globalThis.fetch;

    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-would-fail-if-used', PORT: '0' }),
      telemetry,
      sessions: new MemorySessionStore(),
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Drive one turn and collect its SSE events. */
  async function ask(
    message: string,
    opts: { page?: unknown; voice?: boolean; shop?: string | undefined; sessionId?: string } = {},
  ) {
    const res = await realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId: opts.sessionId ?? `pf-${message.slice(0, 12)}`,
        voice: opts.voice === true,
        ...('shop' in opts ? { shop: opts.shop } : { shop: SHOP }),
        ...(opts.page === null ? {} : { page: opts.page ?? PAGE }),
      }),
    });
    const text = await res.text();
    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)/g)].map((m) => ({
      event: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }));
    return {
      events,
      done: events.find((e) => e.event === 'done')?.data,
      reply: String(events.find((e) => e.event === 'done')?.data?.['reply'] ?? ''),
      deltas: events.filter((e) => e.event === 'delta').map((e) => String(e.data['text'] ?? '')),
      spoken: events.filter((e) => e.event === 'speak').map((e) => String(e.data['text'] ?? '')),
      products: events.find((e) => e.event === 'products')?.data,
    };
  }

  // -- the three it answers --------------------------------------------------

  it('answers a price from the catalog, with no model and no tokens', async () => {
    const { done, reply, products } = await ask('how much is it?');

    expect(done?.['fast']).toBe('page_price');
    // Three variants at three prices and nothing selected, so a range — naming
    // one of them would be the invented-figure failure with no model to catch it.
    expect(reply).toBe('It ranges from $699.95 to $899.95.');
    expect(telemetry.tokens.total()).toBe(0);
    expect(blockedHosts).toEqual([]);

    // The card goes with the sentence, settled, so the figures on screen come
    // from the same read the words did.
    expect((products?.['products'] as { title: string }[])[0]!.title).toBe('The Complete Snowboard');
    expect(products?.['final']).toBe(true);
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_price' })).toBe(1);
  });

  it('answers stock, reading availability from where the store actually puts it', async () => {
    const { done, reply } = await ask('is this in stock?');
    expect(done?.['fast']).toBe('page_stock');
    // Two of three, so it says which — "yes" alone would be true of the product
    // and false of the Powder a shopper might then try to buy.
    expect(reply).toBe('Yes — Ice and Dawn are in stock.');
    expect(telemetry.tokens.total()).toBe(0);
  });

  it('answers an options question', async () => {
    const { done, reply } = await ask('what colours does this come in?');
    expect(done?.['fast']).toBe('page_options');
    expect(reply).toBe('It comes in Ice, Dawn and Powder.');
    expect(telemetry.tokens.total()).toBe(0);
  });

  it('narrows to the variant the page says is selected', async () => {
    // `?variant=` named one, so the answer is that one's price, not a range.
    const { reply } = await ask('how much is it?', {
      page: { ...PAGE, variantName: 'Dawn' },
    });
    expect(reply).toBe("It's $749.95.");
  });

  it('claims only what is true of its own answer', async () => {
    /**
     * `grounded: true` and `attempts: 0` are not decoration — the merchant's
     * funnel and the grounding rate are computed from them. The lane copied
     * every figure out of a catalog read and called no model, so both are
     * literally true here, and a regression that routed this through a model
     * while still reporting `attempts: 0` would corrupt the metric silently.
     */
    const { done } = await ask('how much is it?');
    expect(done?.['grounded']).toBe(true);
    expect(done?.['attempts']).toBe(0);
    expect(done?.['escalated']).toBe(false);
    expect(done?.['handedOff']).toBe(false);
    expect(typeof done?.['ms']).toBe('number');
  });

  it('resolves the bare page id against a catalog that speaks gids', async () => {
    /**
     * The bug this lane shipped with. `ShopifyAnalytics.meta.page.resourceId` is
     * `8944748757044`; the catalog says `gid://shopify/Product/8944748757044`. A
     * string compare said those were different products, so the id the page was
     * certain about resolved to nothing and every page question quietly went to
     * the model — visible only as a latency number nobody was watching.
     */
    const { done } = await ask('how much is it?');
    expect(done?.['fast']).toBe('page_price');
    // The store's own get_product refused, so this answer came through the
    // browse-and-match fallback — which is the path that had to learn gids.
    expect(ucpCalls).toEqual(['get_product', 'search_catalog']);
  });

  it('answers through the store’s own get_product when that works', async () => {
    store.getProductWorks = true;
    const { done, reply } = await ask('how much is it?');
    expect(done?.['fast']).toBe('page_price');
    expect(reply).toBe('It ranges from $699.95 to $899.95.');
    // No fallback needed, so no second call.
    expect(ucpCalls).toEqual(['get_product']);
  });

  it('formats the price itself for the store that sends no display string', async () => {
    store.products = [liveShape];
    const { done, reply } = await ask('how much is it?');
    expect(done?.['fast']).toBe('page_price');
    // 78595 minor is $785.95. The model wrote "$785" for this exact figure once
    // and the tripwire retracted the stream; there is no tripwire on this path.
    expect(reply).toBe('It ranges from $699.95 to $785.95.');
  });

  it('answers stock for the live shape, which does carry availability', async () => {
    // The decline observed against this store was the flat-`available` read, not
    // absent data. Both variants are available, so it says so plainly.
    store.products = [liveShape];
    const { done, reply } = await ask('is this in stock?');
    expect(done?.['fast']).toBe('page_stock');
    expect(reply).toBe('Yes, it’s in stock.');
  });

  it('speaks on a voice turn', async () => {
    // The whole reason the lane exists is time-to-audio; a lane that answered
    // only in text would have fixed nothing for the shopper it was built for.
    const { spoken, reply } = await ask('how much is it?', { voice: true });
    expect(spoken).toEqual([reply]);
  });

  it('is fast, because there is nothing slow left in the path', async () => {
    const started = Date.now();
    await ask('how much is it?');
    // Generous for a loaded CI box. The point is the order of magnitude: the
    // model turn this replaces was 3.5-4.1 s of model time alone.
    expect(Date.now() - started).toBeLessThan(500);
  });

  // -- declining, which is the half that keeps it honest ---------------------

  it('gives the turn to the model rather than inventing availability', async () => {
    /**
     * The decline seen against the real store: it sends no `available` on any
     * variant, so the honest answer is that we do not know. Both "yes" and "no"
     * would be invented stock information, which is the worst thing this lane
     * could say — a shopper acts on it.
     */
    store.products = [noAvailability];
    const { done, reply } = await ask('is this in stock?');

    expect(done?.['fast']).toBeUndefined();
    expect(reply).not.toMatch(/in stock|sold out/i);
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_stock_declined' })).toBe(1);
    // Handed over, not dropped: the model was reached (and blocked here).
    expect(blockedHosts.length).toBeGreaterThan(0);
  });

  it('still answers price and options for a store that sends no availability', async () => {
    // One missing field must cost one question, not the whole lane.
    store.products = [noAvailability];
    expect((await ask('how much is it?')).done?.['fast']).toBe('page_price');
    expect((await ask('what colours does this come in?')).done?.['fast']).toBe('page_options');
  });

  it('hands over when the page names a product the catalog does not have', async () => {
    store.products = [{ ...snowboard, id: 'gid://shopify/Product/999' }];
    const { done } = await ask('how much is it?');
    expect(done?.['fast']).toBeUndefined();
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_price_declined' })).toBe(1);
    expect(blockedHosts.length).toBeGreaterThan(0);
  });

  it('hands over when the storefront cannot be read at all', async () => {
    // A lane whose data source is down must be indistinguishable from a lane
    // that was never there.
    store.products = [];
    const { done } = await ask('how much is it?');
    expect(done?.['fast']).toBeUndefined();
    expect(blockedHosts.length).toBeGreaterThan(0);
  });

  it('does not intercept a question about something other than this product', async () => {
    /**
     * "the jacket" is a word the allowlist does not have and the title does not
     * contain, so the shopper is talking about something else and a price copied
     * off this page would answer a question nobody asked.
     */
    await ask('how much is the jacket?');
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_price' })).toBe(0);
    // Refused by the classifier, before any work — not answered and then
    // discarded, which would still have cost a catalog read per turn.
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_price_declined' })).toBe(0);
    /**
     * `get_product` is the lane's own read, so its absence is the claim. The
     * turn's speculative `search_catalog` may well have fired — that belongs to
     * the model's path and is not this lane's business.
     */
    expect(ucpCalls).not.toContain('get_product');
  });

  it('does not intercept anywhere that is not a product page', async () => {
    await ask('how much is it?', { page: { type: 'collection', title: 'Snowboards' } });
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_price' })).toBe(0);
    expect(ucpCalls).not.toContain('get_product');
  });

  it('does not intercept when there is no page context at all', async () => {
    await ask('how much is it?', { page: null });
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_price' })).toBe(0);
    expect(ucpCalls).not.toContain('get_product');
  });

  it('leaves the turn alone in demo mode, where there is no store to read', async () => {
    /**
     * No shop means the fixture catalog, which is not the merchant's data. The
     * lane declines rather than answering a real shopper off a fixture — and the
     * decline is counted, so a deployment that lost its shop domain shows up as
     * a lane that suddenly only declines.
     */
    const { done } = await ask('how much is it?', { shop: undefined });
    expect(done?.['fast']).toBeUndefined();
    expect(telemetry.fastLane.get({ shop: 'demo.local', intent: 'page_price_declined' })).toBe(1);
    expect(ucpCalls).toEqual([]);
  });

  it('counts every decline, so patterns that never fire are visible', async () => {
    /**
     * Counting only the answers would make a lane whose classifier has drifted
     * look like a lane nobody is asking — the same reason the filter lane counts
     * its declines.
     */
    store.products = [noAvailability];
    await ask('is this in stock?', { sessionId: 'd1' });
    await ask('is this one in stock?', { sessionId: 'd2' });
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_stock_declined' })).toBe(2);
    expect(telemetry.fastLane.get({ shop: SHOP, intent: 'page_stock' })).toBe(0);
  });

  it('never sends two answers for one turn', async () => {
    /**
     * The lane writes to the same stream the model would. If it answered and
     * then fell through, the shopper would see a price followed by a second
     * opinion about the same product, and `done` twice.
     */
    const { events, deltas } = await ask('how much is it?');
    expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
    expect(deltas).toHaveLength(1);
  });
});
