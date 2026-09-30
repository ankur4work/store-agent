import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  classifyIntent,
  mentionsColour,
  parseAmountMinor,
  priceMinorOf,
  suggestChips,
} from '../src/intents.js';

/**
 * The deterministic lane's tests are mostly about what it REFUSES.
 *
 * A router that swallows an ambiguous turn is worse than no router: the shopper
 * gets a confidently wrong answer and nothing anywhere records that a model was
 * skipped. So the interesting cases here are the near-misses — phrases that look
 * like a filter and must go to the model anyway.
 */

const ctx = { visibleProducts: 6, hasCart: false };

describe('cart reads', () => {
  it('recognises the ordinary ways of asking', () => {
    for (const m of [
      'open cart',
      'show my cart',
      "what's in my cart",
      'what is in the cart',
      'view my basket',
      'check my bag',
      'my cart',
    ]) {
      expect(classifyIntent(m, ctx).kind, m).toBe('cart');
    }
  });

  it('refuses a bare "cart", because a shop can sell carts', () => {
    // "do you have a cart" is a catalogue question in a garden centre.
    expect(classifyIntent('cart', ctx).kind).toBe('none');
    expect(classifyIntent('do you have a cart', ctx).kind).toBe('none');
    expect(classifyIntent('any carts in stock', ctx).kind).toBe('none');
  });

  it('refuses anything that would CHANGE the cart', () => {
    // Reading is safe to do without a model. Mutating is not: "remove the
    // second one" needs to be understood, not matched.
    for (const m of [
      'add this to my cart',
      'remove it from my cart',
      'empty my cart',
      'clear the cart',
      'cancel my cart',
      'checkout with my cart',
    ]) {
      expect(classifyIntent(m, ctx).kind, m).toBe('none');
    }
  });

  it('refuses a question about how the cart works', () => {
    expect(classifyIntent('how do i see my cart?', ctx).kind).toBe('none');
    expect(classifyIntent('can i save my cart for later', ctx).kind).toBe('none');
  });

  it('answers a cart read even with no cart yet', () => {
    // "nothing in it yet" is exact, and needs no model either.
    expect(classifyIntent('show my cart', { visibleProducts: 0, hasCart: false }).kind).toBe('cart');
  });
});

describe('narrowing what is on screen', () => {
  it('recognises a colour narrowing', () => {
    const i = classifyIntent('just the blue ones', ctx);
    expect(i.kind).toBe('filter');
    if (i.kind === 'filter') expect(i.filter.colour).toBe('blue');
  });

  it('normalises the two spellings of grey', () => {
    const i = classifyIntent('show me the gray ones', ctx);
    if (i.kind !== 'filter') throw new Error('expected a filter');
    expect(i.filter.colour).toBe('grey');
  });

  it('reads a price ceiling, in digits or in words', () => {
    for (const [m, minor] of [
      ['only the ones under $50', 5000],
      ['just those under fifty', 5000],
      ['show me ones under twenty five dollars', 2500],
      ['only ones below 49.99', 4999],
    ] as const) {
      const i = classifyIntent(m, ctx);
      if (i.kind !== 'filter') throw new Error(`expected a filter for "${m}"`);
      expect(i.filter.maxMinor, m).toBe(minor);
    }
  });

  it('treats a relative ask as a ranking, not a cut', () => {
    // "cheaper" with no number cannot be a threshold, and guessing one would
    // hide products the shopper might want.
    const i = classifyIntent('cheaper ones', ctx);
    if (i.kind !== 'filter') throw new Error('expected a filter');
    expect(i.filter.cheaper).toBe(true);
    expect(i.filter.maxMinor).toBeUndefined();
  });

  /**
   * THE case this module exists to get right.
   *
   * "do you have these in blue" looks exactly like a colour filter. It is not:
   * the blue one may exist and simply not be among the six results on screen, so
   * answering from the visible set would tell a shopper the store does not stock
   * something it does.
   */
  it('hands existence questions to the model even when they name a colour', () => {
    for (const m of [
      'do you have these in blue',
      'do you sell blue ones',
      'is there a blue one',
      'are there any under fifty',
      'can i get it in black',
    ]) {
      expect(classifyIntent(m, ctx).kind, m).toBe('none');
    }
  });

  it('refuses to narrow when there is nothing on screen', () => {
    // With no visible set, "show me the blue ones" is a fresh search.
    expect(classifyIntent('show me the blue ones', { visibleProducts: 0, hasCart: false }).kind).toBe(
      'none',
    );
  });

  it('refuses a sentence, which is conversation rather than a command', () => {
    expect(
      classifyIntent(
        'I liked the blue one but I am not sure it will suit the room it is going in',
        ctx,
      ).kind,
    ).toBe('none');
  });

  it('refuses narrowing words with nothing to narrow by', () => {
    expect(classifyIntent('show me those ones', ctx).kind).toBe('none');
    expect(classifyIntent('just those', ctx).kind).toBe('none');
  });

  it('refuses an unusual colour name rather than matching a coincidence', () => {
    // "sage" and "oatmeal" are real colours and also ordinary words that appear
    // in product text for other reasons.
    expect(classifyIntent('just the sage ones', ctx).kind).toBe('none');
  });
});

