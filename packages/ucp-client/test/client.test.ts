import { beforeEach, describe, expect, it } from 'vitest';
import { UcpClient } from '../src/client.js';
import { UcpRpcError, UcpTimeoutError, UcpTransportError } from '../src/errors.js';
import { UcpTransport, type ToolTiming } from '../src/transport.js';
import { MockUcpServer } from './mock-server.js';

function make(server: MockUcpServer, overrides: Partial<ConstructorParameters<typeof UcpTransport>[0]> = {}) {
  return new UcpClient(
    new UcpTransport({
      shopDomain: 'mock.test',
      agentProfile: 'https://storeagent.dev/ucp-profile.json',
      fetch: server.fetch,
      endpoint: server.endpoint,
      maxRetries: 0,
      ...overrides,
    }),
  );
}

describe('catalog tools', () => {
  const server = new MockUcpServer();
  const client = make(server);
  beforeEach(() => server.reset());

  it('search_catalog returns products for a natural-language query', async () => {
    const res = await client.searchCatalog({ query: 'wool', context: { country: 'US' } });
    expect(res.products).toHaveLength(1);
    expect(res.products[0]!.title).toBe('Merino Wool Overcoat');
  });

  it('rejects a search limit above the documented 250 max', async () => {
    await expect(client.searchCatalog({ query: 'x', pagination: { limit: 251 } })).rejects.toThrow(RangeError);
  });

  it('rejects more than 10 ids on lookup_catalog', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `gid://shopify/Product/${i}`);
    await expect(client.lookupCatalog({ ids })).rejects.toThrow(RangeError);
  });

  it('chunks a large lookup into compliant parallel calls', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `gid://shopify/Product/${i}`);
    await client.lookupCatalogChunked(ids);
    expect(server.callCount('lookup_catalog')).toBe(3); // 10 + 10 + 3
  });

  it('short-circuits an empty lookup without a network call', async () => {
    const res = await client.lookupCatalog({ ids: [] });
    expect(res.products).toEqual([]);
    expect(server.callCount('lookup_catalog')).toBe(0);
  });

  it('get_product returns per-variant availability', async () => {
    const { product } = await client.getProduct({ id: 'gid://shopify/Product/1', selected: { Size: 'M' } });
    expect(product.variants?.find((v) => v.id === 'v-coat-l')?.available).toBe(false);
  });

  it('prices are returned in minor units', async () => {
    const res = await client.searchCatalog({ query: 'scarf' });
    expect(res.products[0]!.price_range?.min.amount).toBe(7900);
  });
});

describe('transport', () => {
  it('sends meta.ucp-agent.profile on every call', async () => {
    const server = new MockUcpServer();
    const client = make(server);
    await client.searchCatalog({ query: 'x' });
    const meta = server.callLog[0]!.args['meta'] as Record<string, unknown>;
    // Nested, not a literal dotted key — verified against a live store.
    expect(meta['ucp-agent']).toEqual({ profile: 'https://storeagent.dev/ucp-profile.json' });
  });

  it('sends an idempotency key only on cancel_cart', async () => {
    const server = new MockUcpServer();
    const client = make(server);
    const { cart } = await client.createCart({ line_items: [] });
    await client.cancelCart(cart.id, crypto.randomUUID());

    const create = server.callLog.find((c) => c.tool === 'create_cart')!;
    const cancel = server.callLog.find((c) => c.tool === 'cancel_cart')!;
    expect((create.args['meta'] as Record<string, unknown>)['idempotency-key']).toBeUndefined();
    expect((cancel.args['meta'] as Record<string, unknown>)['idempotency-key']).toEqual(expect.any(String));
  });

  it('refuses cancel_cart without an idempotency key', async () => {
    const server = new MockUcpServer();
    const client = make(server);
    await expect(client.cancelCart('x', '')).rejects.toThrow(TypeError);
  });

  it('surfaces a JSON-RPC error as UcpRpcError', async () => {
    const server = new MockUcpServer();
    const client = make(server);
    await expect(client.getCart('gid://shopify/Cart/nope')).rejects.toBeInstanceOf(UcpRpcError);
  });

  it('does not retry a non-retryable 4xx', async () => {
    const server = new MockUcpServer({ failNthCall: { tool: 'search_catalog', n: 1, status: 400 } });
    const client = make(server, { maxRetries: 3 });
    await expect(client.searchCatalog({ query: 'x' })).rejects.toBeInstanceOf(UcpTransportError);
    expect(server.callCount('search_catalog')).toBe(1);
  });

  it('retries a 503 and succeeds', async () => {
    const server = new MockUcpServer({ failNthCall: { tool: 'search_catalog', n: 1, status: 503 } });
    const client = make(server, { maxRetries: 2 });
    const res = await client.searchCatalog({ query: 'wool' });
    expect(res.products).toHaveLength(1);
    expect(server.callCount('search_catalog')).toBe(2);
  });

  it('times out a slow endpoint rather than making a shopper wait', async () => {
    const server = new MockUcpServer({ latencyMs: 200 });
    const client = make(server, { timeoutMs: 40, maxRetries: 0 });
    await expect(client.searchCatalog({ query: 'x' })).rejects.toBeInstanceOf(UcpTimeoutError);
  });

  it('emits timing for every attempt', async () => {
    const timings: ToolTiming[] = [];
    const server = new MockUcpServer({ failNthCall: { tool: 'get_product', n: 1, status: 500 } });
    const client = make(server, { maxRetries: 1, onTiming: (t) => timings.push(t) });
    await client.getProduct({ id: 'gid://shopify/Product/2' });
    expect(timings).toHaveLength(2);
    expect(timings[0]!.ok).toBe(false);
    expect(timings[1]!.ok).toBe(true);
  });

  it('honours an external abort signal', async () => {
    const server = new MockUcpServer({ latencyMs: 100 });
    const client = make(server, { timeoutMs: 5000 });
    const ctl = new AbortController();
    const p = client.searchCatalog({ query: 'x' }, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow();
  });

  it('builds the documented endpoint from a shop domain', () => {
    const t = new UcpTransport({ shopDomain: 'acme.myshopify.com', agentProfile: 'p' });
    expect(t.endpoint).toBe('https://acme.myshopify.com/api/ucp/mcp');
  });
});
