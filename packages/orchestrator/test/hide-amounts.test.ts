import { describe, expect, it } from 'vitest';
import { hideComputableAmounts } from '../src/loop.js';

/**
 * The model is told to copy `display` and never compute from `amount`. It
 * complies on short answers and slips on long ones — listing six boards it
 * wrote "$785.00" for the $785.95 board, the tripwire threw the answer away,
 * and the shopper got an escalation instead of a price the store knew.
 */
describe('hiding computable amounts from the model', () => {
  const money = { amount: 78595, currency: 'USD', display: '$785.95' };

  it('drops amount when a quotable display sits beside it', () => {
    expect(hideComputableAmounts(money)).toEqual({ currency: 'USD', display: '$785.95' });
  });

  it('keeps amount when there is no display to quote instead', () => {
    // Removing it here would leave the model with no price at all.
    const bare = { amount: 78595, currency: 'USD' };
    expect(hideComputableAmounts(bare)).toEqual(bare);
  });

  it('reaches money nested anywhere in a catalog payload', () => {
    const payload = {
      products: [
        { id: 'p1', title: 'Board', price_range: { min: money, max: money }, list_price_range: { min: money } },
      ],
    };
    const out = hideComputableAmounts(payload) as typeof payload;
    expect(out.products[0]!.price_range.min).toEqual({ currency: 'USD', display: '$785.95' });
    expect(out.products[0]!.list_price_range.min).toEqual({ currency: 'USD', display: '$785.95' });
    expect(out.products[0]!.id).toBe('p1');
  });

  it('does not mutate the original, which grounding and the cards still read', () => {
    const payload = { price: { ...money } };
    hideComputableAmounts(payload);
    expect(payload.price.amount).toBe(78595);
  });

  it('leaves non-money numbers alone', () => {
    const payload = { quantity: 3, rating: 5, price: money };
    const out = hideComputableAmounts(payload) as Record<string, unknown>;
    expect(out['quantity']).toBe(3);
    expect(out['rating']).toBe(5);
  });

  it('survives a cyclic payload without hanging', () => {
    const node: Record<string, unknown> = { price: money };
    node['self'] = node;
    expect(() => hideComputableAmounts(node)).not.toThrow();
  });
});
