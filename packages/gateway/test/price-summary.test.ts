import { describe, expect, it } from 'vitest';
import { withPriceSummary } from '../src/tool-executor.js';

/**
 * One ready-to-quote price per product.
 *
 * Reproduced against the live store: "how much is the swimsuit" was aborted by the
 * tripwire with `uncited_price: 52.00` — $52.00 written for a $52.99 costume — and
 * only recovered on the retry. When the retry slips too, the turn ends as "I can't
 * confirm the price", which is what the merchant reported seeing.
 *
 * The model is not being careless. A three-product answer on that store carries a
 * `price_range` plus eight to ten priced variants per product — about thirty-six
 * figures — from which it is expected to pick a lowest and a highest and write
 * them exactly. `withDisplayPrices` had already removed the division; this removes
 * the comparison, which is the arithmetic that was actually reaching shoppers.
 */

const priced = (amount: number, currency = 'USD') => ({ price: { amount, currency } });
const product = (variants: unknown[], extra: Record<string, unknown> = {}) => ({
  title: 'Swimsuit',
  variants,
  ...extra,
});
const summaryOf = (p: Record<string, unknown>): unknown =>
  (withPriceSummary({ products: [p] }).products[0] as Record<string, unknown>)['price_display'];

describe('one price line per product', () => {
  it('states a range across the product’s variants', () => {
    expect(summaryOf(product([priced(3359), priced(4245), priced(5299)]))).toBe('$33.59 – $52.99');
  });

  it('states a single price when every variant costs the same', () => {
    expect(summaryOf(product([priced(3299), priced(3299)]))).toBe('$32.99');
  });

  it('believes the variants over the store’s own price_range', () => {
    /**
     * They disagree on the live store: one product reports a `price_range` minimum
     * of 3399 while its cheapest variant is 4699 — a list price against a selling
     * price. A shopper can only buy a variant, so the variants win.
     */
    expect(
      summaryOf(
        product([priced(4699), priced(4999)], {
          price_range: { min: { amount: 3399, currency: 'USD' }, max: { amount: 4999, currency: 'USD' } },
        }),
      ),
    ).toBe('$46.99 – $49.99');
  });

  it('falls back to price_range when no variant carries a price', () => {
    expect(
      summaryOf(
        product([], {
          price_range: { min: { amount: 1000, currency: 'USD' }, max: { amount: 2000, currency: 'USD' } },
        }),
      ),
    ).toBe('$10.00 – $20.00');
  });

  it('says nothing rather than mixing currencies into one range', () => {
    // A range whose ends are in different money is not a range. Saying nothing
    // sends the model back to the per-variant prices, which are still right.
    expect(summaryOf(product([priced(1000, 'USD'), priced(2000, 'EUR')]))).toBeUndefined();
  });

  it('says nothing for a product with no prices at all', () => {
    expect(summaryOf(product([{ title: 'S' }, { title: 'M' }]))).toBeUndefined();
  });

  it('never rounds, and keeps the cents', () => {
    // $52.99 becoming $52.00 is the exact failure this exists to remove.
    expect(summaryOf(product([priced(5299)]))).toBe('$52.99');
    expect(summaryOf(product([priced(5200)]))).toBe('$52.00');
    expect(summaryOf(product([priced(5)]))).toBe('$0.05');
  });

  it('uses the shop’s own currency symbol', () => {
    expect(summaryOf(product([priced(1250, 'GBP'), priced(9900, 'GBP')]))).toBe('£12.50 – £99.00');
    expect(summaryOf(product([priced(1250, 'INR')]))).toBe('₹12.50');
    // An unknown currency gets no symbol rather than a wrong one.
    expect(summaryOf(product([priced(97495, 'SEK')]))).toBe('974.95');
  });

  it('summarises every product in a result, however deeply nested', () => {
    const payload = withPriceSummary({
      products: [product([priced(100)]), product([priced(200), priced(300)])],
    });
    expect(payload.products.map((p) => (p as Record<string, unknown>)['price_display'])).toEqual([
      '$1.00',
      '$2.00 – $3.00',
    ]);
  });

  it('reads as a range when spoken aloud', () => {
    // An en dash, not a hyphen: a hyphen between two numbers is read as a minus.
    expect(String(summaryOf(product([priced(100), priced(200)])))).toContain('–');
    expect(String(summaryOf(product([priced(100), priced(200)])))).not.toContain('-');
  });

  it('leaves a payload with no products alone', () => {
    const cart = { cart: { id: 'c1', total: { amount: 100, currency: 'USD' } } };
    expect(() => withPriceSummary(cart)).not.toThrow();
    expect(JSON.stringify(withPriceSummary(cart))).not.toContain('price_display');
  });
});
