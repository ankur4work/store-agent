import { createHash } from 'node:crypto';

/**
 * Holdout assignment.
 *
 * A slice of sessions never sees the agent. Comparing those two arms is the
 * only way to produce an *incrementality* number rather than the
 * "influenced revenue" figure every merchant has learned to discount — the
 * agent naturally talks to high-intent shoppers, so exposed-vs-everyone is
 * always flattering and always meaningless.
 *
 * Assignment must be:
 *   - **deterministic** — the same session gets the same arm on every page of
 *     its life, across restarts and across gateway nodes. A session that flips
 *     arms mid-visit corrupts both.
 *   - **uniform** — no bias between arms, or the comparison is invalid before
 *     any data arrives.
 *   - **salted per shop** — otherwise the same session id lands in the same arm
 *     at every merchant, correlating what should be independent experiments.
 */

export type Arm = 'exposed' | 'holdout';

/** Deterministic uniform value in [0, 1) from a shop-salted session id. */
export function bucketOf(shop: string, sessionId: string): number {
  const digest = createHash('sha256').update(`${shop}:${sessionId}`, 'utf8').digest();
  // First 4 bytes as an unsigned 32-bit int, scaled. Uniform because SHA-256
  // output is uniform; no modulo, so no modulo bias.
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function assignArm(shop: string, sessionId: string, holdoutFraction: number): Arm {
  if (!(holdoutFraction > 0)) return 'exposed';
  if (holdoutFraction >= 1) return 'holdout';
  return bucketOf(shop, sessionId) < holdoutFraction ? 'holdout' : 'exposed';
}

/**
 * Recommended holdout size for a store's traffic.
 *
 * This is the uncomfortable arithmetic most vendors leave out. A 5% holdout is
 * cheap in lost sales but statistically expensive: the holdout arm is the
 * bottleneck, so at 5% you need ~20x total traffic to fill it. On a store doing
 * a few thousand sessions a month that is *years* to a readable answer.
 *
 * So the holdout scales with volume — small stores hold out more, and get an
 * answer in weeks instead of never; large stores hold out less, because they
 * can afford precision without sacrificing much.
 */
export function recommendedHoldout(monthlySessions: number): number {
  if (monthlySessions < 5_000) return 0.5; // tiny store: split evenly or learn nothing
  if (monthlySessions < 20_000) return 0.3;
  if (monthlySessions < 100_000) return 0.2;
  if (monthlySessions < 500_000) return 0.1;
  return 0.05;
}

/**
 * Sessions needed IN TOTAL to detect a given relative lift, at 80% power and
 * 95% confidence.
 *
 * Standard two-proportion sample size, then scaled up because only
 * `holdoutFraction` of traffic fills the smaller arm.
 */
export function sessionsNeeded(
  baseConversionRate: number,
  minDetectableRelativeLift: number,
  holdoutFraction: number,
): number {
  if (baseConversionRate <= 0 || baseConversionRate >= 1) return Infinity;
  if (minDetectableRelativeLift <= 0 || holdoutFraction <= 0 || holdoutFraction >= 1) return Infinity;

  const p1 = baseConversionRate;
  const p2 = baseConversionRate * (1 + minDetectableRelativeLift);
  if (p2 >= 1) return Infinity;

  const delta = p2 - p1;
  const pBar = (p1 + p2) / 2;
  // (z_{α/2} + z_β)² = (1.96 + 0.84)² ≈ 7.849
  const perArm = (7.849 * 2 * pBar * (1 - pBar)) / (delta * delta);

  // The holdout arm fills slowest, so it sets the total.
  return Math.ceil(perArm / holdoutFraction);
}
