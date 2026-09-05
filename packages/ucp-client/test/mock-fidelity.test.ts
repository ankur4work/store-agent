import { beforeEach, describe, expect, it } from 'vitest';
import { UcpClient } from '../src/client.js';
import { UcpTransport } from '../src/transport.js';
import { MockUcpServer } from './mock-server.js';
import { HOSTILE_CART } from './fixtures.js';

/**
 * These tests do NOT test our code. They test the MOCK.
 *
 * Every safety test in cart-safety.test.ts is only meaningful if the mock
 * actually destroys omitted fields the way the real UCP endpoint does. If the
 * mock were forgiving, SafeCart could be a no-op and the suite would still be
 * green. So we prove the trap is armed before we prove we avoid it.
 */
describe('mock fidelity — the trap is armed', () => {
  const server = new MockUcpServer();
  const client = new UcpClient(
    new UcpTransport({
      shopDomain: 'mock.test',
      agentProfile: 'https://storeagent.dev/ucp-profile.json',
      fetch: server.fetch,
      endpoint: server.endpoint,
      maxRetries: 0,
    }),
  );

  beforeEach(() => server.reset());

  it('update_cart DESTROYS every field omitted from the payload', async () => {
    const { cart } = await client.createCart(HOSTILE_CART);

    // The naive implementation every competitor writes: "just set line_items".
    await client.updateCart(cart.id, { line_items: [{ variant_id: 'v-scarf-grey', quantity: 1 }] });

    const after = server.raw(cart.id)!;
    expect(after.attribution).toBeUndefined();
    expect(after.buyer).toBeUndefined();
    expect(after.note).toBeUndefined();
    expect(after.discount_codes).toBeUndefined();
    expect(after.attributes).toBeUndefined();
    expect(after.context).toBeUndefined();
    expect(after.signals).toBeUndefined();
    // ...and the shopper's other two items are gone.
    expect(after.line_items).toHaveLength(1);
  });

  it('rejects a request missing meta.ucp-agent.profile', async () => {
    const bare = new UcpClient(
      new UcpTransport({
        shopDomain: 'mock.test',
        agentProfile: '',
        fetch: server.fetch,
        endpoint: server.endpoint,
        maxRetries: 0,
      }),
    );
    // Empty string is still a string, so force the invalid shape on the wire.
    const raw = await server.fetch(server.endpoint, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_cart', arguments: { id: 'x' } },
      }),
    });
    const json = (await raw.json()) as { error?: { message: string } };
    expect(json.error?.message).toContain('ucp-agent.profile');
    expect(bare).toBeDefined();
  });

  it('cancel_cart is rejected without an idempotency key', async () => {
    const { cart } = await client.createCart({ line_items: [] });
    const raw = await server.fetch(server.endpoint, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'cancel_cart',
          arguments: { meta: { 'ucp-agent': { profile: 'https://storeagent.dev/p.json' } }, id: cart.id },
        },
      }),
    });
    const json = (await raw.json()) as { error?: { message: string } };
    expect(json.error?.message).toContain('idempotency-key');
  });
});
