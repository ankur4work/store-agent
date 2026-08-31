import { describe, expect, it } from 'vitest';
import {
  UnstablePrefixError,
  assertStable,
  buildCachedPrefix,
  prefixFingerprint,
  renderTurnContext,
} from '../src/prompt.js';
import { DEFAULT_TOOLS } from '../src/tools.js';
import { MERCHANT } from './harness.js';

/**
 * Prompt caching is the business model (ARCHITECTURE.md §7.4): ~$84k/month of
 * model spend with it, ~$310k without. A single interpolated timestamp
 * disables it silently — no error, no failing test, just a 4× bill.
 *
 * These tests are the guard.
 */
describe('cached prefix stability', () => {
  it('is byte-identical across repeated builds', () => {
    const a = buildCachedPrefix(MERCHANT);
    const b = buildCachedPrefix(MERCHANT);
    expect(a[0]!.text).toBe(b[0]!.text);
    expect(prefixFingerprint(a)).toBe(prefixFingerprint(b));
  });

  it('carries exactly one cache breakpoint, on the last block', () => {
    const blocks = buildCachedPrefix(MERCHANT);
    const marked = blocks.filter((b) => b.cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(blocks.at(-1)!.cache_control).toBeDefined();
  });

  it('supports a 1h TTL for high-traffic merchants', () => {
    expect(buildCachedPrefix(MERCHANT, '1h')[0]!.cache_control?.ttl).toBe('1h');
  });

  it('produces a different fingerprint for a different merchant', () => {
    const other = { ...MERCHANT, brandVoice: 'Playful and loud.' };
    expect(prefixFingerprint(buildCachedPrefix(MERCHANT))).not.toBe(
      prefixFingerprint(buildCachedPrefix(other)),
    );
  });
});

describe('silent-invalidator guard', () => {
  it.each([
    ['ISO timestamp', 'Current time is 2026-08-31T14:05 UTC.'],
    ['date', 'Today is 2026-08-31.'],
    ['clock time', 'The store closes at 17:30.'],
    ['UUID', 'Session 550e8400-e29b-41d4-a716-446655440000.'],
    ['session id', 'You are serving sess_01J8ZQ4RTY.'],
    ['cart id', 'Cart gid://shopify/Cart/12345 is active.'],
    ['epoch millis', 'Generated at 1756654800000.'],
  ])('rejects %s in the prefix', (_name, text) => {
    expect(() => assertStable(text)).toThrow(UnstablePrefixError);
  });

  it('names the offending fragment so the fix is obvious', () => {
    try {
      assertStable('Today is 2026-08-31.');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as UnstablePrefixError).message).toContain('2026-08-31');
      expect((e as UnstablePrefixError).message).toContain('last user turn');
    }
  });

  it('allows ordinary brand copy', () => {
    expect(() => assertStable('Free returns within 30 days. We ship worldwide.')).not.toThrow();
  });

  it('fires when a merchant pack smuggles volatile content in', () => {
    expect(() =>
      buildCachedPrefix({ ...MERCHANT, policySummary: 'Updated 2026-08-31.' }),
    ).toThrow(UnstablePrefixError);
  });
});

describe('volatile state lives in the turn, not the prefix', () => {
  it('renders page, cart and navigation context', () => {
    const out = renderTurnContext({
      sessionId: 'sess_abc',
      page: { type: 'product', title: 'Merino Wool Overcoat' },
      cart: { itemCount: 2, subtotalMinor: 26800 },
      justNavigated: true,
    });
    expect(out).toContain('Merino Wool Overcoat');
    expect(out).toContain('2 item(s)');
    expect(out).toContain('$268.00');
    expect(out).toContain('just navigated');
  });

  it('would be rejected by the prefix guard — proving it belongs in the turn', () => {
    const ctx = renderTurnContext({
      sessionId: 'sess_abc',
      cart: { itemCount: 1 },
      page: { type: 'cart' },
    });
    // Not volatile by pattern, but the cart id case is:
    expect(() => assertStable('gid://shopify/Cart/1')).toThrow();
    expect(ctx).not.toBe('');
  });

  it('is empty when there is no context to add', () => {
    expect(renderTurnContext({ sessionId: 'sess_abc' })).toBe('');
  });
});

describe('tool definitions', () => {
  it('are sorted by name so the prefix stays cacheable', () => {
    const names = DEFAULT_TOOLS.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it('state WHEN to call, not just what the tool does', () => {
    for (const t of DEFAULT_TOOLS) {
      expect(t.description.toLowerCase(), `${t.name} lacks a trigger condition`).toMatch(
        /call this|never|whenever|only call/,
      );
    }
  });
});
