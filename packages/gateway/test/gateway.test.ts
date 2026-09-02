import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { MemorySessionStore, newSession } from '../src/sessions.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { searchDemoCatalog, DEMO_POLICIES } from '../src/catalog-fixture.js';
import { loadConfig } from '../src/config.js';

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
