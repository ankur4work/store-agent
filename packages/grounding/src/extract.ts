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

/** Everything that reads as an inventory statement, for the name check below. */
const STOCK_PHRASES = [...IN_STOCK, ...OUT_OF_STOCK];

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

/**
 * Product names that contain stock language, and where they sit in the text.
 *
 * Shopify's own sample catalog — the data on every dev store, and therefore on
 * an app reviewer's store — ships a product called "The Out of Stock
 * Snowboard". Asked for snowboards, the assistant listed it by name, the
 * detector read "out of stock" as an inventory claim, and the tripwire aborted
 * a perfectly grounded answer. It retried, hit the same title, and escalated to
 * a human: "I don't want to guess on that one." Six correct product cards were
 * thrown away because one of them was named after the thing being checked.
 *
 * Only names that are THEMSELVES ambiguous create a span. A product called
 * "Ice" can never mask anything, so nothing generic is suppressed, and the
 * shortest possible thing is hidden from the detector: the name, exactly where
 * it appears, and nothing else in the sentence around it. "The Out of Stock
 * Snowboard is out of stock" still reports out-of-stock, from the second
 * clause.
 */
function nameSpans(text: string, names: readonly string[]): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  const hay = text.toLowerCase();
  for (const raw of names) {
    const needle = raw.trim().toLowerCase();
    if (needle.length < 4) continue;
    if (!STOCK_PHRASES.some((p) => p.test(needle))) continue;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      spans.push([i, i + needle.length]);
    }
  }
  return spans;
}

/** A match wholly inside a product name is part of that name. */
function withinName(spans: readonly (readonly [number, number])[], index: number, length: number): boolean {
  return spans.some(([start, end]) => index >= start && index + length <= end);
}

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
export function detectStock(
  text: string,
  /** Product names from this turn's tool results. See `nameSpans`. */
  names: readonly string[] = [],
): { polarity: StockPolarity; evidence: string } | undefined {
  const spans = nameSpans(text, names);
  const isName = (m: RegExpExecArray): boolean => withinName(spans, m.index, m[0].length);

  const negated = /\b(?:not|isn't|is not|aren't|are not|no longer)\s+(?:currently\s+)?(?:in stock|available)\b/i.exec(text);
  if (negated && !aboutSystems(text, negated.index) && !isName(negated)) {
    return { polarity: 'out_of_stock', evidence: negated[0] };
  }

  /**
   * "We don't have a Canada Goose parka in stock."
   *
   * The rule above only sees a negation sitting directly against the stock
   * phrase. Say what is *not* held and name it, and the negation is several words
   * away — so this sentence fell through to the IN_STOCK patterns, matched
   * "in stock", and was reported as a claim that the parka WAS in stock.
   *
   * It is the exact opposite of what the sentence says, and it is not only an eval
   * artefact: the production tripwire shares this function, so a correct "we don't
   * stock that" was recorded as an unsupported availability claim, throwing the
   * generation away and pushing a turn that had answered perfectly well towards a
   * retry and a handoff. Found by `abs-competitor-product` in the grounding eval.
   *
   * Bounded to the same sentence, because "We don't have that. The Ice is in
   * stock." is two claims and only the first is negative.
   *
   * Bounded again at a contrastive clause, which is the direction that must not be
   * got wrong. "We don't carry Canada Goose, but this parka is in stock" makes two
   * claims, and the second is a real positive one — reading the whole sentence as
   * negative would hand it to the out-of-stock check and leave the availability
   * claim unvalidated. Missing an in-stock claim is the dangerous failure: it is
   * the one that tells a shopper to buy something the store does not have.
   */
  const negatedHolding =
    /\b(?:do(?:es)?n[’']?t|do(?:es)? not|did(?:n[’']?t)? |cannot|can[’']?t|won[’']?t|have(?:n[’']?t)? not|haven[’']?t)\s+(?:\w+\s+){0,2}?(?:have|got|carry|stock|see|find|offer|sell)\b(?:(?!\b(?:but|however|though|although|whereas)\b)[^.!?;]){0,60}?\b(?:in stock|available(?:\s+now)?)\b/i.exec(
      text,
    );
  if (negatedHolding && !aboutSystems(text, negatedHolding.index) && !isName(negatedHolding)) {
    return { polarity: 'out_of_stock', evidence: negatedHolding[0] };
  }

  for (const p of OUT_OF_STOCK) {
    // Every occurrence, not just the first: with one product named after a
    // stock phrase, stopping at the first match would let a real out-of-stock
    // claim later in the same reply go unchecked.
    for (const m of text.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'))) {
      if (!aboutSystems(text, m.index) && !isName(m as RegExpExecArray)) {
        return { polarity: 'out_of_stock', evidence: m[0] };
      }
    }
  }

  for (const p of IN_STOCK) {
    for (const m of text.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'))) {
      if (!isName(m as RegExpExecArray)) return { polarity: 'in_stock', evidence: m[0] };
    }
  }

  return undefined;
}

/**
 * Product and variant titles in a tool result, deep-walked.
 * Feeds the name check in `detectStock`.
 */
export function collectTitles(result: unknown): string[] {
  const out: string[] = [];
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
    if (typeof obj['title'] === 'string') out.push(obj['title']);
    for (const child of Object.values(obj)) walk(child);
  };

  walk(result);
  return out;
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
/**
 * Authoritative out-of-stock notices from a cart or checkout result.
 *
 * The catalog and the cart can disagree, and when they do the CART is right:
 * `available: true` is a search-time snapshot, while "already sold out" comes
 * from the attempt to actually reserve the item. Weighing them equally is how
 * a true statement got suppressed — the cart refused a line, the model
 * relayed it, and the validator called it a contradiction because a stale
 * catalog row in the same turn still said available.
 *
 * Matched on the message CODE where there is one, falling back to the prose,
 * since only cart tools emit these.
 */
export function collectStockMessages(result: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const OOS_CODE = /out_of_stock|sold_out|unavailable|insufficient_(?:stock|inventory)/i;
  const OOS_TEXT = /\b(?:sold out|out of stock|no longer available)\b/i;

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const obj = node as Record<string, unknown>;
    const code = obj['code'];
    const prose = [obj['content'], obj['text'], obj['message']].find((v) => typeof v === 'string');
    if (typeof code === 'string' && OOS_CODE.test(code)) out.push(code);
    else if (typeof prose === 'string' && OOS_TEXT.test(prose)) out.push(prose);

    for (const child of Object.values(obj)) walk(child);
  };

  walk(result);
  return out;
}

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
