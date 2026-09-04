import { PLANS, overageCapMinor, planOf, type Plan, type PlanId } from './plans.js';

/**
 * What a shop is entitled to right now.
 *
 * Two failure directions, and they are not symmetric. Withholding service a
 * merchant paid for is recoverable — they complain, we fix it, they stay.
 * Charging someone who never approved a charge is not: it is a trust failure,
 * a support burden, and grounds for rejection in Shopify's app review. So every
 * ambiguous case below resolves toward *serving without billing*, and the only
 * hard stops are the two where continuing would either bill an unapproved
 * merchant or spend money we will never recover.
 */

/** Mirrors Shopify's `AppSubscriptionStatus`. */
export type SubscriptionStatus =
  | 'none'
  | 'pending'
  | 'active'
  | 'declined'
  | 'expired'
  | 'frozen'
  | 'cancelled';

export interface BillingState {
  readonly shop: string;
  readonly planId: PlanId;
  readonly status: SubscriptionStatus;
  /** Resolved conversations in the current period. */
  readonly used: number;
  /** Overage already charged this period, in cents. */
  readonly overageChargedMinor: number;
  /** Epoch ms when the current period ends, if known. */
  readonly periodEnd: number | undefined;
  readonly trialEndsAt: number | undefined;
}

export type EntitlementVerdict =
  /** Serve, within the included allowance. */
  | 'included'
  /** Serve, and record a usage charge for this conversation. */
  | 'overage'
  /** Free plan allowance exhausted; no approved way to charge. */
  | 'quota_exhausted'
  /** Paid plan past the cap the merchant approved. */
  | 'cap_reached'
  /** Shopify froze the shop — it cannot pay. */
  | 'frozen';

export interface Entitlement {
  readonly verdict: EntitlementVerdict;
  readonly allowed: boolean;
  readonly plan: Plan;
  /** Cents to charge for this conversation. Non-zero only for `overage`. */
  readonly chargeMinor: number;
  readonly used: number;
  readonly included: number;
  readonly remaining: number;
  /** Merchant-facing explanation. Never shown to shoppers. */
  readonly reason: string;
}

/**
 * The plan actually in force, which is not always the plan on record.
 *
 * A subscription that is pending, declined, expired or cancelled means the
 * merchant is not paying — but cutting them off entirely would be both hostile
 * and self-defeating, since a cancelled merchant is one we might win back. They
 * fall back to free-tier entitlement instead.
 *
 * `pending` matters most: it is the window while the merchant is on Shopify's
 * approval screen. Dropping service there would break the upgrade flow at
 * exactly the moment they are trying to pay us.
 */
export function effectivePlan(state: BillingState): Plan {
  if (state.status === 'active') return planOf(state.planId);
  return PLANS.free;
}

export function evaluate(state: BillingState, now: number = Date.now()): Entitlement {
  const plan = effectivePlan(state);
  const used = Math.max(0, state.used);
  const included = plan.included;
  const remaining = Math.max(0, included - used);

  const base = { plan, used, included, remaining };

  // A frozen shop cannot pay Shopify, so Shopify will not pay us. Every
  // conversation served is money spent that will never be recovered. This is
  // the one status that blocks rather than degrading to free.
  if (state.status === 'frozen') {
    return {
      ...base,
      verdict: 'frozen',
      allowed: false,
      chargeMinor: 0,
      reason: 'Shopify has frozen this shop, usually for an unpaid invoice.',
    };
  }

  // Trial grants the paid plan's allowance in full.
  if (state.trialEndsAt !== undefined && now < state.trialEndsAt && state.status === 'active') {
    if (used < included) {
      return { ...base, verdict: 'included', allowed: true, chargeMinor: 0, reason: 'Trial.' };
    }
  }

  if (used < included) {
    return {
      ...base,
      verdict: 'included',
      allowed: true,
      chargeMinor: 0,
      reason: `${remaining} of ${included} conversations remaining.`,
    };
  }

  // Included allowance is gone. Overage is only available where the merchant
  // approved a spending cap — which, on the free plan, they never did.
  if (plan.overageMinor === null || state.status !== 'active') {
    return {
      ...base,
      verdict: 'quota_exhausted',
      allowed: false,
      chargeMinor: 0,
      reason: `The ${plan.name} plan includes ${included} conversations per month. Upgrade to continue.`,
    };
  }

  const cap = overageCapMinor(plan);
  const alreadyCharged = Math.max(0, state.overageChargedMinor);
  if (alreadyCharged + plan.overageMinor > cap) {
    // Shopify rejects usage records past the approved cap, so serving here
    // would be giving the conversation away. Raising the cap needs the
    // merchant's approval — we cannot do it on their behalf.
    return {
      ...base,
      verdict: 'cap_reached',
      allowed: false,
      chargeMinor: 0,
      reason: 'The approved spending limit for this period has been reached.',
    };
  }

  return {
    ...base,
    verdict: 'overage',
    allowed: true,
    chargeMinor: plan.overageMinor,
    reason: 'Beyond the included allowance; billed as overage.',
  };
}

/**
 * Should the merchant be warned?
 *
 * Deliberately warns before the wall rather than at it. A merchant who
 * discovers the limit by having the widget stop is a merchant who churns; one
 * warned at 80% has time to upgrade.
 */
export function usageWarning(e: Entitlement): 'none' | 'approaching' | 'exhausted' {
  if (!e.allowed) return 'exhausted';
  if (e.included === 0) return 'none';
  return e.used / e.included >= 0.8 ? 'approaching' : 'none';
}

/** Start of the next UTC month — the fallback when Shopify's period is unknown. */
export function nextPeriodStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Billing period key, used to reset counters. */
export function periodKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7); // YYYY-MM
}
