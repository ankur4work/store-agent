/**
 * UCP (Universal Commerce Protocol) types — catalog + cart.
 * Spec version targeted: 2026-04-08.
 *
 * Endpoint: POST https://{shop-domain}/api/ucp/mcp  (JSON-RPC 2.0)
 *
 * NOTE: prices are in MINOR currency units (cents). Normalize once at this
 * boundary — never let minor units reach a prompt or a UI string.
 */

// ---------------------------------------------------------------------------
// Request meta
// ---------------------------------------------------------------------------

/**
 * Every UCP request carries `meta`. The agent profile URI is mandatory.
 *
 * SPIKE-OPEN-QUESTION #1: the docs render this as `meta.ucp-agent.profile`.
 * That is ambiguous between a literal dotted key and a nested object. We encode
 * the dotted-key form (most common in this spec family) and keep it behind
 * `MetaCodec` so switching is a one-line change once verified against a live
 * store. See docs/PHASE-0-FINDINGS.md.
 */
export interface UcpMeta {
  readonly 'ucp-agent.profile': string;
  readonly 'idempotency-key'?: string;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface Money {
  /** Amount in MINOR units (e.g. 1999 === $19.99). */
  readonly amount: number;
  readonly currency: string;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface BuyerContext {
  readonly country?: string;
  readonly language?: string;
  readonly currency?: string;
}

export interface CatalogVariant {
  readonly id: string;
  readonly title: string;
  readonly price: Money;
  readonly available: boolean;
  readonly options?: Readonly<Record<string, string>>;
  readonly image_url?: string;
}

export interface CatalogProduct {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
  readonly price_range?: { readonly min: Money; readonly max: Money };
  readonly media?: readonly { readonly url: string; readonly alt?: string }[];
  readonly variants?: readonly CatalogVariant[];
  readonly rating?: { readonly value: number; readonly count: number };
  readonly seller?: { readonly name: string };
}

export interface SearchCatalogInput {
  readonly query: string;
  readonly context?: BuyerContext;
  readonly pagination?: { readonly cursor?: string; readonly limit?: number };
}

export interface SearchCatalogResult {
  readonly products: readonly CatalogProduct[];
  readonly pagination?: { readonly next_cursor?: string };
}

export interface LookupCatalogInput {
  /** Max 10 identifiers per call. Accepts `gid://shopify/Product/123`. */
  readonly ids: readonly string[];
  readonly context?: BuyerContext;
}

export interface LookupCatalogResult {
  readonly products: readonly CatalogProduct[];
}

export interface GetProductInput {
  readonly id: string;
  /** Partial option selection, e.g. `{ Size: "M" }`. */
  readonly selected?: Readonly<Record<string, string>>;
  readonly context?: BuyerContext;
}

export interface GetProductResult {
  readonly product: CatalogProduct;
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export interface CartLineItem {
  readonly id?: string;
  readonly variant_id: string;
  readonly quantity: number;
  readonly attributes?: Readonly<Record<string, string>>;
  /** Server-computed; never sent on write. */
  readonly price?: Money;
  /** Server-computed; never sent on write. */
  readonly title?: string;
}

export interface CartAttribution {
  readonly source?: string;
  readonly session_id?: string;
  readonly agent_profile?: string;
}

export interface CartBuyer {
  readonly email?: string;
  readonly phone?: string;
  readonly country?: string;
}

/**
 * The writable projection of a cart. THIS is what `update_cart` replaces
 * wholesale. Any field omitted here is DELETED server-side.
 */
export interface CartWritable {
  readonly line_items: readonly CartLineItem[];
  readonly context?: BuyerContext;
  readonly attribution?: CartAttribution;
  readonly buyer?: CartBuyer;
  readonly signals?: Readonly<Record<string, unknown>>;
  readonly discount_codes?: readonly string[];
  readonly note?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

/** Server-computed fields that must be stripped before a write. */
export interface CartComputed {
  readonly id: string;
  readonly checkout_url?: string;
  readonly subtotal?: Money;
  readonly total?: Money;
  readonly currency?: string;
  readonly updated_at?: string;
}

export type Cart = CartWritable & CartComputed;

/**
 * Business-outcome messages (out of stock, quantity adjusted, discount
 * rejected). AUTHORITATIVE — surface verbatim to the shopper. Do not let the
 * model paraphrase these; paraphrasing is where hallucination enters.
 */
export interface CartMessage {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly text: string;
  readonly line_item_id?: string;
}

export interface CartResult {
  readonly cart: Cart;
  readonly messages: readonly CartMessage[];
}

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const CATALOG_TOOLS = ['search_catalog', 'lookup_catalog', 'get_product'] as const;
export const CART_TOOLS = ['create_cart', 'get_cart', 'update_cart', 'cancel_cart'] as const;

export type CatalogTool = (typeof CATALOG_TOOLS)[number];
export type CartTool = (typeof CART_TOOLS)[number];
export type UcpTool = CatalogTool | CartTool;

/**
 * Legacy Storefront MCP tools. Support ENDED 2026-08-31.
 * Present only so lint/CI can fail if one ever appears in our source.
 */
export const FORBIDDEN_LEGACY_TOOLS = [
  'search_shop_catalog',
  'search_shop_policies_and_faqs',
  'get_cart_legacy',
  'update_cart_legacy',
] as const;
