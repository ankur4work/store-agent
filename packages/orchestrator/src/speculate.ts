/**
 * Speculative catalog search (ARCHITECTURE.md §6.2).
 *
 * The dominant text-turn latency cost is a tool round trip: the model reads the
 * message, decides to search, we call Shopify (80–250 ms), we hand results
 * back, the model starts over. That doubles time-to-first-token.
 *
 * So we don't wait to be asked. On message submit a cheap local extraction runs
 * (<2 ms) and, if it smells like product intent, fires `search_catalog` in
 * PARALLEL with the model request. By the time the model emits a `tool_use`,
 * the result is usually already in hand and the round trip collapses to a
 * memory read.
 *
 * A miss costs one wasted (edge-cached) Shopify call. The UI wins either way:
 * product skeletons render from the speculation while prose is still streaming.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'im', 'is', 'are', 'was', 'do', 'does', 'you', 'your', 'me', 'my', 'we',
  'have', 'has', 'can', 'could', 'would', 'will', 'to', 'for', 'of', 'in', 'on', 'at', 'with',
  'and', 'or', 'but', 'it', 'this', 'that', 'there', 'what', 'which', 'how', 'any', 'some',
  'please', 'thanks', 'hi', 'hello', 'hey', 'looking', 'want', 'need', 'show', 'find', 'got',
]);

/** Phrases that signal the shopper wants to see products. */
const PRODUCT_INTENT = [
  /\b(?:looking for|show me|do you (?:have|sell|carry)|got any|any\b.*\bin stock|recommend|suggest)\b/i,
  /\b(?:something|anything)\s+(?:for|to|that|warm|light|cheap|nice)\b/i,
  /\bunder\s*[$£€]?\s*\d+/i,
  /\b(?:cheaper|alternative|similar|instead|like this)\b/i,
];

/** Phrases that are clearly NOT product discovery — don't waste the call. */
const NON_PRODUCT_INTENT = [
  /\b(?:where is|track|status of)\s+my\s+order\b/i,
  /\breturn(?:s|ing)?\s+(?:policy|process|it|this)\b/i,
  /\brefund\b/i,
  /\b(?:shipping|delivery)\s+(?:cost|policy|time|options)\b/i,
  /\b(?:speak|talk) to (?:a|someone)\b/i,
];

export interface Speculation {
  readonly shouldSearch: boolean;
  readonly query: string;
  readonly reason: string;
  /**
   * Which tool to fire ahead of the model.
   *
   * `get_product` on a product page is the better guess by a wide margin: the
   * page already told us WHICH product, so there is nothing to guess at and the
   * answer is authoritative rather than a name match. "Is this in my size" then
   * resolves in one pass, from the real variant list, instead of a search for a
   * title that may match three things.
   */
  readonly tool: 'search_catalog' | 'get_product';
  /** The arguments for that tool, ready to execute. */
  readonly input: Record<string, unknown>;
}

/**
 * Decide whether to speculatively search, and with what query.
 * Pure and synchronous — this must not add measurable latency.
 */
/**
 * Words that point at the product the shopper is already looking at.
 *
 * "Something like this but black" is the request this exists for. The words that
 * carry meaning are "black" and whatever the shopper is standing in front of —
 * and the page knows the second part, so the deictic is a signal to go and get it
 * rather than a word to search for.
 */
const DEICTIC = /\b(?:this|these|those|it|that one|the same|same)\b/i;

/**
 * Words that describe the RELATION or the asking, not the product.
 *
 * Dropped from the query because "like this but cheaper" should speculate on the
 * product family, not on the word "cheaper" — left in, the search for "like
 * cheaper" finds nothing and the shopper waits for a second round trip to learn
 * what the first could have told them. The verbs are here for the same reason:
 * "does this come in blue" is a question about a colour, and "come" is grammar.
 */
const COMPARISON_FILLER = new Set([
  'come',
  'comes',
  'available',
  'stock',
  'something',
  'anything',
  'like',
  'similar',
  'alternative',
  'alternatives',
  'instead',
  'version',
  'one',
  'ones',
  'same',
  'cheaper',
  'cheapest',
  'dearer',
  'pricier',
  'bigger',
  'smaller',
  'better',
  'else',
]);

