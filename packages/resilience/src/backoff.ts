/**
 * Retry with backoff.
 *
 * `ARCHITECTURE §9`: *"exponential backoff with jitter"*. The jitter is the
 * part that matters and the part usually left out.
 *
 * When a provider returns 429 to a thousand in-flight requests at once, plain
 * exponential backoff reschedules all thousand for the *same* moment. The
 * retry storm that follows is indistinguishable from the original overload, so
 * the provider 429s again and the whole fleet re-synchronises. Backoff without
 * jitter does not spread load; it quantises it.
 *
 * **Full jitter** — `random(0, cap)` rather than `cap/2 + random(cap/2)` —
 * spreads retries across the entire window. It re-tries sooner on average and
 * de-correlates hardest, which is the property that actually breaks the
 * synchronisation.
 */

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 250,
  maxMs: 8_000,
  // A shopper is waiting. Three attempts against a struggling provider is the
  // limit of what is worth their time; past that, degrade instead.
  maxAttempts: 3,
};

/**
 * Delay before attempt `n` (0-indexed).
 *
 * `random` is injectable so the distribution can be tested rather than
 * assumed — a jitter implementation that quietly returns a constant looks
 * exactly like one that works.
 */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export interface RetryOptions {
  readonly policy?: BackoffPolicy;
  /** Only retry what is worth retrying. */
  readonly isRetryable?: (err: unknown) => boolean;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Retryable by default: transient transport and load-shedding failures only.
 *
 * A 400 means the request is wrong and will be wrong every time; retrying it
 * spends the shopper's patience to get the same answer.
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown; retryable?: unknown };
  if (typeof e.retryable === 'boolean') return e.retryable;
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  if (e.name === 'AbortError') return false;
  const code = typeof e.code === 'string' ? e.code : '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortError();
  if (ms <= 0) return;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Run `fn`, retrying transient failures.
 *
 * Aborts propagate immediately and are never retried: the shopper closed the
 * tab, so the work is already pointless.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const policy = opts.policy ?? DEFAULT_BACKOFF;
  const retryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? abortableSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (opts.signal?.aborted === true) throw abortError();
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!retryable(err) || attempt === policy.maxAttempts - 1) throw err;
      const delay = backoffDelay(attempt, policy, opts.random);
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}
