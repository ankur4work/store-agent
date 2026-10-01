import { describe, expect, it } from 'vitest';
import {
  answerOptions,
  answerPageFact,
  answerPrice,
  answerStock,
  classifyPageFact,
  refersToPage,
  type FactProduct,
} from '../src/page-facts.js';

/**
 * The deterministic answer to the three questions a shopper asks on a product
 * page, and — more importantly — every case where it must refuse to answer.
 *
 * The refusals are the real subject here. A fast lane that answers 95% of
 * questions correctly and 5% confidently wrong is worse than no fast lane,
 * because the shopper has no way to tell which one they got. So most of these
 * tests assert `undefined`.
 */

/** A real product from the dev store: five variants, one axis, one price. */
const SNOWBOARD: FactProduct = {
  title: 'The Complete Snowboard',
  variants: [
    { id: '1', title: 'Ice', price: { amount: 69995, currency: 'USD' }, available: true, options: { Color: 'Ice' } },
    { id: '2', title: 'Dawn', price: { amount: 69995, currency: 'USD' }, available: true, options: { Color: 'Dawn' } },
    { id: '3', title: 'Powder', price: { amount: 69995, currency: 'USD' }, available: false, options: { Color: 'Powder' } },
  ],
};

const PAGE = { type: 'product', productId: '8944748757044', title: 'The Complete Snowboard' };
const usd = (amount: number, currency: string) =>
  `${currency === 'USD' ? '$' : currency + ' '}${(amount / 100).toFixed(2)}`;

describe('recognising the three questions', () => {
  it('recognises a price question', () => {
    for (const q of ['how much is it?', 'how much is this', "what's the price", 'price?', 'how much does this cost']) {
      expect(classifyPageFact(q, PAGE)?.kind, q).toBe('price');
    }
  });

  it('recognises a stock question', () => {
    for (const q of ['is this one in stock?', 'is it available', 'in stock?', 'is this sold out']) {
      expect(classifyPageFact(q, PAGE)?.kind, q).toBe('stock');
    }
  });

  it('recognises an options question, and which axis', () => {
    expect(classifyPageFact('what sizes does this come in?', PAGE)).toMatchObject({
      kind: 'options',
      axis: 'size',
    });
    expect(classifyPageFact('what colours does it come in', PAGE)).toMatchObject({
      kind: 'options',
      axis: 'colour',
    });
    // American spelling, same question.
    expect(classifyPageFact('what colors is this available in', PAGE)).toMatchObject({
      kind: 'options',
      axis: 'colour',
    });
    // No axis named — list everything.
    expect(classifyPageFact('what options does this have', PAGE)?.axis).toBeUndefined();
  });

  it('lets the shopper name the product instead of pointing at it', () => {
    expect(classifyPageFact('how much is the Complete Snowboard', PAGE)?.kind).toBe('price');
  });
});

describe('refusing, which is most of the job', () => {
  it('refuses when the shopper is talking about something else', () => {
    /**
     * The defect this guard exists for. "How much is the jacket" is made almost
     * entirely of price-question words, and answering it with the price of the
     * snowboard on screen would be a confident lie.
     */
    expect(classifyPageFact('how much is the jacket', PAGE)).toBeUndefined();
    expect(classifyPageFact('is the blue one in stock', PAGE)).toBeUndefined();
    expect(classifyPageFact('what sizes do your boots come in', PAGE)).toBeUndefined();
  });

  it('refuses a colour-specific existence question', () => {
    // "Does Navy count as blue" is a judgement. The model makes it better.
    expect(classifyPageFact('does this come in blue', PAGE)).toBeUndefined();
  });

  it('refuses when sizes and prices are asked together', () => {
    // The good answer is a table, and a template writes a bad one.
    expect(classifyPageFact('how much are the different sizes', PAGE)).toBeUndefined();
  });

  it('refuses anywhere that is not a product page', () => {
    expect(classifyPageFact('how much is it', { type: 'collection', productId: '1' })).toBeUndefined();
    expect(classifyPageFact('how much is it', { type: 'product' })).toBeUndefined();
    expect(classifyPageFact('how much is it', undefined)).toBeUndefined();
  });

  it('refuses a sentence long enough to be conversation', () => {
    expect(
      classifyPageFact('hi there I was wondering how much this one costs today please', PAGE),
    ).toBeUndefined();
  });

  it('refuses a question that is not one of the three', () => {
    expect(classifyPageFact('is it any good', PAGE)).toBeUndefined();
    expect(classifyPageFact('can i return it', PAGE)).toBeUndefined();
  });
});

describe('refersToPage', () => {
  it('accepts a deictic, the product name, or a bare fragment', () => {
    expect(refersToPage('how much is this', PAGE)).toBe(true);
    expect(refersToPage('how much is the snowboard', PAGE)).toBe(true);
    expect(refersToPage('how much?', PAGE)).toBe(true);
  });

  it('rejects a longer question that points at nothing', () => {
    expect(refersToPage('how much are the options and choices', PAGE)).toBe(false);
  });
});

