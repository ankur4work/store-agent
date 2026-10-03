import type { SearchCatalogResult } from './types.js';

/**
 * The cursor to send back for the next page, or `undefined` when the walk is over.
 *
 * Reading `pagination.next_cursor` directly is the bug this exists to stop. A live
 * Shopify storefront sends `{ has_next_page, cursor }` and never sends the spec's
 * `next_cursor`, so a caller that checks only the spec field ends its walk after
 * one page and reports success — the failure mode that capped the semantic index
 * at the first 100 products of every catalog.
 *
 * `has_next_page` wins when present, because it is the only field that
 * distinguishes "no more pages" from "a cursor we did not recognise". When it is
 * absent — a store that follows the spec — an absent cursor ends the walk, which
 * is what the observed store does on its last page anyway.
 */
export function nextCursor(result: {
  readonly pagination?: SearchCatalogResult['pagination'] | undefined;
}): string | undefined {
  const page = result.pagination;
  if (page === undefined) return undefined;
  if (page.has_next_page === false) return undefined;
  const cursor = page.next_cursor ?? page.cursor;
  return cursor === undefined || cursor === '' ? undefined : cursor;
}
