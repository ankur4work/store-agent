import { describe, expect, it } from 'vitest';
import { analyze, describe as summarize, normalCdf, twoProportionPValue } from '../src/incrementality.js';

const arm = (sessions: number, conversions: number, aov = 18900) => ({
  sessions,
  conversions,
  revenueMinor: conversions * aov,
});

/**
 * These tests exist to stop us shipping a confident number the data cannot
 * support. That failure is worse than showing nothing: the merchant acts on it,
 * the effect evaporates, and no figure from us is believed again.
 */
describe('refusing to answer', () => {
  it('is unreadable with almost no data', () => {
    const r = analyze(arm(40, 2), arm(3, 0));
    expect(r.readable).toBe(false);
    expect(r.incrementalRevenueMinor).toBeNull();
    expect(r.reason).toContain('Not enough sessions');
  });

  it('is unreadable when only the holdout arm is thin', () => {
    // The holdout is nearly always the bottleneck — 5% of traffic fills it.
    const r = analyze(arm(50_000, 1_800), arm(120, 4));
    expect(r.readable).toBe(false);
  });

  it('is unreadable with enough sessions but too few orders', () => {
    // 300 sessions each, but a 1% base rate means ~3 orders — the normal
    // approximation is not defensible there.
    const r = analyze(arm(400, 4), arm(400, 3));
    expect(r.readable).toBe(false);
    expect(r.reason).toContain('Not enough orders');
  });

  it('estimates how many more sessions are needed', () => {
    const r = analyze(arm(900, 30), arm(100, 3));
    expect(r.sessionsRemaining).toBeGreaterThan(0);
  });

  it('never claims revenue while unreadable, however large the gap looks', () => {
    const r = analyze(arm(100, 50), arm(100, 1));
    expect(r.readable).toBe(false);
    expect(r.incrementalRevenueMinor).toBeNull();
  });
});

describe('readable but not significant', () => {
  it('reports no measurable difference when arms are close', () => {
    const r = analyze(arm(5_000, 150), arm(5_000, 148));
    expect(r.readable).toBe(true);
    expect(r.significant).toBe(false);
    expect(r.incrementalRevenueMinor).toBeNull();
    expect(summarize(r)).toContain('No measurable difference');
  });

  it('a confidence interval spanning zero is not a win', () => {
    const r = analyze(arm(5_000, 155), arm(5_000, 150));
    expect(r.ci95Pp[0]).toBeLessThan(0);
    expect(r.ci95Pp[1]).toBeGreaterThan(0);
    expect(r.significant).toBe(false);
  });
});

describe('a real effect', () => {
  const r = analyze(arm(20_000, 800), arm(20_000, 600)); // 4.0% vs 3.0%

  it('is readable and significant', () => {
    expect(r.readable).toBe(true);
    expect(r.significant).toBe(true);
  });

  it('computes absolute lift in percentage points', () => {
    expect(r.absoluteLiftPp).toBeCloseTo(1.0, 2);
  });

  it('computes relative lift', () => {
    expect(r.relativeLift).toBeCloseTo(0.3333, 3);
  });

  it('produces a confidence interval that excludes zero', () => {
    expect(r.ci95Pp[0]).toBeGreaterThan(0);
  });

  it('reports incremental revenue from the lift, not from total exposed revenue', () => {
    // 1pp of 20,000 sessions = 200 extra orders x $189.
    expect(r.incrementalRevenueMinor).toBe(Math.round(0.01 * 20_000 * 18_900));
    // Sanity: nowhere near the exposed arm's whole revenue.
    expect(r.incrementalRevenueMinor!).toBeLessThan(r.exposed.revenueMinor / 3);
  });

  it('summarises without overclaiming', () => {
    const s = summarize(r);
    expect(s).toContain('95% CI');
    expect(s).toContain('higher');
  });
});

describe('a negative effect is reported honestly', () => {
  const r = analyze(arm(20_000, 500), arm(20_000, 700));

  it('does not hide a significant drop', () => {
    expect(r.significant).toBe(true);
    expect(r.absoluteLiftPp).toBeLessThan(0);
  });

  it('claims no incremental revenue when the agent under-performs', () => {
    expect(r.incrementalRevenueMinor).toBeNull();
  });

  it('says lower, not higher', () => {
    expect(summarize(r)).toContain('lower');
  });
});

describe('edge cases', () => {
  it('handles a zero-session arm without dividing by zero', () => {
    const r = analyze(arm(0, 0), arm(0, 0));
    expect(Number.isFinite(r.absoluteLiftPp)).toBe(true);
    expect(r.readable).toBe(false);
  });

  it('returns null relative lift when the holdout never converted', () => {
    const r = analyze(arm(1_000, 50), arm(1_000, 0));
    expect(r.relativeLift).toBeNull();
  });

  it('computes AOV over converting sessions only', () => {
    const r = analyze({ sessions: 1_000, conversions: 10, revenueMinor: 189_000 }, arm(1_000, 10));
    expect(r.exposed.aovMinor).toBe(18_900);
  });

  it('gives AOV 0 rather than NaN with no conversions', () => {
    expect(analyze(arm(500, 0), arm(500, 0)).exposed.aovMinor).toBe(0);
  });
});

describe('statistics', () => {
  it('normalCdf matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normalCdf(2.575829)).toBeCloseTo(0.995, 4);
  });

  it('p-value is ~1 for identical arms', () => {
    const a = { sessions: 1000, conversions: 30, revenueMinor: 0, rate: 0.03, aovMinor: 0 };
    expect(twoProportionPValue(a, a)).toBeCloseTo(1, 6);
  });

  it('p-value falls as the gap widens', () => {
    const near = analyze(arm(10_000, 320), arm(10_000, 300)).pValue;
    const far = analyze(arm(10_000, 500), arm(10_000, 300)).pValue;
    expect(far).toBeLessThan(near);
  });

  it('is symmetric in direction', () => {
    const up = analyze(arm(10_000, 400), arm(10_000, 300)).pValue;
    const down = analyze(arm(10_000, 300), arm(10_000, 400)).pValue;
    expect(up).toBeCloseTo(down, 10);
  });
});