describe('answering a price', () => {
  it('names the price of the selected variant', () => {
    expect(answerPrice(SNOWBOARD, 'Ice', usd)).toBe("It's $699.95.");
  });

  it('matches the selection by option value as well as title', () => {
    const byOption: FactProduct = {
      variants: [{ title: 'Snowboard - Ice', price: { amount: 100, currency: 'USD' }, options: { Color: 'Ice' } }],
    };
    expect(answerPrice(byOption, 'Ice', usd)).toBe("It's $1.00.");
  });

  it('speaks a range when nothing is selected and the variants differ', () => {
    /**
     * Picking one price here would be the uncited-price failure with no model in
     * the loop to be caught by the tripwire.
     */
    const ranged: FactProduct = {
      variants: [
        { title: 'S', price: { amount: 1000, currency: 'USD' } },
        { title: 'L', price: { amount: 2500, currency: 'USD' } },
      ],
    };
    expect(answerPrice(ranged, undefined, usd)).toBe('It ranges from $10.00 to $25.00.');
  });

  it('collapses a range that is not one', () => {
    expect(answerPrice(SNOWBOARD, undefined, usd)).toBe("It's $699.95.");
  });

  it('never rounds', () => {
    const odd: FactProduct = { variants: [{ title: 'x', price: { amount: 69999, currency: 'USD' } }] };
    expect(answerPrice(odd, 'x', usd)).toContain('699.99');
  });

  it('gives the turn away when there is no price', () => {
    expect(answerPrice({ variants: [{ title: 'x' }] }, 'x', usd)).toBeUndefined();
    expect(answerPrice({}, undefined, usd)).toBeUndefined();
  });

  it('does not mix currencies into one range', () => {
    // A range across two currencies is a meaningless number.
    const mixed: FactProduct = {
      variants: [
        { title: 'a', price: { amount: 1000, currency: 'USD' } },
        { title: 'b', price: { amount: 900, currency: 'EUR' } },
      ],
    };
    expect(answerPrice(mixed, undefined, usd)).toBe("It's $10.00.");
  });
});

describe('answering stock', () => {
  it('answers for the selected variant by name', () => {
    expect(answerStock(SNOWBOARD, 'Ice')).toBe('Yes, the Ice is in stock.');
    expect(answerStock(SNOWBOARD, 'Powder')).toBe('The Powder is sold out.');
  });

  it('answers for the product when nothing is selected', () => {
    const all: FactProduct = { variants: [{ title: 'a', available: true }, { title: 'b', available: true }] };
    expect(answerStock(all, undefined)).toBe('Yes, it’s in stock.');
  });

  it('says which ones, when only some are', () => {
    expect(answerStock(SNOWBOARD, undefined)).toBe('Yes — Ice and Dawn are in stock.');
  });

  it('says so when nothing is left', () => {
    const none: FactProduct = { variants: [{ title: 'a', available: false }] };
    expect(answerStock(none, undefined)).toBe('It’s sold out at the moment.');
  });

  it('gives the turn away rather than inventing availability', () => {
    /**
     * A store that does not report `available` must not be answered for. This is
     * the single most dangerous sentence in the file — "yes, it's in stock" on a
     * sold-out product is a cancelled order and a refund.
     */
    expect(answerStock({ variants: [{ title: 'a' }] }, 'a')).toBeUndefined();
    expect(answerStock({}, undefined)).toBeUndefined();
  });

  it('does not read a placeholder variant name aloud', () => {
    const single: FactProduct = { variants: [{ title: 'Default Title', available: true }] };
    expect(answerStock(single, 'Default Title')).toBe('Yes, that one is in stock.');
  });
});

describe('answering options', () => {
  it('lists the axis that was asked for', () => {
    expect(answerOptions(SNOWBOARD, 'colour')).toBe('It comes in Ice, Dawn and Powder.');
  });

  it('answers a size question about an unsized product with what IS choosable', () => {
    // Measured: the model spent 3.5 s producing this sentence.
    expect(answerOptions(SNOWBOARD, 'size')).toBe(
      'It comes in one size. The choice is color: Ice, Dawn and Powder.',
    );
  });

  it('lists every axis when none was named', () => {
    const two: FactProduct = {
      variants: [
        { title: 'S / Ice', options: { Size: 'S', Color: 'Ice' } },
        { title: 'L / Dawn', options: { Size: 'L', Color: 'Dawn' } },
      ],
    };
    expect(answerOptions(two, undefined)).toBe('It comes in size: S and L and color: Ice and Dawn.');
    expect(answerOptions(two, 'size')).toBe('It comes in S and L.');
  });

  it('falls back to variant titles when the store sends no option names', () => {
    const titled: FactProduct = { variants: [{ title: 'Small' }, { title: 'Large' }] };
    expect(answerOptions(titled, undefined)).toBe('It comes in Small and Large.');
  });

  it('keeps a long list speakable', () => {
    const many: FactProduct = {
      variants: Array.from({ length: 9 }, (_, i) => ({ title: `v${i}`, options: { Size: `v${i}` } })),
    };
    const said = answerOptions(many, 'size');
    expect(said).toBe('It comes in v0, v1, v2, v3 and v4 and 4 more.');
  });

  it('gives the turn away for a product with no options at all', () => {
    expect(answerOptions({ variants: [{ title: 'Default Title' }] }, undefined)).toBeUndefined();
    expect(answerOptions({}, 'size')).toBeUndefined();
  });
});

