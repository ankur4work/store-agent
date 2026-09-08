import { describe, expect, it } from 'vitest';
import { GROUNDING_SYSTEM_RULES } from '../src/schema.js';

/**
 * The system rules are a product surface, not prose: each line exists because a
 * specific failure was observed against a live catalog. These assert the rules
 * that were added in response to one, so a future edit cannot quietly drop the
 * fix and leave the failure to be rediscovered from a merchant report.
 */
describe('price field semantics in the system rules', () => {
  /**
   * A live compound question — "how much is the compare at price snowboard and
   * do you have hydrogen?" — failed 3 times out of 3, escalating each time. The
   * payload held both numbers (price 78595, list_price 88595) but nothing said
   * which one was the compare-at price, and the model's own escalation read
   * "I can't verify the snowboard's compare-at price". It had the answer in
   * front of it and could not name it, so it reached for the current price and
   * rounded it to $785 — which the tripwire then correctly killed.
   */
  it('defines list_price as the compare-at price', () => {
    expect(GROUNDING_SYSTEM_RULES).toMatch(/list_price_range/);
    expect(GROUNDING_SYSTEM_RULES).toMatch(/compare-at/i);
  });

  it('says which field is the price the shopper pays now', () => {
    expect(GROUNDING_SYSTEM_RULES).toMatch(/price_range/);
    expect(GROUNDING_SYSTEM_RULES).toMatch(/pays NOW/);
  });

  it('forbids inferring a compare-at price that is not there', () => {
    // Inventing a "was" price is a pricing claim about a discount that does not
    // exist — worse than declining to answer.
    expect(GROUNDING_SYSTEM_RULES).toMatch(/no\s+compare-at price/i);
  });

  it('still tells the model to copy the display string verbatim', () => {
    // The fix for the original rounding bug: the arithmetic is gone, so the
    // rule must keep pointing at the pre-formatted string.
    expect(GROUNDING_SYSTEM_RULES).toMatch(/display/);
    expect(GROUNDING_SYSTEM_RULES).toMatch(/VERBATIM/i);
  });

  it('still forbids rounding away the cents', () => {
    expect(GROUNDING_SYSTEM_RULES).toMatch(/\$785\.95/);
    expect(GROUNDING_SYSTEM_RULES).toMatch(/never \$785/);
  });
});
