import type { Cart, CartMessage, CartWritable, CatalogProduct } from '../src/types.js';

/**
 * A deliberately HOSTILE UCP mock.
 *
 * The single most important property: `update_cart` implements true PUT
 * semantics — the stored writable state is REPLACED by the payload, so any
 * omitted field is destroyed. If this mock were forgiving, every safety test
 * in this suite would be vacuous. `mock-fidelity.test.ts` proves it bites.
 */

export interface MockOptions {
  /** Simulated round-trip latency in ms. */
  readonly latencyMs?: number;
  /** Variant ids to report as out of stock (clamped to qty 0 + a message). */
  readonly outOfStock?: readonly string[];
  /** Force the Nth call (1-based) of a tool to fail with an HTTP status. */
  readonly failNthCall?: { readonly tool: string; readonly n: number; readonly status: number };
}

const CATALOG: CatalogProduct[] = [
  {
    id: 'gid://shopify/Product/1',
    title: 'Merino Wool Overcoat',
    description: 'Full-length wool overcoat, water resistant.',
    url: 'https://acme.test/products/merino-overcoat',
    price_range: { min: { amount: 18900, currency: 'USD' }, max: { amount: 18900, currency: 'USD' } },
    variants: [
      { id: 'v-coat-s', title: 'S', price: { amount: 18900, currency: 'USD' }, available: true, options: { Size: 'S' } },
      { id: 'v-coat-m', title: 'M', price: { amount: 18900, currency: 'USD' }, available: true, options: { Size: 'M' } },
      { id: 'v-coat-l', title: 'L', price: { amount: 18900, currency: 'USD' }, available: false, options: { Size: 'L' } },
    ],
    rating: { value: 4.6, count: 212 },
  },
  {
    id: 'gid://shopify/Product/2',
    title: 'Cashmere Scarf',
    price_range: { min: { amount: 7900, currency: 'USD' }, max: { amount: 7900, currency: 'USD' } },
    variants: [
      { id: 'v-scarf-grey', title: 'Grey', price: { amount: 7900, currency: 'USD' }, available: true },
    ],
    rating: { value: 4.9, count: 88 },
  },
  {
    id: 'gid://shopify/Product/3',
    title: 'Leather Gloves',
    price_range: { min: { amount: 5400, currency: 'USD' }, max: { amount: 5400, currency: 'USD' } },
    variants: [{ id: 'v-glove-m', title: 'M', price: { amount: 5400, currency: 'USD' }, available: true }],
  },
];

const PRICE_BY_VARIANT: Record<string, number> = {
  'v-coat-s': 18900,
  'v-coat-m': 18900,
  'v-coat-l': 18900,
  'v-scarf-grey': 7900,
  'v-glove-m': 5400,
};

export class MockUcpServer {
  readonly endpoint = 'https://mock.test/api/ucp/mcp';
  /** Raw writable state per cart — exactly what the last write left behind. */
  readonly carts = new Map<string, CartWritable>();
  readonly callLog: { tool: string; args: Record<string, unknown> }[] = [];
  private seq = 0;
  private readonly counts = new Map<string, number>();

  constructor(private readonly opts: MockOptions = {}) {}

  /** Inspect stored state without going through the wire. */
  raw(id: string): CartWritable | undefined {
    return this.carts.get(id);
  }

  callCount(tool: string): number {
    return this.callLog.filter((c) => c.tool === tool).length;
  }

  reset(): void {
    this.carts.clear();
    this.callLog.length = 0;
    this.counts.clear();
    this.seq = 0;
  }

  /** A `fetch`-compatible function to inject into UcpTransport. */
  readonly fetch: typeof globalThis.fetch = async (_input, init) => {
    // A faithful mock must honour AbortSignal exactly as real fetch does —
    // otherwise timeouts and cancellation are untestable and the transport's
    // deadline handling silently does nothing.
    const signal = init?.signal ?? undefined;
    throwIfAborted(signal);

    const body = JSON.parse(String(init?.body ?? '{}')) as {
      id: number;
      params: { name: string; arguments: Record<string, unknown> };
    };
    const tool = body.params.name;
    const args = body.params.arguments;
    this.callLog.push({ tool, args });

    if (this.opts.latencyMs) await sleep(this.opts.latencyMs, signal);
    throwIfAborted(signal);

    const n = (this.counts.get(tool) ?? 0) + 1;
    this.counts.set(tool, n);
    const fail = this.opts.failNthCall;
    if (fail && fail.tool === tool && fail.n === n) {
      return new Response('upstream error', { status: fail.status });
    }

    // --- meta validation: every request must carry the agent profile --------
    const meta = args['meta'] as Record<string, unknown> | undefined;
    // Nested, matching a real store. This mock previously enforced the DOTTED
    // key, which is why the Phase 0 spike could not settle OPEN-QUESTION #1:
    // the mock agreed with the guess. A mock that validates our own assumption
    // proves only that we are self-consistent.
    const agent = meta?.['ucp-agent'] as { profile?: unknown } | undefined;
    if (!meta || typeof agent?.profile !== 'string') {
      return this.rpcError(body.id, -32602, 'meta.ucp-agent.profile is required');
    }

    try {
      switch (tool) {
        case 'search_catalog':
          return this.ok(body.id, this.searchCatalog(args));
        case 'lookup_catalog':
          return this.ok(body.id, this.lookupCatalog(args));
        case 'get_product':
          return this.ok(body.id, this.getProduct(args, body.id));
        case 'create_cart':
          return this.ok(body.id, this.createCart(args));
        case 'get_cart':
          return this.ok(body.id, this.getCart(args));
        case 'update_cart':
          return this.ok(body.id, this.updateCart(args));
        case 'cancel_cart':
          if (typeof meta['idempotency-key'] !== 'string') {
            return this.rpcError(body.id, -32602, 'cancel_cart requires meta.idempotency-key');
          }
          return this.ok(body.id, this.cancelCart(args));
        default:
          return this.rpcError(body.id, -32601, `unknown tool ${tool}`);
      }
    } catch (e) {
      return this.rpcError(body.id, -32000, (e as Error).message);
    }
  };