/**
 * The shape the dev store actually sends, copied off the wire.
 *
 * It differs from the declared UCP type in three ways, and each one was a wrong
 * answer the shopper would have heard out loud:
 *
 * - `options: [{name, label}]`, not `{name: value}` — gave "The choice is 0:
 *   [object Object]", spoken aloud, in production phrasing.
 * - `availability: {available}`, not `available` — every stock question silently
 *   declined to the model, which is why the fast lane looked like it worked.
 * - `price.display` — the merchant's own formatted figure, which we should quote
 *   rather than re-derive.
 *
 * Tested as its own suite because a reader that only handles the spec handles no
 * real store.
 */
describe('the shape a real store sends', () => {
  const LIVE: FactProduct = {
    title: 'The Complete Snowboard',
    variants: [
      {
        id: 'gid://shopify/ProductVariant/48297380675636',
        title: 'Ice',
        price: { amount: 69995, currency: 'USD', display: '$699.95' },
        availability: { available: true },
        options: [{ name: 'Color', label: 'Ice' }],
      },
      {
        id: 'gid://shopify/ProductVariant/48297380708404',
        title: 'Dawn',
        price: { amount: 69995, currency: 'USD', display: '$699.95' },
        availability: { available: false },
        options: [{ name: 'Color', label: 'Dawn' }],
      },
    ],
  };

  it('reads the price, preferring the store’s own formatting', () => {
    expect(answerPrice(LIVE, 'Ice', () => 'WRONG')).toBe("It's $699.95.");
  });

  it('reads availability from where it actually lives', () => {
    expect(answerStock(LIVE, 'Ice')).toBe('Yes, the Ice is in stock.');
    expect(answerStock(LIVE, 'Dawn')).toBe('The Dawn is sold out.');
  });

  it('reads the option list from an array of name/label pairs', () => {
    // Not "0: [object Object]".
    expect(answerOptions(LIVE, 'colour')).toBe('It comes in Ice and Dawn.');
    const said = answerOptions(LIVE, 'size')!;
    expect(said).toBe('It comes in one size. The choice is color: Ice and Dawn.');
    expect(said).not.toContain('[object Object]');
  });

  it('matches the selected variant by its option label', () => {
    const labelled: FactProduct = {
      variants: [
        {
          title: 'Snowboard — Ice',
          price: { amount: 100, currency: 'USD', display: '$1.00' },
          options: [{ name: 'Color', label: 'Ice' }],
        },
      ],
    };
    expect(answerPrice(labelled, 'Ice', () => 'WRONG')).toBe("It's $1.00.");
  });

  it('still falls back to our formatter when the store sends no display', () => {
    const noDisplay: FactProduct = {
      variants: [{ title: 'Ice', price: { amount: 69995, currency: 'USD' } }],
    };
    expect(answerPrice(noDisplay, 'Ice', usd)).toBe("It's $699.95.");
  });

  it('speaks a range using each variant’s own formatting', () => {
    const ranged: FactProduct = {
      variants: [
        { title: 'S', price: { amount: 1000, currency: 'USD', display: '$10.00' } },
        { title: 'L', price: { amount: 2500, currency: 'USD', display: '$25.00' } },
      ],
    };
    expect(answerPrice(ranged, undefined, () => 'WRONG')).toBe('It ranges from $10.00 to $25.00.');
  });

  it('accepts the other array spelling, value instead of label', () => {
    const valued: FactProduct = {
      variants: [{ title: 'M', options: [{ name: 'Size', value: 'M' }] }],
    };
    expect(answerOptions(valued, 'size')).toBe('It comes in M.');
  });
});

describe('answerPageFact', () => {
  it('routes each kind to its answer', () => {
    const price = classifyPageFact('how much is it', PAGE)!;
    expect(answerPageFact(price, SNOWBOARD, 'Ice', usd)).toBe("It's $699.95.");

    const stock = classifyPageFact('is this in stock', PAGE)!;
    expect(answerPageFact(stock, SNOWBOARD, 'Ice', usd)).toBe('Yes, the Ice is in stock.');

    const options = classifyPageFact('what sizes does this come in', PAGE)!;
    expect(answerPageFact(options, SNOWBOARD, 'Ice', usd)).toContain('one size');
  });

  it('is short enough to be spoken, in every branch', () => {
    /**
     * These are read aloud. A sentence that takes eight seconds to say undoes the
     * four seconds this whole file saves.
     */
    for (const q of ['how much is it', 'is this in stock', 'what colours does it come in']) {
      const req = classifyPageFact(q, PAGE)!;
      const said = answerPageFact(req, SNOWBOARD, 'Ice', usd)!;
      expect(said.split(/\s+/).length, said).toBeLessThanOrEqual(14);
    }
  });
});