export function planSpeculation(
  message: string,
  page?: { readonly title?: string; readonly type?: string; readonly productId?: string } | string,
): Speculation {
  // Accepts a bare title as well as a page, so older callers keep working.
  const pageTitle = typeof page === 'string' ? page : page?.title;
  const pageType = typeof page === 'string' ? undefined : page?.type;
  const productId = typeof page === 'string' ? undefined : page?.productId;

  const text = message.trim();
  if (text.length < 3) return NOTHING('too short');

  for (const p of NON_PRODUCT_INTENT) {
    if (p.test(text)) return NOTHING('support intent, not discovery');
  }

  const hasIntentPhrase = PRODUCT_INTENT.some((p) => p.test(text));
  const keywords = extractKeywords(text);

  // A bare question with no nouns ("what do you think?") isn't worth a call.
  if (!hasIntentPhrase && keywords.length < 2) {
    return NOTHING('no product signal');
  }

  /**
   * "Something like this but black", on the page of the thing being pointed at.
   *
   * Keywords alone give "something like black", which is not a product anyone
   * sells — so the speculative search finds nothing, the cards stay empty, and
   * the shopper waits for the model to work out what was obvious from the page
   * they are standing on. Folding the title in gives "black Merino Wool
   * Overcoat", which is the search they meant.
   *
   * Only on a product page, and only when they actually pointed: on a collection
   * page "this" refers to the collection, and the title is not a product.
   */
  if (pageType === 'product' && DEICTIC.test(text)) {
    /**
     * They pointed at the product they are standing on.
     *
     * With its id, fetch THAT product rather than searching for its name: the
     * page has already answered "which one", so a search can only reintroduce
     * ambiguity a title match cannot resolve. This is what lets "does this come
     * in my size" be answered from the real variant list in a single pass.
     */
    /**
     * By NAME, not by id — measured, against a real store.
     *
     * Fetching by id is the better guess in principle: the page already answered
     * "which one". In practice `get_product` is advertised by `tools/list` and
     * then answers "Tool not found" on `tools/call`, so speculating on it buys a
     * guaranteed miss and a wasted round trip. `search_catalog` is the one
     * catalog tool that is callable everywhere, and it returns whole products
     * with their variants, which is what the question needs.
     *
     * The id still reaches the model through the turn context, and the executor
     * repairs `get_product` with its own fallback if the model reaches for it.
     * See getProductResilient in tool-executor.ts.
     */
    if (pageTitle !== undefined && pageTitle !== '') {
      const attributes = keywords.filter((w) => !COMPARISON_FILLER.has(w) && !DEICTIC.test(w));
      const refined = [...attributes, pageTitle].join(' ').trim();
      return {
        shouldSearch: true,
        query: refined,
        reason: 'refinement of the product being viewed, searched by name',
        tool: 'search_catalog',
        input: { query: refined, limit: 6 },
      };
    }
  }

  // On a product page, fold the product title in — "does this come in blue?"
  // has almost no standalone keywords but plenty of context.
  const query = keywords.length > 0 ? keywords.join(' ') : (pageTitle ?? '');
  if (query === '') return NOTHING('nothing to search for');

  return {
    shouldSearch: true,
    query,
    reason: hasIntentPhrase ? 'explicit product intent' : 'keyword density',
    tool: 'search_catalog',
    input: { query, limit: 6 },
  };
}

/** Nothing worth prefetching. */
function NOTHING(reason: string): Speculation {
  return { shouldSearch: false, query: '', reason, tool: 'search_catalog', input: {} };
}

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 6);
}

/**
 * Does an actual tool call match what we speculated?
 * Loose on purpose — the model rephrases, and a near-miss still beats a hop.
 */
export function speculationMatches(speculated: string, actual: string): boolean {
  const a = new Set(speculated.toLowerCase().split(/\s+/).filter(Boolean));
  const b = new Set(actual.toLowerCase().split(/\s+/).filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  let overlap = 0;
  for (const w of b) if (a.has(w)) overlap++;
  return overlap / Math.min(a.size, b.size) >= 0.5;
}
