import { describe, expect, it } from 'vitest';
import { looksFabricated, mismatchesLanguage } from '../src/voice/service.js';
import { carryForward } from '../src/tool-executor.js';

/**
 * Every string in the first block was recovered from one live session, where
 * it arrived as a shopper's message and was answered. Nobody had spoken.
 *
 * The decoder was being sent a vocabulary hint, and a decoder with a prompt
 * and no intelligible audio returns the prompt — whole, in fragments, or
 * translated into a language nobody in the conversation was speaking. The
 * assistant then answered the phantom, in the phantom's language, which is
 * what the shopper saw.
 */
const HINT = 'products, sizes, colours, prices, availability, shipping, returns';

describe('transcripts the decoder invented', () => {
  it('drops a fragment of our own hint', () => {
    // Under the old five-word floor these all passed straight through, and
    // these short ones are the common case — not the full sentence.
    expect(looksFabricated('colours', HINT)).toBe(true);
    expect(looksFabricated('availability,', HINT)).toBe(true);
    expect(looksFabricated('products, sizes,', HINT)).toBe(true);
  });

  it('drops the hint translated into another language', () => {
    // Shares not one word with the English hint, so word overlap read zero
    // and it was answered at length in Polish.
    expect(
      looksFabricated('produkty, rozmiary, kolory, ceny, dostępność, wysyłka', HINT),
    ).toBe(true);
  });

  it('drops a transcript with no letters in it', () => {
    expect(looksFabricated('###', HINT)).toBe(true);
    expect(looksFabricated('...', HINT)).toBe(true);
  });

  it('still drops the whole prompt read back', () => {
    expect(looksFabricated(`${HINT}. Product names may be brand names.`, HINT)).toBe(true);
  });

  it('keeps what a shopper actually says', () => {
    // The filter exists to protect these; a false positive costs a turn.
    expect(looksFabricated('do you have these in black', HINT)).toBe(false);
    expect(looksFabricated('how much is this', HINT)).toBe(false);
    expect(looksFabricated('can you show me some shoes', HINT)).toBe(false);
    expect(looksFabricated('¿tienen zapatos blancos?', HINT)).toBe(false);
    // A genuine question that happens to use hint vocabulary, at length.
    expect(looksFabricated('what sizes and colours do the sneakers come in', HINT)).toBe(false);
  });

  it('keeps a short question that is not made only of hint words', () => {
    expect(looksFabricated('white sneakers', HINT)).toBe(false);
    expect(looksFabricated('got any boots', HINT)).toBe(false);
  });

  it('leaves everything alone when no hint is sent', () => {
    // The default now sends no prompt at all, so the hint-word rules cannot
    // fire and only the structural ones remain.
    expect(looksFabricated('colours', '')).toBe(false);
    expect(looksFabricated('###', '')).toBe(true);
  });

  it('treats an empty transcript as silence, not a fabrication', () => {
    // Empty already means "heard nothing" to every caller; calling it a
    // fabrication would log the wrong diagnosis.
    expect(looksFabricated('', HINT)).toBe(false);
  });
});

/**
 * A shopper shown four pairs of shoes said "best one" and was shown a
 * snowboard, under the words "I couldn't find shoes in the live catalog".
 */
describe('a follow-up that refers to the previous answer', () => {
  const afterShoes = [
    { role: 'user', content: 'can u show me some shoes' },
    { role: 'assistant', content: 'Here are some shoes: Canvas Low-Top Sneakers…' },
  ];

  it('carries the subject into a bare superlative', () => {
    expect(carryForward('best one', afterShoes)).toBe('shoes');
    expect(carryForward('cheapest one', afterShoes)).toBe('shoes');
    expect(carryForward('the other ones', afterShoes)).toBe('shoes');
  });

  it('leaves a self-contained query untouched', () => {
    // Carrying forward here would search for the wrong thing entirely.
    expect(carryForward('white sneakers', afterShoes)).toBe('white sneakers');
    expect(carryForward('snowboards', afterShoes)).toBe('snowboards');
  });

  it('reaches past its own earlier referential turns', () => {
    const history = [
      { role: 'user', content: 'show me shoes' },
      { role: 'assistant', content: '…' },
      { role: 'user', content: 'best one' },
      { role: 'assistant', content: '…' },
    ];
    expect(carryForward('and the cheapest?', history)).toBe('shoes');
  });

  it('browses when nothing has been named yet', () => {
    // An opening "what have you got" is a real browse, not a lost subject.
    expect(carryForward('anything', [])).toBe('anything');
  });

  it('ignores tool results and blocks, which are not what the shopper said', () => {
    const history = [
      { role: 'user', content: [{ type: 'tool_result', content: 'snowboard' }] },
      { role: 'user', content: 'show me shoes' },
    ];
    expect(carryForward('best one', history)).toBe('shoes');
  });
});

/**
 * The widget lives on the merchant's storefront and posts here, so it is
 * cross-origin on every request. A custom header it sends that this server
 * does not advertise fails the preflight — and the request then never
 * arrives, so the failure is invisible from the server side.
 */
