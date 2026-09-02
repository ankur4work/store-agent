/**
 * Incrementality.
 *
 * The number a merchant renews on. Everything here exists to make it honest,
 * which mostly means being willing to say "not yet".
 *
 * Two failure modes we refuse:
 *   1. **Reporting influenced revenue as if it were incremental.** The agent
 *      talks to high-intent shoppers; comparing them to everyone always
 *      flatters us. Only the holdout comparison means anything.
 *   2. **Reporting a lift the sample cannot support.** With a 3% base rate and
 *      a few hundred sessions, observed "lift" is mostly noise. A confident
 *      number here is worse than no number: the merchant acts on it, the
 *      effect evaporates, and they never trust a figure from us again.
 */

export interface ArmTotals {
  readonly sessions: number;
  readonly conversions: number;
  readonly revenueMinor: number;
}

export interface ArmStats extends ArmTotals {
  /** Conversions per session, 0-1. */
  readonly rate: number;
  /** Average order value in MINOR units, over converting sessions. */
  readonly aovMinor: number;
}

export interface Incrementality {
  readonly exposed: ArmStats;
  readonly holdout: ArmStats;
  /** Difference in conversion rate, in percentage POINTS. */
  readonly absoluteLiftPp: number;
  /** Relative lift, e.g. 0.28 for +28%. Null when the holdout never converted. */
  readonly relativeLift: number | null;
  /** 95% CI on the absolute difference, in percentage points. */
  readonly ci95Pp: readonly [number, number];
  readonly pValue: number;
  readonly significant: boolean;
  /**
   * Whether there is enough data to say anything at all. When false, every
   * headline figure must be suppressed in the UI — not shown greyed out, not
   * shown "provisionally". Not shown.
   */
  readonly readable: boolean;
  readonly reason: string;
  /** Revenue attributable to exposure. Null unless readable AND significant. */
  readonly incrementalRevenueMinor: number | null;
  /** Sessions still needed for a readable answer at the current rates. */
  readonly sessionsRemaining: number | null;
}

/** Minimum sessions per arm before the normal approximation is defensible. */
const MIN_SESSIONS_PER_ARM = 300;
/** Minimum conversions per arm — the usual rule of thumb for a z-test. */
const MIN_CONVERSIONS_PER_ARM = 10;

export function analyze(exposedIn: ArmTotals, holdoutIn: ArmTotals): Incrementality {
  const exposed = withStats(exposedIn);
  const holdout = withStats(holdoutIn);

  const diff = exposed.rate - holdout.rate;
  const absoluteLiftPp = diff * 100;
  const relativeLift = holdout.rate > 0 ? diff / holdout.rate : null;

  // Unpooled SE for the interval, pooled for the test — the standard pairing.
  const seDiff = Math.sqrt(
    safeVar(exposed.rate, exposed.sessions) + safeVar(holdout.rate, holdout.sessions),
  );
  const margin = 1.959964 * seDiff;
  const ci95Pp: [number, number] = [(diff - margin) * 100, (diff + margin) * 100];

  const pValue = twoProportionPValue(exposed, holdout);

  const { readable, reason, sessionsRemaining } = readability(exposed, holdout);
  const significant = readable && pValue < 0.05;

  // Only claim revenue when the effect is both measurable and real. Using the
  // point estimate without significance is how "we made you $47k" becomes a
  // number that does not survive a second month.
  const incrementalRevenueMinor =
    significant && diff > 0 ? Math.round(diff * exposed.sessions * exposed.aovMinor) : null;

  return {
    exposed,
    holdout,
    absoluteLiftPp,
    relativeLift,
    ci95Pp,
    pValue,
    significant,
    readable,
    reason,
    incrementalRevenueMinor,
    sessionsRemaining,
  };
}

function withStats(t: ArmTotals): ArmStats {
  return {
    ...t,
    rate: t.sessions > 0 ? t.conversions / t.sessions : 0,
    aovMinor: t.conversions > 0 ? Math.round(t.revenueMinor / t.conversions) : 0,
  };
}

function safeVar(p: number, n: number): number {
  return n > 0 ? (p * (1 - p)) / n : 0;
}

function readability(
  exposed: ArmStats,
  holdout: ArmStats,
): { readable: boolean; reason: string; sessionsRemaining: number | null } {
  const smallestArm = Math.min(exposed.sessions, holdout.sessions);

  if (smallestArm < MIN_SESSIONS_PER_ARM) {
    // The holdout arm is almost always the constraint, so estimate against it.
    const holdoutShare =
      exposed.sessions + holdout.sessions > 0
        ? holdout.sessions / (exposed.sessions + holdout.sessions)
        : 0.1;
    const need = MIN_SESSIONS_PER_ARM - smallestArm;
    const remaining = holdoutShare > 0 ? Math.ceil(need / holdoutShare) : null;
    return {
      readable: false,
      reason: `Not enough sessions yet — ${smallestArm} in the smaller group, ${MIN_SESSIONS_PER_ARM} needed.`,
      sessionsRemaining: remaining,
    };
  }

  const fewestConversions = Math.min(exposed.conversions, holdout.conversions);
  if (fewestConversions < MIN_CONVERSIONS_PER_ARM) {
    return {
      readable: false,
      reason: `Not enough orders yet — ${fewestConversions} in the smaller group, ${MIN_CONVERSIONS_PER_ARM} needed.`,
      sessionsRemaining: null,
    };
  }

  return { readable: true, reason: 'Enough data to report.', sessionsRemaining: null };
}

/** Two-tailed p-value from a pooled two-proportion z-test. */
export function twoProportionPValue(a: ArmStats, b: ArmStats): number {
  if (a.sessions === 0 || b.sessions === 0) return 1;
  const pooled = (a.conversions + b.conversions) / (a.sessions + b.sessions);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.sessions + 1 / b.sessions));
  if (se === 0) return 1;
  const z = (a.rate - b.rate) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Human-readable summary. Never asserts a figure the data cannot support. */
export function describe(r: Incrementality): string {
  if (!r.readable) return r.reason;
  if (!r.significant) {
    return `No measurable difference yet. Exposed ${(r.exposed.rate * 100).toFixed(2)}% vs holdout ${(
      r.holdout.rate * 100
    ).toFixed(2)}% — the gap is within normal variation (p = ${r.pValue.toFixed(2)}).`;
  }
  const dir = r.absoluteLiftPp > 0 ? 'higher' : 'lower';
  const rel = r.relativeLift === null ? '' : ` (${(r.relativeLift * 100).toFixed(0)}% ${dir})`;
  return `Exposed sessions convert ${Math.abs(r.absoluteLiftPp).toFixed(2)}pp ${dir}${rel}, 95% CI ${r.ci95Pp[0].toFixed(
    2,
  )} to ${r.ci95Pp[1].toFixed(2)}pp.`;
}
