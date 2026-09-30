/**
 * The clips we measure listening against.
 *
 * ## Why these, and why they are mostly synthetic
 *
 * Voice is the one path that cannot be tested without a microphone, and that
 * fact has cost this project more than any other. Two endpointing fixes were
 * made blind and both were wrong; the fabricated-transcript class was found by
 * reading a live session's logs, not by a test. A corpus that runs on demand,
 * costs a cent, and produces the same number twice is worth more than a
 * perfect one that nobody runs.
 *
 * So the speech clips are synthesised by TTS and then deliberately degraded
 * (see `VARIANTS`). This flatters the recogniser — synthetic speech has no
 * accent, no mouth noise, no room, and no shopper turning away from the phone
 * mid-sentence — so the absolute WER from this corpus is a **floor, not an
 * estimate**. It is a regression detector and a comparison instrument, and
 * `docs/PHASE-6-PLAN.md` treats it as exactly that: real recordings dropped
 * into `voice-fixtures/real/` are scored alongside and are the number to quote.
 *
 * ## What each group is for
 *
 * | Group | Fails when |
 * |---|---|
 * | `short` | The endpointer cuts in, or a three-word question is padded out |
 * | `long` | The upload is truncated — a fragmented container's signature |
 * | `hanging` | A mid-sentence pause is treated as the end of the turn |
 * | `catalog` | Product vocabulary is transcribed as ordinary English |
 * | `numbers` | Spoken prices and sizes come back wrong, which grounding then rejects |
 * | `language` | A non-English shopper is transliterated instead of transcribed |
 * | `silence` | **The decoder invents.** The highest-value group in the set |
 *
 * ## Numbers are spelled out, on purpose
 *
 * There is no honest normaliser that makes "$50" and "fifty dollars" the same
 * transcript without a per-language number map, and a half-built one would
 * score a working Hindi clip as a total failure. Shoppers say numbers out
 * loud anyway, so the reference is written the way it is spoken.
 */

export type ClipGroup =
  | 'short'
  | 'long'
  | 'hanging'
  | 'catalog'
  | 'numbers'
  | 'language'
  | 'silence';

export interface ClipSpec {
  readonly id: string;
  readonly group: ClipGroup;
  /**
   * What is said, and therefore the reference transcript.
   *
   * Empty for a `silence` clip — there is nothing to say, and any words that
   * come back are invention.
   */
  readonly text: string;
  /** ISO-639-1 code sent as `x-storefront-lang`, as the widget does. */
  readonly lang: string;
  /**
   * Synthetic audio to generate instead of speech. `silence` clips only.
   *
   * These are the clips that catch the failure shoppers actually saw — a
   * Polish shopping list, "context:", "###" and "colours" all arrived from
   * captures in which nobody had said a word.
   */
  readonly synth?: 'silence' | 'room' | 'music';
}

/** A pause written into the prompt, so TTS renders one. */
const PAUSE = '…';

