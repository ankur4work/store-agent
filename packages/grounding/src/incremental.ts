import { collectAvailability, detectStock } from './extract.js';
import { collectMoneyFromResult, extractMoneyFromText, formatMinor, isDerivable, type Minor } from './money.js';
import type { ToolResultRecord, Violation } from './types.js';

/**
 * Mid-stream grounding tripwire.
 *
 * ## Why this exists
 *
 * Streaming and grounding are in tension. Full validation needs the complete
 * `claims` payload, which arrives last — but the shopper is watching prose
 * appear *now*. Two bad options:
 *
 *   - Buffer everything until validated → throws away the whole TTFT budget.
 *   - Stream optimistically and retract → shows a hallucinated price, then
 *     takes it back. For a product whose headline claim is "never makes things
 *     up", that is the worst possible failure.
 *
 * ## The resolution
 *
 * The expensive half of grounding — *is this price present in the tool
 * results?* — needs only the tool results, which we already hold before the
 * model writes a word. So we check each fact the instant it is fully typed and
 * abort the stream mid-sentence if one is unsupported. The shopper sees a
 * truncated message replaced by the escalation, never a wrong price.
 *
 * This is why the agent loop is hand-rolled rather than using an SDK tool
 * runner: it needs to kill an in-flight generation.
 *
 * ## Partial-token safety
 *
 * The critical subtlety: while `$189.00` is still arriving, the buffer briefly
 * reads `$18`. Checking that naively would abort on a perfectly good answer, so
 * every check runs against a "settled" prefix that excludes any trailing token
 * still capable of growing.
 */
export class GroundingTripwire {
  private readonly sourceMoney: Minor[];
  private readonly availability: boolean[];
  private readonly seenMoney = new Set<Minor>();
  private tripped = false;

  constructor(toolResults: readonly ToolResultRecord[]) {
    this.sourceMoney = toolResults.flatMap((r) => collectMoneyFromResult(r.result));
    this.availability = toolResults.flatMap((r) => collectAvailability(r.result));
  }

  /**
   * Check the reply text produced so far. Returns a violation the moment an
   * unsupported fact is fully typed; `undefined` while everything checks out.
   * Fires at most once.
   */
  check(textSoFar: string): Violation | undefined {
    if (this.tripped) return undefined;

    const settled = settledPrefix(textSoFar);
    if (settled === '') return undefined;

    for (const value of extractMoneyFromText(settled)) {
      if (this.seenMoney.has(value)) continue;
      this.seenMoney.add(value);
      if (!isDerivable(value, this.sourceMoney)) {
        this.tripped = true;
        return {
          code: 'uncited_price',
          severity: 'error',
          message:
            `Stream aborted: reply stated ${formatMinor(value)}, which appears in no tool result ` +
            `this turn. Every price shown to a shopper must be traceable to live data.`,
          evidence: formatMinor(value),
        };
      }
    }

    // Stock is checked only on completed sentences — "in sto" must not be read
    // as a claim, and negation ("not in stock") needs the full clause.
    const sentences = completedSentences(settled);
    if (sentences !== '' && this.availability.length > 0) {
      const stock = detectStock(sentences);
      if (stock !== undefined) {
        const anyAvailable = this.availability.includes(true);
        const contradicts =
          (stock.polarity === 'in_stock' && !anyAvailable) ||
          (stock.polarity === 'out_of_stock' && this.availability.every((a) => a));
        if (contradicts) {
          this.tripped = true;
          return {
            code: 'stock_contradicts_source',
            severity: 'error',
            message:
              `Stream aborted: reply asserted "${stock.evidence}" but this turn's tool results ` +
              `reported availability [${this.availability.join(', ')}].`,
            evidence: stock.evidence,
          };
        }
      }
    }

    return undefined;
  }
}

/**
 * Drop a trailing token that could still be growing.
 *
 * `"...for $18"` → `"...for "`, because the next chunk may make it `$189.00`.
 * Also drops a trailing partial word so stock phrases are never half-matched.
 */
export function settledPrefix(text: string): string {
  // Trailing number. The subtlety is the dot: "$189." may still become
  // "$189.50", but "$189.00." already has its decimals, so that second dot can
  // only be sentence punctuation and the amount is final.
  const trailingNumber = /([$£€¥]?\s?\d[\d,]*(?:\.\d{1,2})?)(\.?)$/.exec(text);
  if (trailingNumber) {
    const amount = trailingNumber[1]!;
    const trailingDot = trailingNumber[2]!;
    const hasDecimals = /\.\d{1,2}$/.test(amount);
    const stillGrowing = trailingDot === '' || !hasDecimals;
    if (stillGrowing) return text.slice(0, trailingNumber.index);
    // Otherwise fall through: the amount is settled.
  }

  // A trailing bare word may still be completing.
  const trailingWord = /[A-Za-z][A-Za-z'-]*$/.exec(text);
  if (trailingWord) return text.slice(0, trailingWord.index);

  return text;
}

/** Everything up to and including the last sentence-ending punctuation. */
export function completedSentences(text: string): string {
  const m = /^[\s\S]*[.!?]/.exec(text);
  return m ? m[0] : '';
}
