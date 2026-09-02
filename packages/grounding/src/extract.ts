/**
 * Detectors for factual language that MUST be grounded.
 *
 * These drive the coverage checks: it is not enough for declared claims to be
 * valid — the prose itself must not assert anything undeclared. Without
 * coverage, a model could emit `claims: []` and pass validation while
 * hallucinating freely in `reply`.
 */

export type StockPolarity = 'in_stock' | 'out_of_stock';

const IN_STOCK = [
  /\bin stock\b/i,
  /\bavailable now\b/i,
  /\bwe have (?:it|them|those|\d+)\b/i,
  /\bready to ship\b/i,
  /\bships? (?:today|tomorrow)\b/i,
];

const OUT_OF_STOCK = [
  /\bout of stock\b/i,
  /\bsold out\b/i,
  /\bunavailable\b/i,
  /\bback ?ordered\b/i,
  /\bno longer (?:available|carried)\b/i,
];

/**
 * Words that make "unavailable"/"not available" a statement about our SYSTEMS
 * rather than the merchant's inventory.
 *
 * Found by the eval: "I can't verify the price because the catalog is
 * unavailable" was being read as an out-of-stock claim, so a correct
 * tool-failure response was scored as a stock hallucination. The production
 * validator shares this code path, so the same sentence could trip a
 * stock-contradiction violation on a live turn.
 */
const SYSTEM_SUBJECT =
  /\b(?:catalog|service|system|handoff|tool|api|server|site|feature|tracking|lookup|connection|network|database|integration)\b/i;

/** The sentence containing `index`, used to scope the system-subject check. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index - 1) + 1, text.lastIndexOf('!', index - 1) + 1);
  const endDot = text.indexOf('.', index);
  return text.slice(start, endDot === -1 ? text.length : endDot + 1);
}

/** Shipping-duration claims: "ships in 2-3 days", "arrives within a week". */
const SHIPPING_ESTIMATE = [
  /\b(?:ships?|arrives?|delivered?|delivery)\b[^.!?]{0,40}?\b\d+\s?(?:[-–]\s?\d+\s?)?(?:business\s)?(?:day|week|month)s?\b/i,
  /\bwithin\s+\d+\s?(?:business\s)?(?:day|week)s?\b/i,
  /\b(?:next|same)[- ]day (?:delivery|shipping)\b/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * Detect a stock assertion. Out-of-stock is checked FIRST because "not in
 * stock" and "no longer available" both contain in-stock substrings.
 */
export function detectStock(text: string): { polarity: StockPolarity; evidence: string } | undefined {
  const negated = /\b(?:not|isn't|is not|aren't|are not|no longer)\s+(?:currently\s+)?(?:in stock|available)\b/i.exec(text);
  if (negated && !aboutSystems(text, negated.index)) {
    return { polarity: 'out_of_stock', evidence: negated[0] };
  }

  for (const p of OUT_OF_STOCK) {
    const m = p.exec(text);
    if (m && !aboutSystems(text, m.index)) return { polarity: 'out_of_stock', evidence: m[0] };
  }

  const inStock = firstMatch(text, IN_STOCK);
  if (inStock !== undefined) return { polarity: 'in_stock', evidence: inStock };

  return undefined;
}

function aboutSystems(text: string, index: number): boolean {
  return SYSTEM_SUBJECT.test(sentenceAround(text, index));
}

export function detectShippingEstimate(text: string): string | undefined {
  return firstMatch(text, SHIPPING_ESTIMATE);
}

/**
 * Availability signals present in a tool result, deep-walked.
 * Returns the set of `available` booleans found.
 */
export function collectAvailability(result: unknown): boolean[] {
  const out: boolean[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj['available'] === 'boolean') out.push(obj['available']);
    for (const child of Object.values(obj)) walk(child);
  };

  walk(result);
  return out;
}
