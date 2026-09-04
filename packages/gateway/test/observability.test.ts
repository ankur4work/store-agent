import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, Registry } from '../src/observability/metrics.js';
import { Logger, redact, shouldRedact } from '../src/observability/logger.js';
import { TTFT_BUCKETS, Telemetry } from '../src/observability/telemetry.js';

describe('counter', () => {
  it('counts per label set', () => {
    const c = new Counter('c', 'help');
    c.inc({ shop: 'a' });
    c.inc({ shop: 'a' });
    c.inc({ shop: 'b' });
    expect(c.get({ shop: 'a' })).toBe(2);
    expect(c.total()).toBe(3);
  });

  it('sums across a label subset', () => {
    const c = new Counter('c', 'help');
    c.inc({ shop: 'a', ok: 'false' });
    c.inc({ shop: 'b', ok: 'false' });
    c.inc({ shop: 'a', ok: 'true' }, 97);
    // The gate is a property of the system, not of one merchant.
    expect(c.sumWhere({ ok: 'false' })).toBe(2);
    expect(c.total()).toBe(99);
  });

  it('is order-insensitive about label keys', () => {
    const c = new Counter('c', 'help');
    c.inc({ shop: 'a', ok: 'true' });
    expect(c.get({ ok: 'true', shop: 'a' })).toBe(1);
  });

  it('stops adding series rather than growing without bound', () => {
    // An unbounded label set is a memory leak that arrives disguised as a
    // dashboard.
    const c = new Counter('c', 'help');
    for (let i = 0; i < 5_000; i++) c.inc({ id: String(i) });
    expect(c.total()).toBeLessThanOrEqual(2_000);
  });

  it('renders Prometheus text', () => {
    const c = new Counter('storeagent_turns_total', 'Turns');
    c.inc({ shop: 'acme.myshopify.com', ok: 'true' }, 5);
    const out = c.render();
    expect(out).toContain('# TYPE storeagent_turns_total counter');
    expect(out).toContain('storeagent_turns_total{ok="true",shop="acme.myshopify.com"} 5');
  });

  it('escapes label values', () => {
    const c = new Counter('c', 'help');
    c.inc({ route: 'a"b\\c' });
    expect(c.render()).toContain('route="a\\"b\\\\c"');
  });
});

describe('histogram', () => {
  const h = () => new Histogram('h', 'help', [10, 50, 100, 400, Infinity]);

  it('answers a threshold question exactly at a bucket edge', () => {
    const hist = h();
    // 3 under 400, 1 over.
    for (const v of [5, 60, 300, 900]) hist.observe(v);
    // This is the §12 gate shape: an exact ratio of counters, not an
    // interpolation.
    expect(hist.fractionAtOrBelow(400)).toBe(0.75);
  });

  it('refuses a threshold that is not a bucket edge', () => {
    const hist = h();
    hist.observe(5);
    // An SLO answered by guesswork is worse than one that admits it cannot be
    // answered.
    expect(hist.fractionAtOrBelow(250)).toBeUndefined();
  });

  it('returns undefined with no observations', () => {
    expect(h().fractionAtOrBelow(400)).toBeUndefined();
  });

  it('estimates a quantile for display', () => {
    const hist = h();
    for (let i = 0; i < 100; i++) hist.observe(i);
    const p50 = hist.quantile(0.5);
    expect(p50).toBeGreaterThan(30);
    expect(p50).toBeLessThan(70);
  });

  it('counts cumulatively, as Prometheus requires', () => {
    const hist = h();
    hist.observe(5);
    const out = hist.render();
    // A value of 5 falls in every bucket at or above it.
    expect(out).toContain('h_bucket{le="10"} 1');
    expect(out).toContain('h_bucket{le="50"} 1');
    expect(out).toContain('h_bucket{le="400"} 1');
    expect(out).toContain('h_count 1');
    expect(out).toContain('h_sum 5');
  });

  it('renders +Inf for an unbounded last bucket', () => {
    const hist = h();
    hist.observe(99_999);
    expect(hist.render()).toContain('h_bucket{le="+Inf"} 1');
  });

  it('keeps label sets separate', () => {
    const hist = h();
    hist.observe(5, { target: 'ucp' });
    hist.observe(900, { target: 'model' });
    expect(hist.fractionAtOrBelow(400, { target: 'ucp' })).toBe(1);
    expect(hist.fractionAtOrBelow(400, { target: 'model' })).toBe(0);
  });
});

