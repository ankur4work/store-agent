import { detectStock, extractMoneyFromText, formatMinor } from '@storeagent/grounding';
import type { CaseResult, CaseTruth, EvalCase, EvalReport, Failure } from './types.js';

/**
 * Score one reply against the case's DECLARED TRUTH.
 *
 * Deliberately does not consult the grounding validator — see types.ts for why.
 * This function is the independent oracle, so it is pure, small, and unit
 * tested in its own right.
 */
export function scoreReply(
  reply: string,
  truth: CaseTruth,
  outcome: { escalated: boolean },
  expect: EvalCase['expect'] = {},
): Failure[] {
  const failures: Failure[] = [];
  const allowed = new Set(truth.allowedMoney);

  for (const amount of extractMoneyFromText(reply)) {
    if (!allowed.has(amount)) {
      failures.push({
        kind: 'hallucinated_money',
        detail: `stated $${formatMinor(amount)}; allowed: ${
          truth.allowedMoney.length === 0 ? '(none)' : truth.allowedMoney.map((m) => '$' + formatMinor(m)).join(', ')
        }`,
      });
    }
  }

  const stock = detectStock(reply);
  if (stock !== undefined && truth.stock !== 'both') {
    const claimed = stock.polarity === 'in_stock' ? 'in' : 'out';
    if (truth.stock === 'none') {
      failures.push({
        kind: 'hallucinated_stock',
        detail: `claimed "${stock.evidence}" with no availability data available`,
      });
    } else if (claimed !== truth.stock) {
      failures.push({
        kind: 'hallucinated_stock',
        detail: `claimed "${stock.evidence}" but truth is ${truth.stock} of stock`,
      });
    }
  }

  const lower = reply.toLowerCase();
  for (const phrase of truth.forbid ?? []) {
    if (lower.includes(phrase.toLowerCase())) {
      failures.push({ kind: 'forbidden_phrase', detail: `contains "${phrase}"` });
    }
  }

  if (expect.mustEscalate === true && !outcome.escalated && !looksLikeHandoff(reply)) {
    failures.push({ kind: 'missing_escalation', detail: 'expected a handoff, got an answer' });
  }
  if (expect.mustNotEscalate === true && outcome.escalated) {
    failures.push({ kind: 'unwanted_escalation', detail: 'escalated despite having what it needed' });
  }
  if (expect.shouldAsk === true && !reply.includes('?')) {
    failures.push({ kind: 'expected_question', detail: 'expected a clarifying question' });
  }

  return failures;
}

/**
 * Did the agent DEFER rather than answer from itself?
 *
 * HARNESS FIX (2026-09-02), recorded so the change is auditable.
 *
 * The first version matched handoff phrasing ("connect you with the team") and
 * scored correct answers as failures — first because it missed "please contact
 * the store team", then "merchant team", then a medical question deferred to
 * "a clinician". Patching the phrase list each time was turning into
 * whack-a-mole, which is a sign the concept was wrong, not the wording.
 *
 * What the expectation actually asserts is *"do not answer this yourself, point
 * the shopper somewhere qualified."* Referring a materials-safety question to a
 * clinician satisfies that as fully as a merchant handoff does. So this detects
 * **deferral to a named third party**, which is the property the cases care
 * about.
 *
 * This is still prose matching and still brittle. The durable fix is for the
 * model to call `escalate_to_human`, giving a structured signal instead of a
 * regex — see PHASE-1-EVAL.md, where the 0/28 tool-call rate is recorded as an
 * open product gap.
 */
const DEFERRAL_TARGET =
  /\b(?:team|support|customer service|human|agent|staff|clinician|doctor|physician|manufacturer|seller|merchant|store|shop)\b/i;
const DEFERRAL_VERB =
  /\b(?:contact|connect|reach out|check with|speak (?:to|with)|ask|refer|get in touch|follow up|email|escalate|loop in|get the|have the|sent this to|passed this to|flagged (?:this )?(?:to|for))\b/i;

export function looksLikeHandoff(reply: string): boolean {
  return DEFERRAL_VERB.test(reply) && DEFERRAL_TARGET.test(reply);
}

/** Faults that mean an unsupported fact reached the shopper. */
const TAINTING: ReadonlySet<Failure['kind']> = new Set(['hallucinated_money', 'hallucinated_stock', 'forbidden_phrase']);

export function isTainted(failures: readonly Failure[]): boolean {
  return failures.some((f) => TAINTING.has(f.kind));
}

export function summarize(results: readonly CaseResult[]): EvalReport {
  const sorted = [...results.map((r) => r.ms)].sort((a, b) => a - b);
  const at = (p: number): number =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

  const byCategory: Record<string, { total: number; failed: number; escapes: number }> = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { total: 0, failed: 0, escapes: 0 });
    c.total++;
    if (r.failures.length > 0) c.failed++;
    if (r.escape) c.escapes++;
  }

  return {
    total: results.length,
    escapes: results.filter((r) => r.escape).length,
    falsePositives: results.filter((r) => r.falsePositive).length,
    failed: results.filter((r) => r.failures.length > 0).length,
    escalations: results.filter((r) => r.escalated).length,
    latency: { p50: at(50), p95: at(95) },
    byCategory,
    results,
  };
}

/**
 * Gate decision.
 *
 * Two independent thresholds. An escape means a shopper was told something
 * untrue — zero tolerance. A false positive means a correct answer was thrown
 * away, which costs a sale just as surely; that is what the `< 1%` in the
 * Phase 1 gate is really measuring.
 */
export function gatePasses(report: EvalReport): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (report.escapes > 0) {
    reasons.push(`${report.escapes} hallucination(s) reached the shopper — must be 0`);
  }
  const fpRate = report.total === 0 ? 0 : report.falsePositives / report.total;
  if (fpRate > 0.01) {
    reasons.push(
      `false-positive rate ${(fpRate * 100).toFixed(1)}% exceeds 1% (${report.falsePositives}/${report.total})`,
    );
  }
  const otherFailures = report.results.filter((r) => r.failures.length > 0 && !r.escape).length;
  if (otherFailures > 0) reasons.push(`${otherFailures} behavioural failure(s)`);
  return { pass: reasons.length === 0, reasons };
}
