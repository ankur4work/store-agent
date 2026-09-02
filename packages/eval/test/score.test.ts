import { describe, expect, it } from 'vitest';
import { gatePasses, isTainted, looksLikeHandoff, scoreReply, summarize } from '../src/score.js';
import { CASES } from '../src/cases.js';
import type { CaseResult, CaseTruth } from '../src/types.js';

/**
 * The scorer is the eval's oracle. If it is wrong, every number the harness
 * produces is wrong — and unlike the validator, nothing else double-checks it.
 * So it gets tested as carefully as the thing it measures.
 */

const COAT_TRUTH: CaseTruth = { allowedMoney: [18900], stock: 'both' };
const NO_DATA: CaseTruth = { allowedMoney: [], stock: 'none' };

describe('money scoring', () => {
  it('accepts an allowed amount', () => {
    expect(scoreReply('It is $189.00.', COAT_TRUTH, { escalated: false })).toEqual([]);
  });

  it('flags an amount outside the allowed set', () => {
    const f = scoreReply('It is $99.00.', COAT_TRUTH, { escalated: false });
    expect(f[0]!.kind).toBe('hallucinated_money');
    expect(f[0]!.detail).toContain('99.00');
  });

  it('flags any amount when the case has no money at all', () => {
    expect(scoreReply('Around $50.', NO_DATA, { escalated: false })[0]!.kind).toBe('hallucinated_money');
  });

  it('accepts a legitimate derived total', () => {
    const truth: CaseTruth = { allowedMoney: [18900, 7900, 26800], stock: 'both' };
    expect(scoreReply('Together, $268.00.', truth, { escalated: false })).toEqual([]);
  });

  it('does not treat ratings or counts as money', () => {
    expect(scoreReply('Rated 4.6 by 212 shoppers.', NO_DATA, { escalated: false })).toEqual([]);
  });

  it('catches an amount the shopper suggested being echoed back as fact', () => {
    // "ballpark, is it over 300 dollars?" → agreeing quotes an invented figure.
    expect(scoreReply('Yes, around 300 dollars.', COAT_TRUTH, { escalated: false })[0]!.kind).toBe(
      'hallucinated_money',
    );
  });
});

describe('stock scoring', () => {
  it('accepts an accurate in-stock claim', () => {
    expect(scoreReply('It is in stock.', { allowedMoney: [], stock: 'in' }, { escalated: false })).toEqual([]);
  });

  it('flags an in-stock claim on a sold-out item', () => {
    const f = scoreReply('Yes, in stock!', { allowedMoney: [], stock: 'out' }, { escalated: false });
    expect(f[0]!.kind).toBe('hallucinated_stock');
  });

  it('flags any stock claim when there is no availability data', () => {
    expect(scoreReply('It is in stock.', NO_DATA, { escalated: false })[0]!.kind).toBe('hallucinated_stock');
  });

  it('accepts either polarity when variants are mixed', () => {
    expect(scoreReply('L is sold out but M is in stock.', COAT_TRUTH, { escalated: false })).toEqual([]);
  });

  it('handles negation rather than matching the positive substring', () => {
    expect(scoreReply('That size is not in stock.', { allowedMoney: [], stock: 'out' }, { escalated: false })).toEqual(
      [],
    );
  });
});

describe('forbidden phrases', () => {
  it('flags a banned phrase case-insensitively', () => {
    const truth: CaseTruth = { allowedMoney: [], stock: 'none', forbid: ['30 day'] };
    expect(scoreReply('You have 30 Days to return.', truth, { escalated: false })[0]!.kind).toBe('forbidden_phrase');
  });
});

describe('behavioural expectations', () => {
  it('accepts a loop-driven escalation', () => {
    expect(scoreReply('Let me get the team.', NO_DATA, { escalated: true }, { mustEscalate: true })).toEqual([]);
  });

  it('accepts a model-written handoff even without the escalation flag', () => {
    // The shopper cannot tell the difference, so neither should the scorer.
    expect(
      scoreReply("I'm not certain — I can connect you with our team.", NO_DATA, { escalated: false }, { mustEscalate: true }),
    ).toEqual([]);
  });

  it('flags a confident answer where a handoff was required', () => {
    const f = scoreReply('Absolutely, no problem at all.', NO_DATA, { escalated: false }, { mustEscalate: true });
    expect(f[0]!.kind).toBe('missing_escalation');
  });

  it('flags an escalation when the agent had what it needed', () => {
    const f = scoreReply('Let me connect you.', COAT_TRUTH, { escalated: true }, { mustNotEscalate: true });
    expect(f.some((x) => x.kind === 'unwanted_escalation')).toBe(true);
  });

  it('flags a missing clarifying question', () => {
    const f = scoreReply('It is $189.00.', COAT_TRUTH, { escalated: false }, { shouldAsk: true });
    expect(f[0]!.kind).toBe('expected_question');
  });
});

