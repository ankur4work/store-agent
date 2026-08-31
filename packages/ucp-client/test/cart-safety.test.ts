import { beforeEach, describe, expect, it } from 'vitest';
import { UcpClient } from '../src/client.js';
import { SafeCart, assertNoFieldLoss, mergeLine, projectWritable } from '../src/cart.js';
import { UnsafeCartWriteError } from '../src/errors.js';
import { UcpTransport } from '../src/transport.js';
import { MockUcpServer } from './mock-server.js';
import { HOSTILE_CART, HOSTILE_CART_KEYS } from './fixtures.js';

/**
 * PHASE 0 GATE.
 *
 * `update_cart` full-replacement semantics must be provably survivable against
 * hostile fixtures. If this file is red, Phase 1 does not start.
 */
describe('PHASE 0 GATE — update_cart PUT semantics are survivable', () => {
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
  const cart = new SafeCart(client);

  beforeEach(() => server.reset());

  async function seed(): Promise<string> {
    const { cart: created } = await client.createCart(HOSTILE_CART);
    return created.id;
  }

  it('addLine preserves EVERY writable field on the cart', async () => {
    const id = await seed();
    await cart.addLine(id, { variant_id: 'v-coat-s', quantity: 1 });

    const after = server.raw(id)!;
    for (const key of HOSTILE_CART_KEYS) {
      expect(after[key], `field "${key}" was destroyed by addLine`).toBeDefined();
    }
    expect(after.attribution).toEqual(HOSTILE_CART.attribution);
    expect(after.discount_codes).toEqual(['WINTER20']);
    expect(after.buyer).toEqual({ email: 'shopper@example.com', country: 'US' });
    expect(after.note).toBe('Gift wrap please');
    expect(after.attributes).toEqual({ gift: 'true', delivery_window: 'weekday' });
    expect(after.signals).toEqual({ referrer: 'instagram', dwell_ms: 42_000 });
    expect(after.context).toEqual({ country: 'US', language: 'en', currency: 'USD' });
  });

  it('addLine preserves the other line items', async () => {
    const id = await seed();
    await cart.addLine(id, { variant_id: 'v-coat-s', quantity: 1 });

    const variants = server.raw(id)!.line_items.map((l) => l.variant_id).sort();
    expect(variants).toEqual(['v-coat-m', 'v-coat-s', 'v-glove-m', 'v-scarf-grey']);
  });

  it('adding an existing variant increments quantity instead of duplicating', async () => {
    const id = await seed();
    await cart.addLine(id, { variant_id: 'v-scarf-grey', quantity: 3 });

    const lines = server.raw(id)!.line_items.filter((l) => l.variant_id === 'v-scarf-grey');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(5); // 2 seeded + 3 added
  });

  it('treats the same variant with different attributes as a distinct line', async () => {
    const id = await seed();
    await cart.addLine(id, { variant_id: 'v-coat-m', quantity: 1, attributes: { engraving: 'AB' } });

    const coats = server.raw(id)!.line_items.filter((l) => l.variant_id === 'v-coat-m');
    expect(coats).toHaveLength(2);
    expect(coats.map((c) => c.attributes?.['engraving']).sort()).toEqual(['AB', 'JS']);
  });

  it('removeLine drops exactly one line and keeps all metadata', async () => {
    const id = await seed();
    await cart.removeLine(id, 'v-scarf-grey');

    const after = server.raw(id)!;
    expect(after.line_items.map((l) => l.variant_id).sort()).toEqual(['v-coat-m', 'v-glove-m']);
    expect(after.attribution).toEqual(HOSTILE_CART.attribution);
    expect(after.discount_codes).toEqual(['WINTER20']);
  });

  it('setQuantity(0) removes the line without touching anything else', async () => {
    const id = await seed();
    await cart.setQuantity(id, 'v-glove-m', 0);

    const after = server.raw(id)!;
    expect(after.line_items.some((l) => l.variant_id === 'v-glove-m')).toBe(false);
    expect(after.note).toBe('Gift wrap please');
  });

  it('setQuantity sets an absolute value rather than incrementing', async () => {
    const id = await seed();
    await cart.setQuantity(id, 'v-scarf-grey', 7);
    expect(server.raw(id)!.line_items.find((l) => l.variant_id === 'v-scarf-grey')!.quantity).toBe(7);
  });

  it('never echoes server-computed fields back on a write', async () => {
    const id = await seed();
    await cart.addLine(id, { variant_id: 'v-coat-s', quantity: 1 });

    const write = server.callLog.filter((c) => c.tool === 'update_cart').at(-1)!;
    const payload = write.args['cart'] as Record<string, unknown>;
    for (const f of ['id', 'checkout_url', 'subtotal', 'total', 'currency', 'updated_at']) {
      expect(payload[f], `computed field "${f}" leaked into the write payload`).toBeUndefined();
    }
    for (const li of payload['line_items'] as Record<string, unknown>[]) {
      expect(li['price']).toBeUndefined();
      expect(li['title']).toBeUndefined();
    }
  });

  it('serializes concurrent mutations so neither is lost', async () => {
    const id = await seed();

    // Two agent turns racing. Without the mutex both read the same state and
    // the second PUT silently discards the first — the classic lost update.
    await Promise.all([
      cart.addLine(id, { variant_id: 'v-coat-s', quantity: 1 }),
      cart.addLine(id, { variant_id: 'v-coat-l', quantity: 1 }),
    ]);

    const variants = server.raw(id)!.line_items.map((l) => l.variant_id).sort();
    expect(variants).toEqual(['v-coat-l', 'v-coat-m', 'v-coat-s', 'v-glove-m', 'v-scarf-grey']);
  });

  it('serializes a long chain of concurrent increments without losing any', async () => {
    const id = await seed();
    await Promise.all(Array.from({ length: 12 }, () => cart.addLine(id, { variant_id: 'v-glove-m', quantity: 1 })));
    expect(server.raw(id)!.line_items.find((l) => l.variant_id === 'v-glove-m')!.quantity).toBe(13);
  });

  it('applyDiscount appends without dropping the existing code', async () => {
    const id = await seed();
    await cart.applyDiscount(id, 'FREESHIP');
    expect(server.raw(id)!.discount_codes).toEqual(['WINTER20', 'FREESHIP']);
  });

  it('applyDiscount is idempotent for a repeated code', async () => {
    const id = await seed();
    await cart.applyDiscount(id, 'WINTER20');
    expect(server.raw(id)!.discount_codes).toEqual(['WINTER20']);
  });

  it('setBuyerEmail merges into buyer rather than replacing it', async () => {
    const id = await seed();
    await cart.setBuyerEmail(id, 'new@example.com');
    expect(server.raw(id)!.buyer).toEqual({ email: 'new@example.com', country: 'US' });
  });

  it('surfaces authoritative out-of-stock messages instead of swallowing them', async () => {
    const oosServer = new MockUcpServer({ outOfStock: ['v-coat-m'] });
    const oosCart = new SafeCart(
      new UcpClient(
        new UcpTransport({
          shopDomain: 'mock.test',
          agentProfile: 'https://storeagent.dev/ucp-profile.json',
          fetch: oosServer.fetch,
          endpoint: oosServer.endpoint,
          maxRetries: 0,
        }),
      ),
    );
    const oosClient = new UcpClient(
      new UcpTransport({
        shopDomain: 'mock.test',
        agentProfile: 'https://storeagent.dev/ucp-profile.json',
        fetch: oosServer.fetch,
        endpoint: oosServer.endpoint,
        maxRetries: 0,
      }),
    );
    const { cart: created } = await oosClient.createCart(HOSTILE_CART);
    const res = await oosCart.addLine(created.id, { variant_id: 'v-scarf-grey', quantity: 1 });

    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.code).toBe('line_item_out_of_stock');
    expect(res.messages[0]!.severity).toBe('warning');
  });

  it('refuses a mutator that would delete a field (guard of last resort)', async () => {
    const id = await seed();
    await expect(
      // A careless mutator that rebuilds the cart from scratch.
      cart.mutate(id, (c) => ({ line_items: c.line_items })),
    ).rejects.toBeInstanceOf(UnsafeCartWriteError);

    // ...and the stored cart is untouched.
    expect(server.raw(id)!.attribution).toEqual(HOSTILE_CART.attribution);
  });

  it('names the fields a destructive write would have dropped', async () => {
    const id = await seed();
    await cart.mutate(id, (c) => ({ line_items: c.line_items })).catch((e: UnsafeCartWriteError) => {
      expect(e.droppedFields).toEqual(
        expect.arrayContaining(['context', 'attribution', 'buyer', 'discount_codes', 'note', 'attributes', 'signals']),
      );
    });
  });
});

