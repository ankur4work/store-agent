import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  classifyIntent,
  mentionsColour,
  parseAmountMinor,
  priceMinorOf,
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
