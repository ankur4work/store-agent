import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_BACKOFF,
  DEFAULT_BREAKER,
  SOFT_DEGRADE_AT,
  backoffDelay,
  decideLevel,
  defaultIsRetryable,
  levelRank,
  shopperMessage,
  tierFor,
  withRetry,
  worstOf,
  type LadderInputs,
} from '../src/index.js';

const T0 = 1_700_000_000_000;

function inputs(over: Partial<LadderInputs> = {}): LadderInputs {
  return {
    budgetUsedFraction: 0,
    unbillable: false,
    catalogBreakerOpen: false,
    modelDegraded: false,
    catalogUnavailable: false,
    ...over,
  };
}

describe('degradation ladder', () => {
  it('serves everything when nothing is wrong', () => {
    const d = decideLevel(inputs());
    expect(d.level).toBe('full');
    expect(d.cartActions).toBe(true);
    expect(d.hedgePrices).toBe(false);
  });

  it('soft-degrades at 80% of the allowance', () => {
    expect(decideLevel(inputs({ budgetUsedFraction: 0.79 })).level).toBe('full');
    expect(decideLevel(inputs({ budgetUsedFraction: SOFT_DEGRADE_AT })).level).toBe('reduced');
  });

  it('NEVER cuts a shopper off when the allowance runs out', () => {
    // §8: "Never a hard cut-off mid-conversation with a shopper." The person
    // cut off would be the shopper, who has no idea a billing relationship
    // exists and did nothing wrong.
    const d = decideLevel(inputs({ budgetUsedFraction: 1 }));
    expect(d.level).toBe('faq_only');
    expect(d.level).not.toBe('unavailable');
    // Still answers — just not the expensive part.
    expect(shopperMessage(d.level)).toBeUndefined();
  });

  it('stays up even far past the allowance', () => {
    expect(decideLevel(inputs({ budgetUsedFraction: 12 })).level).toBe('faq_only');
  });

  it('drops to handoff when the shop cannot be billed at all', () => {
    // Different from "used its allowance": there is no path to charging for
    // more, so we stop spending — but handoff costs nothing and still gets
    // the shopper a person.
    const d = decideLevel(inputs({ unbillable: true }));
    expect(d.level).toBe('handoff');
    expect(d.cartActions).toBe(false);
    expect(shopperMessage(d.level)).toContain('email');
  });

  it('reduces when the model provider sheds load', () => {
    expect(decideLevel(inputs({ modelDegraded: true })).level).toBe('reduced');
  });

  it('hedges prices and disables cart when the storefront is failing', () => {
    const d = decideLevel(inputs({ catalogBreakerOpen: true }));
    expect(d.level).toBe('faq_only');
    // §9: "disable cart actions rather than guessing" — the shopper would
    // otherwise discover the wrong variant at checkout.
    expect(d.cartActions).toBe(false);
    expect(d.hedgePrices).toBe(true);
  });

  it('disables cart actions when there is no catalog data at all', () => {
    const d = decideLevel(inputs({ catalogUnavailable: true }));
    expect(d.cartActions).toBe(false);
    expect(d.level).toBe('handoff');
  });

  it('takes the worst of several simultaneous problems', () => {
    const d = decideLevel(
      inputs({ budgetUsedFraction: 0.9, modelDegraded: true, catalogBreakerOpen: true }),
    );
    expect(d.level).toBe('faq_only');
    expect(d.reason).toContain('storefront failing');
    expect(d.reason).toContain('approaching monthly allowance');
  });

  it('never reports an error level for a merchant problem', () => {
    // "Never show an error" is the §9 rule. Every merchant-side condition must
    // land on a rung that still serves the shopper something.
    for (const over of [
      { budgetUsedFraction: 1 },
      { unbillable: true },
      { catalogBreakerOpen: true },
      { modelDegraded: true },
    ]) {
      expect(decideLevel(inputs(over)).level).not.toBe('unavailable');
    }
  });

  it('orders levels worst-wins', () => {
    expect(worstOf('full', 'faq_only', 'reduced')).toBe('faq_only');
    expect(levelRank('full')).toBeLessThan(levelRank('unavailable'));
  });
});

describe('model tier selection', () => {
  it('uses the escalation tier only at full service', () => {
    expect(tierFor('full', true)).toBe('escalation');
    // The point of degrading is to stop spending, so a hard question does not
    // buy its way back up the ladder.
    expect(tierFor('reduced', true)).toBe('workhorse');
  });

  it('uses the cheapest tier for FAQ-only', () => {
    expect(tierFor('faq_only', false)).toBe('classify');
  });

  it('needs no model at all below that', () => {
    expect(tierFor('handoff', false)).toBeUndefined();
    expect(tierFor('unavailable', false)).toBeUndefined();
  });
});

