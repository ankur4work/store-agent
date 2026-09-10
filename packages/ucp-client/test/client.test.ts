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

  /**
   * A tool-level failure is a RESULT, not a JSON-RPC error: `isError: true`
   * with the reason in `content`. Both fields were declared and neither was
   * read, so every such failure surfaced as "missing result.structuredContent"
   * — true, and useless. A cart that would not open cost an afternoon to
   * diagnose because the server had said why and nothing looked.
   */
  it('surfaces what the tool actually said when it reports an error', async () => {
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'cart creation is not enabled for this merchant' }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const client = new UcpClient(
      new UcpTransport({
        shopDomain: 'mock.test',
        agentProfile: 'https://storeagent.tech/ucp-profile.json',
        fetch: fetchStub,
        endpoint: 'https://mock.test/ucp',
        maxRetries: 0,
      }),
    );

    await expect(client.createCart({ line_items: [{ variant_id: 'v1', quantity: 1 }] })).rejects.toThrow(
      /cart creation is not enabled/,
    );
  });

  /**
   * The cart wire format, pinned against a live Shopify UCP endpoint. Each
   * of these was wrong, and each failed silently: create_cart rejected every
   * call, `const { cart } = ...` was undefined so SafeCart threw, and the
   * authoritative "already sold out" notice read as an empty string.
   */
  it('sends line items as {item: {id}}, which is what the schema requires', async () => {
    const server = new MockUcpServer();
    const client = make(server);
    await client.createCart({ line_items: [{ variant_id: 'v-coat-m', quantity: 2 }] });

    const sent = server.callLog.find((c) => c.tool === 'create_cart')!.args as {
      cart: { line_items: { item?: { id?: string }; variant_id?: string; quantity: number }[] };
    };
    expect(sent.cart.line_items[0]).toMatchObject({ item: { id: 'v-coat-m' }, quantity: 2 });
    expect(sent.cart.line_items[0]!.variant_id).toBeUndefined();
  });

  it('reads a cart whose fields arrive at the top level, not under `cart`', async () => {
    const server = new MockUcpServer();
    const client = make(server);
    const created = await client.createCart({ line_items: [{ variant_id: 'v-coat-m', quantity: 1 }] });

    expect(created.cart.id).toMatch(/^gid:\/\/shopify\/Cart\//);
    expect(created.cart.line_items[0]!.variant_id).toBe('v-coat-m');
  });

  it('reads a business message from {type, content}, not {severity, text}', async () => {
    // These are authoritative and shown to the shopper verbatim. Read from
    // the wrong fields they are empty, and a sold-out line vanishes in
    // silence — the cart says nothing and the shopper never learns.
    const server = new MockUcpServer({ outOfStock: ['v-coat-l'] });
    const client = make(server);
    const created = await client.createCart({ line_items: [{ variant_id: 'v-coat-l', quantity: 1 }] });

    expect(created.messages).toHaveLength(1);
    expect(created.messages[0]!.severity).toBe('warning');
    expect(created.messages[0]!.text).toContain('out of stock');
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
