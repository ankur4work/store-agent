/**
 * Per-merchant circuit breaker.
 *
 * `ARCHITECTURE §8`: *"a merchant with a broken storefront shouldn't consume
 * orchestrator threads."*
 *
 * The failure this prevents is specific and easy to miss. A merchant's
 * storefront starts timing out. Every turn for that shop now waits the full
 * upstream timeout before failing. Those turns hold connections and worker
 * time, so the *other* merchants' turns queue behind them — one broken
 * storefront degrades everybody. Retrying makes it worse, because the retries
 * are additional slow calls against something already unhealthy.
 *
 * The breaker converts a slow failure into a fast one. After enough failures
 * it stops calling and fails immediately, which frees the capacity and gives
 * the struggling upstream room to recover.
 *
 * Keyed per merchant, deliberately: one broken storefront must not trip the
 * breaker for the other 4,999.
 */

export type BreakerState =
  /** Calls flow normally. */
  | 'closed'
  /** Failing fast. Not calling upstream at all. */
  | 'open'
  /** One probe allowed through to see whether it recovered. */
  | 'half_open';

export interface BreakerPolicy {
  /** Consecutive failures before opening. */
  readonly threshold: number;
  /** How long to stay open before probing. */
  readonly resetAfterMs: number;
  /** Consecutive probe successes needed to close again. */
  readonly successesToClose: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = {
  // Low enough to protect capacity quickly, high enough that a single blip
  // does not disable a working storefront.
  threshold: 5,
  resetAfterMs: 30_000,
  // More than one, because a single success can be luck — and flapping
  // between open and closed is worse than either state.
  successesToClose: 2,
};

interface Entry {
  state: BreakerState;
  failures: number;
  successes: number;
  openedAt: number;
  lastUsedAt: number;
  /** True while a half-open probe is in flight, so only one is admitted. */
  probing: boolean;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly policy: BreakerPolicy = DEFAULT_BREAKER,
    private readonly maxKeys = 10_000,
  ) {}

  state(key: string, now: number = Date.now()): BreakerState {
    const e = this.entries.get(key);
    if (e === undefined) return 'closed';
    if (e.state === 'open' && now - e.openedAt >= this.policy.resetAfterMs) {
      e.state = 'half_open';
      e.probing = false;
      e.successes = 0;
    }
    return e.state;
  }

  /**
   * May a call proceed?
   *
   * In `half_open` this admits exactly one probe. Letting the whole backlog
   * through the moment the timer expires would hammer an upstream that has not
   * recovered, which is how a breaker turns into a retry storm.
   */
  allow(key: string, now: number = Date.now()): boolean {
    const state = this.state(key, now);
    if (state === 'closed') return true;
    if (state === 'open') return false;

    const e = this.entries.get(key)!;
    if (e.probing) return false;
    e.probing = true;
    e.lastUsedAt = now;
    return true;
  }

  succeed(key: string, now: number = Date.now()): void {
    const e = this.entry(key, now);
    e.lastUsedAt = now;
    e.probing = false;

    if (e.state === 'half_open') {
      e.successes += 1;
      if (e.successes >= this.policy.successesToClose) {
        e.state = 'closed';
        e.failures = 0;
        e.successes = 0;
      }
      return;
    }
    // A success resets the count: the threshold means *consecutive* failures,
    // so occasional unrelated errors over a long period never open it.
    e.failures = 0;
    e.state = 'closed';
  }

  fail(key: string, now: number = Date.now()): void {
    const e = this.entry(key, now);
    e.lastUsedAt = now;
    e.probing = false;

    if (e.state === 'half_open') {
      // The probe failed; it is still broken. Back to open with a fresh timer.
      e.state = 'open';
      e.openedAt = now;
      e.successes = 0;
      return;
    }

    e.failures += 1;
    if (e.failures >= this.policy.threshold) {
      e.state = 'open';
      e.openedAt = now;
    }
  }

  /** Wrap a call. Rejects immediately when open, without touching upstream. */
  async run<T>(key: string, fn: () => Promise<T>, now: number = Date.now()): Promise<T> {
    if (!this.allow(key, now)) {
      throw new CircuitOpenError(key);
    }
    try {
      const result = await fn();
      this.succeed(key, Date.now());
      return result;
    } catch (err) {
      this.fail(key, Date.now());
      throw err;
    }
  }

  /** Drop long-idle entries. A closed, unused breaker holds no information. */
  sweep(now: number = Date.now(), idleMs = 60 * 60 * 1000): number {
    let removed = 0;
    for (const [key, e] of this.entries) {
      if (e.state === 'closed' && now - e.lastUsedAt > idleMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Keys currently failing fast. Surfaced in metrics and the admin. */
  openKeys(now: number = Date.now()): string[] {
    return [...this.entries.keys()].filter((k) => this.state(k, now) !== 'closed');
  }

  private entry(key: string, now: number): Entry {
    let e = this.entries.get(key);
    if (e === undefined) {
      // Bounded like the rate limiter's store, and for the same reason: an
      // unbounded per-key map is a memory leak under the exact conditions this
      // code exists to survive. Evicting a *closed* entry loses nothing.
      if (this.entries.size >= this.maxKeys) this.evictClosed(now);
      e = { state: 'closed', failures: 0, successes: 0, openedAt: 0, lastUsedAt: now, probing: false };
      this.entries.set(key, e);
    }
    return e;
  }

  private evictClosed(now: number): void {
    for (const [key, e] of this.entries) {
      // Never evict an open breaker: that would silently re-admit traffic to a
      // failing upstream, which is the opposite of the job.
      if (e.state === 'closed') {
        this.entries.delete(key);
        if (this.entries.size < this.maxKeys) return;
      }
    }
    void now;
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly key: string) {
    super(`circuit open for ${key}`);
    this.name = 'CircuitOpenError';
  }
}