describe('shopper-facing copy', () => {
  it('never mentions billing, plans or quotas', () => {
    // A shopper reading "this store exceeded its plan" has learned something
    // embarrassing about the merchant and useless to themselves.
    for (const level of ['full', 'reduced', 'faq_only', 'handoff', 'unavailable'] as const) {
      const msg = shopperMessage(level) ?? '';
      expect(msg).not.toMatch(/plan|billing|quota|allowance|upgrade|payment|subscription/i);
    }
  });
});

describe('circuit breaker', () => {
  it('opens after consecutive failures', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < DEFAULT_BREAKER.threshold; i++) b.fail('shop-a', T0);
    expect(b.state('shop-a', T0)).toBe('open');
    expect(b.allow('shop-a', T0)).toBe(false);
  });

  it('counts consecutive failures, not lifetime ones', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 4; i++) b.fail('shop-a', T0);
    b.succeed('shop-a', T0);
    for (let i = 0; i < 4; i++) b.fail('shop-a', T0);
    // Occasional unrelated errors over a long period must never open it.
    expect(b.state('shop-a', T0)).toBe('closed');
  });

  it('isolates merchants from each other', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 10; i++) b.fail('broken-shop', T0);
    // One broken storefront must not trip the breaker for the other 4,999.
    expect(b.state('broken-shop', T0)).toBe('open');
    expect(b.allow('healthy-shop', T0)).toBe(true);
  });

  it('probes once after the reset window, not with the whole backlog', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.fail('shop-a', T0);
    const later = T0 + DEFAULT_BREAKER.resetAfterMs;

    expect(b.allow('shop-a', later)).toBe(true);
    // Admitting the backlog would hammer an upstream that has not recovered —
    // a breaker turning into a retry storm.
    expect(b.allow('shop-a', later)).toBe(false);
    expect(b.allow('shop-a', later)).toBe(false);
  });

  it('reopens with a fresh timer when the probe fails', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.fail('shop-a', T0);
    const later = T0 + DEFAULT_BREAKER.resetAfterMs;
    b.allow('shop-a', later);
    b.fail('shop-a', later);
    expect(b.state('shop-a', later)).toBe('open');
    expect(b.state('shop-a', later + 1)).toBe('open');
  });

  it('needs more than one success to close, so it cannot flap', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.fail('shop-a', T0);
    const later = T0 + DEFAULT_BREAKER.resetAfterMs;

    b.allow('shop-a', later);
    b.succeed('shop-a', later);
    expect(b.state('shop-a', later)).toBe('half_open'); // one success is luck

    b.allow('shop-a', later);
    b.succeed('shop-a', later);
    expect(b.state('shop-a', later)).toBe('closed');
  });

  it('fails fast without touching upstream when open', async () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.fail('shop-a', T0);

    const upstream = vi.fn(async () => 'ok');
    await expect(b.run('shop-a', upstream, T0)).rejects.toBeInstanceOf(CircuitOpenError);
    // The whole point: a slow failure became a fast one, and the upstream was
    // spared the call.
    expect(upstream).not.toHaveBeenCalled();
  });

  it('run() records outcomes', async () => {
    const b = new CircuitBreaker();
    await b.run('shop-a', async () => 'ok', T0);
    expect(b.state('shop-a', T0)).toBe('closed');

    for (let i = 0; i < 5; i++) {
      await b.run('shop-a', async () => {
        throw new Error('boom');
      }, T0).catch(() => undefined);
    }
    expect(b.state('shop-a', T0)).toBe('open');
  });

  it('lists open keys for metrics', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.fail('shop-a', T0);
    expect(b.openKeys(T0)).toEqual(['shop-a']);
  });

  it('sweeps idle closed entries but never open ones', () => {
    const b = new CircuitBreaker();
    b.succeed('idle-shop', T0);
    for (let i = 0; i < 5; i++) b.fail('broken-shop', T0);

    b.sweep(T0 + 2 * 60 * 60 * 1000);
    // Evicting an open breaker would silently re-admit traffic to a failing
    // upstream — the opposite of the job.
    expect(b.state('broken-shop', T0 + 2 * 60 * 60 * 1000)).not.toBe('closed');
  });

  it('stays bounded under key pressure', () => {
    const b = new CircuitBreaker(DEFAULT_BREAKER, 100);
    for (let i = 0; i < 5_000; i++) b.succeed(`shop-${i}`, T0);
    expect(b.size).toBeLessThanOrEqual(100);
  });

  it('keeps open breakers even under key pressure', () => {
    const b = new CircuitBreaker(DEFAULT_BREAKER, 50);
    for (let i = 0; i < 5; i++) b.fail('broken-shop', T0);
    for (let i = 0; i < 2_000; i++) b.succeed(`shop-${i}`, T0);
    expect(b.state('broken-shop', T0)).toBe('open');
  });
});

