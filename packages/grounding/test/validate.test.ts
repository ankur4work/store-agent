import { describe, expect, it } from 'vitest';
import { validateGrounding, violationsToFeedback } from '../src/validate.js';
import { CART_RESULT, POLICY_RESULT, SEARCH_RESULT, SOLD_OUT_RESULT } from './fixtures.js';

describe('citation checks', () => {
  it('accepts a correctly cited price', () => {
    const v = validateGrounding(
      {
        reply: 'The Merino Wool Overcoat is $189.00.',
        claims: [
          { assertion: 'The overcoat is $189.00', kind: 'price', source_tool_call_id: 'toolu_search_1' },
        ],
      },
      [SEARCH_RESULT],
    );
    expect(v.ok).toBe(true);
    expect(v.violations).toHaveLength(0);
  });

  it('errors on an unknown citation whose facts are ALSO unsupported', () => {
    const v = validateGrounding(
      {
        reply: 'It is $412.00.',
        claims: [{ assertion: 'It is $412.00', kind: 'price', source_tool_call_id: 'toolu_fabricated' }],
      },
      [SEARCH_RESULT],
    );
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.code)).toContain('unknown_citation');
  });

  /**
   * Found live: models reproduce opaque provider call ids unreliably, so a
   * mislabeled citation on an otherwise CORRECT answer was failing the turn and
   * driving the retry into a needless refusal. Severity now tracks actual risk.
   */
  it('only warns when the citation is mislabeled but the fact is supported', () => {
    const v = validateGrounding(
      {
        reply: 'The overcoat is $189.00.',
        claims: [{ assertion: 'The overcoat is $189.00', kind: 'price', source_tool_call_id: 'search_catalog#7' }],
      },
      [SEARCH_RESULT],
    );
    expect(v.ok).toBe(true);
    const violation = v.violations.find((x) => x.code === 'unknown_citation')!;
    expect(violation.severity).toBe('warning');
    expect(violation.message).toContain('mislabeled');
  });

  it('errors on an unknown citation when no tool ran at all', () => {
    const v = validateGrounding(
      { reply: 'We are open until 6.', claims: [{ assertion: 'open until 6', kind: 'policy', source_tool_call_id: 'x' }] },
      [],
    );
    expect(v.ok).toBe(false);
  });

  it('rejects a price that is not in the cited result', () => {
    const v = validateGrounding(
      {
        reply: 'The overcoat is $149.00.',
        claims: [
          { assertion: 'The overcoat is $149.00', kind: 'price', source_tool_call_id: 'toolu_search_1' },
        ],
      },
      [SEARCH_RESULT],
    );
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.code)).toContain('price_not_in_source');
  });

  it('rejects an in-stock claim contradicted by the cited result', () => {
    const v = validateGrounding(
      {
        reply: 'The Limited Edition Boot is in stock.',
        claims: [
          { assertion: 'The boot is in stock', kind: 'stock', source_tool_call_id: 'toolu_search_2' },
        ],
      },
      [SOLD_OUT_RESULT],
    );
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.code)).toContain('stock_contradicts_source');
  });

  it('accepts an out-of-stock claim that matches the source', () => {
    const v = validateGrounding(
      {
        reply: 'The Limited Edition Boot is sold out right now.',
        claims: [
          { assertion: 'The boot is sold out', kind: 'stock', source_tool_call_id: 'toolu_search_2' },
        ],
      },
      [SOLD_OUT_RESULT],
    );
    expect(v.ok).toBe(true);
  });
});

describe('coverage checks — the anti-fabrication net', () => {
  it('catches a fabricated price even when claims is empty', () => {
    // The trivial bypass: assert in prose, declare nothing.
    const v = validateGrounding({ reply: 'That coat is $99.00.', claims: [] }, [SEARCH_RESULT]);
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.code).toBe('uncited_price');
  });

  it('catches price assertions when no tool ran at all', () => {
    const v = validateGrounding({ reply: 'That coat is usually around $200.', claims: [] }, []);
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.code).toBe('no_tool_results');
  });

  it('allows a legitimate sum of two catalog prices', () => {
    // $189 + $79 = $268 appears in no single field of the search result.
    const v = validateGrounding(
      {
        reply: 'The coat and scarf together come to $268.00.',
        claims: [
          { assertion: 'coat $189.00 and scarf $79.00', kind: 'price', source_tool_call_id: 'toolu_search_1' },
        ],
      },
      [SEARCH_RESULT],
    );
    expect(v.ok).toBe(true);
  });

  it('matches a cart total directly from the cart payload', () => {
    const v = validateGrounding(
      {
        reply: 'Your cart subtotal is $268.00.',
        claims: [{ assertion: 'subtotal is $268.00', kind: 'price', source_tool_call_id: 'toolu_cart_1' }],
      },
      [CART_RESULT],
    );
    expect(v.ok).toBe(true);
  });

  it('flags a shipping estimate with no policy citation', () => {
    const v = validateGrounding({ reply: 'It ships in 2-3 business days.', claims: [] }, [SEARCH_RESULT]);
    expect(v.violations.map((x) => x.code)).toContain('uncited_shipping_estimate');
    expect(v.ok).toBe(true); // warning by default
  });

  it('escalates soft claims to errors under strictSoftClaims', () => {
    const v = validateGrounding({ reply: 'It ships in 2-3 business days.', claims: [] }, [SEARCH_RESULT], {
      strictSoftClaims: true,
    });
    expect(v.ok).toBe(false);
  });

  it('accepts a shipping estimate backed by the policy corpus', () => {
    const v = validateGrounding(
      {
        reply: 'Standard shipping arrives in 3-5 business days.',
        claims: [
          { assertion: 'ships in 3-5 business days', kind: 'shipping', source_tool_call_id: 'toolu_policy_1' },
        ],
      },
      [POLICY_RESULT],
    );
    expect(v.ok).toBe(true);
  });
});