describe('cross-origin headers the widget actually sends', () => {
  it('advertises every custom header the widget sets', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/server.ts', import.meta.url)),
      'utf8',
    );
    const widget = readFileSync(
      fileURLToPath(new URL('../public/widget.js', import.meta.url)),
      'utf8',
    );

    const advertised = /access-control-allow-headers',\s*'([^']+)'/.exec(src)?.[1] ?? '';
    // Every x-* header literal in the widget's fetch calls.
    const sent = [...widget.matchAll(/'(x-[a-z-]+)':/g)].map((m) => m[1]);

    expect(sent.length).toBeGreaterThan(0);
    for (const h of sent) expect(advertised).toContain(h);
  });
});

/**
 * Both of these reached a shopper. The server log said `header:"en"
 * using:"en"` for each — we asked for English and the decoder answered in
 * something else, because `language` is a hint it is free to ignore when
 * the audio is too quiet to decode.
 */
describe('answers in a language we did not ask for', () => {
  it('rejects a different writing system outright', () => {
    // "You don't understand?" — nobody said this.
    expect(mismatchesLanguage('آپ کو سمجھ نہیں؟', 'en')).toBe(true);
    expect(mismatchesLanguage('मुझे जूते दिखाओ', 'en')).toBe(true);
    expect(mismatchesLanguage('Покажите мне обувь', 'en')).toBe(true);
  });

  it('rejects Turkish, which hides in the same script as English', () => {
    expect(mismatchesLanguage('Konuşmamı da bırakmam.', 'en')).toBe(true);
  });

  it('keeps real English, including the odd borrowed word', () => {
    expect(mismatchesLanguage('can you show me the best one', 'en')).toBe(false);
    expect(mismatchesLanguage('do you have these in black', 'en')).toBe(false);
    expect(mismatchesLanguage('is the café blend in stock today', 'en')).toBe(false);
  });

  it('accepts each language in its own script', () => {
    // The point is not to force English — it is to get what was asked for.
    expect(mismatchesLanguage('मुझे जूते दिखाओ', 'hi')).toBe(false);
    expect(mismatchesLanguage('آپ کو سمجھ نہیں؟', 'ur')).toBe(false);
    expect(mismatchesLanguage('Konuşmamı da bırakmam.', 'tr')).toBe(false);
    expect(mismatchesLanguage('¿tienen zapatos blancos?', 'es')).toBe(false);
  });

  it('does nothing when no language was pinned', () => {
    // Auto-detect has nothing to be measured against.
    expect(mismatchesLanguage('Konuşmamı da bırakmam.', undefined)).toBe(false);
    expect(mismatchesLanguage('Konuşmamı da bırakmam.', '')).toBe(false);
  });

  it('does not guess for a language it has no script for', () => {
    // A wrong guess here silently eats real speech, so it abstains.
    expect(mismatchesLanguage('anything at all', 'xx')).toBe(false);
  });
});

/**
 * The storefront cannot tell us who is talking. An Indian store renders
 * lang="en" and its customers speak Hindi; following the page would
 * transcribe them as English and return nonsense, with no way for the
 * merchant to correct it.
 */
describe('the merchant chooses the voice language', () => {
  it('defaults to English rather than detection', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/admin/settings.js');
    // Detection is what produced Urdu and then Turkish for one English
    // sentence, so it must be a choice, never the default.
    expect(DEFAULT_SETTINGS.voiceLanguage).toBe('en');
  });

  it('accepts a supported language and rejects anything else', async () => {
    const { validateSettings } = await import('../src/admin/settings.js');
    const base = { accentColor: '#1b3a34', cornerRadius: 16, position: 'right', greeting: '' };

    expect(validateSettings('s.myshopify.com', { ...base, voiceLanguage: 'hi' }).ok).toBe(true);
    expect(validateSettings('s.myshopify.com', { ...base, voiceLanguage: 'auto' }).ok).toBe(true);
    expect(validateSettings('s.myshopify.com', { ...base, voiceLanguage: 'klingon' }).ok).toBe(false);
  });

  it('offers Hindi, and offers detection last', async () => {
    const { VOICE_LANGUAGES } = await import('../src/admin/settings.js');
    expect(VOICE_LANGUAGES.some(([c]) => c === 'hi')).toBe(true);
    expect(VOICE_LANGUAGES[VOICE_LANGUAGES.length - 1]![0]).toBe('auto');
  });

  it('survives a round trip through SQLite, including the added column', async () => {
    // CREATE TABLE IF NOT EXISTS does nothing to an existing table, so a new
    // column only reaches a deployed database through the migration.
    const { openDatabase, SqliteSettingsStore } = await import('../src/store/sqlite.js');
    const db = openDatabase({ path: ':memory:' });
    const store = new SqliteSettingsStore(db);
    const saved = {
      shop: 'india.myshopify.com',
      accentColor: '#1b3a34',
      cornerRadius: 16,
      position: 'right' as const,
      greeting: '',
      enabled: true,
      holdoutFraction: 0.2,
      voiceLanguage: 'hi',
      updatedAt: Date.now(),
    };
    await store.put(saved);
    expect((await store.get('india.myshopify.com')).voiceLanguage).toBe('hi');
    // A shop that has never been saved still gets the default.
    expect((await store.get('new.myshopify.com')).voiceLanguage).toBe('en');
  });
});
