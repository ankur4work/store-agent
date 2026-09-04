import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { BucketStore, TokenBucket } from '../src/limits/bucket.js';
import { clientKey, normalize } from '../src/limits/client-ip.js';
import { MemorySpendStore, SqliteSpendStore, dayKey } from '../src/limits/budget.js';
import { DEFAULT_RATE_LIMITS, RateLimiter, costFor, isExempt } from '../src/limits/limiter.js';
import { openDatabase } from '../src/store/sqlite.js';

/** Minimal IncomingMessage stand-in. */
function req(ip: string, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { socket: { remoteAddress: ip }, headers } as unknown as IncomingMessage;
}

const T0 = 1_700_000_000_000;

describe('TokenBucket', () => {
  it('allows a burst then throttles', () => {
    const b = new TokenBucket({ burst: 5, refillPerMin: 60 }, T0);
    for (let i = 0; i < 5; i++) expect(b.consume(T0).allowed).toBe(true);
    expect(b.consume(T0).allowed).toBe(false);
  });

  it('refills over time', () => {
    const b = new TokenBucket({ burst: 5, refillPerMin: 60 }, T0);
    for (let i = 0; i < 5; i++) b.consume(T0);
    expect(b.consume(T0 + 500).allowed).toBe(false);
    // 60/min = 1/sec.
    expect(b.consume(T0 + 1_100).allowed).toBe(true);
  });

  it('does not charge for a rejected request', () => {
    const b = new TokenBucket({ burst: 2, refillPerMin: 60 }, T0);
    b.consume(T0);
    b.consume(T0);
    // A client that keeps retrying must still recover on schedule. Deducting
    // on rejection would turn a brief burst into an indefinite lockout.
    for (let i = 0; i < 50; i++) b.consume(T0);
    expect(b.consume(T0 + 1_100).allowed).toBe(true);
  });

  it('reports a usable Retry-After', () => {
    const b = new TokenBucket({ burst: 1, refillPerMin: 60 }, T0);
    b.consume(T0);
    const d = b.consume(T0);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(d.retryAfterSec).toBeLessThanOrEqual(2);
  });

  it('never exceeds burst however long it idles', () => {
    const b = new TokenBucket({ burst: 3, refillPerMin: 60 }, T0);
    const day = T0 + 86_400_000;
    for (let i = 0; i < 3; i++) expect(b.consume(day).allowed).toBe(true);
    expect(b.consume(day).allowed).toBe(false);
  });

  it('charges cost proportionally', () => {
    const b = new TokenBucket({ burst: 10, refillPerMin: 60 }, T0);
    expect(b.consume(T0, 5).allowed).toBe(true);
    expect(b.consume(T0, 5).allowed).toBe(true);
    expect(b.consume(T0, 1).allowed).toBe(false);
  });
});

describe('BucketStore eviction', () => {
  it('stays bounded — the limiter must not be a memory exhaustion vector', () => {
    const store = new BucketStore({ burst: 5, refillPerMin: 60 }, 100);
    for (let i = 0; i < 5_000; i++) store.consume(`ip-${i}`, T0);
    expect(store.size).toBeLessThanOrEqual(100);
  });

  it('does not let an attacker evict their own throttle with junk keys', () => {
    const store = new BucketStore({ burst: 2, refillPerMin: 1 }, 10);

    // Attacker exhausts their bucket.
    store.consume('attacker', T0, 2);
    expect(store.consume('attacker', T0).allowed).toBe(false);

    // ...then floods with fresh keys hoping to displace it.
    for (let i = 0; i < 500; i++) store.consume(`junk-${i}`, T0);

    // The most-throttled entry is retained longest, so the attacker is still
    // throttled. Eviction order is a security property, not a detail.
    expect(store.consume('attacker', T0).allowed).toBe(false);
  });

  it('sweeps idle buckets', () => {
    const store = new BucketStore({ burst: 5, refillPerMin: 60 }, 1000);
    store.consume('a', T0);
    store.consume('b', T0);
    expect(store.sweep(T0 + 60_000)).toBe(2);
    expect(store.size).toBe(0);
  });
});

