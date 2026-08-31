import { collectAvailability, detectShippingEstimate, detectStock } from './extract.js';
import { collectMoneyFromResult, extractMoneyFromText, formatMinor, isDerivable } from './money.js';
import type {
  Claim,
  GroundedResponse,
  GroundingVerdict,
  ToolResultRecord,
  ValidateOptions,
  Violation,
} from './types.js';

/**
 * Validate a grounded response against the tool results from THIS turn.
 *
 * Two independent families of check, deliberately separated so failures are
 * diagnosable rather than just "grounding failed":
 *
 *   1. CITATION checks — each declared claim must resolve to a real tool call
 *      whose payload actually supports it. Catches mis-citation.
 *
 *   2. COVERAGE checks — factual language in `reply` must be traceable to some
 *      tool result, whether or not the model declared a claim for it. Catches
 *      fabrication. Without this, `claims: []` would pass trivially while the
 *      prose invented prices.
 *
 * Pure and synchronous: no model in the loop where a comparison suffices.
 */
export function validateGrounding(
  response: GroundedResponse,
  toolResults: readonly ToolResultRecord[],
  opts: ValidateOptions = {},
): GroundingVerdict {
  const violations: Violation[] = [];
  const byId = new Map(toolResults.map((r) => [r.tool_call_id, r]));

  // Every money value observable anywhere in this turn's tool results.
  const allSourceMoney = toolResults.flatMap((r) => collectMoneyFromResult(r.result));
  const allAvailability = toolResults.flatMap((r) => collectAvailability(r.result));

  // --- 1. Citation checks -------------------------------------------------

  for (const claim of response.claims) {
    const source = byId.get(claim.source_tool_call_id);

    if (source === undefined) {
      violations.push({
        code: 'unknown_citation',
        severity: 'error',
        message:
          `Claim cites tool_call_id "${claim.source_tool_call_id}", which was not called this turn. ` +
          `Citations must reference a tool call from the current turn.`,
        claim,
      });
      continue;
    }

    if (claim.kind === 'price') {
      const sourceMoney = collectMoneyFromResult(source.result);
      for (const mentioned of extractMoneyFromText(claim.assertion)) {
        if (!isDerivable(mentioned, sourceMoney)) {
          violations.push({
            code: 'price_not_in_source',
            severity: 'error',
            message:
              `Claim asserts ${formatMinor(mentioned)} but tool "${source.tool}" ` +
              `(${claim.source_tool_call_id}) returned no such value.`,
            claim,
            evidence: formatMinor(mentioned),
          });
        }
      }
    }

    if (claim.kind === 'stock') {
      const stock = detectStock(claim.assertion);
      const availability = collectAvailability(source.result);
      if (stock !== undefined && availability.length > 0) {
        const anyAvailable = availability.includes(true);
        const contradicts =
          (stock.polarity === 'in_stock' && !anyAvailable) ||
          (stock.polarity === 'out_of_stock' && availability.every((a) => a));
        if (contradicts) {
          violations.push({
            code: 'stock_contradicts_source',
            severity: 'error',
            message:
              `Claim asserts "${stock.evidence}" but tool "${source.tool}" ` +
              `reported availability [${availability.join(', ')}].`,
            claim,
            evidence: stock.evidence,
          });
        }
      }
    }
  }

  // --- 2. Coverage checks on the prose ------------------------------------

  const replyMoney = extractMoneyFromText(response.reply);
  const replyStock = detectStock(response.reply);
  const replyShipping = detectShippingEstimate(response.reply);
  const assertsFact = replyMoney.length > 0 || replyStock !== undefined;

  // The worst case: factual assertions with no tool call at all — the model
  // answered from prior knowledge.
  if (assertsFact && toolResults.length === 0) {
    const evidence = replyMoney.length > 0 ? formatMinor(replyMoney[0]!) : replyStock?.evidence;
    violations.push({
      code: 'no_tool_results',
      severity: 'error',
      message:
        `Reply asserts price or availability but no tools were called this turn. ` +
        `Product facts must come from a tool result, never from model knowledge.`,
      // Omit the key entirely rather than setting it to undefined —
      // exactOptionalPropertyTypes draws a real distinction between the two.
      ...(evidence === undefined ? {} : { evidence }),
    });
    return finalize(violations);
  }

  for (const mentioned of replyMoney) {
    if (!isDerivable(mentioned, allSourceMoney)) {
      violations.push({
        code: 'uncited_price',
        severity: 'error',
        message:
          `Reply states ${formatMinor(mentioned)}, which appears in no tool result this turn. ` +
          `Every price shown to a shopper must be traceable to live catalog or cart data.`,
        evidence: formatMinor(mentioned),
      });
    }
  }

  if (replyStock !== undefined) {
    const hasStockClaim = response.claims.some((c) => c.kind === 'stock');
    if (allAvailability.length === 0 && !hasStockClaim) {
      violations.push({
        code: 'uncited_stock',
        severity: opts.strictSoftClaims === true ? 'error' : 'warning',
        message: `Reply asserts "${replyStock.evidence}" with no supporting availability data.`,
        evidence: replyStock.evidence,
      });
    } else if (allAvailability.length > 0) {
      const anyAvailable = allAvailability.includes(true);
      const contradicts =
        (replyStock.polarity === 'in_stock' && !anyAvailable) ||
        (replyStock.polarity === 'out_of_stock' && allAvailability.every((a) => a));
      if (contradicts) {
        violations.push({
          code: 'stock_contradicts_source',
          severity: 'error',
          message:
            `Reply asserts "${replyStock.evidence}" but this turn's tool results ` +
            `reported availability [${allAvailability.join(', ')}].`,
          evidence: replyStock.evidence,
        });
      }
    }
  }

  if (replyShipping !== undefined) {
    const hasSupport = response.claims.some((c) => c.kind === 'shipping' || c.kind === 'policy');
    if (!hasSupport) {
      violations.push({
        code: 'uncited_shipping_estimate',
        severity: opts.strictSoftClaims === true ? 'error' : 'warning',
        message:
          `Reply gives a delivery estimate ("${replyShipping}") with no shipping or policy claim. ` +
          `Delivery promises must cite the merchant's policy corpus.`,
        evidence: replyShipping,
      });
    }
  }

  return finalize(violations);
}

function finalize(violations: readonly Violation[]): GroundingVerdict {
  return { ok: !violations.some((v) => v.severity === 'error'), violations };
}

/**
 * Feedback for the regeneration attempt. The model gets told exactly what
 * failed — a bare "try again" wastes the retry.
 */
export function violationsToFeedback(violations: readonly Violation[]): string {
  const errors = violations.filter((v) => v.severity === 'error');
  if (errors.length === 0) return '';
  const lines = errors.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`);
  return (
    `Your previous response failed grounding validation:\n${lines.join('\n')}\n\n` +
    `Rewrite it using ONLY facts present in this turn's tool results. If a fact ` +
    `is not available, say so and offer to connect the shopper with the team — ` +
    `that is a correct answer, not a failure.`
  );
}

/** Convenience for metrics: the gate tracks error-rate, not warning-rate. */
export function hasErrors(verdict: GroundingVerdict): boolean {
  return !verdict.ok;
}

export type { Claim, GroundedResponse, ToolResultRecord };
