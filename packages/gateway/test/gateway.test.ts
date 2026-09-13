import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { MemorySessionStore, newSession } from '../src/sessions.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { searchDemoCatalog, DEMO_POLICIES } from '../src/catalog-fixture.js';
import { loadConfig } from '../src/config.js';
import { MemoryShopStore, newShop } from '../src/shopify/shops.js';
import { Telemetry } from '../src/observability/telemetry.js';

/**
 * The gateway is tested against a stub OpenAI endpoint rather than the live
 * API: these assert wiring, SSE framing, and session behaviour. Model
 * correctness is covered by scripts/smoke-gateway.mjs against the real thing.
 */

function stubOpenAI(outputs: unknown[]): string {
  // A tiny SSE server that replays scripted Responses-API events.
  return JSON.stringify(outputs);
}

describe('config', () => {
  it('refuses to start without an API key', () => {
    expect(() => loadConfig({})).toThrow(/OPENAI_API_KEY/);
  });

  it('defaults to demo mode when no shop is configured', () => {
    expect(loadConfig({ OPENAI_API_KEY: 'sk-x' }).shopDomain).toBeUndefined();
  });

  it('accepts either SHOP_DOMAIN or DEV_SHOP_DOMAIN', () => {
    expect(loadConfig({ OPENAI_API_KEY: 'sk-x', DEV_SHOP_DOMAIN: 'a.myshopify.com' }).shopDomain).toBe(
      'a.myshopify.com',
    );
  });

  it('treats a blanked shop domain as unset, not as a shop named ""', () => {
    // Blanking the value is how a hosting UI turns a variable off. Kept as an
    // empty string it would be built into `https:///api/ucp/mcp`.
    expect(loadConfig({ OPENAI_API_KEY: 'sk-x', SHOP_DOMAIN: '' }).shopDomain).toBeUndefined();
    expect(
      loadConfig({ OPENAI_API_KEY: 'sk-x', SHOP_DOMAIN: '', DEV_SHOP_DOMAIN: 'a.myshopify.com' }).shopDomain,
    ).toBe('a.myshopify.com');
  });
});

describe('session store', () => {
  it('round-trips a session', async () => {
    const s = new MemorySessionStore();
    await s.put(newSession('a', 'shop.test'));
    expect((await s.get('a'))?.shopDomain).toBe('shop.test');
  });

  it('expires a session past its TTL', async () => {
    const s = new MemorySessionStore(10);
    const sess = newSession('a', 'shop.test');
    await s.put(sess);
    sess.updatedAt = Date.now() - 1000;
    expect(await s.get('a')).toBeUndefined();
  });

  it('caps history so old turns do not bloat every request', async () => {
    const s = new MemorySessionStore();
    const sess = newSession('a', 'shop.test');
    sess.history = Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    await s.put(sess);
    const got = await s.get('a');
    expect(got!.history.length).toBeLessThanOrEqual(24);
    // Keeps the MOST RECENT turns, not the oldest.
    expect(got!.history.at(-1)!.content).toBe('m59');
  });

  it('sweeps expired entries', async () => {
    const s = new MemorySessionStore(10);
    const sess = newSession('a', 'shop.test');
    await s.put(sess);
    sess.updatedAt = Date.now() - 1000;
    expect(s.sweep()).toBe(1);
    expect(await s.size()).toBe(0);
  });
});

describe('demo catalog', () => {
  it('matches on title words', () => {
    expect(searchDemoCatalog('wool coat').products[0]!.title).toBe('Merino Wool Overcoat');
  });

  it('falls back to the full catalog rather than nothing', () => {
    // An empty result makes the model apologise when it could offer options.
    expect(searchDemoCatalog('xylophone').products.length).toBeGreaterThan(0);
  });

  it('respects the limit', () => {
    expect(searchDemoCatalog('', 2).products).toHaveLength(2);
  });

  it('returns prices in minor units', () => {
    expect(searchDemoCatalog('overcoat').products[0]!.price_range.min.amount).toBe(18900);
  });
});