export const LISTENING_CORPUS: readonly ClipSpec[] = [
  // --- short: the shape most shopper turns actually take -------------------
  { id: 'short-price', group: 'short', lang: 'en', text: 'How much is it?' },
  { id: 'short-stock', group: 'short', lang: 'en', text: 'Do you have this in black?' },
  { id: 'short-greet', group: 'short', lang: 'en', text: 'Hi, can you help me?' },
  { id: 'short-two-words', group: 'short', lang: 'en', text: 'Red dresses.' },

  // --- long: a truncated upload shows up here and nowhere else -------------
  {
    id: 'long-wedding',
    group: 'long',
    lang: 'en',
    text:
      'I am looking for something warm to wear to a wedding in November, ' +
      'and it needs to work with flat shoes because I will be standing all day.',
  },
  {
    id: 'long-gift',
    group: 'long',
    lang: 'en',
    text:
      'My brother snowboards every winter and I want to get him something useful ' +
      'for his birthday, but I do not really know anything about the sport.',
  },
  {
    id: 'long-returns',
    group: 'long',
    lang: 'en',
    text:
      'If I order two sizes to try them both on at home, can I send back the one ' +
      'that does not fit, and how long do I have to do that?',
  },

  // --- hanging: the endpointer's hardest case ------------------------------
  //
  // A pause after a conjunction. `endpoint.ts` waits 1100ms here and 260ms
  // after a finished question; if that logic is wrong, the second half of the
  // sentence never reaches the recogniser and the reference will not match.
  {
    id: 'hanging-and',
    group: 'hanging',
    lang: 'en',
    text: `I want something warm and ${PAUSE} maybe waterproof as well.`,
  },
  {
    id: 'hanging-thinking',
    group: 'hanging',
    lang: 'en',
    text: `Do you have ${PAUSE} sorry ${PAUSE} do you have these in a medium?`,
  },
  {
    id: 'hanging-budget',
    group: 'hanging',
    lang: 'en',
    text: `Something under ${PAUSE} let us say fifty pounds.`,
  },

  // --- catalog: the words the merchant typed, spoken back ------------------
  //
  // Real titles from the development store's catalog. A recogniser with no
  // vocabulary hint has to get these from acoustics alone, which is the
  // trade made when the decoder prompt was removed for inventing shoppers.
  { id: 'catalog-snowboard', group: 'catalog', lang: 'en', text: 'Do you sell snowboards?' },
  {
    id: 'catalog-merino',
    group: 'catalog',
    lang: 'en',
    text: 'Is the merino wool overcoat still available?',
  },
  {
    id: 'catalog-opentoe',
    group: 'catalog',
    lang: 'en',
    text: 'I am after open toe sandals with an ankle strap.',
  },
  {
    id: 'catalog-gold-chain',
    group: 'catalog',
    lang: 'en',
    text: 'A black bag with a gold chain, please.',
  },

  // --- numbers: where a mishearing becomes a grounding failure -------------
  //
  // A wrong price in the transcript is not a transcription bug the shopper
  // ever sees — it is a search for the wrong thing, or a tripwire abort.
  {
    id: 'numbers-budget',
    group: 'numbers',
    lang: 'en',
    text: 'Show me boots under one hundred and fifty dollars.',
  },
  {
    id: 'numbers-size',
    group: 'numbers',
    lang: 'en',
    text: 'I take a size nine and a half in shoes.',
  },
  {
    id: 'numbers-quantity',
    group: 'numbers',
    lang: 'en',
    text: 'Can I order three of the grey ones?',
  },

  // --- language: the failure that produced Urdu on an English store -------
  { id: 'lang-hi-price', group: 'language', lang: 'hi', text: 'यह कोट कितने का है?' },
  {
    id: 'lang-hi-stock',
    group: 'language',
    lang: 'hi',
    text: 'क्या यह काले रंग में उपलब्ध है?',
  },
  { id: 'lang-es-warm', group: 'language', lang: 'es', text: '¿Tienes algo abrigado para el invierno?' },
  { id: 'lang-es-size', group: 'language', lang: 'es', text: 'Necesito una talla mediana, por favor.' },

  // --- silence: the group that matters most --------------------------------
  //
  // The correct answer to every one of these is the empty string. A transcript
  // here is a fabrication, and a fabrication is answered out loud to a shopper
  // who said nothing.
  { id: 'silence-digital', group: 'silence', lang: 'en', text: '', synth: 'silence' },
  { id: 'silence-room', group: 'silence', lang: 'en', text: '', synth: 'room' },
  { id: 'silence-room-loud', group: 'silence', lang: 'en', text: '', synth: 'room' },
  { id: 'silence-music', group: 'silence', lang: 'en', text: '', synth: 'music' },
];

/**
 * How each speech clip is degraded before upload.
 *
 * Clean synthetic speech is not what a storefront microphone hears. A shopper
 * is in a room with a fan, a till, traffic, or the shop's own music, and that
 * is precisely the condition under which `gpt-4o-transcribe` stops
 * transcribing and starts writing — so measuring only clean audio measures
 * the case that was never broken.
 *
 * SNR is signal-to-noise in decibels: 20 dB is a quiet room, 12 dB is a café,
 * 6 dB is a shop with music on and someone talking nearby. Beyond that a
 * human cannot reliably do it either, and a recogniser failing where a person
 * would is not a defect worth chasing.
 */
export const VARIANTS: readonly { readonly name: string; readonly snrDb: number | null }[] = [
  { name: 'clean', snrDb: null },
  { name: 'room', snrDb: 12 },
  { name: 'noisy', snrDb: 6 },
];
