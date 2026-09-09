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
  return PLAN_ORDER.map((id) => PLANS[id]).find(
    (p) => p.name.toLowerCase() === needle || p.id === needle,
  );
}

/**
 * Resolve the plan a Shopify subscription corresponds to.
 *
 * `planByName` alone was enough while the app created every subscription
 * itself — it passed `plan.name`, so the name came back exactly as sent. Under
 * **Shopify App Pricing** the plan is defined in the Partner dashboard and the
 * subscription carries whatever the merchant-facing plan name is there
 * ("StoreAgent Plus", "Plus Plan", "Plus — monthly"). None of those match, and
 * the caller then silently keeps the merchant on Free after they have paid.
 *
 * So the name is tried first and the **price** second. The price is the amount
 * Shopify says the merchant is actually being charged, which is a far better
 * claim to a plan than a display string an admin can retype at will. It is only
 * consulted when it is unambiguous: two plans priced the same resolve to
 * neither, and a zero or absent price never resolves, so a trial or a $0 line
 * cannot silently confer a paid plan.
 *
 * Returning `undefined` remains meaningful — the caller must not guess, because
 * a wrong guess either grants entitlement nobody paid for or withdraws one they
 * did.
 */
export function resolvePlan(subscription: {
  readonly name?: string | undefined;
  readonly priceMinor?: number | undefined;
}): Plan | undefined {
  const byName = subscription.name === undefined ? undefined : planByName(subscription.name);
  if (byName !== undefined) return byName;

  const price = subscription.priceMinor;
  if (price === undefined || price <= 0) return undefined;

  const matches = PLAN_ORDER.map((id) => PLANS[id]).filter((p) => p.priceMinor === price);
  return matches.length === 1 ? matches[0] : undefined;
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
