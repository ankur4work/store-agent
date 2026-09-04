import { verifyWebhookHmac } from './hmac.js';
import { parseShopDomain } from './domain.js';
import type { ShopStore } from './shops.js';

/**
 * Webhook handling.
 *
 * The three `customers/*` and `shop/redact` topics are MANDATORY for Shopify
 * app review — an app that does not respond correctly to them is rejected, and
 * mishandling them is a data-protection problem regardless of review.
 *
 * Every webhook is HMAC-verified against the RAW body before anything else.
 * An unverified webhook endpoint is an unauthenticated write endpoint.
 */

export type WebhookTopic =
  | 'app/uninstalled'
  | 'shop/redact'
  | 'customers/redact'
  | 'customers/data_request'
  | 'orders/create'
  | 'app_subscriptions/update'
  | string;

export interface WebhookRequest {
  readonly topic: WebhookTopic;
  readonly shopHeader: string | undefined;
  readonly hmacHeader: string | undefined;
  readonly rawBody: Buffer;
}

export interface WebhookDeps {
  readonly apiSecret: string;
  readonly shops: ShopStore;
  /** Called for orders/create — attribution reconciliation (Phase 2). */
  readonly onOrder?: (shop: string, payload: unknown) => Promise<void> | void;
  /** Called for app_subscriptions/update — billing state (Phase 5). */
  readonly onSubscription?: (shop: string, payload: unknown) => Promise<void> | void;
  /** Called for app/uninstalled and shop/redact, so billing state goes too. */
  readonly onPurge?: (shop: string) => Promise<void> | void;
  readonly log?: (line: string) => void;
}

export interface WebhookOutcome {
  readonly status: number;
  readonly body: unknown;
}

export async function handleWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<WebhookOutcome> {
  if (!verifyWebhookHmac(req.rawBody, req.hmacHeader, deps.apiSecret)) {
    // 401 with no detail. Telling a caller *why* verification failed helps
    // them forge the next one.
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const parsed = parseShopDomain(req.shopHeader);
  if (!parsed.ok) return { status: 400, body: { error: 'invalid shop domain' } };
  const shop = parsed.shop!;

  let payload: unknown = {};
  try {
    payload = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  switch (req.topic) {
    case 'app/uninstalled':
      // Shopify has already revoked the token; keeping it is pointless and a
      // liability. Mark uninstalled so nothing tries to use it.
      await deps.shops.markUninstalled(shop);
      deps.log?.(`[webhook] ${shop} uninstalled`);
      return { status: 200, body: { ok: true } };

    case 'shop/redact':
      // Sent 48h after uninstall. Everything for this shop must be destroyed —
      // including billing history, which lives outside ShopStore.
      await deps.shops.purge(shop);
      await deps.onPurge?.(shop);
      deps.log?.(`[webhook] ${shop} redacted`);
      return { status: 200, body: { ok: true } };

    case 'customers/redact':
      // We store no customer PII today: conversations are keyed by an anonymous
      // session id, and carts live in Shopify. Nothing to erase — but the
      // endpoint must still exist and return 200, and this branch is where the
      // deletion goes the moment email capture ships (Phase 2).
      deps.log?.(`[webhook] ${shop} customers/redact — no stored PII`);
      return { status: 200, body: { ok: true } };

    case 'customers/data_request':
      // Same: nothing to hand over yet. Must still acknowledge.
      deps.log?.(`[webhook] ${shop} customers/data_request — no stored PII`);
      return { status: 200, body: { ok: true } };

    case 'orders/create':
      await deps.onOrder?.(shop, payload);
      return { status: 200, body: { ok: true } };

    case 'app_subscriptions/update':
      // Shopify is the authority on subscription state, and this is how we
      // hear about a merchant approving, declining, cancelling, or being
      // frozen for non-payment. Without it, local state drifts silently: we
      // would keep serving a cancelled shop, or keep a frozen one blocked
      // after they pay.
      await deps.onSubscription?.(shop, payload);
      return { status: 200, body: { ok: true } };

    default:
      // Unknown topics get a 200. A non-2xx makes Shopify retry and eventually
      // disable the subscription for a topic we simply do not handle yet.
      deps.log?.(`[webhook] ${shop} unhandled topic ${req.topic}`);
      return { status: 200, body: { ok: true } };
  }
}

/** Topics we register at install time. The GDPR three are mandatory. */
export const REQUIRED_TOPICS: readonly WebhookTopic[] = [
  'app/uninstalled',
  'shop/redact',
  'customers/redact',
  'customers/data_request',
  // Not mandated by review, but billing state is wrong without it.
  'app_subscriptions/update',
];

/**
 * Pull subscription state out of an `app_subscriptions/update` payload.
 *
 * Shopify nests it under `app_subscription`. The admin GraphQL id is the join
 * key back to the subscription we created.
 */
export function parseSubscriptionPayload(payload: unknown): {
  subscriptionId: string | undefined;
  name: string | undefined;
  status: string | undefined;
} {
  const root = (payload ?? {}) as Record<string, unknown>;
  const sub = (root['app_subscription'] ?? root) as Record<string, unknown>;
  const id = sub['admin_graphql_api_id'] ?? sub['id'];
  const name = sub['name'];
  const status = sub['status'];
  return {
    subscriptionId: id === undefined || id === null ? undefined : String(id),
    name: typeof name === 'string' ? name : undefined,
    status: typeof status === 'string' ? status : undefined,
  };
}
