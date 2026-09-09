import { overageCapMinor, type Plan } from '@storeagent/billing';
import type { SubscriptionStatus } from '@storeagent/billing';

/**
 * Shopify Billing API.
 *
 * Recurring charges cannot be created silently: `appSubscriptionCreate` returns
 * a `confirmationUrl` and nothing is charged until the merchant approves it on
 * Shopify's own screen. So this module never "charges" anyone — it *proposes* a
 * charge and reports the outcome.
 *
 * ## The `test` flag is the dangerous one
 *
 * `test: true` produces a subscription that behaves identically in every
 * respect except that no money moves. The two ways to get it wrong are not
 * symmetric:
 *
 *   left true in production   → merchants "subscribe" and we are never paid,
 *                               and nothing anywhere looks broken
 *   set false while testing   → real charges against a real card
 *
 * Both are silent. So it is never inferred: `loadConfig` requires an explicit
 * choice in production and the value is logged at startup. See `config.ts`.
 */

const API_VERSION = '2026-07';

export interface BillingApiConfig {
  readonly shop: string;
  readonly accessToken: string;
  /** Where Shopify returns the merchant after they approve or decline. */
  readonly returnUrl: string;
  readonly test: boolean;
}

export class BillingApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /**
     * Shopify rejected the access token itself.
     *
     * Distinct from `retryable` because retrying with the same token is
     * pointless — the caller has to get a NEW token. A stored token stops
     * working whenever the app is reinstalled or its scopes change, and
     * without this flag that is indistinguishable from any other 4xx, so the
     * app sits wedged on a dead token forever.
     */
    readonly unauthorized: boolean = false,
  ) {
    super(message);
    this.name = 'BillingApiError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * Shopify's explanation for a refusal, made safe to log.
 *
 * Truncated because an error string ends up in logs and alerts, and redacted
 * because a body echoed back into an exception is exactly where a credential
 * leaks without anyone deciding it should.
 */
async function safeDetail(res: Response): Promise<string> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    return 'no body';
  }
  return (
    body
      .replace(/sh[a-z]at_[A-Za-z0-9_-]+/gi, '[redacted]')
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]')
      .slice(0, 300)
      .trim() || 'empty body'
  );
}

