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
 * Recognizes the UCP `{ amount, currency }` shape wherever it appears —
 * variant prices, price_range min/max, cart subtotal/total, line item prices.
 * Bare numbers are deliberately IGNORED: treating every integer in a payload
 * as a price would make the check meaningless (quantities, ratings, counts).
 */
export function collectMoneyFromResult(result: unknown): Minor[] {
  const out: Minor[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
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

/** Human-readable rendering for violation messages. Major units. */
export function formatMinor(v: Minor): string {
  return (v / 100).toFixed(2);
}