describe('gauge', () => {
  it('replaces rather than accumulates', () => {
    const g = new Gauge('g', 'help');
    g.set(5);
    g.set(9);
    expect(g.get()).toBe(9);
  });
});

describe('registry', () => {
  it('omits metrics that have never been touched', () => {
    const r = new Registry();
    r.counter('unused_total', 'never incremented');
    const used = r.counter('used_total', 'incremented');
    used.inc();
    const out = r.render();
    // An empty series is noise on a dashboard, not information.
    expect(out).not.toContain('unused_total');
    expect(out).toContain('used_total');
  });

  it('ends with a newline, as the exposition format requires', () => {
    const r = new Registry();
    r.counter('c_total', 'help').inc();
    expect(r.render().endsWith('\n')).toBe(true);
  });
});

describe('redaction', () => {
  it('redacts credentials by field name', () => {
    for (const k of ['accessToken', 'access_token', 'apiKey', 'SHOPIFY_API_SECRET', 'authorization', 'hmac']) {
      expect(shouldRedact(k)).toBe(true);
    }
  });

  it('redacts shopper content by field name', () => {
    // What someone types into a shopping assistant records what they want,
    // what they can afford, and sometimes what they are treating.
    for (const k of ['message', 'reply', 'transcript', 'utterance', 'email', 'prompt']) {
      expect(shouldRedact(k)).toBe(true);
    }
  });

  it('leaves correlation ids alone', () => {
    // These identify a conversation without revealing it — the whole point.
    for (const k of ['sessionId', 'shop', 'turnId', 'status', 'ms']) {
      expect(shouldRedact(k)).toBe(false);
    }
  });

  it('redacts nested values', () => {
    const out = redact({ turn: { sessionId: 's1', message: 'do you have this in blue' } }) as any;
    expect(out.turn.sessionId).toBe('s1');
    expect(out.turn.message).toBe('[redacted]');
  });

  it('survives a cycle', () => {
    const a: any = { name: 'x' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as any).self).toBe('[circular]');
  });

  it('truncates rather than shipping a long string', () => {
    const out = redact({ note: 'x'.repeat(5_000) }) as any;
    expect(out.note.length).toBeLessThan(220);
  });

  it('reduces an Error to name and message', () => {
    const out = redact(new TypeError('bad')) as any;
    expect(out).toEqual({ name: 'TypeError', message: 'bad' });
  });

  it('bounds depth and breadth', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });
});

describe('logger', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, sink: (l: string) => lines.push(l) };
  };

  it('never writes a shopper message even when handed one', () => {
    const { lines, sink } = capture();
    const log = new Logger({ level: 'info', json: true, sink, now: () => 0 });
    log.info('turn_complete', { sessionId: 's1', message: 'do you sell insulin' });
    // The call site made a mistake; the logger must still not leak.
    expect(lines[0]).not.toContain('insulin');
    expect(lines[0]).toContain('[redacted]');
    expect(lines[0]).toContain('s1');
  });

  it('never writes an access token', () => {
    const { lines, sink } = capture();
    const log = new Logger({ level: 'info', json: true, sink, now: () => 0 });
    log.error('install_failed', { shop: 'a.myshopify.com', accessToken: 'shpat_realsecret' });
    expect(lines[0]).not.toContain('shpat_realsecret');
  });

  it('honours the level', () => {
    const { lines, sink } = capture();
    const log = new Logger({ level: 'warn', json: true, sink });
    log.info('ignored');
    log.warn('kept');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('kept');
  });

  it('emits parseable JSON lines', () => {
    const { lines, sink } = capture();
    const log = new Logger({ level: 'info', json: true, sink, now: () => 0 });
    log.info('http_request', { route: '/api/chat', status: 200, ms: 41 });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: 'info', event: 'http_request', status: 200, ms: 41 });
    expect(parsed.ts).toBe('1970-01-01T00:00:00.000Z');
  });

  it('stamps child fields on every line', () => {
    const { lines, sink } = capture();
    const log = new Logger({ level: 'info', json: true, sink }).child({ shop: 'acme' });
    log.info('a');
    log.info('b');
    expect(lines.every((l) => l.includes('acme'))).toBe(true);
  });
});

