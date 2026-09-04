/**
 * Token bucket.
 *
 * Chosen over a fixed window because retail conversation is bursty in a way
 * that is completely legitimate: a shopper sends "do you have this in medium",
 * then "what about blue", then "how long is shipping" in ten seconds. A fixed
 * window of 3/minute blocks the third message; a bucket with burst 5 and a slow
 * refill allows the flurry and still caps the sustained rate.
 *
 * It also degrades better under attack. A fixed window lets an attacker send a
 * full window's worth at 59.9s and again at 60.1s — double the intended rate at
 * the boundary. A bucket has no boundary to exploit.
 */

export interface BucketDecision {
  readonly allowed: boolean;
  /** Whole seconds until the next token, for the `Retry-After` header. */
  readonly retryAfterSec: number;
  readonly remaining: number;
}

export interface BucketPolicy {
  /** Maximum tokens — the burst allowance. */
  readonly burst: number;
  /** Sustained rate. */
  readonly refillPerMin: number;
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly policy: BucketPolicy,
    now: number,
  ) {
    this.tokens = policy.burst;
    this.updatedAt = now;
  }

  /** True when the bucket is indistinguishable from a brand new one. */
  isFull(now: number): boolean {
    return this.peek(now) >= this.policy.burst;
  }

  /** Tokens available now, without consuming. */
  peek(now: number): number {
    const elapsedMin = Math.max(0, now - this.updatedAt) / 60_000;
    return Math.min(this.policy.burst, this.tokens + elapsedMin * this.policy.refillPerMin);
  }

  /**
   * Try to spend `cost` tokens.
   *
   * `cost` exists because endpoints are not equally expensive: a chat turn
   * costs model tokens, while a config fetch costs almost nothing. Charging
   * them the same either throttles cheap traffic pointlessly or lets expensive
   * traffic through freely.
   */
  consume(now: number, cost = 1): BucketDecision {
    this.tokens = this.peek(now);
    this.updatedAt = now;

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, retryAfterSec: 0, remaining: Math.floor(this.tokens) };
    }

    // Do NOT deduct on rejection. Charging for refused requests means a client
    // that keeps retrying never recovers, turning a brief burst into an
    // indefinite lockout.
    const deficit = cost - this.tokens;
    const waitMin = deficit / this.policy.refillPerMin;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(waitMin * 60)),
      remaining: 0,
    };
  }
}

/**
 * A bounded collection of buckets.
 *
 * Bounded deliberately. A `Map` keyed by client IP grows without limit under
 * exactly the attack this code exists to stop, so the naive rate limiter is
 * itself a memory-exhaustion vector.
 *
 * Eviction order is a security decision, not a performance one. Evicting an
 * arbitrary entry would let an attacker reset their own throttle by flooding
 * the map with junk keys. So we evict the *fullest* buckets first: a full
 * bucket is by definition identical to a fresh one, so dropping it grants no
 * advantage, and the most-throttled keys are retained longest.
 */
export class BucketStore {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly policy: BucketPolicy,
    private readonly maxKeys = 50_000,
  ) {}

  consume(key: string, now: number, cost = 1): BucketDecision {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      bucket = new TokenBucket(this.policy, now);
      this.buckets.set(key, bucket);
    }
    return bucket.consume(now, cost);
  }

  /** Drop idle buckets. Call on an interval. */
  sweep(now: number): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull(now)) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }

  private evict(now: number): void {
    const sweptEnough = this.sweep(now) > 0;
    if (sweptEnough) return;

    // Nothing idle: every bucket is under active use. Drop the one with the
    // most tokens left, i.e. the least throttled, so an attacker cannot
    // displace their own throttled entry.
    let fullestKey: string | undefined;
    let fullestTokens = -1;
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.peek(now);
      if (tokens > fullestTokens) {
        fullestTokens = tokens;
        fullestKey = key;
      }
    }
    if (fullestKey !== undefined) this.buckets.delete(fullestKey);
  }
}
