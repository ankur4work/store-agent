import type { ToolResultRecord } from '../src/types.js';

/** A realistic `search_catalog` payload — prices in MINOR units. */
export const SEARCH_RESULT: ToolResultRecord = {
  tool_call_id: 'toolu_search_1',
  tool: 'search_catalog',
  result: {
    products: [
      {
        id: 'gid://shopify/Product/1',
        title: 'Merino Wool Overcoat',
        price_range: { min: { amount: 18900, currency: 'USD' }, max: { amount: 18900, currency: 'USD' } },
        variants: [
          { id: 'v-coat-s', title: 'S', price: { amount: 18900, currency: 'USD' }, available: true },
          { id: 'v-coat-m', title: 'M', price: { amount: 18900, currency: 'USD' }, available: true },
          { id: 'v-coat-l', title: 'L', price: { amount: 18900, currency: 'USD' }, available: false },
        ],
      },
      {
        id: 'gid://shopify/Product/2',
        title: 'Cashmere Scarf',
        price_range: { min: { amount: 7900, currency: 'USD' }, max: { amount: 7900, currency: 'USD' } },
        variants: [{ id: 'v-scarf-grey', title: 'Grey', price: { amount: 7900, currency: 'USD' }, available: true }],
      },
    ],
  },
};

/** Everything sold out — for contradiction tests. */
export const SOLD_OUT_RESULT: ToolResultRecord = {
  tool_call_id: 'toolu_search_2',
  tool: 'search_catalog',
  result: {
    products: [
      {
        id: 'gid://shopify/Product/9',
        title: 'Limited Edition Boot',
        price_range: { min: { amount: 29900, currency: 'USD' }, max: { amount: 29900, currency: 'USD' } },
        variants: [{ id: 'v-boot-9', title: '9', price: { amount: 29900, currency: 'USD' }, available: false }],
      },
    ],
  },
};

export const CART_RESULT: ToolResultRecord = {
  tool_call_id: 'toolu_cart_1',
  tool: 'get_cart',
  result: {
    cart: {
      id: 'gid://shopify/Cart/1',
      line_items: [
        { variant_id: 'v-coat-m', quantity: 1, price: { amount: 18900, currency: 'USD' } },
        { variant_id: 'v-scarf-grey', quantity: 1, price: { amount: 7900, currency: 'USD' } },
      ],
      subtotal: { amount: 26800, currency: 'USD' },
      total: { amount: 26800, currency: 'USD' },
      currency: 'USD',
    },
    messages: [],
  },
};

/** Merchant policy corpus hit — the owned side of the grounding split. */
export const POLICY_RESULT: ToolResultRecord = {
  tool_call_id: 'toolu_policy_1',
  tool: 'get_policy',
  result: {
    topic: 'shipping',
    text: 'Standard shipping arrives in 3-5 business days. Returns accepted within 30 days.',
    source_url: 'https://acme.test/policies/shipping',
  },
};

/**
 * Shopify's own sample catalog, as it arrives from a fresh dev store.
 *
 * The titles are verbatim: every dev store, and therefore every app reviewer's
 * store, has a product literally called "The Out of Stock Snowboard" — and it
 * reports `available: true`, because the name is a label for demo data, not a
 * statement about its inventory. Listing it by name was read as a stock claim
 * that contradicted the source, which aborted the answer and escalated.
 */
export const SHOPIFY_SAMPLE_SNOWBOARDS: ToolResultRecord = {
  tool_call_id: 'toolu_search_snow',
  tool: 'search_catalog',
  result: {
    products: [
      {
        id: 'gid://shopify/Product/8944748527668',
        title: 'The Out of Stock Snowboard',
        price_range: { min: { amount: 88595, currency: 'USD' }, max: { amount: 88595, currency: 'USD' } },
        variants: [
          { id: 'v-oos', title: 'Default Title', price: { amount: 88595, currency: 'USD' }, available: true },
        ],
      },
      {
        id: 'gid://shopify/Product/8944748757044',
        title: 'The Complete Snowboard',
        price_range: { min: { amount: 69995, currency: 'USD' }, max: { amount: 69995, currency: 'USD' } },
        variants: [{ id: 'v-ice', title: 'Ice', price: { amount: 69995, currency: 'USD' }, available: true }],
      },
    ],
  },
};
