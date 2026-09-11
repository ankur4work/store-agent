/**
 * Money extraction and matching.
 *
 * A hallucinated price is the single most expensive failure mode in retail
 * chat — it costs a sale or produces a chargeback. Everything here exists to
 * make "the model said $189" provably traceable to a tool result.
 *
 * UCP returns MINOR units (18900 === $189.00). Prose uses major units. This
 * module is the only place that conversion is allowed to happen.
 */

/** A money value in MINOR units, normalized for comparison. */
export type Minor = number;

const MONEY_PATTERNS: readonly RegExp[] = [
  // $189, $189.00, $1,299.99, £45, €19.90
  /[$£€¥]\s?(\d[\d,]*(?:\.\d{1,2})?)/g,
  // 189.00 USD, 45 GBP
  /(\d[\d,]*(?:\.\d{1,2})?)\s?(?:USD|EUR|GBP|CAD|AUD|JPY)\b/gi,
  // "189 dollars", "45 pounds"
  /(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars?|pounds?|euros?)\b/gi,
];

/**
 * Extract every money mention from prose, as minor units.
 * Deduplicated; order preserved.
 */
export function extractMoneyFromText(text: string): Minor[] {
  const found: Minor[] = [];
  for (const pattern of MONEY_PATTERNS) {
    // Patterns are module-level with /g, so reset lastIndex per use.
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const raw = m[1];
      if (raw === undefined) continue;
      const major = Number.parseFloat(raw.replace(/,/g, ''));
      if (Number.isFinite(major)) found.push(Math.round(major * 100));
    }
  }
  return [...new Set(found)];
}

/**
 * Deep-walk an arbitrary tool payload and collect every money value it
 * contains, as minor units.
 *
 * Two sources, both necessary:
 *
 *  1. **Structured** — the UCP `{ amount, currency }` shape wherever it appears:
 *     variant prices, price_range min/max, cart subtotal/total, line items.
 *
 *  2. **Prose inside string values** — policy and FAQ text says things like
 *     "free shipping over $75". That is a perfectly grounded fact, but it lives
 *     in a string, not a money object. Found live: omitting this made the
 *     mid-stream tripwire abort a *correct* answer about free-shipping
 *     thresholds.
 *
 * Bare numbers are still ignored — treating every integer in a payload as a
 * price would make the check meaningless (quantities, ratings, counts). A
 * string only contributes when it carries an explicit currency marker.
 */
export function collectMoneyFromResult(result: unknown): Minor[] {
  const out: Minor[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(...extractMoneyFromText(node));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return; // cycle guard
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj['amount'] === 'number' && typeof obj['currency'] === 'string') {
      out.push(Math.round(obj['amount']));
    }
    for (const child of Object.values(obj)) walk(child);
  };

  walk(result);
  return [...new Set(out)];
}

/**
 * Can `value` be derived from `sources`?
 *
 * Exact match first, then bounded sums — the model legitimately says things
 * like "that's $268 for both", and the sum of two catalog prices appears in no
 * single tool field. We allow pairs, triples, and the full-set total.
 *
 * LIMITATION: quantity-weighted sums (3 × $79) and arbitrary subsets are not
 * covered. In practice cart tool results carry `subtotal`/`total`, so real
 * totals are matched by exact lookup. Documented in PHASE-1-FINDINGS.md.
 */
export function isDerivable(value: Minor, sources: readonly Minor[]): boolean {
  if (sources.includes(value)) return true;
  const n = sources.length;
  if (n === 0) return false;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sources[i]! + sources[j]! === value) return true;
      for (let k = j + 1; k < n; k++) {
        if (sources[i]! + sources[j]! + sources[k]! === value) return true;
      }
    }
  }

  if (n > 3 && sources.reduce((a, b) => a + b, 0) === value) return true;
  return false;
}

/**
 * Restore the cents on a price the model abbreviated.
 *
 * Models shorten prices in prose — "$9" for a $9.95 wax, "$785" for a
 * $785.95 board — especially in lists and ranges. The guard is right to
 * refuse: $9 is not the price, and a shopper who reads it has been
 * misinformed. But refusing threw away an otherwise correct answer and sent
 * the shopper to a human for a price the catalog knew exactly, and no amount
 * of instruction stopped the model doing it.
 *
 * So the text is repaired instead of rejected. The rules are deliberately
 * narrow, because this writes prices a shopper will read:
 *
 *   - only a BARE dollar amount, written without cents ("$9", never "$9.00")
 *   - only when that amount matches no real price on its own
 *   - only when exactly ONE catalog price shares its whole-dollar part, so
 *     there is nothing to choose between
 *
 * Anything else is left alone and fails validation as before. The result is
 * always a price that came from the catalog — the repair can only replace an
 * abbreviation with the full value it abbreviated, never invent one.
 */
export function restoreCents(
  reply: string,
  sources: readonly Minor[],
): { readonly reply: string; readonly repaired: readonly string[] } {
  const repaired: string[] = [];

  // Matches a whole-dollar figure written either way: "$9" or "$9.00".
  //
  // The first version took only the bare form, on the theory that explicit
  // cents are an assertion rather than an abbreviation. Against the live
  // store the model wrote "$9.00" for a $9.95 wax, so the rule excluded the
  // exact case it was built for. Both spellings say the same wrong thing —
  // whole dollars where the catalog has cents.
  //
  // A NON-ZERO cents value is still untouchable: "$9.50" is a specific claim
  // about a price, not a rounding of one, and it must fail rather than be
  // quietly rewritten.
  const out = reply.replace(
    /([$£€¥])\s?(\d[\d,]*)(?:\.00)?(?!\d)(?!\.\d)/g,
    (whole, symbol: string, digits: string) => {
    const stated = Math.round(Number.parseFloat(digits.replace(/,/g, '')) * 100);
    if (!Number.isFinite(stated)) return whole;
    // Already a real price: nothing to repair.
    if (sources.includes(stated)) return whole;

    const candidates = sources.filter((s) => s > stated && s < stated + 100);
    if (candidates.length !== 1) return whole;

    // Append the cents to the digits AS WRITTEN, rather than reformatting
    // from the minor units — that would turn "$1,025" into "$1025.95" and
    // quietly restyle the model's prose while fixing the price.
    const exact = `${symbol}${digits}.${String(candidates[0]! % 100).padStart(2, '0')}`;
    repaired.push(`${whole.trim()}→${exact}`);
    return exact;
    },
  );

  return { reply: out, repaired };
}

/** Human-readable rendering for violation messages. Major units. */
export function formatMinor(v: Minor): string {
  return (v / 100).toFixed(2);
}
