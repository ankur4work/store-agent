import { describe, expect, it } from 'vitest';
import { collectMoneyFromResult, extractMoneyFromText, isDerivable } from '../src/money.js';
import { detectShippingEstimate, detectStock } from '../src/extract.js';
import { SEARCH_RESULT } from './fixtures.js';

describe('extractMoneyFromText', () => {
  it.each([
    ['$189', 18900],
    ['$189.00', 18900],
    ['$1,299.99', 129999],
    ['189.00 USD', 18900],
    ['45 GBP', 4500],
    ['250 dollars', 25000],
    ['£45.50', 4550],
    ['€19.90', 1990],
  ])('parses %s → %i minor units', (text, expected) => {
    expect(extractMoneyFromText(text)).toContain(expected);
  });

  it('ignores bare numbers that are not money', () => {
    expect(extractMoneyFromText('rated 4.6 by 212 shoppers, quantity 2')).toEqual([]);
  });

  it('deduplicates repeated mentions', () => {
    expect(extractMoneyFromText('$189 and $189.00 again')).toEqual([18900]);
  });

  it('finds several distinct values', () => {
    expect(extractMoneyFromText('$189.00 and $79.00').sort((a, b) => a - b)).toEqual([7900, 18900]);
  });
});

describe('collectMoneyFromResult', () => {
  it('deep-walks a UCP payload for {amount, currency} shapes', () => {
    expect(collectMoneyFromResult(SEARCH_RESULT.result).sort((a, b) => a - b)).toEqual([7900, 18900]);
  });

  it('ignores bare numbers so quantities and ratings are not treated as prices', () => {
    expect(collectMoneyFromResult({ rating: 4.6, count: 212, quantity: 2 })).toEqual([]);
  });

  /**
   * Found live: the tripwire aborted a correct answer about free shipping
   * because "$75" lived in policy prose rather than a {amount,currency} object.
   */
  it('extracts money written in prose inside string values', () => {
    const policy = { topic: 'shipping', text: 'Standard shipping is free over $75 and Express is $12.' };
    expect(collectMoneyFromResult(policy).sort((a, b) => a - b)).toEqual([1200, 7500]);
  });

  it('still ignores numbers in prose that carry no currency marker', () => {
    expect(collectMoneyFromResult({ text: 'Arrives in 3-5 business days, rated 4.6 by 212 people.' })).toEqual([]);
  });

  it('collects from structured and prose sources together', () => {
    const mixed = {
      price: { amount: 18900, currency: 'USD' },
      note: 'Free shipping over $75.',
    };
    expect(collectMoneyFromResult(mixed).sort((a, b) => a - b)).toEqual([7500, 18900]);
  });

  it('survives cyclic structures', () => {
    const a: Record<string, unknown> = { price: { amount: 100, currency: 'USD' } };
    a['self'] = a;
    expect(collectMoneyFromResult(a)).toEqual([100]);
  });

  it('returns nothing for primitives', () => {
    expect(collectMoneyFromResult('hello')).toEqual([]);
    expect(collectMoneyFromResult(null)).toEqual([]);
  });
});

describe('isDerivable', () => {
  it('matches exactly', () => {
    expect(isDerivable(18900, [18900, 7900])).toBe(true);
  });
  it('matches a pair sum', () => {
    expect(isDerivable(26800, [18900, 7900])).toBe(true);
  });
  it('matches a triple sum', () => {
    expect(isDerivable(32200, [18900, 7900, 5400])).toBe(true);
  });
  it('rejects an unrelated value', () => {
    expect(isDerivable(9900, [18900, 7900])).toBe(false);
  });
  it('rejects against an empty source set', () => {
    expect(isDerivable(100, [])).toBe(false);
  });
});

