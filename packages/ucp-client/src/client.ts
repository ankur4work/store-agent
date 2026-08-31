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
    return this.transport.call<SearchCatalogResult>('search_catalog', { ...input }, signal ? { signal } : undefined);
  }

  async lookupCatalog(input: LookupCatalogInput, signal?: AbortSignal): Promise<LookupCatalogResult> {
    if (input.ids.length === 0) return { products: [] };
    if (input.ids.length > LOOKUP_MAX_IDS) {
      throw new RangeError(`lookup_catalog accepts at most ${LOOKUP_MAX_IDS} ids, got ${input.ids.length}`);
    }
    return this.transport.call<LookupCatalogResult>('lookup_catalog', { ...input }, signal ? { signal } : undefined);
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
    return this.transport.call<GetProductResult>('get_product', { ...input }, signal ? { signal } : undefined);
  }

  // --- Cart ---------------------------------------------------------------

  async createCart(cart: CartWritable, signal?: AbortSignal): Promise<CartResult> {
    return this.transport.call<CartResult>('create_cart', { cart }, signal ? { signal } : undefined);
  }

  async getCart(id: string, signal?: AbortSignal): Promise<CartResult> {
    return this.transport.call<CartResult>('get_cart', { id }, signal ? { signal } : undefined);
  }

  /**
   * ⚠️ PUT SEMANTICS — replaces the cart's ENTIRE state with `cart`.
   * Any field you omit is removed. Prefer SafeCart.
   */
  async updateCart(id: string, cart: CartWritable, signal?: AbortSignal): Promise<CartResult> {
    return this.transport.call<CartResult>('update_cart', { id, cart }, signal ? { signal } : undefined);
  }

  async cancelCart(id: string, idempotencyKey: string, signal?: AbortSignal): Promise<CartResult> {
    if (!idempotencyKey) throw new TypeError('cancel_cart requires meta.idempotency-key (UUID)');
    return this.transport.call<CartResult>('cancel_cart', { id }, signal ? { idempotencyKey, signal } : { idempotencyKey });
  }
}
