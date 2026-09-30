import { describe, expect, it } from 'vitest';
import {
  MIN_DYNAMIC_RANGE,
  SILENCE_RMS,
  looksHallucinated,
  speechPresence,
} from '../src/speech-presence.js';
import { mixAtSnr, synthNoise } from '../src/noise.js';
import { TARGET_RATE } from '../src/wav.js';

/**
 * The defence against a decoder that invents.
 *
 * Measured against the live API, four seconds of silence produced "Thank you for
 * watching." — the best-known Whisper-family hallucination, learnt from subtitle
 * training data. Four of four silence clips produced text, and none of the
 * existing filters could see it: it is plain ASCII English, so comparing writing
 * systems cannot help, and no vocabulary hint is sent any more for it to echo.
 *
 * These tests pin the thresholds AND the two approaches that failed, because both
 * looked obviously right and only measurement showed otherwise.
 */

/** Speech-like: syllables and gaps. Not real speech, but the right shape. */
function syllables(seconds: number, rate = TARGET_RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    // 4 syllables a second, each with a clear gap: energy swings by design.
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 3;
    out[i] = Math.sin(2 * Math.PI * 180 * t) * 0.3 * envelope;
  }
  return out;
}

describe('digital silence', () => {
  it('is recognised without looking at any structure', () => {
    const p = speechPresence(new Float32Array(TARGET_RATE), TARGET_RATE);
    expect(p.speech).toBe(false);
    expect(p.reason).toBe('digital_silence');
  });

  it('cannot reject a real recording, because a microphone never returns zeros', () => {
    // The floor is far below any real noise floor: even a very quiet room is
    // orders of magnitude above this.
    const veryQuiet = synthNoise('room', 1, TARGET_RATE, 5);
    for (let i = 0; i < veryQuiet.length; i++) veryQuiet[i] = veryQuiet[i]! * 0.01;
    expect(speechPresence(veryQuiet, TARGET_RATE).rms).toBeGreaterThan(SILENCE_RMS);
  });

  it('is discarded without an API call at all', () => {
    // Worth a request as well as a fabrication: there is nothing to transcribe.
    const p = speechPresence(new Float32Array(TARGET_RATE), TARGET_RATE);
    expect(looksHallucinated(p, '')).toBe(true);
    expect(looksHallucinated(p, 'Covenant.')).toBe(true);
  });
});

describe('stationary noise has no speech structure', () => {
  it('rejects a flat room', () => {
    const p = speechPresence(synthNoise('room', 3, TARGET_RATE, 11), TARGET_RATE);
    expect(p.speech).toBe(false);
    expect(p.reason).toBe('no_dynamic_range');
  });

  it('rejects music, which is periodic but not speech', () => {
    /**
     * The reason pitch periodicity was abandoned as a test: music scored 0.53 on
     * autocorrelation against a speech floor of 0.12, so a voicing detector would
     * have called the music clip speech. Energy structure sees it correctly.
     */
    const p = speechPresence(synthNoise('music', 3, TARGET_RATE), TARGET_RATE);
    expect(p.speech).toBe(false);
  });

  it('keeps audio with syllables and gaps', () => {
    const p = speechPresence(syllables(3), TARGET_RATE);
    expect(p.speech).toBe(true);
    expect(p.dynamicRange).toBeGreaterThan(MIN_DYNAMIC_RANGE);
  });

  it('keeps speech buried in noise, which is the hardest case', () => {
    // Noise fills the gaps between syllables and pushes the median up, which is
    // exactly what this test has least margin against.
    const noisy = mixAtSnr(syllables(3), synthNoise('room', 3, TARGET_RATE, 3), 6);
    expect(speechPresence(noisy, TARGET_RATE).speech).toBe(true);
  });
});

describe('the threshold is measured, not chosen', () => {
  it('sits inside the gap the corpus showed', () => {
    /**
     * Across 63 speech clips and 4 non-speech clips:
     *
     *     speech      max/median  min 1.84
     *     non-speech  max/median  max 1.57
     *
     * The constant must stay between those, or it starts eating real questions on
     * one side or admitting hallucinations on the other.
     */
    expect(MIN_DYNAMIC_RANGE).toBeGreaterThan(1.57);
    expect(MIN_DYNAMIC_RANGE).toBeLessThan(1.84);
  });

  it('uses the maximum frame, not a percentile', () => {
    /**
     * The 95th percentile was the first attempt, so that one click could not make
     * silence look like speech. It cannot work: for speech the loudest frame IS
     * in the top 5%, so trimming it collapsed speech to 1.46 against non-speech
     * at 1.48 — the distributions crossed and 26 of 63 real utterances were
     * rejected.
     *
     * This asserts the consequence rather than the implementation: a clip with
     * one loud syllable in three seconds of quiet must read as speech.
     */
    const sparse = new Float32Array(3 * TARGET_RATE);
    const quiet = synthNoise('room', 3, TARGET_RATE, 7);
    sparse.set(quiet);
    // One 200 ms syllable, the rest room tone.
    const syl = syllables(0.2);
    sparse.set(syl.map((v, i) => v + quiet[i]!), TARGET_RATE);
    expect(speechPresence(sparse, TARGET_RATE).speech).toBe(true);
  });
});

describe('short audio is not judged', () => {
  it('passes a single word to the decoder rather than deciding', () => {
    // "yes" and "black" are legitimate whole answers, and under a fifth of a
    // second "peak versus typical" means nothing. The widget's own
    // minimum-speech gate covers the cough case.
    const p = speechPresence(syllables(0.1), TARGET_RATE);
    expect(p.speech).toBe(true);
    expect(p.frames).toBeLessThan(10);
  });

  it('has no opinion about an empty buffer', () => {
    const p = speechPresence(new Float32Array(0), TARGET_RATE);
    expect(p.rms).toBe(0);
    expect(p.speech).toBe(false);
  });
});

describe('looksHallucinated requires both signals', () => {
  const flat = (): ReturnType<typeof speechPresence> =>
    speechPresence(synthNoise('room', 3, TARGET_RATE, 11), TARGET_RATE);
  const speechy = (): ReturnType<typeof speechPresence> => speechPresence(syllables(3), TARGET_RATE);

  it('discards the fabrications that were actually observed', () => {
    for (const text of ['Covenant.', 'Thank you for watching.', 'Thanks for watching!', 'sr']) {
      expect(looksHallucinated(flat(), text), text).toBe(true);
    }
  });

  it('keeps a long transcript even from flat audio', () => {
    /**
     * The whole reason for requiring two signals. The clips that scored LOWEST
     * acoustically were the longest ones — continuous narration has little
     * frame-to-frame variation — so a single acoustic threshold would have eaten
     * exactly the most informative utterances.
     */
    const long = 'I am looking for something warm to wear to a wedding in November';
    expect(looksHallucinated(flat(), long)).toBe(false);
  });

  it('never discards anything when the audio did contain speech', () => {
    // However short the answer. "Yes" from real speech is an answer.
    expect(looksHallucinated(speechy(), 'Yes')).toBe(false);
    expect(looksHallucinated(speechy(), 'Thank you for watching.')).toBe(false);
  });

  it('does not invent a fabrication out of an empty transcript', () => {
    // Empty already means "heard nothing" to every caller, and has its own
    // outcome. Calling it a hallucination would log the wrong diagnosis.
    expect(looksHallucinated(flat(), '')).toBe(false);
    expect(looksHallucinated(flat(), '   ')).toBe(false);
  });
});
