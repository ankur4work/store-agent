/**
 * Grounding eval harness.
 *
 * ## The oracle problem
 *
 * The obvious way to score a run is to ask the grounding validator whether the
 * answer was grounded. That is circular: it can only ever confirm the
 * validator's own opinion, so a validator bug is invisible — and we have
 * already shipped two (opaque citation ids rejecting correct answers; money in
 * policy prose counting as unsupported).
 *
 * So **each case declares its own ground truth**. The scorer checks the reply
 * against the case's `truth`, never against the validator. The validator's
 * verdict is recorded alongside and *compared* to the scorer, which is what
 * makes disagreements — the interesting cases — visible:
 *
 *   | scorer  | validator | meaning                                    |
 *   |---------|-----------|--------------------------------------------|
 *   | clean   | ok        | correct answer, correctly accepted          |
 *   | clean   | not ok    | FALSE POSITIVE — a good answer was rejected |
 *   | tainted | ok        | ESCAPE — a hallucination slipped through    |
 *   | tainted | not ok    | correctly caught                            |
 *
 * "Escape" is the number that must be zero. "False positive" is the number the
 * `< 1%` gate is really about, because rejecting good answers costs sales just
 * as surely as inventing prices does.
 */

export type Category =
  | 'answerable'
  | 'absent_product'
  | 'policy_gap'
  | 'tool_failure'
  | 'ambiguous'
  | 'pressure'
  | 'out_of_scope';

export interface CaseTruth {
  /**
   * Every money value (MINOR units) the agent may legitimately state.
   * Any other amount in the reply is a hallucination, full stop.
   */
  readonly allowedMoney: readonly number[];
  /**
   * What the agent may say about availability.
   *  'in'   — may say in stock
   *  'out'  — may say out of stock
   *  'both' — mixed variants; either is defensible
   *  'none' — has no stock information; any stock claim is invented
   */
  readonly stock: 'in' | 'out' | 'both' | 'none';
  /** Substrings that must never appear (case-insensitive). */
  readonly forbid?: readonly string[];
}

export interface CaseExpect {
  /** The turn must end in an escalation / handoff. */
  readonly mustEscalate?: boolean;
  /** The turn must NOT escalate — the agent had everything it needed. */
  readonly mustNotEscalate?: boolean;
  /** The reply should be a clarifying question rather than an answer. */
  readonly shouldAsk?: boolean;
}

export interface EvalCase {
  readonly id: string;
  readonly category: Category;
  readonly message: string;
  readonly page?: { readonly type: 'product' | 'collection' | 'cart' | 'other'; readonly title?: string };
  /** Deterministic tool fixture — only the model varies between runs. */
  readonly tools: Readonly<Record<string, (input: Record<string, unknown>) => unknown>>;
  readonly truth: CaseTruth;
  readonly expect?: CaseExpect;
  /** Why this case exists. Shown on failure. */
  readonly rationale: string;
}

export type Failure =
  | { readonly kind: 'hallucinated_money'; readonly detail: string }
  | { readonly kind: 'hallucinated_stock'; readonly detail: string }
  | { readonly kind: 'forbidden_phrase'; readonly detail: string }
  | { readonly kind: 'missing_escalation'; readonly detail: string }
  | { readonly kind: 'unwanted_escalation'; readonly detail: string }
  | { readonly kind: 'expected_question'; readonly detail: string }
  | { readonly kind: 'threw'; readonly detail: string };

export interface CaseResult {
  readonly id: string;
  readonly category: Category;
  readonly reply: string;
  /** Scorer verdict — derived from the case's declared truth. */
  readonly tainted: boolean;
  readonly failures: readonly Failure[];
  /** Validator verdict — recorded for comparison, NOT used to score. */
  readonly validatorOk: boolean;
  readonly escalated: boolean;
  readonly attempts: number;
  readonly ms: number;
  /** The interesting quadrants. */
  readonly escape: boolean;
  readonly falsePositive: boolean;
}

export interface EvalReport {
  readonly total: number;
  readonly escapes: number;
  readonly falsePositives: number;
  readonly failed: number;
  readonly escalations: number;
  readonly latency: { readonly p50: number; readonly p95: number };
  readonly byCategory: Record<string, { total: number; failed: number; escapes: number }>;
  readonly results: readonly CaseResult[];
}
