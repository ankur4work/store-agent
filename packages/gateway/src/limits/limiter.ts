import type { IncomingMessage } from 'node:http';
import { BucketStore, type BucketPolicy } from './bucket.js';
import { clientKey } from './client-ip.js';
import { dayKey, MemorySpendStore, type SpendStore } from './budget.js';

/**
 * Request admission control.
 *
 * Two independent controls, because they stop different things:
 *
 *   token bucket per client   — one script hammering the gateway
 *   daily unit ceiling        — distributed low-rate traffic that never trips
 *                               a per-client limit but runs up a bill all day
 *
 * Neither subsumes the other. The bucket bounds the *rate*; only the ceiling
 * bounds the *total*.
 *
 * ## Why there is no per-session limit
 *
 * The obvious third layer would be per-session, and it is worthless here: the
 * session id is supplied by the client. An attacker generates a fresh one per
 * request for free, so a session limit constrains only a well-behaved widget —
 * exactly the traffic we do not need to constrain. Client IP is the cheapest
 * identifier an attacker cannot mint at will, so that is what we key on.
 */

export type LimitReason = 'ip' | 'shop_daily' | 'global_daily';

export interface LimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSec: number;
  readonly reason?: LimitReason;
}

const ALLOW: LimitDecision = { allowed: true, retryAfterSec: 0 };

export interface RouteCost {
  /** Bucket tokens charged. Reflects load, not money. */
  readonly tokens: number;
  /**
   * Units charged against the daily ceiling. Non-zero only for routes that
   * actually spend money upstream — everything else is free to serve.
   */
  readonly units: number;
}

/**
 * Per-route cost.
 *
 * Costs differ by an order of magnitude, so charging every route the same
 * either throttles a free config fetch pointlessly or lets a model call
 * through as if it were free.
 */
const ROUTE_COSTS: readonly (readonly [RegExp, RouteCost])[] = [
  // Model tokens. The expensive one, and the reason this file exists.
  [/^\/api\/chat$/, { tokens: 5, units: 1 }],
  // Speech-to-text: an upload plus an inference call.
  [/^\/api\/voice\/transcribe$/, { tokens: 5, units: 1 }],
  [/^\/api\/voice\/speak$/, { tokens: 3, units: 0.5 }],
  // Cheap to serve, but an exposure flood inflates the experiment's
  // denominator and quietly ruins the incrementality maths, so it is not free.
  [/^\/api\/exposure$/, { tokens: 2, units: 0 }],
  [/^\/api\/pixel$/, { tokens: 2, units: 0 }],
  [/^\/api\/config$/, { tokens: 1, units: 0 }],
  // OAuth start: cheap, but no reason to allow a flood of install attempts.
  [/^\/shopify\/auth/, { tokens: 3, units: 0 }],
  [/^\/admin/, { tokens: 2, units: 0 }],
];

const DEFAULT_COST: RouteCost = { tokens: 1, units: 0 };

/**
 * Routes that must never be throttled.
 *
 * `/healthz` — the container healthcheck polls it. A 429 here reads as
 * "unhealthy" and the orchestrator kills a container that is working fine,
 * turning a rate limit into an outage.
 *
 * `/shopify/webhooks` — `orders/create` is the server-side truth for revenue
 * attribution. Shopify does retry, but dropping order webhooks corrupts the
 * numbers the whole product is sold on. They are HMAC-verified and cheap to
 * serve, so the bucket buys us nothing here.
 *
 * `/metrics`, `/api/slo` — **monitoring must not be the first casualty of the
 * incident it exists to show you.** A scraper polls on a fixed interval from
 * one address; under an attack that same address is also serving the flood, so
 * a shared bucket blacks out the dashboard exactly when it is needed. Found by
 * `scripts/check-observability.mjs`, where a synthetic flood throttled the
 * scrape that was measuring it. Both routes require a bearer token, so
 * exempting them opens nothing.
 */
const EXEMPT = /^\/healthz$|^\/shopify\/webhooks$|^\/metrics$|^\/api\/slo$/;

export interface RateLimitOptions {
  readonly enabled: boolean;
  readonly trustProxyHops: number;
  readonly perIp: BucketPolicy;
  /** Daily unit ceiling per shop. */
  readonly shopDailyUnits: number;
  /** Daily unit ceiling across the whole deployment — the backstop. */
  readonly globalDailyUnits: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitOptions = {
  enabled: true,
  // Safe default: ignore X-Forwarded-For entirely. See client-ip.ts.
  trustProxyHops: 0,
  // 60 burst, 60/min refill. A chat turn costs 5, so a shopper gets a burst of
  // 12 messages and 12/minute sustained — far above real conversation, and far
  // below what a script needs to be worth running.
  perIp: { burst: 60, refillPerMin: 60 },
  shopDailyUnits: 5_000,
  globalDailyUnits: 50_000,
};

export function costFor(pathname: string): RouteCost {
  for (const [pattern, cost] of ROUTE_COSTS) if (pattern.test(pathname)) return cost;
  return DEFAULT_COST;
}

export function isExempt(pathname: string): boolean {
  return EXEMPT.test(pathname);
}

export class RateLimiter {
  private readonly buckets: BucketStore;

  constructor(
    private readonly opts: RateLimitOptions = DEFAULT_RATE_LIMITS,
    private readonly spend: SpendStore = new MemorySpendStore(),
  ) {
    this.buckets = new BucketStore(opts.perIp);
  }

  /**
   * Decide whether to admit a request.
   *
   * `shop` is optional because it is not always known at dispatch time; when
   * absent only the global ceiling applies.
   */
  check(
    req: IncomingMessage,
    pathname: string,
    shop: string | undefined,
    now: number = Date.now(),
  ): LimitDecision {
    if (!this.opts.enabled || isExempt(pathname)) return ALLOW;

    const cost = costFor(pathname);
    const key = clientKey(req, { trustProxyHops: this.opts.trustProxyHops });

    const bucket = this.buckets.consume(key, now, cost.tokens);
    if (!bucket.allowed) {
      return { allowed: false, retryAfterSec: bucket.retryAfterSec, reason: 'ip' };
    }

    if (cost.units <= 0) return ALLOW;

    // Ceilings are checked BEFORE charging, so a request that would exceed the
    // cap is refused rather than allowed-and-then-recorded.
    const day = dayKey(now);
    const secondsToMidnight = Math.ceil((Date.parse(`${day}T23:59:59.999Z`) - now) / 1000);
    const retryAfterSec = Math.max(1, secondsToMidnight);

    if (this.spend.total('global', day) + cost.units > this.opts.globalDailyUnits) {
      return { allowed: false, retryAfterSec, reason: 'global_daily' };
    }
    if (shop !== undefined && this.spend.total(`shop:${shop}`, day) + cost.units > this.opts.shopDailyUnits) {
      return { allowed: false, retryAfterSec, reason: 'shop_daily' };
    }

    this.spend.add('global', day, cost.units);
    if (shop !== undefined) this.spend.add(`shop:${shop}`, day, cost.units);
    return ALLOW;
  }

  /** Reclaim idle buckets. Call on an interval. */
  sweep(now: number = Date.now()): number {
    return this.buckets.sweep(now);
  }

  /** For `/healthz` and tests. */
  get trackedClients(): number {
    return this.buckets.size;
  }

  usage(shop: string | undefined, now: number = Date.now()): { shop: number; global: number } {
    const day = dayKey(now);
    return {
      shop: shop === undefined ? 0 : this.spend.total(`shop:${shop}`, day),
      global: this.spend.total('global', day),
    };
  }
}