describe('backoff', () => {
  it('grows exponentially up to the cap', () => {
    const always1 = () => 0.999999;
    const d0 = backoffDelay(0, DEFAULT_BACKOFF, always1);
    const d1 = backoffDelay(1, DEFAULT_BACKOFF, always1);
    const d5 = backoffDelay(5, DEFAULT_BACKOFF, always1);
    expect(d1).toBeGreaterThan(d0);
    expect(d5).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
  });

  it('spreads retries across the whole window', () => {
    // Without jitter, a thousand requests 429'd together all retry at the same
    // moment and re-create the overload. This is the property that prevents it.
    const samples = Array.from({ length: 400 }, () => backoffDelay(3));
    const unique = new Set(samples);
    expect(unique.size).toBeGreaterThan(100);
    expect(Math.min(...samples)).toBeLessThan(DEFAULT_BACKOFF.maxMs / 4);
  });

  it('never exceeds the cap', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(backoffDelay(attempt, DEFAULT_BACKOFF, () => 0.9999)).toBeLessThanOrEqual(
        DEFAULT_BACKOFF.maxMs,
      );
    }
  });

  it('retries only what is worth retrying', () => {
    expect(defaultIsRetryable({ status: 429 })).toBe(true);
    expect(defaultIsRetryable({ status: 503 })).toBe(true);
    expect(defaultIsRetryable({ code: 'ECONNRESET' })).toBe(true);
    // A 400 will be wrong every time; retrying spends the shopper's patience
    // to get the same answer.
    expect(defaultIsRetryable({ status: 400 })).toBe(false);
    expect(defaultIsRetryable({ status: 401 })).toBe(false);
    expect(defaultIsRetryable({ name: 'AbortError' })).toBe(false);
  });

  it('succeeds after transient failures', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw { status: 503 };
        return 'ok';
      },
      { sleep: async () => undefined },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after maxAttempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 503 };
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toBeTruthy();
    expect(calls).toBe(DEFAULT_BACKOFF.maxAttempts);
  });

  it('does not retry a non-retryable error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 400 };
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('stops immediately when the shopper leaves', async () => {
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return 'never';
        },
        { signal: ctl.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // The tab is closed; the work is already pointless.
    expect(calls).toBe(0);
  });
});

describe('chaos: the ladder holds under compound failure', () => {
  /**
   * Each scenario is a plausible bad day. The assertion is always the same and
   * is the §9 rule: the shopper is never shown an error, and cart actions are
   * never taken on data we do not trust.
   */
  const scenarios: { name: string; input: Partial<LadderInputs> }[] = [
    { name: 'Black Friday: budget blown, model shedding', input: { budgetUsedFraction: 1.4, modelDegraded: true } },
    { name: 'merchant storefront down', input: { catalogBreakerOpen: true } },
    { name: 'storefront down AND budget blown', input: { catalogBreakerOpen: true, budgetUsedFraction: 1 } },
    { name: 'total catalog outage', input: { catalogUnavailable: true } },
    { name: 'unpaid invoice mid-conversation', input: { unbillable: true } },
    {
      name: 'everything at once',
      input: {
        budgetUsedFraction: 3,
        unbillable: true,
        catalogBreakerOpen: true,
        modelDegraded: true,
        catalogUnavailable: true,
      },
    },
  ];

  for (const { name, input } of scenarios) {
    it(name, () => {
      const d = decideLevel(inputs(input));

      // Never an error page, and never a silent wrong answer.
      const msg = shopperMessage(d.level);
      if (msg !== undefined) expect(msg).not.toMatch(/error|failed|exception|500/i);

      // Cart mutations require data we trust.
      if (input.catalogUnavailable === true || input.catalogBreakerOpen === true) {
        expect(d.cartActions).toBe(false);
      }
      // Stale data must be admitted to, not hidden.
      if (input.catalogBreakerOpen === true || input.catalogUnavailable === true) {
        expect(d.hedgePrices).toBe(true);
      }
      // And the merchant always gets a diagnosis.
      expect(d.reason).not.toBe('');
    });
  }

  it('the worst possible day still lands on a rung that helps', () => {
    const d = decideLevel(
      inputs({
        budgetUsedFraction: 3,
        unbillable: true,
        catalogBreakerOpen: true,
        modelDegraded: true,
        catalogUnavailable: true,
      }),
    );
    expect(d.level).toBe('handoff');
    // Even here the shopper gets a route to a human rather than a dead widget.
    expect(shopperMessage(d.level)).toContain('email');
  });
});
