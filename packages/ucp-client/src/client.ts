import { UcpTransport, type TransportOptions } from './transport.js';
import type {
  CartResult,
  CartWritable,
  GetProductInput,
  GetProductResult,
  LookupCatalogInput,
  LookupCatalogResult,
  SearchCatalogInput,
  SearchCatalogResult,
} from './types.js';

const LOOKUP_MAX_IDS = 10;
const SEARCH_MAX_LIMIT = 250;

/**
 * The cart wire format, and why translation lives here.
 *
 * The cart tools were built to a guessed shape and never checked against a
 * real store. Against the live UCP endpoint all three parts were wrong, and
 * every one of them failed silently:
 *
 *   request   we sent `{variant_id, quantity}`; the schema requires
 *             `{item: {id}, quantity}`, so create_cart rejected every call
 *   response  we expected `{cart, messages}`; the cart's fields arrive at the
 *             TOP LEVEL, so `const { cart } = ...` was undefined and every
 *             SafeCart read-modify-write threw
 *   messages  we read `{severity, text}`; they arrive as `{type, content}`,
 *             so `text` was undefined — and these are the authoritative
 *             "already sold out" / "quantity adjusted" notices a shopper is
 *             supposed to be told verbatim. A cart could silently drop a
 *             sold-out line and say nothing.
 *
 * Translating at this boundary keeps the protocol in one file: SafeCart, the
 * tool executor and the tests go on using `variant_id` and `{cart, messages}`,
 * which is also the layering the module header already claims.
 */
interface WireLineItem {
  readonly id?: string;
  readonly item?: { readonly id?: string };
  readonly variant_id?: string;
  readonly quantity?: number;
  readonly attributes?: Readonly<Record<string, string>>;
}

interface WireCart {
  readonly ucp?: unknown;
  readonly messages?: readonly {
    readonly code?: string;
    readonly type?: string;
    readonly severity?: string;
    readonly content?: string;
    readonly text?: string;
  }[];
  readonly line_items?: readonly WireLineItem[];
  readonly cart?: unknown;
}

/** `{variant_id}` → `{item: {id}}`, which is what the schema requires. */
function toWireCart(cart: CartWritable): Record<string, unknown> {
  return {
    ...cart,
    line_items: cart.line_items.map((l) => ({
      ...(l.id === undefined ? {} : { id: l.id }),
      item: { id: l.variant_id },
      quantity: l.quantity,
      ...(l.attributes === undefined ? {} : { attributes: l.attributes }),
    })),
  };
}

/** Severity is carried by `type` on the wire. Unknown values stay `info`. */
function toSeverity(value: string | undefined): 'info' | 'warning' | 'error' {
  return value === 'warning' || value === 'error' ? value : 'info';
}

/** Top-level cart fields → `{cart, messages}`, and `item.id` → `variant_id`. */
function fromWireCart(raw: unknown): CartResult {
  const wire = (raw ?? {}) as WireCart;
  // Tolerate a nested `cart` too: the mock server and the spec examples both
  // use it, and a client that only understands one of the two is how this
  // went unnoticed in the first place.
  const body = (wire.cart ?? wire) as WireCart;
  const { ucp: _ucp, messages: _messages, cart: _cart, ...rest } = body as Record<string, unknown> & WireCart;

  const line_items = (body.line_items ?? []).map((l) => ({
    ...l,
    variant_id: l.item?.id ?? l.variant_id ?? '',
    quantity: l.quantity ?? 0,
  }));

  const messages = (wire.messages ?? body.messages ?? []).map((m) => ({
    code: m.code ?? 'unknown',
    severity: toSeverity(m.type ?? m.severity),
    text: m.content ?? m.text ?? '',
  }));

  // Through `unknown`: `rest` is whatever the server sent, and the fields
  // `Cart` requires are the server's to provide. Asserting the shape here
  // would only move a missing-id failure somewhere less obvious.
  return { cart: { ...rest, line_items } as unknown as CartResult['cart'], messages };
}