describe('parseAmountMinor', () => {
  it('reads digits, with or without a symbol or decimals', () => {
    expect(parseAmountMinor('$50')).toBe(5000);
    expect(parseAmountMinor('under 50')).toBe(5000);
    expect(parseAmountMinor('49.99')).toBe(4999);
    expect(parseAmountMinor('£120')).toBe(12000);
  });

  it('reads the spelled numbers a voice transcript produces', () => {
    // "under fifty dollars" is how someone says it out loud, and the transcript
    // carries exactly that.
    expect(parseAmountMinor('fifty')).toBe(5000);
    expect(parseAmountMinor('twenty five')).toBe(2500);
    expect(parseAmountMinor('a hundred')).toBe(10000);
  });

  it('has no opinion where there is no number', () => {
    expect(parseAmountMinor('cheaper please')).toBeUndefined();
  });
});

describe('reading a price off a product', () => {
  const p = (variants: unknown[]) => ({ variants });

  it('takes the cheapest readable variant', () => {
    expect(priceMinorOf(p([{ price: 7995 }, { price: 4995 }]))).toBe(4995);
  });

  it('copes with the shapes UCP actually returns', () => {
    expect(priceMinorOf(p([{ priceMinor: 1200 }]))).toBe(1200);
    expect(priceMinorOf(p([{ amount: 3400 }]))).toBe(3400);
  });

  it('is undefined rather than zero when nothing is readable', () => {
    // Zero would make a product look free and pass every "under" filter.
    expect(priceMinorOf(p([{}]))).toBeUndefined();
    expect(priceMinorOf({})).toBeUndefined();
    expect(priceMinorOf(null)).toBeUndefined();
  });
});

describe('mentionsColour', () => {
  it('finds a colour in the title', () => {
    expect(mentionsColour({ title: 'Navy Wool Overcoat' }, 'navy')).toBe(true);
  });

  it('finds one in variant options, which is where it usually lives', () => {
    expect(
      mentionsColour(
        { title: 'Wool Overcoat', variants: [{ selectedOptions: [{ name: 'Colour', value: 'Black' }] }] },
        'black',
      ),
    ).toBe(true);
  });

  it('does not match a colour inside another word', () => {
    // "Redwood" is not red, and "Blackberry" is not black.
    expect(mentionsColour({ title: 'Redwood Deck Oil' }, 'red')).toBe(false);
    expect(mentionsColour({ title: 'Blackberry Jam' }, 'black')).toBe(false);
  });
});

describe('applyFilter', () => {
  const cheapBlue = { title: 'Blue Tee', variants: [{ price: 1500 }] };
  const dearBlue = { title: 'Blue Coat', variants: [{ price: 18000 }] };
  const red = { title: 'Red Tee', variants: [{ price: 1200 }] };
  const priceless = { title: 'Blue Mystery', variants: [{}] };
  const all = [dearBlue, red, cheapBlue, priceless];

  it('narrows by colour', () => {
    expect(applyFilter(all, { colour: 'blue' })).toEqual([dearBlue, cheapBlue, priceless]);
  });

  it('narrows by a ceiling', () => {
    expect(applyFilter(all, { maxMinor: 1300 })).toEqual([red]);
  });

  it('drops a product whose price cannot be read from a price filter', () => {
    // Showing something as "under fifty" without knowing its price is exactly
    // the claim the grounding layer exists to prevent.
    expect(applyFilter([priceless], { maxMinor: 100000 })).toEqual([]);
  });

  it('ranks rather than cuts for a relative ask', () => {
    // The shopper still sees every option, cheapest first.
    const out = applyFilter(all, { cheaper: true });
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(red);
    // Unreadable prices sort last rather than vanishing.
    expect(out[3]).toBe(priceless);
  });

  it('combines colour and price', () => {
    expect(applyFilter(all, { colour: 'blue', maxMinor: 2000 })).toEqual([cheapBlue]);
  });

  it('never grows the set', () => {
    expect(applyFilter([red], { colour: 'blue' }).length).toBeLessThanOrEqual(1);
  });

  it('does not mutate what it was given', () => {
    const input = [dearBlue, cheapBlue];
    applyFilter(input, { cheaper: true });
    expect(input).toEqual([dearBlue, cheapBlue]);
  });
});

