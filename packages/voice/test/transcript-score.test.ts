import { describe, expect, it } from 'vitest';
import {
  aggregate,
  normaliseWords,
  percentile,
  scoreTranscript,
  type ClipResult,
} from '../src/transcript-score.js';

/**
 * These tests are the definition of the Level 1 gate. If the scorer is wrong,
 * every "we improved listening by X%" claim built on it is wrong in the same
 * direction and nobody finds out — so the arithmetic is pinned here rather
 * than trusted.
 */

describe('normaliseWords', () => {
  it('ignores case and punctuation, which are not listening errors', () => {
    expect(normaliseWords('How much is the wool coat?')).toEqual([
      'how',
      'much',
      'is',
      'the',
      'wool',
      'coat',
    ]);
  });

  it('keeps apostrophes and hyphens inside words', () => {
    // "don't" is one word to a shopper. Splitting it would invent an error out
    // of a correct transcription.
    expect(normaliseWords("don't show me open-toe shoes")).toEqual([
      "don't",
      'show',
      'me',
      'open-toe',
      'shoes',
    ]);
  });

  it('drops a dangling joiner rather than counting it as a word', () => {
    expect(normaliseWords('the coat - and the boots')).toEqual([
      'the',
      'coat',
      'and',
      'the',
      'boots',
    ]);
  });

  it('preserves Devanagari vowel signs', () => {
    // Marks are not letters. Stripping them mangles every Hindi reference and
    // would score a working Hindi transcript as a total failure.
    expect(normaliseWords('कोट कितने का है?')).toEqual(['कोट', 'कितने', 'का', 'है']);
  });

  it('returns nothing for punctuation-only junk', () => {
    // "###" and "..." are what the decoder emits when it heard nothing. They
    // must score as an empty transcript, not as one mystery word.
    expect(normaliseWords('### ... —')).toEqual([]);
  });
});

describe('scoreTranscript', () => {
  it('scores a perfect transcript as zero', () => {
    const s = scoreTranscript('how much is the wool coat', 'How much is the wool coat?');
    expect(s.wer).toBe(0);
    expect(s).toMatchObject({ substitutions: 0, insertions: 0, deletions: 0 });
  });

  it('counts one mishearing as one substitution', () => {
    const s = scoreTranscript('how much is the wool coat', 'how much is the wolf coat');
    expect(s).toMatchObject({ substitutions: 1, insertions: 0, deletions: 0 });
    expect(s.wer).toBeCloseTo(1 / 6, 6);
  });

  it('counts a dropped word as a deletion and an added one as an insertion', () => {
    expect(scoreTranscript('show me red dresses', 'show red dresses')).toMatchObject({
      deletions: 1,
      insertions: 0,
      substitutions: 0,
    });
    expect(scoreTranscript('show me red dresses', 'show me the red dresses')).toMatchObject({
      insertions: 1,
      deletions: 0,
      substitutions: 0,
    });
  });

  it('flags invention on a silence clip, and does not call it a WER', () => {
    // The real thing, recovered from a live session: nobody spoke, and the
    // decoder produced a Polish shopping list that was answered at length.
    const s = scoreTranscript('', 'produkty, rozmiary, kolory');
    expect(s.fabricated).toBe(true);
    expect(s.referenceWords).toBe(0);
    expect(s.insertions).toBe(3);
  });

  it('scores silence answered with silence as perfect', () => {
    const s = scoreTranscript('', '');
    expect(s.wer).toBe(0);
    expect(s.fabricated).toBe(false);
  });

  it('scores an entirely missed utterance as total error, not as an error above one', () => {
    // A recogniser that returns nothing is 100% wrong, and no more than that.
    // Without the deletion path this would fall through to some other number.
    const s = scoreTranscript('how much is the wool coat', '');
    expect(s.wer).toBe(1);
    expect(s.deletions).toBe(6);
  });
});

describe('aggregate', () => {
  const clip = (
    id: string,
    reference: string,
    hypothesis: string,
    latencyMs: number,
  ): ClipResult => ({
    id,
    reference,
    score: scoreTranscript(reference, hypothesis),
    latencyMs,
    empty: hypothesis.trim() === '',
  });

  it('weights by words, not by clip', () => {
    // The reason this is not a mean of per-clip rates: one wrong word in a
    // three-word clip is 33%, and averaging would let it outweigh a
    // twenty-word clip that was transcribed perfectly.
    const a = aggregate([
      clip('short', 'red dress please', 'red dressing please', 100),
      clip(
        'long',
        'i am looking for something warm to wear to a wedding in november',
        'i am looking for something warm to wear to a wedding in november',
        100,
      ),
    ]);
    expect(a.referenceWords).toBe(16);
    expect(a.wer).toBeCloseTo(1 / 16, 6);
  });

  it('keeps silence clips out of the WER entirely', () => {
    const a = aggregate([
      clip('speech', 'red dress please', 'red dress please', 100),
      clip('silence', '', 'context:', 100),
    ]);
    // Otherwise the headline number becomes a function of how many silence
    // clips are in the fixture set rather than of how well we hear.
    expect(a.wer).toBe(0);
    expect(a.fabricated).toBe(1);
    expect(a.silenceClips).toBe(1);
  });

  it('counts a missed utterance separately from a misheard one', () => {
    const a = aggregate([
      clip('missed', 'red dress please', '', 100),
      clip('heard', 'red dress please', 'red dress please', 100),
    ]);
    expect(a.missed).toBe(1);
  });

  it('reports exact percentiles over every sample', () => {
    const a = aggregate(
      [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms, i) =>
        clip(`c${i}`, 'red dress please', 'red dress please', ms),
      ),
    );
    expect(a.latencyP50Ms).toBe(500);
    expect(a.latencyP95Ms).toBe(1000);
  });

  it('has no opinion about an empty set', () => {
    const a = aggregate([]);
    expect(a).toMatchObject({ clips: 0, wer: 0, fabricated: 0 });
    expect(a.latencyP50Ms).toBeUndefined();
  });
});

describe('percentile', () => {
  it('uses nearest rank, so every value is reachable', () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(percentile([], 0.5)).toBeUndefined();
  });
});