export async function graphql<T>(
  cfg: BillingApiConfig,
  query: string,
  variables: Record<string, unknown>,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> {
  const res = await doFetch(`https://${cfg.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Never logged, never echoed in an error.
      'x-shopify-access-token': cfg.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 || res.status >= 500) {
    throw new BillingApiError(`Shopify billing API unavailable (${res.status})`, true);
  }
  if (res.status === 401 || res.status === 403) {
    // The token is dead, not the request. Says so, so the caller can mint a
    // fresh one instead of failing every call from here on.
    //
    // 401 and 403 are NOT the same problem and the distinction is the whole
    // diagnosis: 401 means the token is not valid, 403 means it is valid and
    // the app is not permitted to do this. Only 401 is worth re-minting for —
    // a fresh token has exactly the same permissions as the one it replaced,
    // so re-minting on 403 just burns an exchange and reports the same error.
    //
    // Shopify says which in the body ("This action requires merchant approval
    // for the read_orders scope"). Reporting only the status threw that away
    // and left the cause to guesswork, so it is included — truncated, and with
    // anything token-shaped stripped, because an error string travels further
    // than the request that produced it.
    throw new BillingApiError(
      `Shopify rejected the access token (${res.status}): ${await safeDetail(res)}`,
      false,
      res.status === 401,
    );
  }
  if (!res.ok) {
    // The body can echo request detail; report the status only.
    throw new BillingApiError(`Shopify billing API rejected the request (${res.status})`, false);
  }

  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors && body.errors.length > 0) {
    throw new BillingApiError(body.errors.map((e) => e.message).join('; '), false);
  }
  if (body.data === undefined) throw new BillingApiError('empty response', false);
  return body.data;
}

// ---------------------------------------------------------------------------

const CREATE = `
mutation Create($name: String!, $returnUrl: URL!, $test: Boolean!, $trialDays: Int!,
                $lineItems: [AppSubscriptionLineItemInput!]!) {
  appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test,
                        trialDays: $trialDays, lineItems: $lineItems) {
    confirmationUrl
    appSubscription { id status }
    userErrors { field message }
  }
}`;

export interface CreatedSubscription {
  /** Send the merchant here. Nothing is charged until they approve. */
  readonly confirmationUrl: string;
  readonly subscriptionId: string;
  readonly status: SubscriptionStatus;
}

/**
 * Propose a subscription.
 *
 * Two line items where the plan supports overage: a flat recurring price, and a
 * usage line carrying the spending cap. Shopify requires the cap to be approved
 * up front and then refuses usage records that would exceed it — which is
 * precisely the property that makes a runaway bill impossible.
 */
export async function createSubscription(
  cfg: BillingApiConfig,
  plan: Plan,
  currency = 'USD',
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CreatedSubscription> {
  if (plan.priceMinor === 0 && plan.overageMinor === null) {
    // The free plan is the absence of a subscription. Creating a zero-value
    // one would send the merchant to an approval screen to approve nothing.
    throw new BillingApiError('the free plan does not require a subscription', false);
  }

  const lineItems: unknown[] = [
    {
      plan: {
        appRecurringPricingDetails: {
          price: { amount: (plan.priceMinor / 100).toFixed(2), currencyCode: currency },
          interval: 'EVERY_30_DAYS',
        },
      },
    },
  ];

  if (plan.overageMinor !== null) {
    lineItems.push({
      plan: {
        appUsagePricingDetails: {
          cappedAmount: { amount: (overageCapMinor(plan) / 100).toFixed(2), currencyCode: currency },
          terms: `$${(plan.overageMinor / 100).toFixed(2)} per resolved conversation beyond the ${plan.included} included`,
        },
      },
    });
  }

  const data = await graphql<{
    appSubscriptionCreate: {
      confirmationUrl: string | null;
      appSubscription: { id: string; status: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    cfg,
    CREATE,
    {
      name: plan.name,
      returnUrl: cfg.returnUrl,
      test: cfg.test,
      trialDays: plan.trialDays,
      lineItems,
    },
    doFetch,
  );

  const result = data.appSubscriptionCreate;
  if (result.userErrors.length > 0) {
    throw new BillingApiError(result.userErrors.map((e) => e.message).join('; '), false);
  }
  if (result.confirmationUrl === null || result.appSubscription === null) {
    throw new BillingApiError('Shopify returned no confirmation URL', false);
  }

  return {
    confirmationUrl: result.confirmationUrl,
    subscriptionId: result.appSubscription.id,
    status: normalizeStatus(result.appSubscription.status),
  };
}

const ACTIVE = `
query Active {
  currentAppInstallation {
    activeSubscriptions {
      id name status test currentPeriodEnd trialDays
      lineItems {
        id
        plan {
          pricingDetails {
            __typename
            # The recurring amount is what identifies the plan when the name
            # was chosen in the Partner dashboard rather than sent by us.
            ... on AppRecurringPricing { price { amount currencyCode } }
          }
        }
      }
    }
  }
}`;

export interface ActiveSubscription {
  readonly id: string;
  readonly name: string;
  readonly status: SubscriptionStatus;
  readonly test: boolean;
  readonly currentPeriodEnd: number | undefined;
  /** Line item id for usage records; absent when the plan has no usage line. */
  readonly usageLineItemId?: string;
  /**
   * The recurring price in cents, as Shopify reports it. Absent when the
   * subscription carries no recurring line. Used to identify the plan when the
   * subscription name was set in the Partner dashboard and does not match ours.
   */
  readonly recurringPriceMinor?: number;
}

/**
 * Read the subscription Shopify believes is active.
 *
 * Shopify is the authority, not our database. Webhooks can be missed and local
 * state drifts; this is how it gets reconciled, and it is what the admin page
 * reads rather than trusting a cached row.
 */
export async function fetchActiveSubscription(
  cfg: BillingApiConfig,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ActiveSubscription | undefined> {
  const data = await graphql<{
    currentAppInstallation: {
      activeSubscriptions: {
        id: string;
        name: string;
        status: string;
        test: boolean;
        currentPeriodEnd: string | null;
        trialDays: number | null;
        lineItems: {
          id: string;
          plan: {
            pricingDetails: {
              __typename: string;
              price?: { amount: string; currencyCode: string } | null;
            };
          };
        }[];
      }[];
    } | null;
  }>(cfg, ACTIVE, {}, doFetch);

  const sub = data.currentAppInstallation?.activeSubscriptions?.[0];
  if (sub === undefined) return undefined;

  const usageLine = sub.lineItems.find(
    (li) => li.plan.pricingDetails.__typename === 'AppUsagePricing',
  );
  const recurringLine = sub.lineItems.find(
    (li) => li.plan.pricingDetails.__typename === 'AppRecurringPricing',
  );
  const periodEnd = sub.currentPeriodEnd === null ? NaN : Date.parse(sub.currentPeriodEnd);

  // Shopify returns money as a decimal string ("599.00"). Round rather than
  // truncate: 0.1 + 0.2 arithmetic on a parsed float can land at 59899.999…,
  // and a cent lost here would stop the price from identifying the plan.
  const amount = Number(recurringLine?.plan.pricingDetails.price?.amount);
  const recurringPriceMinor = Number.isFinite(amount) ? Math.round(amount * 100) : undefined;

  return {
    id: sub.id,
    name: sub.name,
    status: normalizeStatus(sub.status),
    test: sub.test,
    currentPeriodEnd: Number.isFinite(periodEnd) ? periodEnd : undefined,
    ...(usageLine === undefined ? {} : { usageLineItemId: usageLine.id }),
    ...(recurringPriceMinor === undefined ? {} : { recurringPriceMinor }),
  };
}

const USAGE = `
mutation Usage($subscriptionLineItemId: ID!, $description: String!, $price: MoneyInput!,
               $idempotencyKey: String!) {
  appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, description: $description,
                       price: $price, idempotencyKey: $idempotencyKey) {
    appUsageRecord { id }
    userErrors { field message }
  }
}`;

/**
 * Record an overage charge.
 *
 * `idempotencyKey` is load-bearing, not decorative. A retry after a timeout
 * would otherwise double-charge a merchant for one conversation, and a usage
 * record cannot be retracted once created. The key is derived from the shop,
 * period and session, so the same conversation can never be billed twice
 * however many times this is called.
 *
 * Returns `false` when Shopify refuses because the approved cap is reached —
 * that is an expected outcome, not an error, and the caller stops serving
 * overage rather than treating it as a failure.
 */
export async function recordUsage(
  cfg: BillingApiConfig,
  lineItemId: string,
  amountMinor: number,
  description: string,
  idempotencyKey: string,
  currency = 'USD',
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  const data = await graphql<{
    appUsageRecordCreate: {
      appUsageRecord: { id: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    cfg,
    USAGE,
    {
      subscriptionLineItemId: lineItemId,
      description,
      price: { amount: (amountMinor / 100).toFixed(2), currencyCode: currency },
      idempotencyKey,
    },
    doFetch,
  );

  const result = data.appUsageRecordCreate;
  if (result.userErrors.length > 0) {
    const message = result.userErrors.map((e) => e.message).join('; ');
    if (/cap|exceed|limit/i.test(message)) return false;
    throw new BillingApiError(message, false);
  }
  return result.appUsageRecord !== null;
}

const CANCEL = `
mutation Cancel($id: ID!) {
  appSubscriptionCancel(id: $id) {
    appSubscription { id status }
    userErrors { field message }
  }
}`;

export async function cancelSubscription(
  cfg: BillingApiConfig,
  subscriptionId: string,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<SubscriptionStatus> {
  const data = await graphql<{
    appSubscriptionCancel: {
      appSubscription: { id: string; status: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(cfg, CANCEL, { id: subscriptionId }, doFetch);

  const result = data.appSubscriptionCancel;
  if (result.userErrors.length > 0) {
    throw new BillingApiError(result.userErrors.map((e) => e.message).join('; '), false);
  }
  return normalizeStatus(result.appSubscription?.status ?? 'CANCELLED');
}

/**
 * Map Shopify's status enum to ours.
 *
 * An unknown value maps to `cancelled` rather than `active`: if Shopify adds a
 * status we do not recognise, granting paid entitlement on the strength of a
 * string we cannot interpret is the wrong side to fail on.
 */
export function normalizeStatus(raw: string): SubscriptionStatus {
  switch (raw.toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'PENDING':
      return 'pending';
    case 'DECLINED':
      return 'declined';
    case 'EXPIRED':
      return 'expired';
    case 'FROZEN':
      return 'frozen';
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'cancelled';
  }
}

/** Stable per-conversation key, so a retry can never double-charge. */
export function usageIdempotencyKey(shop: string, period: string, sessionId: string): string {
  return `${shop}:${period}:${sessionId}`;
}