describe('projectWritable', () => {
  it('preserves unknown fields (denylist, not whitelist)', () => {
    const cart = {
      id: 'c1',
      subtotal: { amount: 100, currency: 'USD' },
      line_items: [{ variant_id: 'v1', quantity: 1, price: { amount: 100, currency: 'USD' }, title: 'X' }],
      // A field UCP might add tomorrow that we have no type for:
      loyalty_tier: 'gold',
    } as unknown as Parameters<typeof projectWritable>[0];

    const w = projectWritable(cart) as unknown as Record<string, unknown>;
    expect(w['loyalty_tier']).toBe('gold');
    expect(w['id']).toBeUndefined();
    expect(w['subtotal']).toBeUndefined();
    expect((w['line_items'] as Record<string, unknown>[])[0]!['price']).toBeUndefined();
  });
});

describe('mergeLine', () => {
  it('appends a new variant', () => {
    expect(mergeLine([], { variant_id: 'a', quantity: 1 })).toEqual([{ variant_id: 'a', quantity: 1 }]);
  });
  it('increments a matching variant', () => {
    expect(mergeLine([{ variant_id: 'a', quantity: 2 }], { variant_id: 'a', quantity: 3 })[0]!.quantity).toBe(5);
  });
  it('sets when told to', () => {
    expect(mergeLine([{ variant_id: 'a', quantity: 2 }], { variant_id: 'a', quantity: 3 }, 'set')[0]!.quantity).toBe(3);
  });
});

describe('assertNoFieldLoss', () => {
  it('passes when all keys survive', () => {
    expect(() => assertNoFieldLoss({ line_items: [], note: 'x' }, { line_items: [], note: 'y' })).not.toThrow();
  });
  it('throws when a key vanishes', () => {
    expect(() => assertNoFieldLoss({ line_items: [], note: 'x' }, { line_items: [] })).toThrow(UnsafeCartWriteError);
  });
});