describe('SLO gates', () => {
  it('says unknown rather than pass on thin data', () => {
    const t = new Telemetry();
    t.turns.inc({ shop: 'a', ok: 'true' });
    // A gate declared from one turn is noise wearing a verdict's clothes.
    expect(t.gates().groundingGate).toBe('unknown');
  });

  it('passes the grounding gate below 1% failure', () => {
    const t = new Telemetry();
    t.turns.inc({ shop: 'a', ok: 'true' }, 999);
    t.turns.inc({ shop: 'a', ok: 'false' }, 1);
    const g = t.gates();
    expect(g.groundingFailureRate).toBeCloseTo(0.001);
    expect(g.groundingGate).toBe('pass');
  });

  it('fails the grounding gate above 1%', () => {
    const t = new Telemetry();
    t.turns.inc({ shop: 'a', ok: 'true' }, 900);
    t.turns.inc({ shop: 'a', ok: 'false' }, 100);
    expect(t.gates().groundingGate).toBe('fail');
  });

  it('aggregates failures across shops', () => {
    const t = new Telemetry();
    t.turns.inc({ shop: 'a', ok: 'true' }, 500);
    t.turns.inc({ shop: 'b', ok: 'true' }, 400);
    t.turns.inc({ shop: 'a', ok: 'false' }, 50);
    t.turns.inc({ shop: 'b', ok: 'false' }, 50);
    expect(t.gates().groundingFailureRate).toBeCloseTo(0.1);
  });

  it('answers the TTFT gate exactly, since 400 is a bucket edge', () => {
    const t = new Telemetry();
    expect(TTFT_BUCKETS).toContain(400);
    for (let i = 0; i < 60; i++) t.ttft.observe(120);
    for (let i = 0; i < 40; i++) t.ttft.observe(2_000);
    const g = t.gates();
    expect(g.ttftUnder400).toBeCloseTo(0.6);
    // p50 < 400ms means at least half are under 400ms.
    expect(g.ttftGate).toBe('pass');
  });

  it('fails the TTFT gate when most turns are slow', () => {
    const t = new Telemetry();
    for (let i = 0; i < 40; i++) t.ttft.observe(120);
    for (let i = 0; i < 60; i++) t.ttft.observe(2_000);
    expect(t.gates().ttftGate).toBe('fail');
  });

  it('renders every touched metric', () => {
    const t = new Telemetry();
    t.turns.inc({ shop: 'a', ok: 'true' });
    t.ttft.observe(120);
    t.errors.inc({ kind: 'upstream' });
    const out = t.render();
    expect(out).toContain('storeagent_turns_total');
    expect(out).toContain('storeagent_ttft_ms_bucket');
    expect(out).toContain('storeagent_errors_total');
  });

  it('carries no shopper content into the exposition output', () => {
    const t = new Telemetry();
    t.turns.inc({ shop: 'acme.myshopify.com', ok: 'true' });
    t.errors.inc({ kind: 'model_timeout' });
    // Only the sample lines carry data; `# HELP` text is our own prose and
    // legitimately contains the word "message".
    const samples = t
      .render()
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));

    // Every sample is `name{label="value"} number`. Values come from a fixed
    // vocabulary — shop domains, route names, error kinds — so there is no
    // field shopper content could travel in.
    for (const line of samples) {
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?[\d.e+]+$/i);
    }
    expect(samples.length).toBeGreaterThan(0);
  });
});