describe('detectStock', () => {
  it.each([
    ['It is in stock.', 'in_stock'],
    ['Ready to ship today.', 'in_stock'],
    ['That one is sold out.', 'out_of_stock'],
    ['Currently unavailable.', 'out_of_stock'],
    ['It is backordered.', 'out_of_stock'],
  ])('%s → %s', (text, polarity) => {
    expect(detectStock(text)?.polarity).toBe(polarity);
  });

  it('handles negation rather than matching the positive substring', () => {
    // "not in stock" contains "in stock" — naive matching gets this backwards.
    expect(detectStock('That size is not in stock.')?.polarity).toBe('out_of_stock');
    expect(detectStock('It is no longer available.')?.polarity).toBe('out_of_stock');
    expect(detectStock("It isn't currently in stock.")?.polarity).toBe('out_of_stock');
  });

  /**
   * Saying what the store does NOT have, and naming it.
   *
   * Found by `abs-competitor-product` in the grounding eval. The negation rule only
   * looked for a negation sitting directly against the stock phrase, so once the
   * thing being refused was named — "we don't have a Canada Goose parka in stock" —
   * the negation was several words away, "in stock" matched on its own, and the
   * reply was recorded as claiming the parka WAS available. The exact opposite of
   * what it says, and the production tripwire shares this function: a correct
   * refusal was treated as an unsupported availability claim, throwing the
   * generation away and pushing a good turn towards a retry and a handoff.
   */
  it.each([
    ['We don’t have a Canada Goose parka in stock.', 'out_of_stock'],
    ['We do not have that in stock.', 'out_of_stock'],
    ['I can’t find a Canada Goose parka in stock.', 'out_of_stock'],
    ['We don’t carry that size in stock.', 'out_of_stock'],
    ['We haven’t got it in stock.', 'out_of_stock'],
  ])('%s → %s', (text, polarity) => {
    expect(detectStock(text)?.polarity).toBe(polarity);
  });

  /**
   * A negation must not swallow a positive claim that follows it.
   *
   * Missing an in-stock claim is the dangerous direction — it is the one that tells
   * a shopper to buy something the store does not have — so a contrastive clause or
   * a sentence end ends the negation's reach.
   */
  it.each([
    ['We don’t carry Canada Goose, but this parka is in stock.', 'in_stock'],
    ['We don’t have that; the Ice is in stock.', 'in_stock'],
    ['We don’t have that. The Ice is in stock.', 'in_stock'],
  ])('%s → %s', (text, polarity) => {
    expect(detectStock(text)?.polarity).toBe(polarity);
  });

  it('returns undefined when no stock language is present', () => {
    expect(detectStock('What size do you need?')).toBeUndefined();
  });

  /**
   * Found by the eval: "the catalog is unavailable" is a statement about our
   * systems, not the merchant's inventory. Reading it as an out-of-stock claim
   * turned correct tool-failure responses into stock hallucinations.
   */
  it.each([
    'I can’t verify the price right now because the catalog is unavailable.',
    'The policy service is unavailable.',
    'Order tracking is unavailable here.',
    'The team handoff is unavailable right now.',
  ])('ignores system unavailability: %s', (text) => {
    expect(detectStock(text)).toBeUndefined();
  });

  it('still detects product unavailability in the same reply', () => {
    // System sentence first, product claim second — only the second counts.
    const text = 'The catalog is unavailable. Size L is sold out.';
    expect(detectStock(text)?.polarity).toBe('out_of_stock');
  });

  /**
   * Shopify's sample catalog — the data on every dev store, and so on an app
   * reviewer's store — contains "The Out of Stock Snowboard". Listing it by
   * name was read as an inventory claim, which aborted a correct answer twice
   * and escalated the shopper to a human instead of showing six snowboards.
   */
  const SAMPLE = ['The Out of Stock Snowboard', 'The Complete Snowboard'];

  it('reads a stock phrase inside a product name as a name', () => {
    expect(detectStock('Here are six snowboards: The Out of Stock Snowboard — $885.95.', SAMPLE)).toBeUndefined();
  });

  it('still detects a real claim about a product whose name contains one', () => {
    // The name is masked; the clause after it is not.
    expect(
      detectStock('The Out of Stock Snowboard is sold out.', SAMPLE)?.polarity,
    ).toBe('out_of_stock');
    expect(
      detectStock('The Out of Stock Snowboard is in stock.', SAMPLE)?.polarity,
    ).toBe('in_stock');
  });

  it('masks nothing when the name carries no stock language', () => {
    // A product called "Ice" must never suppress a real claim.
    expect(detectStock('The Ice board is sold out.', ['Ice'])?.polarity).toBe('out_of_stock');
  });

  it('is unchanged when no names are supplied', () => {
    expect(detectStock('The Out of Stock Snowboard — $885.95.')?.polarity).toBe('out_of_stock');
  });
});

describe('detectShippingEstimate', () => {
  it.each([
    'It ships in 2-3 business days.',
    'Arrives within 5 days.',
    'Next-day delivery is available.',
  ])('detects: %s', (text) => {
    expect(detectShippingEstimate(text)).toBeDefined();
  });

  it('ignores shipping talk with no duration', () => {
    expect(detectShippingEstimate('We ship worldwide.')).toBeUndefined();
  });
});