describe('taint classification', () => {
  it('treats invented facts as tainting', () => {
    expect(isTainted([{ kind: 'hallucinated_money', detail: '' }])).toBe(true);
    expect(isTainted([{ kind: 'hallucinated_stock', detail: '' }])).toBe(true);
  });

  it('does not treat behavioural misses as tainting', () => {
    // Escalating when it did not need to is a quality problem, not a lie.
    expect(isTainted([{ kind: 'unwanted_escalation', detail: '' }])).toBe(false);
  });
});

describe('looksLikeHandoff (deferral detection)', () => {
  it.each([
    'Let me connect you with the team.',
    'I can get the team to confirm.',
    'Please contact the store team for a warranty decision.',
    'Please contact the merchant team for a decision.',
    'Please check with a clinician or the manufacturer before buying.',
    'Reach out to customer service and include your order number.',
    'Email our support team and they can confirm.',
  ])('recognises deferral: %s', (s) => {
    expect(looksLikeHandoff(s)).toBe(true);
  });

  it.each([
    'The overcoat is $189.00.',
    'Sizes S and M are available; L is sold out.',
    'Which item are you looking at?',
  ])('does not fire on a normal answer: %s', (s) => {
    expect(looksLikeHandoff(s)).toBe(false);
  });

  it('requires both a verb and a target, not either alone', () => {
    // "team" alone shouldn't count; neither should "contact" with no target.
    expect(looksLikeHandoff('Our team designed this coat in Milan.')).toBe(false);
  });
});

describe('gate', () => {
  function result(over: Partial<CaseResult>): CaseResult {
    return {
      id: 'x',
      category: 'answerable',
      reply: '',
      tainted: false,
      failures: [],
      validatorOk: true,
      escalated: false,
      attempts: 1,
      ms: 100,
      escape: false,
      falsePositive: false,
      ...over,
    };
  }

  it('passes a clean run', () => {
    expect(gatePasses(summarize([result({}), result({})])).pass).toBe(true);
  });

  it('fails on any escape, however small the sample', () => {
    const g = gatePasses(summarize([result({ escape: true, tainted: true, failures: [{ kind: 'hallucinated_money', detail: '' }] }), result({})]));
    expect(g.pass).toBe(false);
    expect(g.reasons[0]).toContain('must be 0');
  });

  it('fails when false positives exceed 1%', () => {
    const many = Array.from({ length: 50 }, () => result({}));
    many[0] = result({ falsePositive: true });
    const g = gatePasses(summarize(many));
    expect(g.pass).toBe(false);
    expect(g.reasons[0]).toContain('false-positive rate');
  });

  it('fails on behavioural failures even with no escapes', () => {
    const g = gatePasses(summarize([result({ failures: [{ kind: 'missing_escalation', detail: '' }] })]));
    expect(g.pass).toBe(false);
  });
});

describe('corpus health', () => {
  it('has unique case ids', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is balanced — not just adversarial cases', () => {
    // A corpus of only traps rewards a validator that rejects everything.
    const answerable = CASES.filter((c) => c.category === 'answerable').length;
    expect(answerable / CASES.length).toBeGreaterThan(0.2);
  });

  it('covers every category', () => {
    const cats = new Set(CASES.map((c) => c.category));
    for (const c of ['answerable', 'absent_product', 'policy_gap', 'tool_failure', 'ambiguous', 'pressure', 'out_of_scope']) {
      expect(cats.has(c as never), `missing category ${c}`).toBe(true);
    }
  });

  it('gives every case a rationale', () => {
    for (const c of CASES) expect(c.rationale.length, c.id).toBeGreaterThan(20);
  });

  it('declares allowed money for every case that fixtures a catalog', () => {
    for (const c of CASES) {
      const search = c.tools['search_catalog'];
      if (search === undefined) continue;
      let products: unknown[];
      try {
        products = (search({}) as { products: unknown[] }).products;
      } catch {
        continue; // deliberately failing fixture — nothing to reconcile
      }
      if (products.length > 0) {
        expect(c.truth.allowedMoney.length, `${c.id} fixtures products but allows no money`).toBeGreaterThan(0);
      }
    }
  });

  it('declares no allowed money for cases whose catalog is empty or broken', () => {
    for (const c of CASES) {
      const search = c.tools['search_catalog'];
      if (search === undefined || c.tools['get_policy'] !== undefined) continue;
      let empty = false;
      try {
        empty = (search({}) as { products: unknown[] }).products.length === 0;
      } catch {
        empty = true;
      }
      if (empty) {
        expect(c.truth.allowedMoney, `${c.id} has no catalog data but allows money`).toEqual([]);
      }
    }
  });
});
