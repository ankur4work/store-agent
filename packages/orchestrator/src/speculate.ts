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
}

/**
 * Decide whether to speculatively search, and with what query.
 * Pure and synchronous — this must not add measurable latency.
 */
export function planSpeculation(message: string, pageTitle?: string): Speculation {
  const text = message.trim();
  if (text.length < 3) return { shouldSearch: false, query: '', reason: 'too short' };

  for (const p of NON_PRODUCT_INTENT) {
    if (p.test(text)) return { shouldSearch: false, query: '', reason: 'support intent, not discovery' };
  }

  const hasIntentPhrase = PRODUCT_INTENT.some((p) => p.test(text));
  const keywords = extractKeywords(text);

  // A bare question with no nouns ("what do you think?") isn't worth a call.
  if (!hasIntentPhrase && keywords.length < 2) {
    return { shouldSearch: false, query: '', reason: 'no product signal' };
  }

  // On a product page, fold the product title in — "does this come in blue?"
  // has almost no standalone keywords but plenty of context.
  const query = keywords.length > 0 ? keywords.join(' ') : (pageTitle ?? '');
  if (query === '') return { shouldSearch: false, query: '', reason: 'nothing to search for' };

  return {
    shouldSearch: true,
    query,
    reason: hasIntentPhrase ? 'explicit product intent' : 'keyword density',
  };
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
