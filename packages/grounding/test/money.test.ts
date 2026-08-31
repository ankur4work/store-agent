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

  it('returns undefined when no stock language is present', () => {
    expect(detectStock('What size do you need?')).toBeUndefined();
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