  // --- catalog ------------------------------------------------------------

  private searchCatalog(args: Record<string, unknown>) {
    const q = String(args['query'] ?? '').toLowerCase();
    const limit = (args['pagination'] as { limit?: number } | undefined)?.limit ?? 10;
    const products = CATALOG.filter(
      (p) => q === '' || p.title.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q),
    ).slice(0, limit);
    return { products };
  }

  private lookupCatalog(args: Record<string, unknown>) {
    const ids = (args['ids'] as string[] | undefined) ?? [];
    if (ids.length > 10) throw new Error('lookup_catalog: max 10 ids');
    return { products: CATALOG.filter((p) => ids.includes(p.id)) };
  }

  private getProduct(args: Record<string, unknown>, _id: number) {
    const product = CATALOG.find((p) => p.id === args['id']);
    if (!product) throw new Error(`product not found: ${String(args['id'])}`);
    return { product };
  }

  // --- cart ---------------------------------------------------------------

  private createCart(args: Record<string, unknown>) {
    const incoming = (args['cart'] ?? {}) as CartWritable;
    const id = `gid://shopify/Cart/${++this.seq}`;
    const stored: CartWritable = { ...incoming, line_items: [...(incoming.line_items ?? [])] };
    this.carts.set(id, stored);
    return this.materialize(id);
  }

  private getCart(args: Record<string, unknown>) {
    const id = String(args['id']);
    if (!this.carts.has(id)) throw new Error(`cart not found: ${id}`);
    return this.materialize(id);
  }

  /**
   * ⚠️ TRUE PUT SEMANTICS. The stored state is replaced outright. Anything the
   * caller omitted is gone. This is the behaviour SafeCart exists to survive.
   */
  private updateCart(args: Record<string, unknown>) {
    const id = String(args['id']);
    if (!this.carts.has(id)) throw new Error(`cart not found: ${id}`);
    const incoming = (args['cart'] ?? {}) as CartWritable;
    this.carts.set(id, { ...incoming, line_items: [...(incoming.line_items ?? [])] });
    return this.materialize(id);
  }

  private cancelCart(args: Record<string, unknown>) {
    const id = String(args['id']);
    const snapshot = this.materialize(id);
    this.carts.delete(id);
    return snapshot;
  }

  /** Attach server-computed fields + business messages, as the real API does. */
  private materialize(id: string) {
    const stored = this.carts.get(id);
    if (!stored) throw new Error(`cart not found: ${id}`);
    const messages: CartMessage[] = [];
    const oos = new Set(this.opts.outOfStock ?? []);

    const line_items = (stored.line_items ?? []).map((li) => {
      if (oos.has(li.variant_id)) {
        messages.push({
          code: 'line_item_out_of_stock',
          severity: 'warning',
          text: `${li.variant_id} is out of stock and was removed.`,
          line_item_id: li.variant_id,
        });
        return { ...li, quantity: 0, price: { amount: PRICE_BY_VARIANT[li.variant_id] ?? 0, currency: 'USD' } };
      }
      return { ...li, price: { amount: PRICE_BY_VARIANT[li.variant_id] ?? 0, currency: 'USD' } };
    });

    const subtotal = line_items.reduce((s, li) => s + (li.price?.amount ?? 0) * li.quantity, 0);

    const cart: Cart = {
      ...stored,
      line_items,
      id,
      checkout_url: `https://mock.test/checkouts/${encodeURIComponent(id)}`,
      subtotal: { amount: subtotal, currency: 'USD' },
      total: { amount: subtotal, currency: 'USD' },
      currency: 'USD',
      updated_at: new Date(0).toISOString(),
    };
    return { cart, messages };
  }

  // --- envelopes ----------------------------------------------------------

  private ok(id: number, structuredContent: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  private rpcError(id: number, code: number, message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Sleep that rejects with AbortError the moment the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
