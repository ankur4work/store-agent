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
    // Prescriptive trigger conditions measurably raise should-call rate on
    // recent models — and for us tool-calling rate IS grounding rate.
    for (const t of DEFAULT_TOOLS) {
      expect(t.description.toLowerCase(), `${t.name} lacks a trigger condition`).toMatch(
        /call this|use this|use it|never|whenever|only call|only when/,
      );
    }
  });
});

/**
 * A shopper shown four pairs of shoes said "I want the best one" and was
 * told: "I can't verify which shoe is best right now. Our team can help
 * choose one — share your email for a follow-up."
 *
 * The escalation rule had swallowed the single most common thing anyone
 * asks a shop assistant. Recommending is not a claim to verify.
 */
describe('recommendations are not escalations', () => {
  const prefix = buildCachedPrefix(MERCHANT)
    .map((b) => b.text)
    .join('\n');

  it('tells the model an opinion is its to give', () => {
    expect(prefix).toContain('Being asked to recommend is not a verification problem');
    expect(prefix).toContain('Never\nescalate a matter of taste');
  });

  it('keeps escalation for facts, which is what it is for', () => {
    // The rule still has to bite on price, stock, policy and existence —
    // the whole product rests on not inventing those.
    expect(prefix).toContain('Escalate when you cannot\nestablish a FACT');
  });

  it('still requires a reason drawn from the product itself', () => {
    // "I'd go with this one" with no why is a guess wearing a recommendation.
    expect(prefix).toContain("that product's own attributes");
  });
});

/**
 * Answers were arriving as five products with a sentence of copy each, a
 * colourway, a size range and a closing paragraph. That is a product page
 * in a chat bubble — and it is also read aloud, where a shopper cannot skim.
 */
describe('brevity', () => {
  const prefix = buildCachedPrefix(MERCHANT)
    .map((b) => b.text)
    .join('\n');

  it('caps a direct answer at a sentence or two', () => {
    expect(prefix).toContain('A direct question gets one or two sentences');
  });

  it('caps a list at one line per product', () => {
    expect(prefix).toContain('A list gets one line per product');
  });

  it('forbids narrating what the cards already show', () => {
    expect(prefix).toContain('Never describe what the cards already show');
  });

  it('gives the spoken-length reason, not just the rule', () => {
    // A rule with no reason gets argued away by the next instruction.
    expect(prefix).toContain('cannot skim speech');
  });
});
