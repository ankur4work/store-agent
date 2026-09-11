import { describe, expect, it } from 'vitest';
import { restoreCents } from '../src/money.js';

/**
 * Models abbreviate prices in prose — "$9" for a $9.95 wax, "$785" for a
 * $785.95 board — most often in lists and ranges. The guard is right to
 * refuse those: $9 is not the price. But refusing threw away an otherwise
 * correct answer and sent the shopper to a human for a price the catalog
 * knew exactly, and neither hiding the raw amounts nor naming the exact
 * string in the retry stopped the model doing it.
 *
 * This writes prices a shopper reads, so the rules are narrow on purpose and
 * every boundary below is load-bearing.
 */
describe('restoring cents on an abbreviated price', () => {
  const SOURCES = [995, 4995, 78595, 69995]; // $9.95, $49.95, $785.95, $699.95

  it('expands a bare dollar figure to the catalog price it abbreviated', () => {
    const r = restoreCents('Selling Plans Ski Wax starts at $9.', SOURCES);
    expect(r.reply).toBe('Selling Plans Ski Wax starts at $9.95.');
    expect(r.repaired).toEqual(['$9→$9.95']);
  });

  it('repairs every abbreviation in a range', () => {
    const r = restoreCents('From $9 to $49.', SOURCES);
    expect(r.reply).toBe('From $9.95 to $49.95.');
  });

  it('leaves a price that is already exact alone', () => {
    const r = restoreCents('It is $785.95.', SOURCES);
    expect(r.reply).toBe('It is $785.95.');
    expect(r.repaired).toEqual([]);
  });

  it('leaves a real whole-dollar price alone', () => {
    // $600.00 is genuinely the price; there is nothing to restore.
    const r = restoreCents('It is $600.', [60000]);
    expect(r.reply).toBe('It is $600.');
  });

  it('refuses to choose when two catalog prices share the dollar', () => {
    // $9.50 and $9.95 both match "$9" — guessing either could misquote.
    const r = restoreCents('From $9.', [950, 995]);
    expect(r.reply).toBe('From $9.');
    expect(r.repaired).toEqual([]);
  });

  it('never invents a price that is not in the catalog', () => {
    const r = restoreCents('It is $42.', SOURCES);
    expect(r.reply).toBe('It is $42.');
  });

  it('does not touch a figure written with cents, even a wrong one', () => {
    // "$9.00" is an assertion, not an abbreviation. It must still fail
    // validation rather than be silently corrected.
    const r = restoreCents('It is $9.00.', SOURCES);
    expect(r.reply).toBe('It is $9.00.');
    expect(r.repaired).toEqual([]);
  });

  it('handles thousands separators and other currencies', () => {
    expect(restoreCents('£1,025 today', [102595]).reply).toBe('£1,025.95 today');
  });

  it('does not run past the dollars into a following number', () => {
    const r = restoreCents('$9 and 95 reviews', SOURCES);
    expect(r.reply).toBe('$9.95 and 95 reviews');
  });
});
