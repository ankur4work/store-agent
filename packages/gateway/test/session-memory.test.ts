import { describe, expect, it } from 'vitest';
import { renderTurnContext } from '@storeagent/orchestrator';
import { openDatabase, SqliteSessionStore } from '../src/store/sqlite.js';
import { MemorySessionStore, newSession, readPreferences, readVisibleProducts } from '../src/sessions.js';

/**
 * What a session remembers between turns, and what it refuses to.
 *
 * Two things were added here: the products the shopper can see, so "just the blue
 * ones" needs no model, and the preferences they stated, so the assistant stops
 * asking for a size it was already given. Both are only useful if they survive a
 * round trip through the store, and both are only SAFE if what comes back is
 * checked — this JSON reaches the model as an instruction about the shopper.
 */

describe('preferences survive a round trip', () => {
  it('through the SQLite store', async () => {
    const db = openDatabase({ path: ':memory:' });
    const store = new SqliteSessionStore(db);

    const s = newSession('sess-1', 'acme.myshopify.com');
    s.preferences = { size: 'M', colour: 'navy', budgetMaxMinor: 8000, occasion: 'wedding' };
    s.products = [{ title: 'Navy Coat' }];
    await store.put(s);

    const back = await store.get('sess-1');
    expect(back?.preferences).toEqual({
      size: 'M',
      colour: 'navy',
      budgetMaxMinor: 8000,
      occasion: 'wedding',
    });
    expect(back?.products).toEqual([{ title: 'Navy Coat' }]);
  });

  it('through the in-memory store, which is what a single node uses', async () => {
    const store = new MemorySessionStore();
    const s = newSession('sess-2', 'acme.myshopify.com');
    s.preferences = { size: 'L' };
    await store.put(s);
    expect((await store.get('sess-2'))?.preferences).toEqual({ size: 'L' });
  });

  it('is absent, not empty, on a session that has learned nothing', async () => {
    const db = openDatabase({ path: ':memory:' });
    const store = new SqliteSessionStore(db);
    await store.put(newSession('sess-3', 'acme.myshopify.com'));
    const back = await store.get('sess-3');
    expect(back?.preferences).toBeUndefined();
    expect(back?.products).toBeUndefined();
  });

  it('reads a row written before the columns existed', async () => {
    // The migration adds them as NULL, and that must mean "ask once more"
    // rather than an error on a shopper's turn.
    expect(readPreferences(null)).toEqual({});
    expect(readVisibleProducts(null)).toEqual({});
    expect(readPreferences('not json')).toEqual({});
  });
});

describe('what comes back out of the store is checked', () => {
  it('keeps only the four fields it knows', () => {
    /**
     * This JSON is rendered into an instruction about the shopper. A row written
     * by a different version — or by a bug — must not be able to put an
     * arbitrary key in front of the model.
     */
    const read = readPreferences(
      JSON.stringify({ size: 'M', name: 'Priya', creditLimit: 9999, colour: 'navy' }),
    );
    expect(read.preferences).toEqual({ size: 'M', colour: 'navy' });
  });

  it('refuses a shape that is not an object', () => {
    expect(readPreferences(JSON.stringify(['M']))).toEqual({});
    expect(readPreferences(JSON.stringify('M'))).toEqual({});
  });

  it('bounds the strings, so a stored value cannot become a paragraph', () => {
    const read = readPreferences(JSON.stringify({ size: 'M'.repeat(500) }));
    expect(read.preferences?.size?.length).toBeLessThanOrEqual(12);
  });

  it('ignores a budget that is not a finite number', () => {
    expect(readPreferences(JSON.stringify({ budgetMaxMinor: 'lots' }))).toEqual({});
    expect(readPreferences(JSON.stringify({ budgetMaxMinor: null }))).toEqual({});
  });

  it('caps a visible set written by another version', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `p${i}` }));
    expect(readVisibleProducts(JSON.stringify(many)).products).toHaveLength(12);
  });
});

describe('preferences reach the prompt as a volatile instruction', () => {
  it('appears in the turn context, not the cached prefix', () => {
    const block = renderTurnContext({
      sessionId: 'sess-1',
      preferences: 'The shopper has already told you: size M. Do not ask for any of these again.',
    });
    expect(block).toContain('size M');
    expect(block).toMatch(/^<context>/);
  });

  it('comes last, nearest to what the shopper just said', () => {
    const block = renderTurnContext({
      sessionId: 'sess-1',
      page: { type: 'product', title: 'Navy Coat' },
      cart: { itemCount: 1 },
      preferences: 'The shopper has already told you: size M.',
    });
    expect(block.indexOf('size M')).toBeGreaterThan(block.indexOf('Navy Coat'));
    expect(block.indexOf('size M')).toBeGreaterThan(block.indexOf('Cart has'));
  });

  it('adds nothing when nothing is known', () => {
    // An early turn should not spend tokens reporting an absence.
    expect(renderTurnContext({ sessionId: 'sess-1' })).toBe('');
    expect(renderTurnContext({ sessionId: 'sess-1', preferences: '' })).toBe('');
  });
});