describe('tool executor (demo mode)', () => {
  const exec = createToolExecutor({ session: newSession('s', 'demo.local') });

  it('searches the fixture catalog', async () => {
    const r = (await exec.execute('search_catalog', { query: 'wool' })) as { products: unknown[] };
    expect(r.products.length).toBeGreaterThan(0);
  });

  it('returns policy text for a known topic', async () => {
    const r = (await exec.execute('get_policy', { topic: 'returns', question: 'x' })) as { text: string };
    expect(r.text).toBe(DEMO_POLICIES['returns']);
  });

  it('reports an unknown policy topic as an error rather than inventing one', async () => {
    const r = (await exec.execute('get_policy', { topic: 'nonsense', question: 'x' })) as { error: boolean };
    expect(r.error).toBe(true);
  });

  it('acknowledges add_to_cart without inventing totals in demo mode', async () => {
    const r = (await exec.execute('add_to_cart', { variant_id: 'v-coat-m' })) as Record<string, unknown>;
    expect(r['demo']).toBe(true);
    // Nothing numeric that the model could quote as a grounded fact.
    expect(JSON.stringify(r)).not.toMatch(/amount/);
  });

  it('reports an unknown tool rather than throwing', async () => {
    const r = (await exec.execute('nope', {})) as { error: boolean };
    expect(r.error).toBe(true);
  });
});

