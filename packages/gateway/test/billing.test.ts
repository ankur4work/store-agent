import { describe, expect, it, vi } from 'vitest';
import { PLANS, overageCapMinor, periodKey } from '@storeagent/billing';
import { openDatabase } from '../src/store/sqlite.js';
import { SqliteBillingStore } from '../src/billing/store.js';
import { BillingService } from '../src/billing/service.js';
import {
  BillingApiError,
  cancelSubscription,
  createSubscription,
  fetchActiveSubscription,
  normalizeStatus,
  recordUsage,
  usageIdempotencyKey,
  type BillingApiConfig,
} from '../src/billing/shopify-billing.js';
import { parseSubscriptionPayload } from '../src/shopify/webhooks.js';

const SHOP = 'acme.myshopify.com';
const PERIOD = periodKey(Date.parse('2026-09-04T12:00:00Z'));
const T0 = Date.parse('2026-09-04T12:00:00Z');

const api: BillingApiConfig = {
  shop: SHOP,
  accessToken: 'shpat_secret',
  returnUrl: 'https://example.com/admin',
  test: true,
};

/** Capture the outgoing GraphQL request and reply with a canned body. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn = vi.fn(async (url: any, init: any) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

function store(): SqliteBillingStore {
  return new SqliteBillingStore(openDatabase({ path: ':memory:' }));
}

describe('billing store', () => {
  it('treats the absence of a subscription as the free plan', () => {
    const s = store();
    const record = s.get(SHOP);
    // We never create a zero-value subscription just to have a row.
    expect(record.planId).toBe('free');
    expect(record.status).toBe('none');
    expect(record.subscriptionId).toBeUndefined();
  });

  it('round-trips a subscription record', () => {
    const s = store();
    s.put({
      shop: SHOP,
      subscriptionId: 'gid://shopify/AppSubscription/1',
      planId: 'growth',
      status: 'active',
      test: false,
      periodEnd: T0 + 86_400_000,
      trialEndsAt: T0 + 3_600_000,
      usageLineItemId: 'gid://line/9',
    });
    const r = s.get(SHOP);
    expect(r.planId).toBe('growth');
    expect(r.status).toBe('active');
    expect(r.test).toBe(false);
    expect(r.usageLineItemId).toBe('gid://line/9');
  });

  it('falls back to free for an unrecognised stored plan', () => {
    const s = store();
    s.put({
      shop: SHOP, subscriptionId: undefined, planId: 'enterprise' as never, status: 'active',
      test: true, periodEnd: undefined, trialEndsAt: undefined, usageLineItemId: undefined,
    });
    // Guessing here would grant entitlement nobody paid for.
    expect(s.get(SHOP).planId).toBe('free');
  });

  it('counts one conversation per session however many turns it has', () => {
    const s = store();
    expect(s.markResolved(SHOP, PERIOD, 's1')).toBe(true);
    for (let i = 0; i < 25; i++) expect(s.markResolved(SHOP, PERIOD, 's1')).toBe(false);
    expect(s.resolvedCount(SHOP, PERIOD)).toBe(1);
  });

  it('survives a restart — an uncounted conversation is revenue we never bill', () => {
    const db = openDatabase({ path: ':memory:' });
    new SqliteBillingStore(db).markResolved(SHOP, PERIOD, 's1');
    // A second process on the same database.
    expect(new SqliteBillingStore(db).resolvedCount(SHOP, PERIOD)).toBe(1);
  });

  it('purges billing history on redaction', () => {
    const s = store();
    s.markResolved(SHOP, PERIOD, 's1');
    s.addOverage(SHOP, PERIOD, 6);
    s.purge(SHOP);
    expect(s.resolvedCount(SHOP, PERIOD)).toBe(0);
    expect(s.overageCharged(SHOP, PERIOD)).toBe(0);
    expect(s.get(SHOP).planId).toBe('free');
  });

  it('reports per-period history', () => {
    const s = store();
    s.markResolved(SHOP, '2026-08', 'a');
    s.markResolved(SHOP, '2026-09', 'b');
    s.markResolved(SHOP, '2026-09', 'c');
    const h = s.history(SHOP);
    expect(h[0]).toMatchObject({ period: '2026-09', resolved: 2 });
    expect(h[1]).toMatchObject({ period: '2026-08', resolved: 1 });
  });
});

describe('settle', () => {
  const svc = (s: SqliteBillingStore, doFetch?: typeof globalThis.fetch) =>
    new BillingService({
      store: s,
      apiFor: async () => api,
      ...(doFetch === undefined ? {} : { doFetch }),
    });

  const turn = { sessionId: 's1', grounded: true, handedOff: false, arm: 'exposed' as const };

  it('counts a resolved conversation', async () => {
    const s = store();
    await svc(s).settle(SHOP, turn, T0);
    expect(s.resolvedCount(SHOP, PERIOD)).toBe(1);
  });

  it('counts a long conversation exactly once', async () => {
    const s = store();
    const service = svc(s);
    for (let i = 0; i < 12; i++) await service.settle(SHOP, turn, T0);
    expect(s.resolvedCount(SHOP, PERIOD)).toBe(1);
  });

  it('does not bill for ungrounded or handed-off turns', async () => {
    const s = store();
    const service = svc(s);
    await service.settle(SHOP, { ...turn, grounded: false }, T0);
    await service.settle(SHOP, { ...turn, sessionId: 's2', handedOff: true }, T0);
    await service.settle(SHOP, { ...turn, sessionId: 's3', arm: 'holdout' }, T0);
    expect(s.resolvedCount(SHOP, PERIOD)).toBe(0);
  });

  it('charges Shopify once the allowance is used up', async () => {
    const s = store();
    s.put({
      shop: SHOP, subscriptionId: 'gid://sub/1', planId: 'growth', status: 'active',
      test: true, periodEnd: undefined, trialEndsAt: undefined, usageLineItemId: 'gid://line/9',
    });
    for (let i = 0; i < PLANS.growth.included; i++) s.markResolved(SHOP, PERIOD, `s${i}`);

    const { fn, calls } = fakeFetch({
      data: { appUsageRecordCreate: { appUsageRecord: { id: 'gid://usage/1' }, userErrors: [] } },
    });
    await svc(s, fn).settle(SHOP, { ...turn, sessionId: 'overflow' }, T0);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.variables.price.amount).toBe('0.06');
    // Derived from the session, so a retry cannot double-charge a conversation
    // — and usage records cannot be retracted.
    expect(calls[0]!.body.variables.idempotencyKey).toBe(
      usageIdempotencyKey(SHOP, PERIOD, 'overflow'),
    );
    expect(s.overageCharged(SHOP, PERIOD)).toBe(6);
  });

  it('does not charge inside the allowance', async () => {
    const s = store();
    s.put({
      shop: SHOP, subscriptionId: 'gid://sub/1', planId: 'growth', status: 'active',
      test: true, periodEnd: undefined, trialEndsAt: undefined, usageLineItemId: 'gid://line/9',
    });
    const { fn, calls } = fakeFetch({ data: {} });
    await svc(s, fn).settle(SHOP, turn, T0);
    expect(calls).toHaveLength(0);
  });

  it('never breaks a conversation when billing fails', async () => {
    const s = store();
    s.put({
      shop: SHOP, subscriptionId: 'gid://sub/1', planId: 'growth', status: 'active',
      test: true, periodEnd: undefined, trialEndsAt: undefined, usageLineItemId: 'gid://line/9',
    });
    for (let i = 0; i < PLANS.growth.included; i++) s.markResolved(SHOP, PERIOD, `s${i}`);

    const boom = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;

    // We would rather lose six cents than fail a turn the merchant paid for.
    await expect(svc(s, boom).settle(SHOP, { ...turn, sessionId: 'x' }, T0)).resolves.toBeUndefined();
  });

  it('stops recording overage once Shopify refuses at the cap', async () => {
    const s = store();
    s.put({
      shop: SHOP, subscriptionId: 'gid://sub/1', planId: 'growth', status: 'active',
      test: true, periodEnd: undefined, trialEndsAt: undefined, usageLineItemId: 'gid://line/9',
    });
    for (let i = 0; i < PLANS.growth.included; i++) s.markResolved(SHOP, PERIOD, `s${i}`);

    const { fn } = fakeFetch({
      data: {
        appUsageRecordCreate: {
          appUsageRecord: null,
          userErrors: [{ field: null, message: 'Usage exceeds capped amount' }],
        },
      },
    });
    await svc(s, fn).settle(SHOP, { ...turn, sessionId: 'x' }, T0);
    // A refusal at the cap is an expected outcome, not an error, and must not
    // be recorded as money we collected.
    expect(s.overageCharged(SHOP, PERIOD)).toBe(0);
  });
});

describe('Shopify billing API', () => {
  it('refuses to create a subscription for the free plan', async () => {
    // It would send the merchant to an approval screen to approve nothing.
    await expect(createSubscription(api, PLANS.free)).rejects.toBeInstanceOf(BillingApiError);
  });

  it('sends the test flag, price, trial and capped amount', async () => {
    const { fn, calls } = fakeFetch({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: 'https://shopify.test/confirm',
          appSubscription: { id: 'gid://sub/1', status: 'PENDING' },
          userErrors: [],
        },
      },
    });
    const created = await createSubscription(api, PLANS.growth, 'USD', fn);

    const vars = calls[0]!.body.variables;
    expect(vars.test).toBe(true);
    expect(vars.name).toBe('Growth');
    expect(vars.trialDays).toBe(14);
    expect(vars.lineItems[0].plan.appRecurringPricingDetails.price.amount).toBe('49.00');
    // The cap is what makes a runaway bill impossible: Shopify refuses usage
    // records beyond the amount the merchant approved.
    expect(vars.lineItems[1].plan.appUsagePricingDetails.cappedAmount.amount).toBe(
      (overageCapMinor(PLANS.growth) / 100).toFixed(2),
    );
    // Nothing is charged yet — the merchant must approve.
    expect(created.confirmationUrl).toBe('https://shopify.test/confirm');
    expect(created.status).toBe('pending');
  });

  it('never puts the access token anywhere but the header', async () => {
    const { fn, calls } = fakeFetch({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: 'https://shopify.test/c',
          appSubscription: { id: 'gid://sub/1', status: 'PENDING' },
          userErrors: [],
        },
      },
    });
    await createSubscription(api, PLANS.growth, 'USD', fn);
    expect(calls[0]!.headers['x-shopify-access-token']).toBe('shpat_secret');
    expect(JSON.stringify(calls[0]!.body)).not.toContain('shpat_secret');
    expect(calls[0]!.url).not.toContain('shpat_secret');
  });

  it('surfaces userErrors rather than pretending it worked', async () => {
    const { fn } = fakeFetch({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: null,
          appSubscription: null,
          userErrors: [{ field: ['name'], message: 'Plan not available' }],
        },
      },
    });
    await expect(createSubscription(api, PLANS.growth, 'USD', fn)).rejects.toThrow('Plan not available');
  });

  it('marks 429 and 5xx retryable, 4xx not', async () => {
    const five = fakeFetch({}, 503);
    await expect(createSubscription(api, PLANS.growth, 'USD', five.fn)).rejects.toMatchObject({
      retryable: true,
    });
    const four = fakeFetch({}, 422);
    await expect(createSubscription(api, PLANS.growth, 'USD', four.fn)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('reads back the active subscription and its usage line', async () => {
    const { fn } = fakeFetch({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            {
              id: 'gid://sub/1',
              name: 'Scale',
              status: 'ACTIVE',
              test: false,
              currentPeriodEnd: '2026-10-01T00:00:00Z',
              trialDays: 14,
              lineItems: [
                { id: 'gid://line/1', plan: { pricingDetails: { __typename: 'AppRecurringPricing' } } },
                { id: 'gid://line/2', plan: { pricingDetails: { __typename: 'AppUsagePricing' } } },
              ],
            },
          ],
        },
      },
    });
    const active = await fetchActiveSubscription(api, fn);
    expect(active?.name).toBe('Scale');
    expect(active?.status).toBe('active');
    // The usage line is the only one we may post usage records against.
    expect(active?.usageLineItemId).toBe('gid://line/2');
  });

  it('reports no subscription when Shopify has none', async () => {
    const { fn } = fakeFetch({ data: { currentAppInstallation: { activeSubscriptions: [] } } });
    expect(await fetchActiveSubscription(api, fn)).toBeUndefined();
  });

  it('returns false rather than throwing when usage hits the cap', async () => {
    const { fn } = fakeFetch({
      data: {
        appUsageRecordCreate: {
          appUsageRecord: null,
          userErrors: [{ field: null, message: 'exceeds capped amount' }],
        },
      },
    });
    expect(await recordUsage(api, 'gid://line/2', 6, 'x', 'key', 'USD', fn)).toBe(false);
  });

  it('cancels', async () => {
    const { fn } = fakeFetch({
      data: {
        appSubscriptionCancel: {
          appSubscription: { id: 'gid://sub/1', status: 'CANCELLED' },
          userErrors: [],
        },
      },
    });
    expect(await cancelSubscription(api, 'gid://sub/1', fn)).toBe('cancelled');
  });

  it('maps an unknown status to cancelled, never to active', () => {
    expect(normalizeStatus('ACTIVE')).toBe('active');
    expect(normalizeStatus('FROZEN')).toBe('frozen');
    expect(normalizeStatus('CANCELED')).toBe('cancelled');
    // Granting paid entitlement on a string we cannot interpret is the wrong
    // side to fail on.
    expect(normalizeStatus('SOME_NEW_STATUS')).toBe('cancelled');
  });
});

describe('subscription webhook', () => {
  it('reads the nested app_subscription payload', () => {
    const parsed = parseSubscriptionPayload({
      app_subscription: {
        admin_graphql_api_id: 'gid://shopify/AppSubscription/7',
        name: 'Growth',
        status: 'ACTIVE',
      },
    });
    expect(parsed.subscriptionId).toBe('gid://shopify/AppSubscription/7');
    expect(parsed.name).toBe('Growth');
    expect(parsed.status).toBe('ACTIVE');
  });

  it('tolerates a flat payload', () => {
    const parsed = parseSubscriptionPayload({ id: 12, name: 'Scale', status: 'FROZEN' });
    expect(parsed.subscriptionId).toBe('12');
    expect(parsed.status).toBe('FROZEN');
  });

  it('returns undefined rather than guessing on junk', () => {
    const parsed = parseSubscriptionPayload({});
    expect(parsed.subscriptionId).toBeUndefined();
    expect(parsed.name).toBeUndefined();
  });

  it('applies a cancellation without touching usage counts', async () => {
    const s = store();
    s.put({
      shop: SHOP, subscriptionId: 'gid://sub/1', planId: 'growth', status: 'active',
      test: true, periodEnd: undefined, trialEndsAt: undefined, usageLineItemId: 'gid://line/9',
    });
    s.markResolved(SHOP, PERIOD, 's1');

    const svc = new BillingService({ store: s, apiFor: async () => undefined });
    await svc.applyWebhook(SHOP, {
      subscriptionId: 'gid://sub/1',
      name: 'Growth',
      status: 'CANCELLED',
    });

    expect(s.get(SHOP).status).toBe('cancelled');
    // Usage history is billing evidence and must survive a status change.
    expect(s.resolvedCount(SHOP, PERIOD)).toBe(1);
  });

  it('leaves the plan alone when the name is unrecognised', async () => {
    const s = store();
    s.put({
      shop: SHOP, subscriptionId: 'gid://sub/1', planId: 'scale', status: 'active',
      test: true, periodEnd: undefined, trialEndsAt: undefined, usageLineItemId: undefined,
    });
    const svc = new BillingService({ store: s, apiFor: async () => undefined });
    await svc.applyWebhook(SHOP, {
      subscriptionId: 'gid://sub/1',
      name: 'Enterprise',
      status: 'ACTIVE',
    });
    expect(s.get(SHOP).planId).toBe('scale');
  });

  it('records a freeze so service stops', async () => {
    const s = store();
    const svc = new BillingService({ store: s, apiFor: async () => undefined });
    await svc.applyWebhook(SHOP, { subscriptionId: 'gid://sub/1', name: 'Plus', status: 'FROZEN' });
    expect(svc.check(SHOP, T0).allowed).toBe(false);
    expect(svc.check(SHOP, T0).verdict).toBe('frozen');
  });
});
