import type { CartWritable } from '../src/types.js';

/**
 * The Phase 0 gate fixture.
 *
 * A cart carrying every category of writable state a real shopper accumulates:
 * multiple lines, attribution (our revenue tracking), buyer identity, a
 * discount, a gift note, custom attributes, locale context, and opaque signals.
 *
 * Any mutation that loses ANY of this is a revenue-destroying bug:
 *  - lose `attribution` → we can no longer prove the agent earned the sale
 *  - lose `discount_codes` → shopper is silently overcharged
 *  - lose `buyer` → abandoned-cart recovery breaks
 *  - lose a line item → the shopper's cart is emptied mid-conversation
 */
export const HOSTILE_CART: CartWritable = {
  line_items: [
    { variant_id: 'v-coat-m', quantity: 1, attributes: { engraving: 'JS' } },
    { variant_id: 'v-scarf-grey', quantity: 2 },
    { variant_id: 'v-glove-m', quantity: 1 },
  ],
  context: { country: 'US', language: 'en', currency: 'USD' },
  attribution: {
    source: 'storeagent',
    session_id: 'sess_01J8ZQ',
    agent_profile: 'https://storeagent.dev/ucp-profile.json',
  },
  buyer: { email: 'shopper@example.com', country: 'US' },
  discount_codes: ['WINTER20'],
  note: 'Gift wrap please',
  attributes: { gift: 'true', delivery_window: 'weekday' },
  signals: { referrer: 'instagram', dwell_ms: 42_000 },
};

/** Every writable key the fixture carries — used for exhaustive assertions. */
export const HOSTILE_CART_KEYS = Object.keys(HOSTILE_CART) as (keyof CartWritable)[];
