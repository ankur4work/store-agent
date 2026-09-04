import { Registry, type Histogram } from './metrics.js';

/**
 * What we measure, and why each one exists.
 *
 * Not a generic dashboard. Every metric here answers a question the product
 * makes a promise about, and the two SLO thresholds from `ARCHITECTURE §12`
 * appear verbatim as bucket edges so the gates are answerable exactly:
 *
 *     p50 TTFT < 400 ms        → TTFT_BUCKETS contains 400
 *     validator failure < 1%   → a ratio of two counters, no bucketing needed
 *
 * Before this existed, neither gate could be checked in production at all. A
 * grounding regression — the one failure that destroys the product's entire
 * claim — would have been invisible until a merchant noticed a wrong price.
 */

/**
 * Time-to-first-token buckets.
 *
 * 400 is the §12 gate. 44 is the product-card promise from `UX-PERFORMANCE`.
 * The rest fill in enough shape to see a regression's direction.
 */
export const TTFT_BUCKETS = [44, 100, 200, 300, 400, 600, 900, 1_500, 3_000, 6_000, Infinity];

/** Whole-turn duration. Long tail matters more here than precision. */
export const TURN_BUCKETS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, Infinity];

/** Upstream calls: UCP catalog, model, STT/TTS. */
export const UPSTREAM_BUCKETS = [25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, Infinity];

export class Telemetry {
  readonly registry = new Registry();

  // --- the product's core claim ------------------------------------------

  /**
   * Turns that produced a reply, split by whether grounding passed.
   *
   * The §12 gate is `validator failure < 1%`, which is
   * `turns_grounded{ok="false"} / turns_grounded`. This is the single most
   * important number in the system: it is the difference between "never
   * wrong" being a product and being a slogan.
   */
  readonly turns = this.registry.counter(
    'storeagent_turns_total',
    'Completed turns, labelled by shop and grounding outcome',
  );

  /**
   * Mid-stream tripwire aborts.
   *
   * Distinct from a failed validation: this is the validator catching a bad
   * claim *while it is being written* and retracting it before the shopper
   * reads it. A rising number here is the safety net working — and also a
   * signal that generation quality has slipped.
   */
  readonly tripwireAborts = this.registry.counter(
    'storeagent_tripwire_aborts_total',
    'Replies retracted mid-stream by the grounding tripwire',
  );

  readonly escalations = this.registry.counter(
    'storeagent_escalations_total',
    'Turns escalated to a human or lead capture',
  );

  // --- latency ------------------------------------------------------------

  readonly ttft: Histogram = this.registry.histogram(
    'storeagent_ttft_ms',
    'Milliseconds from request to first reply token',
    TTFT_BUCKETS,
  );

  readonly turnDuration: Histogram = this.registry.histogram(
    'storeagent_turn_ms',
    'Milliseconds for a complete turn',
    TURN_BUCKETS,
  );

  readonly upstream: Histogram = this.registry.histogram(
    'storeagent_upstream_ms',
    'Milliseconds for an upstream call, labelled by target',
    UPSTREAM_BUCKETS,
  );

  // --- money --------------------------------------------------------------

  /**
   * Model tokens, split by direction.
   *
   * Cached input tokens are counted separately because the prompt-caching
   * strategy in §7 is the difference between a viable margin and an unviable
   * one. If the cache hit rate silently degrades, this is where it shows —
   * long before the invoice does.
   */
  readonly tokens = this.registry.counter(
    'storeagent_model_tokens_total',
    'Model tokens, labelled by shop and kind (input/output/cached)',
  );

  readonly billableConversations = this.registry.counter(
    'storeagent_billable_conversations_total',
    'Conversations counted as resolved for billing',
  );

  // --- the request layer --------------------------------------------------

  readonly requests = this.registry.counter(
    'storeagent_requests_total',
    'HTTP requests, labelled by route and status class',
  );

  readonly rateLimited = this.registry.counter(
    'storeagent_rate_limited_total',
    'Requests refused by the rate limiter, labelled by reason',
  );

  readonly errors = this.registry.counter(
    'storeagent_errors_total',
    'Errors, labelled by kind. Never contains a message or any shopper input',
  );

  // --- process ------------------------------------------------------------

  readonly sessions = this.registry.gauge('storeagent_active_sessions', 'Sessions within TTL');
  readonly installs = this.registry.gauge('storeagent_installed_shops', 'Installed shops');
  readonly uptime = this.registry.gauge('storeagent_uptime_seconds', 'Process uptime');
  readonly rss = this.registry.gauge('storeagent_memory_rss_bytes', 'Resident set size');
  readonly trackedClients = this.registry.gauge(
    'storeagent_rate_limit_clients',
    'Client entries held by the rate limiter',
  );

  /** Refresh process gauges. Called on scrape rather than on a timer. */
  sample(now: number, startedAt: number): void {
    this.uptime.set(Math.round((now - startedAt) / 1000));
    this.rss.set(process.memoryUsage().rss);
  }

  render(): string {
    return this.registry.render();
  }

  /**
   * The §12 gates, evaluated.
   *
   * Returned as `pass | fail | unknown` rather than a bare number, because
   * "no data yet" and "failing" must not look the same on a dashboard — that
   * confusion is how a broken pipeline gets read as a healthy system.
   */
  gates(): {
    groundingFailureRate: number | undefined;
    groundingGate: Gate;
    ttftUnder400: number | undefined;
    ttftGate: Gate;
    turns: number;
  } {
    const total = this.turns.total();
    // Across every shop: the gate is a property of the system, not of one
    // merchant. Per-shop breakdown is still available in the raw metric.
    const failed = this.turns.sumWhere({ ok: 'false' });
    const failureRate = total === 0 ? undefined : failed / total;

    const under400 = this.ttft.fractionAtOrBelow(400);

    return {
      groundingFailureRate: failureRate,
      groundingGate: gateFor(failureRate, (r) => r < 0.01, total),
      ttftUnder400: under400,
      // p50 < 400ms means at least half of turns are under 400ms — which is
      // exactly the bucket fraction, so this gate is exact.
      ttftGate: gateFor(under400, (r) => r >= 0.5, this.ttft.count()),
      turns: total,
    };
  }
}

export type Gate = 'pass' | 'fail' | 'unknown';

function gateFor(
  value: number | undefined,
  predicate: (v: number) => boolean,
  sampleCount: number,
): Gate {
  // A gate declared from a handful of turns is noise wearing a verdict's
  // clothes. Below the floor it stays honest and says it does not know.
  if (value === undefined || sampleCount < 100) return 'unknown';
  return predicate(value) ? 'pass' : 'fail';
}
