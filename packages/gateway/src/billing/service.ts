import {
  evaluate,
  isBillable,
  periodKey,
  planByName,
  planOf,
  type BillingState,
  type Entitlement,
  type PlanId,
  type TurnOutcome,
} from '@storeagent/billing';
import type { SqliteBillingStore } from './store.js';
import {
  BillingApiError,
  cancelSubscription,
  createSubscription,
  fetchActiveSubscription,
  normalizeStatus,
  recordUsage,
  usageIdempotencyKey,
  type BillingApiConfig,
} from './shopify-billing.js';

/**
 * Billing on the request path.
 *
 * Two calls, deliberately at opposite ends of a turn:
 *
 *   `check`  — before any model work, so a shop past its allowance costs
 *              nothing to refuse
 *   `settle` — after a turn succeeds, so only resolved conversations count
 *
 * The ordering is the point. Checking after the fact would mean paying for the
 * model call and then declining to bill for it, which is the worst of both.
 */

/** Just enough of `Logger` to log a failure, so tests need not build one. */
export interface BillingLogger {
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface BillingServiceDeps {
  readonly store: SqliteBillingStore;
  /** Absent in demo mode, where there is no shop to bill. */
  readonly apiFor: (shop: string) => Promise<BillingApiConfig | undefined>;
  readonly doFetch?: typeof globalThis.fetch;
  /** Redacting logger. Falls back to stderr so a failure is never silent. */
  readonly log?: BillingLogger;
}

export class BillingService {
  constructor(private readonly deps: BillingServiceDeps) {}

  stateFor(shop: string, now: number = Date.now()): BillingState {
    const record = this.deps.store.get(shop);
    const period = periodKey(now);
    return {
      shop,
      planId: record.planId,
      status: record.status,
      used: this.deps.store.resolvedCount(shop, period),
      overageChargedMinor: this.deps.store.overageCharged(shop, period),
      periodEnd: record.periodEnd,
      trialEndsAt: record.trialEndsAt,
    };
  }

  check(shop: string, now: number = Date.now()): Entitlement {
    return evaluate(this.stateFor(shop, now), now);
  }

  /**
   * Count a resolved conversation and charge overage if it is one.
   *
   * Never throws. A billing failure must not break a conversation the shopper
   * is having — we would rather lose six cents than fail a turn the merchant is
   * paying for. Failures are logged, not surfaced.
   */
  async settle(shop: string, turn: TurnOutcome, now: number = Date.now()): Promise<void> {
    try {
      if (!isBillable(turn)) return;

      const period = periodKey(now);
      // Idempotent by primary key: only the first turn of a session counts,
      // so a 20-message conversation bills exactly once.
      const isNew = this.deps.store.markResolved(shop, period, turn.sessionId);
      if (!isNew) return;

      // Re-evaluate against the state BEFORE this conversation was counted,
      // which is what decides whether it fell inside the allowance or beyond.
      const used = this.deps.store.resolvedCount(shop, period) - 1;
      const record = this.deps.store.get(shop);
      const entitlement = evaluate(
        {
          shop,
          planId: record.planId,
          status: record.status,
          used,
          overageChargedMinor: this.deps.store.overageCharged(shop, period),
          periodEnd: record.periodEnd,
          trialEndsAt: record.trialEndsAt,
        },
        now,
      );

      if (entitlement.verdict !== 'overage' || entitlement.chargeMinor <= 0) return;

      const api = await this.deps.apiFor(shop);
      if (api === undefined || record.usageLineItemId === undefined) {
        // Nothing to charge against. Record it locally so the merchant's usage
        // page still reflects reality even if the charge could not be made.
        this.deps.store.addOverage(shop, period, entitlement.chargeMinor);
        return;
      }

      const accepted = await recordUsage(
        api,
        record.usageLineItemId,
        entitlement.chargeMinor,
        `Resolved conversation (${period})`,
        // Derived from the session, so a retry after a timeout cannot charge
        // the same conversation twice. Usage records cannot be retracted.
        usageIdempotencyKey(shop, period, turn.sessionId),
        'USD',
        this.deps.doFetch,
      );

      if (accepted) this.deps.store.addOverage(shop, period, entitlement.chargeMinor);
      // If Shopify refused because the cap is reached, the next `check` returns
      // `cap_reached` on its own — nothing else to do here.
    } catch (err) {
      // Through the redacting logger: an upstream error body could otherwise
      // carry request detail into the logs.
      if (this.deps.log !== undefined) this.deps.log.error('billing_settle_failed', { shop, err });
      else process.stderr.write(`billing_settle_failed ${String(err)}\n`);
    }
  }

