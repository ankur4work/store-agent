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

  /**
   * A dropped-cents price and an invented price are the same violation and
   * need opposite corrections. Found live: the model wrote "$785" for a
   * $785.95 board while listing several products, the retry was told only
   * that 785.00 matched nothing, and it made the same edit again — so the
   * shopper got an escalation for a price the catalog knew exactly.
   */
  it('tells the model the real price when it only dropped the cents', () => {
    // $189.00 is in the fixture; "$189" parses to the same minor units, so
    // use a genuine near-miss the catalog does not contain.
    const v = validateGrounding({ reply: 'The overcoat is $189.50.', claims: [] }, [SEARCH_RESULT]);
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.code).toBe('uncited_price');
    expect(v.violations[0]!.message).toContain('189.00');
    expect(v.violations[0]!.message).toMatch(/display/);
  });

  it('does not suggest a nearest price for one that is simply invented', () => {
    // Inviting "did you mean" on a distant value would hand the model a
    // price it never had.
    const v = validateGrounding({ reply: 'That coat is $99.00.', claims: [] }, [SEARCH_RESULT]);
    expect(v.violations[0]!.message).toContain('appears in no tool result');
    expect(v.violations[0]!.message).not.toContain('the catalog says');
  });

  /**
   * A budget the shopper named is not a claim about the catalog. "anything
   * under $700" came back as "here are the boards under $700", the validator
   * flagged $700 as fabricated, threw away a correct answer and escalated —
   * because $700 appears in no product row, which is exactly what a budget is.
   */
  it('lets the reply repeat a budget the shopper named', () => {
    const v = validateGrounding(
      { reply: 'Two boards come in under $700: the scarf at $79.00 and the coat at $189.00.', claims: [] },
      [SEARCH_RESULT],
      { shopperMessage: 'do you have anything under $700' },
    );
    expect(v.ok).toBe(true);
  });

  it('still refuses that same figure when stated as a price', () => {
    // Otherwise a shopper could name a number and be quoted it back.
    const v = validateGrounding({ reply: 'That coat is $700.00.', claims: [] }, [SEARCH_RESULT], {
      shopperMessage: 'is the coat $700',
    });
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.code).toBe('uncited_price');
  });

  it('does not accept a threshold the shopper never mentioned', () => {
    const v = validateGrounding({ reply: 'Everything is under $700.', claims: [] }, [SEARCH_RESULT], {
      shopperMessage: 'what do you have',
    });
    expect(v.ok).toBe(false);
  });

  /**
   * The cart outranks the catalog on availability. Found live: add_to_cart
   * returned "The product is already sold out", the model relayed it, and the
   * validator called it a contradiction because a search_catalog result in
   * the same turn still said `available: true`. The one thing the shopper
   * most needed to hear was thrown away as a hallucination.
   */
  it('believes a cart that says sold out over a catalog row that says available', () => {
    const cartSaysNo = {
      tool_call_id: 'add_to_cart#2',
      tool: 'add_to_cart',
      result: {
        line_items: [],
        messages: [
          { code: 'merchandise_out_of_stock', type: 'warning', content: "'Hydrogen' is already sold out." },
        ],
      },
    };
    const v = validateGrounding(
      { reply: 'I couldn’t add it — the Hydrogen snowboard is sold out.', claims: [] },
      [SEARCH_RESULT, cartSaysNo],
    );
    expect(v.ok).toBe(true);
  });

  it('still catches an invented out-of-stock with no cart notice behind it', () => {
    // Everything in this source is available and nothing reported a problem,
    // so "sold out" is the model's own invention.
    const allAvailable = {
      tool_call_id: 'search_catalog#1',
      tool: 'search_catalog',
      result: {
        products: [
          { id: 'p1', title: 'Overcoat', variants: [{ id: 'v1', available: true }] },
        ],
      },
    };
    const v = validateGrounding({ reply: 'The overcoat is sold out.', claims: [] }, [allAvailable]);
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.code).toBe('stock_contradicts_source');
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