/**
 * Chips are the visible half of the deterministic lane.
 *
 * Each one is written to be a phrase the classifier recognises, so tapping it is
 * answered in milliseconds for no tokens. And each is VERIFIED before it is
 * offered — run through the real classifier and the real filter — which rules
 * out the two ways a suggestion insults the shopper: offering "the blue ones"
 * when nothing is blue, and offering it when everything is.
 */
describe('suggestChips', () => {
  const blue = { title: 'Blue Tee', variants: [{ price: 1500 }] };
  const red = { title: 'Red Tee', variants: [{ price: 1200 }] };
  const navy = { title: 'Navy Coat', variants: [{ price: 18000 }] };

  it('offers one colour, and one that splits the set', () => {
    // One, not three: "blue / red / navy" is the same axis three times and
    // crowds out the price options. Which one is a deterministic tie-break on
    // COLOURS order, so this asserts the property rather than the winner.
    const chips = suggestChips([blue, red, navy]);
    const colours = chips.filter((c) => c.kind === 'colour');
    expect(colours).toHaveLength(1);
    expect(['blue', 'red', 'navy']).toContain(colours[0]!.colour);
  });

  it('prefers the colour that splits most evenly', () => {
    // A colour matching one product in twelve barely narrows anything, and the
    // shopper can already see it.
    const blues = Array.from({ length: 4 }, (_, i) => ({
      title: `Blue ${i}`,
      variants: [{ price: 1000 + i }],
    }));
    const chips = suggestChips([...blues, red, { title: 'Green Hat', variants: [{ price: 900 }] }]);
    expect(chips.find((c) => c.kind === 'colour')?.colour).toBe('blue');
  });

  it('never offers a colour nothing has', () => {
    // A dead end, and it says plainly that nothing looked at the products.
    const chips = suggestChips([blue, red]);
    expect(chips.some((c) => c.colour === 'green')).toBe(false);
  });

  it('never offers a colour everything has', () => {
    // Tapping it would change nothing on screen.
    const chips = suggestChips([blue, { title: 'Blue Coat', variants: [{ price: 9000 }] }]);
    expect(chips.some((c) => c.colour === 'blue')).toBe(false);
  });

  it('offers a price threshold taken from the data, not a round number', () => {
    // A shop selling £180 coats needs a threshold that splits ITS prices; "under
    // 50" would match nothing.
    const chips = suggestChips([navy, red, blue]);
    const under = chips.find((c) => c.kind === 'under');
    expect(under).toBeDefined();
    expect(under!.maxMinor).toBe(1500);
  });

  it('offers cheaper only when the order would actually change', () => {
    const chips = suggestChips([navy, blue, red]);
    expect(chips.some((c) => c.kind === 'cheaper')).toBe(true);
    // Already cheapest-first: the chip would visibly do nothing.
    const sorted = suggestChips([red, blue, navy]);
    expect(sorted.some((c) => c.kind === 'cheaper')).toBe(false);
  });

  it('offers nothing when prices are identical', () => {
    const a = { title: 'A Tee', variants: [{ price: 1000 }] };
    const b = { title: 'B Tee', variants: [{ price: 1000 }] };
    const chips = suggestChips([a, b]);
    expect(chips.some((c) => c.kind === 'cheaper' || c.kind === 'under')).toBe(false);
  });

  it('offers to widen when there is nothing left to narrow', () => {
    /**
     * One product cannot be narrowed, and an empty chip row is worst exactly
     * there: a shopper looking at a single result is the one most in need of a
     * next step. This chip IS a model turn, unlike the others, and it is offered
     * only where there is genuinely nothing cheaper to do.
     */
    const chips = suggestChips([blue]);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.kind).toBe('similar');
    expect(chips[0]!.message).toBe('something like the Blue Tee');
  });

  it('offers nothing for an empty set, or a product with no name', () => {
    expect(suggestChips([])).toEqual([]);
    expect(suggestChips([{ variants: [{ price: 100 }] }])).toEqual([]);
  });

  it('every chip it offers is answerable without a model', () => {
    // The contract that makes chips free. If one of these stopped classifying,
    // tapping it would silently start costing a turn.
    const products = [navy, red, blue, { title: 'Green Hat', variants: [{ price: 2000 }] }];
    const chips = suggestChips(products, 5);
    expect(chips.length).toBeGreaterThan(0);
    // 'similar' is deliberately a model turn and only appears for a single
    // product; every narrowing chip must classify.
    for (const chip of chips.filter((c) => c.kind !== 'similar')) {
      const intent = classifyIntent(chip.message, {
        visibleProducts: products.length,
        hasCart: false,
      });
      expect(intent.kind, chip.message).toBe('filter');
    }
  });

  it('respects the maximum, because a wall of chips is not a suggestion', () => {
    const many = [navy, red, blue, { title: 'Green Hat', variants: [{ price: 2000 }] }];
    expect(suggestChips(many, 2).length).toBeLessThanOrEqual(2);
  });
});
