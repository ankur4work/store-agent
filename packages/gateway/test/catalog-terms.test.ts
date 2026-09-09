import { describe, expect, it } from 'vitest';
import { catalogTerms } from '../src/tool-executor.js';

/**
 * Catalog search matches the shopper's words against product text, so a
 * sentence made mostly of words about the *asking* matches nothing. Every
 * example here is a real question that returned zero products against the live
 * store, and was answered "I couldn't find a board in the catalog" by a store
 * whose catalog is entirely boards.
 */
describe('reducing a shopper sentence to catalog terms', () => {
  it('keeps the product word out of a conversational request', () => {
    expect(catalogTerms("hey i need a board for my kid he's 12 whats good and how much")).toBe('board');
  });

  it('keeps both products in a comparison', () => {
    expect(catalogTerms('whats the difference between the complete snowboard and the multi-managed one')).toBe(
      'complete snowboard multi-managed',
    );
  });

  it('survives slang and missing punctuation', () => {
    expect(catalogTerms('yo whats poppin any deals on boards rn')).toBe('poppin boards');
  });

  it('drops a superlative down to the product word', () => {
    expect(catalogTerms('whats your most expensive product')).toBe('most product');
  });

  it('returns empty when nothing product-like remains, which means browse', () => {
    // "i want something cool" is all asking and no product.
    expect(catalogTerms('i want something cool')).toBe('');
    expect(catalogTerms('what do you sell')).toBe('');
    expect(catalogTerms('hi')).toBe('');
  });

  it('leaves a clean product query alone', () => {
    expect(catalogTerms('Hydrogen snowboard')).toBe('hydrogen snowboard');
  });

  it('drops bare numbers, which match nothing and pull in wrong products', () => {
    expect(catalogTerms('board for a 12 year old')).toBe('board');
  });
});
