/**
 * Grounding contract.
 *
 * The model returns prose for the shopper AND a machine-checkable claim set.
 * A deterministic validator then proves every factual assertion traces to a
 * tool result from THIS turn. Prompts are advisory; this module is enforcing.
 */

export type ClaimKind = 'price' | 'stock' | 'shipping' | 'policy' | 'other';

export interface Claim {
  /** The factual statement, as the model phrased it. */
  readonly assertion: string;
  readonly kind: ClaimKind;
  /** Must reference a tool call made during the current turn. */
  readonly source_tool_call_id: string;
}

/** What the model is required to emit (see JSON schema in schema.ts). */
export interface GroundedResponse {
  readonly reply: string;
  readonly claims: readonly Claim[];
}

/** A tool call + its result, recorded by the orchestrator for this turn. */
export interface ToolResultRecord {
  readonly tool_call_id: string;
  readonly tool: string;
  readonly result: unknown;
}

export type ViolationCode =
  | 'unknown_citation'
  | 'price_not_in_source'
  | 'uncited_price'
  | 'stock_contradicts_source'
  | 'uncited_stock'
  | 'uncited_shipping_estimate'
  | 'no_tool_results';

export type Severity = 'error' | 'warning';

export interface Violation {
  readonly code: ViolationCode;
  readonly severity: Severity;
  readonly message: string;
  readonly claim?: Claim;
  /** The offending fragment, for logging and eval triage. */
  readonly evidence?: string;
}

export interface GroundingVerdict {
  /** False if any `error`-severity violation was found. */
  readonly ok: boolean;
  readonly violations: readonly Violation[];
}

export interface ValidateOptions {
  /**
   * Treat a bare stock/shipping mention with no supporting tool result as an
   * error rather than a warning. Default false — merchants writing "ships
   * fast" in brand copy shouldn't trip the validator.
   */
  readonly strictSoftClaims?: boolean;
}