/**
 * Thin, faithful binding to the seven UCP tools. No convenience, no merging —
 * every method maps 1:1 to a wire call so the semantics stay visible.
 *
 * DO NOT call `updateCart` directly from application code. Use SafeCart
 * (see cart.ts) — `update_cart` has PUT semantics and a partial payload
 * silently destroys the shopper's cart.
 */
export class UcpClient {
  readonly transport: UcpTransport;

  constructor(opts: TransportOptions | UcpTransport) {
    this.transport = opts instanceof UcpTransport ? opts : new UcpTransport(opts);
  }

  // --- Catalog ------------------------------------------------------------

  async searchCatalog(input: SearchCatalogInput, signal?: AbortSignal): Promise<SearchCatalogResult> {
    const limit = input.pagination?.limit;
    if (limit !== undefined && (limit < 1 || limit > SEARCH_MAX_LIMIT)) {
      throw new RangeError(`search_catalog limit must be 1..${SEARCH_MAX_LIMIT}, got ${limit}`);
    }
    return this.transport.call<SearchCatalogResult>('search_catalog', { catalog: input }, signal ? { signal } : undefined);
  }

  async lookupCatalog(input: LookupCatalogInput, signal?: AbortSignal): Promise<LookupCatalogResult> {
    if (input.ids.length === 0) return { products: [] };
    if (input.ids.length > LOOKUP_MAX_IDS) {
      throw new RangeError(`lookup_catalog accepts at most ${LOOKUP_MAX_IDS} ids, got ${input.ids.length}`);
    }
    return this.transport.call<LookupCatalogResult>('lookup_catalog', { catalog: input }, signal ? { signal } : undefined);
  }

  /** Convenience: chunks >10 ids into parallel compliant calls. */
  async lookupCatalogChunked(
    ids: readonly string[],
    context?: LookupCatalogInput['context'],
    signal?: AbortSignal,
  ): Promise<LookupCatalogResult> {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += LOOKUP_MAX_IDS) chunks.push(ids.slice(i, i + LOOKUP_MAX_IDS));
    const results = await Promise.all(
      chunks.map((c) => this.lookupCatalog(context ? { ids: c, context } : { ids: c }, signal)),
    );
    return { products: results.flatMap((r) => r.products) };
  }

  async getProduct(input: GetProductInput, signal?: AbortSignal): Promise<GetProductResult> {
    return this.transport.call<GetProductResult>('get_product', { catalog: input }, signal ? { signal } : undefined);
  }

  // --- Cart ---------------------------------------------------------------

  async createCart(cart: CartWritable, signal?: AbortSignal): Promise<CartResult> {
    return fromWireCart(
      await this.transport.call<unknown>(
        'create_cart',
        { cart: toWireCart(cart) },
        signal ? { signal } : undefined,
      ),
    );
  }

  async getCart(id: string, signal?: AbortSignal): Promise<CartResult> {
    return fromWireCart(await this.transport.call<unknown>('get_cart', { id }, signal ? { signal } : undefined));
  }

  /**
   * ⚠️ PUT SEMANTICS — replaces the cart's ENTIRE state with `cart`.
   * Any field you omit is removed. Prefer SafeCart.
   */
  async updateCart(id: string, cart: CartWritable, signal?: AbortSignal): Promise<CartResult> {
    return fromWireCart(
      await this.transport.call<unknown>(
        'update_cart',
        { id, cart: toWireCart(cart) },
        signal ? { signal } : undefined,
      ),
    );
  }

  async cancelCart(id: string, idempotencyKey: string, signal?: AbortSignal): Promise<CartResult> {
    if (!idempotencyKey) throw new TypeError('cancel_cart requires meta.idempotency-key (UUID)');
    return fromWireCart(
      await this.transport.call<unknown>(
        'cancel_cart',
        { id },
        signal ? { idempotencyKey, signal } : { idempotencyKey },
      ),
    );
  }
}
