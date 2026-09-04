/**
 * The degradation ladder.
 *
 * `ARCHITECTURE §9` states the rule this file exists to keep: **never show an
 * error.** Walk down instead.
 *
 *     full  →  reduced  →  faq_only  →  handoff  →  unavailable
 *
 * ## The correction this makes to billing
 *
 * `§8` is explicit: *"Never a hard cut-off mid-conversation with a shopper."*
 * The billing layer shipped before this returned a hard `402` the moment a
 * shop's allowance ran out, which breaks that rule in the worst way — the
 * person cut off is the **shopper**, who has no idea a billing relationship
 * exists, is mid-sentence, and did nothing wrong. The merchant's plan is not
 * the shopper's problem.
 *
 * So exhausting an allowance now moves the shop down the ladder instead of
 * off it. At 100% the agent stays up in FAQ-only mode: it can still answer
 * from the merchant's policies, still capture a lead, still hand off to a
 * human. What it stops doing is the expensive part — live catalog reasoning
 * over the model. The merchant sees an upsell in the admin; the shopper sees a
 * slightly less capable assistant rather than a dead widget.
 *
 * That is also better commercially. A dead widget teaches a merchant the
 * product is unreliable. A degraded one teaches them what they are missing.
 */

export type ServiceLevel =
  /** Everything: best model, live catalog, cart actions. */
  | 'full'
  /** Cheaper model, live catalog. The shopper should not notice much. */
  | 'reduced'
  /** Policy and FAQ answers only. No model-driven catalog reasoning. */
  | 'faq_only'
  /** Collect an email and route to a human. */
  | 'handoff'
  /** Static contact details. The last rung, and still not an error page. */
  | 'unavailable';

export const LEVEL_ORDER: readonly ServiceLevel[] = [
  'full',
  'reduced',
  'faq_only',
  'handoff',
  'unavailable',
];

/** Lower is better. Used to take the worst of several signals. */
export function levelRank(level: ServiceLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export function worstOf(...levels: readonly ServiceLevel[]): ServiceLevel {
  return levels.reduce((a, b) => (levelRank(b) > levelRank(a) ? b : a), 'full' as ServiceLevel);
}

export interface LadderInputs {
  /** Fraction of the monthly allowance consumed. 1.0 means exhausted. */
  readonly budgetUsedFraction: number;
  /** Merchant cannot be billed at all — frozen, or past an approved cap. */
  readonly unbillable: boolean;
  /** The merchant's storefront keeps failing; see `breaker.ts`. */
  readonly catalogBreakerOpen: boolean;
  /** The model provider is shedding load. */
  readonly modelDegraded: boolean;
  /** No catalog access at all — UCP down and nothing cached. */
  readonly catalogUnavailable: boolean;
}

export interface LadderDecision {
  readonly level: ServiceLevel;
  /**
   * Cart mutations allowed?
   *
   * Disabled the moment catalog data is stale or absent. `§9`: *"disable cart
   * actions rather than guessing"* — adding the wrong variant to someone's
   * cart is worse than not adding one, because they find out at checkout.
   */
  readonly cartActions: boolean;
  /** Prices may be stale; the reply must say so out loud. */
  readonly hedgePrices: boolean;
  /** Merchant-facing. Never rendered to a shopper. */
  readonly reason: string;
}

/** §8: soft-degrade at 80% of the monthly allowance. */
export const SOFT_DEGRADE_AT = 0.8;

/**
 * Decide the service level.
 *
 * Pure and synchronous — it sits on every turn, and each input is already
 * known by the time a turn starts.
 */
export function decideLevel(input: LadderInputs): LadderDecision {
  const reasons: string[] = [];
  let level: ServiceLevel = 'full';

  // --- budget ------------------------------------------------------------
  if (input.budgetUsedFraction >= 1) {
    // NOT a cut-off. The agent stays up; it stops doing the expensive part.
    level = worstOf(level, 'faq_only');
    reasons.push('monthly allowance used');
  } else if (input.budgetUsedFraction >= SOFT_DEGRADE_AT) {
    level = worstOf(level, 'reduced');
    reasons.push('approaching monthly allowance');
  }

  // A shop that cannot be billed at all is different from one that has merely
  // used its allowance: there is no path to charging for more, so we do not
  // spend more. Still not an error — it drops to handoff, which costs nothing
  // and still gets the shopper an answer from a person.
  if (input.unbillable) {
    level = worstOf(level, 'handoff');
    reasons.push('shop cannot be billed');
  }

  // --- upstream ----------------------------------------------------------
  if (input.modelDegraded) {
    level = worstOf(level, 'reduced');
    reasons.push('model provider shedding load');
  }

  if (input.catalogBreakerOpen) {
    // The merchant's own storefront is failing. Answering catalog questions
    // from a stale cache is fine; inventing them is not.
    level = worstOf(level, 'faq_only');
    reasons.push('storefront failing');
  }

  if (input.catalogUnavailable) {
    level = worstOf(level, 'handoff');
    reasons.push('no catalog data available');
  }

  const cartActions = level === 'full' || level === 'reduced';
  const hedgePrices = input.catalogBreakerOpen || input.catalogUnavailable;

  return {
    level,
    // Cart mutations need current data. Guessing a variant means the shopper
    // discovers the mistake at checkout, which is the worst place to find it.
    cartActions: cartActions && !input.catalogUnavailable,
    hedgePrices,
    reason: reasons.length === 0 ? 'nominal' : reasons.join('; '),
  };
}

/**
 * Which model tier to use at a given level.
 *
 * Named by role rather than by model id so this survives a provider change —
 * `§9`'s ladder is still written in Anthropic model names, which stopped being
 * accurate when the project moved to OpenAI.
 */
export type ModelTier = 'escalation' | 'workhorse' | 'classify';

export function tierFor(level: ServiceLevel, escalated: boolean): ModelTier | undefined {
  switch (level) {
    case 'full':
      return escalated ? 'escalation' : 'workhorse';
    case 'reduced':
      // Never the escalation tier while degraded, even for a hard question:
      // the point of degrading is to stop spending.
      return 'workhorse';
    case 'faq_only':
      return 'classify';
    default:
      // handoff / unavailable need no model at all.
      return undefined;
  }
}

/**
 * What the shopper is told.
 *
 * Never mentions billing, plans, quotas or the merchant's account. A shopper
 * who reads "this store has exceeded its plan" has learned something
 * embarrassing about the merchant and useless to themselves.
 */
export function shopperMessage(level: ServiceLevel): string | undefined {
  switch (level) {
    case 'full':
    case 'reduced':
      return undefined;
    case 'faq_only':
      return undefined; // still answers, just from policy rather than catalog
    case 'handoff':
      return 'I can’t check that here, but someone from the team can — leave an email and they’ll follow up.';
    case 'unavailable':
      return 'I can’t help right now. The team can be reached through the contact page.';
  }
}
