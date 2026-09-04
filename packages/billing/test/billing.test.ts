import { describe, expect, it } from 'vitest';
import {
  MemoryUsageStore,
  PLANS,
  PLAN_ORDER,
  effectivePlan,
  evaluate,
  formatPrice,
  isBillable,
  isPlanId,
  overageCapMinor,
  periodKey,
  planByName,
  usageWarning,
  type BillingState,
  type SubscriptionStatus,
} from '../src/index.js';

const T0 = Date.parse('2026-09-04T12:00:00Z');

function state(over: Partial<BillingState> = {}): BillingState {
  return {
    shop: 'acme.myshopify.com',
    planId: 'free',
    status: 'none',
    used: 0,
    overageChargedMinor: 0,
    periodEnd: undefined,
    trialEndsAt: undefined,
    ...over,
  };
}

describe('plan catalog', () => {
  it('matches the pricing in ARCHITECTURE §13', () => {
    expect(PLANS.free.priceMinor).toBe(0);
    expect(PLANS.free.included).toBe(100);
    expect(PLANS.growth.priceMinor).toBe(4_900);
    expect(PLANS.growth.included).toBe(500);
    expect(PLANS.scale.priceMinor).toBe(19_900);
    expect(PLANS.scale.included).toBe(2_500);
    expect(PLANS.plus.priceMinor).toBe(59_900);
    expect(PLANS.plus.included).toBe(10_000);
    for (const id of ['growth', 'scale', 'plus'] as const) {
      expect(PLANS[id].overageMinor).toBe(6);
    }
  });

  it('offers no overage on free — nobody approved a charge', () => {
    // Overage requires a spending cap the merchant agreed to. A free merchant
    // agreed to nothing, so there is no lawful way to bill them.
    expect(PLANS.free.overageMinor).toBeNull();
    expect(overageCapMinor(PLANS.free)).toBe(0);
  });

  it('caps every SKU field out of existence', () => {
    // Unlimited products at every tier is a deliberate pricing advantage, so
    // no product limit should exist to be accidentally enforced later.
    for (const id of PLAN_ORDER) {
      expect(JSON.stringify(PLANS[id])).not.toMatch(/sku|productLimit|maxProducts/i);
    }
  });

  it('resolves a subscription name back to a plan', () => {
    expect(planByName('Growth')?.id).toBe('growth');
    expect(planByName('  scale ')?.id).toBe('scale');
    // An unknown name must not guess — either direction is a real error.
    expect(planByName('Enterprise')).toBeUndefined();
  });

  it('validates plan ids', () => {
    expect(isPlanId('growth')).toBe(true);
    expect(isPlanId('enterprise')).toBe(false);
    expect(isPlanId(null)).toBe(false);
  });

  it('formats prices for humans', () => {
    expect(formatPrice(4_900)).toBe('$49.00');
    expect(formatPrice(6)).toBe('$0.06');
  });
});

describe('effective plan', () => {
  it('grants the paid plan only while active', () => {
    expect(effectivePlan(state({ planId: 'scale', status: 'active' })).id).toBe('scale');
  });

  it('falls back to free rather than cutting a merchant off', () => {
    // Hostile and self-defeating: a cancelled merchant is one we might win
    // back, and a pending one is mid-approval.
    for (const status of ['pending', 'declined', 'expired', 'cancelled'] as SubscriptionStatus[]) {
      expect(effectivePlan(state({ planId: 'scale', status })).id).toBe('free');
    }
  });

  it('keeps serving during the approval window', () => {
    // `pending` is the moment the merchant is on Shopify's approval screen.
    // Dropping service there breaks the upgrade at the exact moment they are
    // trying to pay us.
    const e = evaluate(state({ planId: 'growth', status: 'pending', used: 10 }), T0);
    expect(e.allowed).toBe(true);
  });
});

describe('entitlement', () => {
  it('serves inside the included allowance', () => {
    const e = evaluate(state({ used: 40 }), T0);
    expect(e.verdict).toBe('included');
    expect(e.allowed).toBe(true);
    expect(e.chargeMinor).toBe(0);
    expect(e.remaining).toBe(60);
  });

  it('stops a free shop at its allowance without charging', () => {
    const e = evaluate(state({ used: 100 }), T0);
    expect(e.verdict).toBe('quota_exhausted');
    expect(e.allowed).toBe(false);
    expect(e.chargeMinor).toBe(0);
  });

  it('bills overage on a paid plan past the allowance', () => {
    const e = evaluate(state({ planId: 'growth', status: 'active', used: 500 }), T0);
    expect(e.verdict).toBe('overage');
    expect(e.allowed).toBe(true);
    expect(e.chargeMinor).toBe(6);
  });

  it('stops at the approved cap rather than giving service away', () => {
    const cap = overageCapMinor(PLANS.growth);
    const e = evaluate(
      state({ planId: 'growth', status: 'active', used: 5_000, overageChargedMinor: cap }),
      T0,
    );
    // Shopify refuses usage records past the cap, so serving here would be
    // unpaid work. Raising the cap needs the merchant's approval.
    expect(e.verdict).toBe('cap_reached');
    expect(e.allowed).toBe(false);
    expect(e.chargeMinor).toBe(0);
  });

  it('blocks a frozen shop', () => {
    // Frozen means Shopify cannot collect, so anything served is money spent
    // that will never be recovered. The one status that blocks outright.
    const e = evaluate(state({ planId: 'plus', status: 'frozen', used: 0 }), T0);
    expect(e.verdict).toBe('frozen');
    expect(e.allowed).toBe(false);
  });

  it('blocks a frozen shop even with allowance remaining', () => {
    const e = evaluate(state({ planId: 'plus', status: 'frozen', used: 1 }), T0);
    expect(e.allowed).toBe(false);
  });

  it('does not let a lapsed paid plan keep its larger allowance', () => {
    // 400 is inside Growth's 500 but outside Free's 100.
    const e = evaluate(state({ planId: 'growth', status: 'cancelled', used: 400 }), T0);
    expect(e.verdict).toBe('quota_exhausted');
    expect(e.included).toBe(100);
  });

  it('serves the full allowance during a trial', () => {
    const e = evaluate(
      state({ planId: 'plus', status: 'active', used: 9_000, trialEndsAt: T0 + 86_400_000 }),
      T0,
    );
    expect(e.allowed).toBe(true);
    expect(e.chargeMinor).toBe(0);
  });

  it('charges normally once the trial has expired', () => {
    const e = evaluate(
      state({ planId: 'growth', status: 'active', used: 500, trialEndsAt: T0 - 1 }),
      T0,
    );
    expect(e.verdict).toBe('overage');
  });

  it('treats negative usage as zero rather than granting credit', () => {
    const e = evaluate(state({ used: -50 }), T0);
    expect(e.used).toBe(0);
    expect(e.remaining).toBe(100);
  });

  it('gives the merchant a reason, never the shopper', () => {
    const e = evaluate(state({ used: 100 }), T0);
    expect(e.reason).toContain('Upgrade');
  });
});