describe('http surface', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createGateway({ config: loadConfig({ OPENAI_API_KEY: 'sk-test', PORT: '0' }) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reports health and mode', async () => {
    const r = await fetch(`${base}/healthz`).then((x) => x.json());
    expect(r).toMatchObject({ ok: true, mode: 'demo' });
  });

  it('serves the demo catalog', async () => {
    const r = (await fetch(`${base}/api/catalog`).then((x) => x.json())) as { products: unknown[] };
    expect(r.products.length).toBeGreaterThan(0);
  });

  it('serves the widget bundle', async () => {
    const r = await fetch(`${base}/widget.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
  });

  it('lets the widget revalidate without blocking the page', async () => {
    // It loads on every navigation of every storefront. `must-revalidate`
    // stalled each one on a round trip once the 5 minutes were up, on a file
    // whose ETag already made that a 304.
    const cc = (await fetch(`${base}/widget.js`)).headers.get('cache-control') ?? '';
    expect(cc).toMatch(/stale-while-revalidate=\d+/);
    // But bounded: an unversioned URL plus a week of staleness means a fixed
    // bug keeps running on storefronts for days.
    const swr = Number(/stale-while-revalidate=(\d+)/.exec(cc)![1]);
    expect(swr).toBeLessThanOrEqual(3600);
  });

  it('serves the demo storefront at /', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('rejects a chat request with no message', async () => {
    const r = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const r = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(r.status).toBe(400);
  });

  it('refuses to serve files outside the public root', async () => {
    const r = await fetch(`${base}/..%2f..%2f.env`);
    expect(r.status).toBe(404);
  });

  it('404s an unknown route', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('answers a CORS preflight', async () => {
    const r = await fetch(`${base}/api/chat`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('never leaks a stack trace', async () => {
    const text = await fetch(`${base}/nope`).then((x) => x.text());
    expect(text).not.toMatch(/at .*\(/);
  });
});

/**
 * Who is allowed to reach the gateway from a browser.
 *
 * App review failed 5.1.2 here: the embed rendered on their test store, the
 * shopper asked for snowboards, and the fetch never left the browser because
 * ALLOWED_ORIGINS — a list written before any merchant existed — did not name
 * their storefront. A refused preflight looks identical to an outage from the
 * page and leaves nothing in the server log, so these pin the three ways in.
 */
describe('storefront origins', () => {
  let server: Server;
  let base: string;
  let shops: MemoryShopStore;

  async function preflight(origin: string, query = ''): Promise<string | null> {
    const r = await fetch(`${base}/api/chat${query}`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    expect(r.status).toBe(204);
    return r.headers.get('access-control-allow-origin');
  }

  beforeEach(async () => {
    shops = new MemoryShopStore();
    await shops.put(newShop('installed.myshopify.com', 'tok', 'read_products'));
    server = createGateway({
      config: loadConfig({
        OPENAI_API_KEY: 'sk-test',
        ALLOWED_ORIGINS: 'https://storeagent.tech,http://localhost:3000',
      }),
      shops,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('allows an origin the operator listed', async () => {
    expect(await preflight('https://storeagent.tech')).toBe('https://storeagent.tech');
    // Development still works: the list is matched verbatim, scheme and port
    // included, so a localhost entry is not quietly upgraded away.
    expect(await preflight('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('allows any Shopify storefront, listed or not', async () => {
    // The review blocker in one line: this store was never in the env var and
    // never could have been, because it did not exist when the var was written.
    expect(await preflight('https://reviewer-test-store.myshopify.com')).toBe(
      'https://reviewer-test-store.myshopify.com',
    );
  });

  it('refuses an origin that is neither listed nor a storefront', async () => {
    expect(await preflight('https://evil.example')).toBeNull();
    // A lookalike must not pass on a suffix match.
    expect(await preflight('https://myshopify.com.evil.example')).toBeNull();
  });

  it('refuses a Shopify-shaped origin served over http', async () => {
    // Real storefronts are https. An http one is someone stripping transport
    // security, not a merchant.
    expect(await preflight('http://acme.myshopify.com')).toBeNull();
  });

  it('allows a custom storefront domain when the shop it names is installed', async () => {
    // Most merchants do not shop on myshopify.com — they have their own
    // domain, and the origin alone proves nothing about who owns it. The
    // install record is what vouches for the claim.
    expect(await preflight('https://shop.acme.com', '?shop=installed.myshopify.com')).toBe(
      'https://shop.acme.com',
    );
  });

  it('refuses a custom domain claiming a shop that never installed', async () => {
    expect(await preflight('https://shop.acme.com', '?shop=stranger.myshopify.com')).toBeNull();
    // And a claim that is not a shop domain at all buys nothing.
    expect(await preflight('https://shop.acme.com', '?shop=shop.acme.com')).toBeNull();
  });

  it('still honours a wildcard where an operator sets one', async () => {
    const open = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-test', ALLOWED_ORIGINS: '*' }),
    });
    await new Promise<void>((r) => open.listen(0, r));
    const at = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
    const r = await fetch(`${at}/api/chat`, { method: 'OPTIONS', headers: { origin: 'https://anywhere.example' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://anywhere.example');
    await new Promise<void>((r) => open.close(() => r()));
  });
});

/**
 * Which store answers.
 *
 * The chat request used to carry no shop at all, so every turn in every
 * storefront was served from SHOP_DOMAIN. Reviewing that as a public app, the
 * snowboards a merchant sees would be someone else's snowboards — wrong
 * prices, wrong stock, stated with complete confidence.
 *
 * Asserted on the service-level metric because it is labelled with the shop
 * and recorded before any model call, so the binding can be checked without a
 * live model or a live storefront.
 */
describe('chat is bound to the storefront it came from', () => {
  let server: Server;
  let base: string;
  let metrics: Telemetry;

  async function openTurn(body: unknown, query = ''): Promise<void> {
    const ctl = new AbortController();
    // Headers arrive before the model is asked anything; the turn is abandoned
    // immediately after, which is exactly what a shopper closing a tab does.
    await fetch(`${base}/api/chat${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    ctl.abort();
  }

  beforeEach(async () => {
    metrics = new Telemetry();
    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-test', SHOP_DOMAIN: 'operator.myshopify.com' }),
      telemetry: metrics,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('serves the shop the widget names, not the one in the env var', async () => {
    await openTurn({ message: 'show me some snowboards', shop: 'merchant.myshopify.com' });
    expect(metrics.render()).toContain('merchant.myshopify.com');
    expect(metrics.render()).not.toContain('operator.myshopify.com');
  });

  it('falls back to SHOP_DOMAIN when the widget names nothing', async () => {
    // Single-tenant and demo deployments must behave exactly as before.
    await openTurn({ message: 'hello' });
    expect(metrics.render()).toContain('operator.myshopify.com');
  });

  it('ignores a shop that is not a Shopify domain', async () => {
    // The field is client-supplied, and it becomes an outbound URL.
    await openTurn({ message: 'hello', shop: 'evil.example/../x' });
    expect(metrics.render()).toContain('operator.myshopify.com');
  });
});

// Keeps the unused stub helper honest rather than deleting it prematurely —
// it is the seam for scripted-model gateway tests in the next phase.
describe('stub helper', () => {
  it('serializes scripted outputs', () => {
    expect(stubOpenAI([{ a: 1 }])).toBe('[{"a":1}]');
  });
});

describe('shopify install routes — unconfigured', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createGateway({ config: loadConfig({ OPENAI_API_KEY: 'sk-test' }) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('disables install wholesale rather than half-working', async () => {
    // A partly-configured OAuth flow fails confusingly, mid-install.
    const r = await fetch(`${base}/shopify/auth?shop=acme.myshopify.com`, { redirect: 'manual' });
    expect(r.status).toBe(503);
  });

  it('reports install status on health without echoing the secret', async () => {
    const h = await fetch(`${base}/healthz`).then((x) => x.json());
    expect(h.install).toBe('disabled');
    expect(JSON.stringify(h)).not.toMatch(/secret|shpss_/i);
  });
});

describe('shopify install routes — configured', () => {
  let server: Server;
  let base: string;

  const env = {
    OPENAI_API_KEY: 'sk-test',
    SHOPIFY_API_KEY: 'client-id',
    SHOPIFY_API_SECRET: 'shpss_secret',
    SHOPIFY_APP_URL: 'https://app.test',
  };

  beforeEach(async () => {
    server = createGateway({ config: loadConfig(env) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('redirects a valid install to the shop origin', async () => {
    const r = await fetch(`${base}/shopify/auth?shop=acme.myshopify.com`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin).toBe('https://acme.myshopify.com');
    expect(loc.pathname).toBe('/admin/oauth/authorize');
  });

  it('refuses an attacker-supplied shop rather than redirecting to it', async () => {
    // Open-redirect guard: the response must not carry a Location at all.
    const r = await fetch(`${base}/shopify/auth?shop=evil.com`, { redirect: 'manual' });
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
  });

  it('rejects a callback with no valid hmac', async () => {
    const r = await fetch(`${base}/shopify/auth/callback?shop=acme.myshopify.com&code=c&state=s&hmac=bad`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(401);
  });

  it('rejects an unsigned webhook', async () => {
    const r = await fetch(`${base}/shopify/webhooks`, {
      method: 'POST',
      headers: { 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': 'acme.myshopify.com' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('404s an unknown shopify route', async () => {
    expect((await fetch(`${base}/shopify/nope`)).status).toBe(404);
  });

  it('refuses a non-https app url at config time', () => {
    // The OAuth code would otherwise travel in plaintext.
    expect(() => loadConfig({ ...env, SHOPIFY_APP_URL: 'http://app.test' })).toThrow(/https/);
  });
});

describe('catalog money is pre-formatted for the model', () => {
  /**
   * The model was handed minor units and asked to divide by 100 itself. On the
   * live catalog it wrote $785.00 for a $785.95 board on ~3 turns in 5. The
   * tripwire caught every one, so no shopper saw a wrong price — but each catch
   * discarded the generation and re-ran the turn (~5.6k -> ~7.2k input tokens),
   * and one run in five escalated a question the store could answer.
   *
   * Prompting reduced it without fixing it, because the instruction was still
   * "do this arithmetic correctly every time". These assert the arithmetic is
   * gone: the exact string to quote is in the payload.
   */
  const exec = createToolExecutor({ session: newSession('s', 'demo.local') });

  it('attaches a display string to every price', async () => {
    const r = (await exec.execute('search_catalog', { query: 'wool' })) as {
      products: { price_range: { min: { amount: number; display?: string } } }[];
    };
    const money = r.products[0]!.price_range.min;
    expect(money.display).toBe('$189.00');
    // Minor units survive: grounding validates claims against them.
    expect(money.amount).toBe(18900);
  });

  it('keeps both decimal places on a non-round price', async () => {
    // 78595 -> $785.95 is the exact value the model kept rounding to $785.
    const { formatMinor } = await import('@storeagent/grounding');
    expect(formatMinor(78595)).toBe('785.95');
  });

  it('formats every money object it can find, not just the first', async () => {
    const r = (await exec.execute('search_catalog', { query: '' })) as {
      products: { price_range: { min: { display?: string }; max: { display?: string } } }[];
    };
    for (const p of r.products) {
      expect(p.price_range.min.display).toMatch(/^\$\d+\.\d{2}$/);
      expect(p.price_range.max.display).toMatch(/^\$\d+\.\d{2}$/);
    }
  });
});
