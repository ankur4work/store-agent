import { describe, expect, it } from 'vitest';
import { GroundingTripwire, completedSentences, settledPrefix } from '../src/incremental.js';
import { SEARCH_RESULT, SOLD_OUT_RESULT } from './fixtures.js';

/**
 * The tripwire lets us stream safely: it kills a generation the moment an
 * unsupported fact is fully typed, so a shopper never sees a hallucinated
 * price — not even for the second it would take to retract it.
 */
describe('settledPrefix — partial-token safety', () => {
  it('withholds a trailing number that may still be growing', () => {
    // "$18" must not be judged while "$189.00" is still arriving.
    expect(settledPrefix('The coat is $18')).toBe('The coat is ');
  });

  it('withholds a trailing decimal mid-typing', () => {
    expect(settledPrefix('costs $189.')).toBe('costs ');
  });

  it('withholds a trailing partial word', () => {
    expect(settledPrefix('It is in sto')).toBe('It is in ');
  });

  it('settles everything once punctuation lands', () => {
    expect(settledPrefix('The coat is $189.00.')).toBe('The coat is $189.00.');
  });

  it('settles a completed number followed by a space', () => {
    expect(settledPrefix('The coat is $189.00 and')).toBe('The coat is $189.00 ');
  });

  it('handles an empty buffer', () => {
    expect(settledPrefix('')).toBe('');
  });
});

describe('completedSentences', () => {
  it('returns only up to the last terminator', () => {
    expect(completedSentences('One. Two! Three and')).toBe('One. Two!');
  });
  it('returns empty when nothing has terminated', () => {
    expect(completedSentences('no end yet')).toBe('');
  });
});

describe('GroundingTripwire', () => {
  it('stays quiet while a supported price is being typed', () => {
    const t = new GroundingTripwire([SEARCH_RESULT]);
    for (const partial of ['The coat is $1', 'The coat is $18', 'The coat is $189', 'The coat is $189.00']) {
      expect(t.check(partial), `tripped early on "${partial}"`).toBeUndefined();
    }
    expect(t.check('The coat is $189.00.')).toBeUndefined();
  });

  it('fires as soon as an unsupported price is complete', () => {
    const t = new GroundingTripwire([SEARCH_RESULT]);
    expect(t.check('The coat is $99')).toBeUndefined(); // still growing
    const v = t.check('The coat is $99.00 today');
    expect(v?.code).toBe('uncited_price');
    expect(v?.evidence).toBe('99.00');
  });

  it('fires only once', () => {
    const t = new GroundingTripwire([SEARCH_RESULT]);
    expect(t.check('It is $99.00 and also $77.00 ')).toBeDefined();
    expect(t.check('It is $99.00 and also $77.00 more')).toBeUndefined();
  });

  it('allows a legitimate two-item sum', () => {
    const t = new GroundingTripwire([SEARCH_RESULT]);
    expect(t.check('Together that is $268.00. ')).toBeUndefined();
  });

  it('fires on a stock claim that contradicts the source', () => {
    const t = new GroundingTripwire([SOLD_OUT_RESULT]);
    const v = t.check('Good news, it is in stock. ');
    expect(v?.code).toBe('stock_contradicts_source');
  });

  it('does not fire on stock language mid-word', () => {
    const t = new GroundingTripwire([SOLD_OUT_RESULT]);
    expect(t.check('Good news, it is in sto')).toBeUndefined();
  });

  it('does not fire on an accurate out-of-stock statement', () => {
    const t = new GroundingTripwire([SOLD_OUT_RESULT]);
    expect(t.check('That one is sold out. ')).toBeUndefined();
  });

  it('fires on any price when no tool results exist', () => {
    const t = new GroundingTripwire([]);
    expect(t.check('It costs about $80.00 usually')?.code).toBe('uncited_price');
  });

  it('ignores non-money numbers', () => {
    const t = new GroundingTripwire([SEARCH_RESULT]);
    expect(t.check('Rated 4.6 by 212 shoppers. ')).toBeUndefined();
  });
});