describe('usage warnings', () => {
  it('warns before the wall, not at it', () => {
    // A merchant who discovers the limit by the widget stopping is a merchant
    // who churns.
    expect(usageWarning(evaluate(state({ used: 79 }), T0))).toBe('none');
    expect(usageWarning(evaluate(state({ used: 80 }), T0))).toBe('approaching');
    expect(usageWarning(evaluate(state({ used: 100 }), T0))).toBe('exhausted');
  });
});

describe('what counts as a resolved conversation', () => {
  const turn = { sessionId: 's1', grounded: true, handedOff: false, arm: 'exposed' as const };

  it('counts a grounded, self-served turn', () => {
    expect(isBillable(turn)).toBe(true);
  });

  it('does not bill for failures', () => {
    // Billing for ungrounded answers would charge most for the turns we are
    // worst at. The incentive has to point the other way.
    expect(isBillable({ ...turn, grounded: false })).toBe(false);
  });

  it('does not bill a conversation we handed to a human', () => {
    expect(isBillable({ ...turn, handedOff: true })).toBe(false);
  });

  it('never bills a holdout session', () => {
    // Holdout shoppers never see the assistant, so nothing was resolved.
    expect(isBillable({ ...turn, arm: 'holdout' })).toBe(false);
  });
});

describe('usage counting', () => {
  const shop = 'acme.myshopify.com';
  const period = '2026-09';

  it('counts a session once however long the conversation runs', () => {
    const store = new MemoryUsageStore();
    expect(store.markResolved(shop, period, 's1')).toBe(true);
    for (let i = 0; i < 19; i++) expect(store.markResolved(shop, period, 's1')).toBe(false);
    // 20 messages, one conversation. This is the whole point of §13's first
    // departure from per-message billing.
    expect(store.resolvedCount(shop, period)).toBe(1);
  });

  it('counts distinct sessions separately', () => {
    const store = new MemoryUsageStore();
    for (const id of ['s1', 's2', 's3']) store.markResolved(shop, period, id);
    expect(store.resolvedCount(shop, period)).toBe(3);
  });

  it('resets each period', () => {
    const store = new MemoryUsageStore();
    store.markResolved(shop, '2026-08', 's1');
    expect(store.resolvedCount(shop, period)).toBe(0);
  });

  it('keeps shops separate', () => {
    const store = new MemoryUsageStore();
    store.markResolved(shop, period, 's1');
    expect(store.resolvedCount('other.myshopify.com', period)).toBe(0);
  });

  it('accumulates overage', () => {
    const store = new MemoryUsageStore();
    expect(store.addOverage(shop, period, 6)).toBe(6);
    expect(store.addOverage(shop, period, 6)).toBe(12);
    expect(store.overageCharged(shop, period)).toBe(12);
  });

  it('keys periods by UTC month', () => {
    expect(periodKey(Date.parse('2026-09-30T23:59:59Z'))).toBe('2026-09');
    expect(periodKey(Date.parse('2026-10-01T00:00:01Z'))).toBe('2026-10');
  });
});

describe('the full arc a merchant actually walks', () => {
  it('free → exhausted → upgrade → overage → cap', () => {
    const store = new MemoryUsageStore();
    const shop = 'acme.myshopify.com';
    const period = '2026-09';
    const read = (s: Partial<BillingState>): BillingState =>
      state({ used: store.resolvedCount(shop, period), overageChargedMinor: store.overageCharged(shop, period), ...s });

    // 100 free conversations.
    for (let i = 0; i < 100; i++) store.markResolved(shop, period, `s${i}`);
    expect(evaluate(read({}), T0).verdict).toBe('quota_exhausted');

    // Merchant upgrades; the same usage is now well inside Growth.
    const growth = { planId: 'growth' as const, status: 'active' as const };
    expect(evaluate(read(growth), T0).verdict).toBe('included');

    // They grow into overage.
    for (let i = 100; i < 500; i++) store.markResolved(shop, period, `s${i}`);
    const over = evaluate(read(growth), T0);
    expect(over.verdict).toBe('overage');
    expect(over.chargeMinor).toBe(6);

    // Overage accrues to the approved cap and stops there.
    store.addOverage(shop, period, overageCapMinor(PLANS.growth));
    expect(evaluate(read(growth), T0).verdict).toBe('cap_reached');
  });
});
