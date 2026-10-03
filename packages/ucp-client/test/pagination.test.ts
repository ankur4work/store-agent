import { describe, expect, it } from 'vitest';
import { nextCursor } from '../src/pagination.js';

/**
 * Reading the cursor the store actually sends.
 *
 * The spec calls it `next_cursor`. Measured against a live Shopify storefront,
 * the endpoint sends `{ has_next_page, cursor }` and never sends `next_cursor`:
 *
 *     page 1: 10 products | has_next_page=true  | cursor=present | next_cursor=ABSENT
 *     page 2: 10 products | has_next_page=true  | cursor=present | next_cursor=ABSENT
 *     page 3:  7 products | has_next_page=false | cursor=ABSENT  | next_cursor=ABSENT
 *
 * So every walk in this codebase ended after one page and reported success —
 * which is how the semantic index came to hold the first 100 products of each
 * catalog and nothing else, with no error anywhere to show it.
 */
describe('nextCursor', () => {
  it('reads the cursor a live Shopify storefront sends', () => {
    // The case that was broken: no `next_cursor` anywhere in the response.
    expect(nextCursor({ pagination: { has_next_page: true, cursor: 'c2' } })).toBe('c2');
  });

  it('reads the cursor the spec promises', () => {
    expect(nextCursor({ pagination: { next_cursor: 'c2' } })).toBe('c2');
  });

  it('prefers the spec spelling when a store sends both', () => {
    expect(nextCursor({ pagination: { next_cursor: 'spec', cursor: 'observed' } })).toBe('spec');
  });

  it('ends the walk when the store says there is no next page', () => {
    // `has_next_page` is authoritative. A store that left a stale cursor in the
    // last response would otherwise be walked forever.
    expect(nextCursor({ pagination: { has_next_page: false, cursor: 'stale' } })).toBeUndefined();
    expect(
      nextCursor({ pagination: { has_next_page: false, next_cursor: 'stale' } }),
    ).toBeUndefined();
  });

  it('ends the walk on the last page of the observed store', () => {
    // Page 3 above: the flag is false and the cursor is simply gone.
    expect(nextCursor({ pagination: { has_next_page: false } })).toBeUndefined();
  });

  it('treats a missing or empty cursor as the end', () => {
    expect(nextCursor({})).toBeUndefined();
    expect(nextCursor({ pagination: undefined })).toBeUndefined();
    expect(nextCursor({ pagination: {} })).toBeUndefined();
    expect(nextCursor({ pagination: { cursor: '' } })).toBeUndefined();
    // A spec-following store that omits the flag: an absent cursor still ends it.
    expect(nextCursor({ pagination: { has_next_page: true } })).toBeUndefined();
  });
});