describe('client identification', () => {
  it('ignores X-Forwarded-For by default', () => {
    // The default must not be forgeable. Trusting this header without a proxy
    // in front makes the limiter worse than useless.
    const key = clientKey(req('9.9.9.9', { 'x-forwarded-for': '1.2.3.4' }), { trustProxyHops: 0 });
    expect(key).toBe('9.9.9.9');
  });

  it('takes the client N from the right with N trusted hops', () => {
    // Traefik appends the address it saw, so with one trusted hop the LAST
    // entry is ours and everything left of it is attacker-supplied.
    const key = clientKey(req('10.0.0.1', { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }), {
      trustProxyHops: 1,
    });
    expect(key).toBe('203.0.113.9');
  });

  it('cannot be evaded by prepending forged entries', () => {
    const forged = Array.from({ length: 50 }, (_, i) => `1.1.1.${i}`).join(', ');
    const key = clientKey(req('10.0.0.1', { 'x-forwarded-for': `${forged}, 203.0.113.9` }), {
      trustProxyHops: 1,
    });
    expect(key).toBe('203.0.113.9');
  });

  it('handles two trusted hops', () => {
    const key = clientKey(req('10.0.0.1', { 'x-forwarded-for': 'forged, 203.0.113.9, 172.16.0.1' }), {
      trustProxyHops: 2,
    });
    expect(key).toBe('203.0.113.9');
  });

  it('falls back to the socket when the header is absent or short', () => {
    expect(clientKey(req('9.9.9.9'), { trustProxyHops: 1 })).toBe('9.9.9.9');
    // Chain shorter than the configured hops: do not reach past the start.
    expect(clientKey(req('9.9.9.9', { 'x-forwarded-for': '1.2.3.4' }), { trustProxyHops: 3 })).toBe(
      '1.2.3.4',
    );
  });

  it('groups IPv6 by /64, not by address', () => {
    // A residential IPv6 allocation is a /64 at minimum. Limiting per address
    // would let one attacker rotate through billions of them for free.
    const a = normalize('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = normalize('2001:db8:1234:5678:1111:2222:3333:4444');
    expect(a).toBe(b);
    expect(normalize('2001:db8:1234:9999::1')).not.toBe(a);
  });

  it('normalizes ports and IPv4-mapped addresses', () => {
    expect(normalize('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalize('203.0.113.9:54321')).toBe('203.0.113.9');
    expect(normalize('[2001:db8::1]:443')).toBe('2001:db8:0:0');
    expect(normalize('2001:DB8::1')).toBe('2001:db8:0:0');
  });

  it('collapses :: consistently however it is written', () => {
    expect(normalize('2001:db8::1')).toBe(normalize('2001:0db8:0000:0000:0000:0000:0000:0001'));
  });
});

describe('route costs', () => {
  it('charges expensive routes more than cheap ones', () => {
    expect(costFor('/api/chat').tokens).toBeGreaterThan(costFor('/api/config').tokens);
    expect(costFor('/api/chat').units).toBeGreaterThan(0);
    expect(costFor('/api/config').units).toBe(0);
  });

  it('exempts health checks', () => {
    // A 429 here reads as "unhealthy" and the orchestrator kills a working
    // container — a rate limit becoming an outage.
    expect(isExempt('/healthz')).toBe(true);
  });

  it('exempts Shopify webhooks', () => {
    // orders/create is the server-side truth for revenue. Dropping it corrupts
    // the numbers the product is sold on.
    expect(isExempt('/shopify/webhooks')).toBe(true);
  });

  it('exempts the metrics endpoints', () => {
    // Monitoring must not be the first casualty of the incident it exists to
    // show you: under an attack the scraper shares the attacker's bucket.
    // Both routes require a bearer token, so this opens nothing.
    expect(isExempt('/metrics')).toBe(true);
    expect(isExempt('/api/slo')).toBe(true);
  });

  it('does not exempt anything else', () => {
    for (const p of ['/api/chat', '/api/pixel', '/admin/settings', '/shopify/auth', '/']) {
      expect(isExempt(p)).toBe(false);
    }
  });
});

describe('RateLimiter', () => {
  const opts = { ...DEFAULT_RATE_LIMITS, perIp: { burst: 10, refillPerMin: 60 } };

  it('throttles a single client hammering chat', () => {
    const rl = new RateLimiter(opts);
    const r = req('203.0.113.5');
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (rl.check(r, '/api/chat', 'acme', T0).allowed) allowed++;
    expect(allowed).toBe(2); // burst 10 / cost 5
  });

  it('does not throttle a different client', () => {
    const rl = new RateLimiter(opts);
    for (let i = 0; i < 20; i++) rl.check(req('203.0.113.5'), '/api/chat', 'acme', T0);
    expect(rl.check(req('203.0.113.6'), '/api/chat', 'acme', T0).allowed).toBe(true);
  });

  it('never throttles the health endpoint', () => {
    const rl = new RateLimiter(opts);
    const r = req('203.0.113.5');
    for (let i = 0; i < 500; i++) expect(rl.check(r, '/healthz', undefined, T0).allowed).toBe(true);
  });

  it('enforces a per-shop daily ceiling across many clients', () => {
    // The case a per-IP bucket cannot catch: distributed low-rate traffic.
    const rl = new RateLimiter({ ...opts, shopDailyUnits: 10 }, new MemorySpendStore());
    let allowed = 0;
    for (let i = 0; i < 50; i++) {
      if (rl.check(req(`203.0.113.${i}`), '/api/chat', 'acme', T0).allowed) allowed++;
    }
    expect(allowed).toBe(10);
  });

  it('keeps shops isolated — one shop cannot exhaust another', () => {
    const rl = new RateLimiter({ ...opts, shopDailyUnits: 5 }, new MemorySpendStore());
    for (let i = 0; i < 20; i++) rl.check(req(`203.0.113.${i}`), '/api/chat', 'acme', T0);
    expect(rl.check(req('198.51.100.1'), '/api/chat', 'other', T0).allowed).toBe(true);
  });

  it('enforces the global ceiling as a backstop', () => {
    const rl = new RateLimiter(
      { ...opts, shopDailyUnits: 1_000_000, globalDailyUnits: 3 },
      new MemorySpendStore(),
    );
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if (rl.check(req(`203.0.113.${i}`), '/api/chat', `shop-${i}`, T0).allowed) allowed++;
    }
    expect(allowed).toBe(3);
  });

  it('does not charge units for free routes', () => {
    const rl = new RateLimiter({ ...opts, shopDailyUnits: 2 }, new MemorySpendStore());
    for (let i = 0; i < 5; i++) rl.check(req(`203.0.113.${i}`), '/api/config', 'acme', T0);
    expect(rl.usage('acme', T0).shop).toBe(0);
    // ...so the budget is still intact for the routes that cost money.
    expect(rl.check(req('198.51.100.9'), '/api/chat', 'acme', T0).allowed).toBe(true);
  });

  it('refuses rather than allows-then-records at the boundary', () => {
    const rl = new RateLimiter({ ...opts, shopDailyUnits: 1 }, new MemorySpendStore());
    expect(rl.check(req('203.0.113.1'), '/api/chat', 'acme', T0).allowed).toBe(true);
    const d = rl.check(req('203.0.113.2'), '/api/chat', 'acme', T0);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('shop_daily');
    // The refused request must not have been counted.
    expect(rl.usage('acme', T0).shop).toBe(1);
  });

  it('resets the ceiling the next UTC day', () => {
    const rl = new RateLimiter({ ...opts, shopDailyUnits: 1 }, new MemorySpendStore());
    rl.check(req('203.0.113.1'), '/api/chat', 'acme', T0);
    expect(rl.check(req('203.0.113.2'), '/api/chat', 'acme', T0).allowed).toBe(false);
    expect(rl.check(req('203.0.113.2'), '/api/chat', 'acme', T0 + 86_400_000).allowed).toBe(true);
  });

  it('reports which limit fired', () => {
    const rl = new RateLimiter({ ...opts, perIp: { burst: 5, refillPerMin: 1 } });
    const r = req('203.0.113.1');
    rl.check(r, '/api/chat', 'acme', T0);
    expect(rl.check(r, '/api/chat', 'acme', T0).reason).toBe('ip');
  });

  it('can be disabled entirely', () => {
    const rl = new RateLimiter({ ...opts, enabled: false, shopDailyUnits: 1 });
    for (let i = 0; i < 100; i++) {
      expect(rl.check(req('203.0.113.1'), '/api/chat', 'acme', T0).allowed).toBe(true);
    }
  });

  it('applies the global ceiling even when the shop is unknown', () => {
    const rl = new RateLimiter({ ...opts, globalDailyUnits: 2 }, new MemorySpendStore());
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (rl.check(req(`203.0.113.${i}`), '/api/chat', undefined, T0).allowed) allowed++;
    }
    expect(allowed).toBe(2);
  });
});

describe('spend persistence', () => {
  it('survives a restart — a crash loop must not reset the budget', () => {
    const db = openDatabase({ path: ':memory:' });
    const day = dayKey(T0);

    const first = new SqliteSpendStore(db);
    first.add('shop:acme', day, 7);

    // A second process opening the same database.
    const second = new SqliteSpendStore(db);
    expect(second.total('shop:acme', day)).toBe(7);

    // And the ceiling is enforced against the recovered figure.
    const rl = new RateLimiter({ ...DEFAULT_RATE_LIMITS, shopDailyUnits: 7 }, second);
    expect(rl.check(req('203.0.113.1'), '/api/chat', 'acme', T0).allowed).toBe(false);
  });

  it('accumulates fractional units', () => {
    const db = openDatabase({ path: ':memory:' });
    const store = new SqliteSpendStore(db);
    const day = dayKey(T0);
    store.add('global', day, 0.5);
    store.add('global', day, 0.5);
    // TTS costs half a unit; integer columns would silently round it to zero.
    expect(store.total('global', day)).toBe(1);
  });

  it('prunes old days but keeps today', () => {
    const db = openDatabase({ path: ':memory:' });
    const store = new SqliteSpendStore(db);
    store.add('global', dayKey(T0 - 30 * 86_400_000), 5);
    store.add('global', dayKey(T0), 5);
    expect(store.prune(T0, 7)).toBe(1);
    expect(store.total('global', dayKey(T0))).toBe(5);
  });

  it('keys days in UTC', () => {
    expect(dayKey(Date.parse('2026-09-04T23:59:59Z'))).toBe('2026-09-04');
    expect(dayKey(Date.parse('2026-09-05T00:00:01Z'))).toBe('2026-09-05');
  });
});