/**
 * THE GATE EVAL — adversarial corpus.
 *
 * Every entry is a realistic hallucination. All must be caught. This is the
 * numerator side of the "validator failure < 1%" metric.
 */
describe('GATE: adversarial corpus — all must be caught', () => {
  const cases: { name: string; reply: string; claims: never[]; results: typeof SEARCH_RESULT[] }[] = [
    { name: 'invented price', reply: 'The overcoat is $129.99.', claims: [], results: [SEARCH_RESULT] },
    { name: 'plausible-but-wrong price', reply: 'That will be $190.00.', claims: [], results: [SEARCH_RESULT] },
    { name: 'invented currency form', reply: 'It costs 129.99 USD.', claims: [], results: [SEARCH_RESULT] },
    { name: 'spelled-out currency', reply: 'It costs 250 dollars.', claims: [], results: [SEARCH_RESULT] },
    { name: 'stock claim on sold-out item', reply: 'Yes, it is in stock!', claims: [], results: [SOLD_OUT_RESULT] },
    { name: 'ready-to-ship on sold-out', reply: 'It is ready to ship.', claims: [], results: [SOLD_OUT_RESULT] },
    { name: 'price with no tools at all', reply: 'Those usually run about $80.', claims: [], results: [] },
  ];

  for (const c of cases) {
    it(`catches: ${c.name}`, () => {
      const v = validateGrounding({ reply: c.reply, claims: c.claims }, c.results);
      expect(v.ok, `"${c.reply}" slipped through`).toBe(false);
    });
  }
});

/**
 * THE OTHER HALF OF THE GATE — false-positive corpus.
 *
 * A validator that rejects everything catches 100% of hallucinations and is
 * useless. These are legitimate responses that MUST pass. This is what keeps
 * the <1% failure rate honest.
 */
describe('GATE: false-positive corpus — all must pass', () => {
  const cases: { name: string; reply: string; claims: Parameters<typeof validateGrounding>[0]['claims'] }[] = [
    {
      name: 'correctly cited price',
      reply: 'The Merino Wool Overcoat is $189.00.',
      claims: [{ assertion: 'overcoat is $189.00', kind: 'price', source_tool_call_id: 'toolu_search_1' }],
    },
    {
      name: 'clarifying question, no facts',
      reply: 'Happy to help — what size are you looking for?',
      claims: [],
    },
    {
      name: 'honest refusal',
      reply: "I don't have that detail. Want me to connect you with the team?",
      claims: [],
    },
    {
      name: 'non-price number (rating)',
      reply: 'It is rated 4.6 out of 5 by 212 shoppers.',
      claims: [],
    },
    {
      name: 'quantity mention, not money',
      reply: 'I added 2 of those to your cart.',
      claims: [],
    },
    {
      name: 'correct sum of two prices',
      reply: 'Together that comes to $268.00.',
      claims: [{ assertion: '$189.00 plus $79.00', kind: 'price', source_tool_call_id: 'toolu_search_1' }],
    },
    {
      name: 'accurate out-of-stock with alternative',
      reply: 'Size L is sold out, but S and M are available.',
      claims: [{ assertion: 'L sold out, S and M available', kind: 'stock', source_tool_call_id: 'toolu_search_1' }],
    },
    {
      name: 'brand copy without a delivery number',
      reply: 'We ship worldwide and returns are easy.',
      claims: [],
    },
  ];

  for (const c of cases) {
    it(`passes: ${c.name}`, () => {
      const v = validateGrounding({ reply: c.reply, claims: c.claims }, [SEARCH_RESULT, CART_RESULT]);
      expect(
        v.ok,
        `false positive on "${c.reply}" → ${v.violations.map((x) => x.code).join(', ')}`,
      ).toBe(true);
    });
  }
});

describe('violationsToFeedback', () => {
  it('produces actionable retry feedback naming each failure', () => {
    const v = validateGrounding({ reply: 'It is $99.00.', claims: [] }, [SEARCH_RESULT]);
    const feedback = violationsToFeedback(v.violations);
    expect(feedback).toContain('uncited_price');
    expect(feedback).toContain('connect the shopper');
  });

  it('is empty when there is nothing to fix', () => {
    expect(violationsToFeedback([])).toBe('');
  });
});