  /**
   * Apply an `app_subscriptions/update` webhook.
   *
   * Shopify is the authority; this never *decides* anything, it records what
   * Shopify says. The plan is resolved from the subscription name, and an
   * unrecognised name leaves the stored plan alone rather than guessing — a
   * wrong guess either grants entitlement nobody paid for or withdraws one
   * they did.
   */
  async applyWebhook(
    shop: string,
    parsed: { subscriptionId: string | undefined; name: string | undefined; status: string | undefined },
  ): Promise<void> {
    const record = this.deps.store.get(shop);
    const status = parsed.status === undefined ? record.status : normalizeStatus(parsed.status);
    const plan = parsed.name === undefined ? undefined : planByName(parsed.name);

    this.deps.store.put({
      ...record,
      ...(parsed.subscriptionId === undefined ? {} : { subscriptionId: parsed.subscriptionId }),
      planId: plan?.id ?? record.planId,
      status,
    });

    // A subscription that just went active may carry a usage line we do not
    // know the id of yet — it is only returned by the API, not the webhook.
    if (status === 'active') await this.reconcile(shop).catch(() => undefined);
  }

  /**
   * Re-read state from Shopify and overwrite ours.
   *
   * Webhooks get missed. This is the repair path, and it is what the admin
   * page calls rather than trusting a cached row.
   */
  async reconcile(shop: string, now: number = Date.now()): Promise<void> {
    const api = await this.deps.apiFor(shop);
    if (api === undefined) return;

    const active = await fetchActiveSubscription(api, this.deps.doFetch);
    const record = this.deps.store.get(shop);

    if (active === undefined) {
      // Shopify says there is no active subscription, so there is not one.
      this.deps.store.put({
        ...record,
        subscriptionId: undefined,
        planId: 'free',
        status: 'none',
        usageLineItemId: undefined,
        periodEnd: undefined,
      });
      return;
    }

    const plan = planByName(active.name);
    this.deps.store.put({
      ...record,
      subscriptionId: active.id,
      planId: plan?.id ?? record.planId,
      status: active.status,
      test: active.test,
      ...(active.currentPeriodEnd === undefined ? {} : { periodEnd: active.currentPeriodEnd }),
      ...(active.usageLineItemId === undefined ? {} : { usageLineItemId: active.usageLineItemId }),
    });
    void now;
  }

  /**
   * Begin an upgrade.
   *
   * Returns a URL to send the merchant to. Nothing is charged until they
   * approve it on Shopify's own screen — we cannot and must not charge
   * silently.
   */
  async beginUpgrade(shop: string, planId: PlanId, returnUrl: string): Promise<string> {
    const plan = planOf(planId);
    const api = await this.deps.apiFor(shop);
    if (api === undefined) throw new BillingApiError('this shop is not installed', false);

    const created = await createSubscription(
      { ...api, returnUrl },
      plan,
      'USD',
      this.deps.doFetch,
    );

    // Recorded as pending, not active. The merchant has not approved yet, and
    // treating it as active here would grant a plan nobody paid for.
    this.deps.store.put({
      ...this.deps.store.get(shop),
      subscriptionId: created.subscriptionId,
      planId,
      status: 'pending',
      test: api.test,
    });

    return created.confirmationUrl;
  }

  /** Cancel, returning the shop to the free plan. */
  async cancel(shop: string): Promise<void> {
    const record = this.deps.store.get(shop);
    const api = await this.deps.apiFor(shop);
    if (api !== undefined && record.subscriptionId !== undefined) {
      await cancelSubscription(api, record.subscriptionId, this.deps.doFetch);
    }
    this.deps.store.put({
      ...record,
      subscriptionId: undefined,
      planId: 'free',
      status: 'cancelled',
      usageLineItemId: undefined,
    });
  }

  /** Uninstall and GDPR redaction. */
  purge(shop: string): void {
    this.deps.store.purge(shop);
  }

  /** Merchant-facing summary for the admin page. */
  summary(shop: string, now: number = Date.now()): {
    planId: string;
    planName: string;
    status: string;
    used: number;
    included: number;
    remaining: number;
    overageMinor: number;
    verdict: string;
    test: boolean;
    history: { period: string; resolved: number; overageMinor: number }[];
  } {
    const record = this.deps.store.get(shop);
    const entitlement = this.check(shop, now);
    return {
      planId: record.planId,
      planName: planOf(record.planId).name,
      status: record.status,
      used: entitlement.used,
      included: entitlement.included,
      remaining: entitlement.remaining,
      overageMinor: this.deps.store.overageCharged(shop, periodKey(now)),
      verdict: entitlement.verdict,
      test: record.test,
      history: this.deps.store.history(shop),
    };
  }
}
