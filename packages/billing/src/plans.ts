/**
 * The plan catalog.
 *
 * Mirrors `ARCHITECTURE §13`. The three deliberate departures from SiteAgent
 * are encoded here rather than described:
 *
 *  1. **Billed per resolved conversation, not per message.** Per-message
 *     billing makes a merchant hope the product goes unused. See `usage.ts` for
 *     what "resolved" means and why the definition is deliberately strict.
 *  2. **Unlimited SKUs at every tier**, including free — so there is no product
 *     limit field anywhere in this file. We do not index the catalog (§4), so
 *     catalog size costs us nothing and capping it would be an invented
 *     scarcity.
 *  3. **A free tier generous enough to prove value** — 100 resolutions, versus
 *     SiteAgent's ~50-conversation equivalent.
 */

export type PlanId = 'free' | 'growth' | 'scale' | 'plus';

export interface Plan {
  readonly id: PlanId;
  /**
   * Shown to the merchant AND used to identify the subscription when reading
   * it back from Shopify, so it must stay stable. Renaming a plan orphans
   * every existing subscription.
   */
  readonly name: string;
  /** Monthly price in cents. */
  readonly priceMinor: number;
  /** Included resolved conversations per billing period. */
  readonly included: number;
  /**
   * Per-conversation overage in cents, or `null` where overage is not offered.
   *
   * Free has none deliberately: overage requires a spending cap the merchant
   * has approved, and a merchant on the free plan has approved nothing. We do
   * not get to bill someone who never agreed to be billed.
   */
  readonly overageMinor: number | null;
  readonly features: readonly string[];
  readonly trialDays: number;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMinor: 0,
    included: 100,
    overageMinor: null,
    features: ['Unlimited products', 'Grounded answers', 'Incrementality holdout'],
    trialDays: 0,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceMinor: 4_900,
    included: 500,
    overageMinor: 6,
    features: ['Everything in Free'],
    trialDays: 14,
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    priceMinor: 19_900,
    included: 2_500,
    overageMinor: 6,
    features: ['Everything in Growth', 'Human handoff'],
    trialDays: 14,
  },
  plus: {
    id: 'plus',
    name: 'Plus',
    priceMinor: 59_900,
    included: 10_000,
    overageMinor: 6,
    features: ['Everything in Scale', 'Voice', 'API access', 'Priority routing'],
    trialDays: 14,
  },
};

export const PLAN_ORDER: readonly PlanId[] = ['free', 'growth', 'scale', 'plus'];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && value in PLANS;
}

export function planOf(id: PlanId): Plan {
  return PLANS[id];
}

/**
 * Resolve a Shopify subscription name back to a plan.
 *
 * Matched case-insensitively against the plan name. An unrecognised name
 * returns `undefined` rather than guessing — a wrong guess here either grants
 * entitlement nobody paid for or withholds one they did.
 */
export function planByName(name: string): Plan | undefined {
  const needle = name.trim().toLowerCase();
  return PLAN_ORDER.map((id) => PLANS[id]).find((p) => p.name.toLowerCase() === needle);
}

export function formatPrice(minor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

/**
 * The spending cap presented to the merchant for overage.
 *
 * Shopify requires usage-based line items to carry a cap that the merchant
 * approves up front, and refuses usage records that would exceed it. Set at
 * roughly one extra period of included volume: enough that a busy month does
 * not silently stop billing, low enough that nobody discovers a five-figure
 * surprise.
 */
export function overageCapMinor(plan: Plan): number {
  if (plan.overageMinor === null) return 0;
  return plan.included * plan.overageMinor;
}
