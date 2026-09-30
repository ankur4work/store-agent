import { describe, expect, it } from 'vitest';
import { extractPreferences, mergePreferences, renderPreferences } from '../src/preferences.js';

/**
 * Like the intent classifier, this is mostly tested on what it REFUSES.
 *
 * A wrong remembered preference is worse than none: a size the shopper never
 * gave silently narrows every later recommendation, and they never find out why
 * the assistant keeps showing them the wrong thing. So the bar for recording
 * anything is "they stated it about themselves", not "the word appeared".
 */

describe('size', () => {
  it('records a size the shopper states about themselves', () => {
    expect(extractPreferences("I'm a medium").size).toBe('M');
    expect(extractPreferences('i am a large').size).toBe('L');
    expect(extractPreferences('I take a 9.5').size).toBe('9.5');
    expect(extractPreferences('I wear an XL').size).toBe('XL');
    expect(extractPreferences('my size is small').size).toBe('S');
  });

  it('ignores a question about stock', () => {
    // "do you have a large" is about the shop, not about the person asking.
    expect(extractPreferences('do you have a large').size).toBeUndefined();
    expect(extractPreferences('got any medium left').size).toBeUndefined();
    expect(extractPreferences('is there a size 9').size).toBeUndefined();
  });

  it('ignores a bare size word', () => {
    // "medium" is also a coffee, a heat setting, and half of "medium blue".
    expect(extractPreferences('medium').size).toBeUndefined();
    expect(extractPreferences('the medium blue one').size).toBeUndefined();
  });

  it('will not turn a price or a year into a shoe size', () => {
    expect(extractPreferences('I take a 2026').size).toBeUndefined();
    expect(extractPreferences('size 4500').size).toBeUndefined();
  });
});

describe('budget', () => {
  it('records an upper bound that was framed as one', () => {
    expect(extractPreferences('something under £50').budgetMaxMinor).toBe(5000);
    expect(extractPreferences('my budget is about 120').budgetMaxMinor).toBe(12000);
    expect(extractPreferences('no more than $75.50').budgetMaxMinor).toBe(7550);
  });

  it('does not treat a product price as a budget', () => {
    /**
     * "it's £200" is a statement about a thing, not a limit on the shopper.
     * Recording it would cap every later recommendation at a number they never
     * set, and they would never learn why nothing dear was ever shown.
     */
    expect(extractPreferences("it's £200").budgetMaxMinor).toBeUndefined();
    expect(extractPreferences('the coat costs 300').budgetMaxMinor).toBeUndefined();
  });
});

describe('colour', () => {
  it('records a stated preference', () => {
    expect(extractPreferences("I'd like something in black").colour).toBe('black');
    expect(extractPreferences('looking for a navy coat').colour).toBe('navy');
    expect(extractPreferences('I prefer grey').colour).toBe('grey');
  });

  it('normalises the two spellings of grey', () => {
    expect(extractPreferences('I prefer gray').colour).toBe('grey');
  });

  it('does not turn a question into a standing instruction', () => {
    // Asking whether the black one is in stock is not "only ever show me black".
    expect(extractPreferences('is the black one in stock').colour).toBeUndefined();
    expect(extractPreferences('what colours does it come in').colour).toBeUndefined();
  });
});

describe('occasion', () => {
  it('records what they are shopping for', () => {
    expect(extractPreferences('something warm for a wedding').occasion).toBe('wedding');
    expect(extractPreferences('I need trainers for running').occasion).toBe('running');
  });

  it('has no opinion when nothing was said', () => {
    expect(extractPreferences('how much is this')).toEqual({});
  });
});

describe('several at once, which is how people actually talk', () => {
  it('reads a whole sentence', () => {
    const p = extractPreferences("I'm a medium and I'd like something in navy under £80 for a wedding");
    expect(p).toEqual({ size: 'M', colour: 'navy', budgetMaxMinor: 8000, occasion: 'wedding' });
  });
});

describe('mergePreferences', () => {
  it('lets the newer statement win, because people change their minds', () => {
    // Rule 12: if the shopper changes direction, update context.
    const after = mergePreferences({ colour: 'black', size: 'M' }, { colour: 'navy' });
    expect(after).toEqual({ colour: 'navy', size: 'M' });
  });

  it('never forgets through silence', () => {
    // Not mentioning a size again does not mean they stopped having one.
    expect(mergePreferences({ size: 'M' }, {})).toEqual({ size: 'M' });
  });
});

describe('renderPreferences', () => {
  it('says what is known and forbids asking again', () => {
    // The failure being fixed is not the model forgetting — it is the model
    // asking anyway.
    const line = renderPreferences({ size: 'M', colour: 'navy', budgetMaxMinor: 8000 });
    expect(line).toContain('size M');
    expect(line).toContain('prefers navy');
    expect(line).toContain('budget up to 80.00');
    expect(line).toMatch(/Do not ask for any of these again/);
  });

  it('is empty when nothing is known, rather than saying so', () => {
    // "The shopper has told you nothing" would be tokens spent on every early
    // turn to convey the absence of information.
    expect(renderPreferences({})).toBe('');
  });

  it('writes money with both decimal places', () => {
    // Same rule as everywhere else: never a rounded amount.
    expect(renderPreferences({ budgetMaxMinor: 7550 })).toContain('75.50');
    expect(renderPreferences({ budgetMaxMinor: 8000 })).toContain('80.00');
  });
});
