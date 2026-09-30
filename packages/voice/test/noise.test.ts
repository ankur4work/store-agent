import { describe, expect, it } from 'vitest';
import { TARGET_RATE } from '../src/wav.js';
import { LISTENING_CORPUS, VARIANTS } from '../src/listening-corpus.js';
import { mixAtSnr, mulberry32, rms, synthNoise } from '../src/noise.js';

function tone(hz: number, seconds: number, rate: number, amp = 0.4): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amp;
  return out;
}

describe('mulberry32', () => {
  it('is deterministic, so two runs a week apart are comparable', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces different streams for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('synthNoise', () => {
  it('returns true digital zero for silence', () => {
    // The purest fabrication test: no acoustic content at all, so any word that
    // comes back was written rather than heard.
    const s = synthNoise('silence', 0.5, TARGET_RATE);
    expect(rms(s)).toBe(0);
    expect(s.length).toBe(TARGET_RATE / 2);
  });

  it('produces audible but un-clipped room noise', () => {
    const s = synthNoise('room', 1, TARGET_RATE, 7);
    expect(rms(s)).toBeGreaterThan(0.02);
    expect(Math.max(...s)).toBeLessThan(1);
  });

  it('slopes room noise downward in frequency, as a real room does', () => {
    // White noise would put its energy above the speech band, making the test
    // easier than reality. A crude high-frequency estimate: mean absolute
    // sample-to-sample difference, which rises with treble content.
    const room = synthNoise('room', 0.5, TARGET_RATE, 3);
    const white = new Float32Array(room.length);
    const rng = mulberry32(3);
    for (let i = 0; i < white.length; i++) white[i] = (rng() * 2 - 1) * rms(room) * 1.7;

    const roughness = (s: Float32Array): number => {
      let sum = 0;
      for (let i = 1; i < s.length; i++) sum += Math.abs(s[i]! - s[i - 1]!);
      return sum / (s.length - 1);
    };
    expect(roughness(room)).toBeLessThan(roughness(white));
  });

  it('is reproducible per seed', () => {
    expect([...synthNoise('room', 0.05, TARGET_RATE, 9)]).toEqual([
      ...synthNoise('room', 0.05, TARGET_RATE, 9),
    ]);
  });

  it('makes music a sustained pitched signal, not a hiss', () => {
    const m = synthNoise('music', 0.5, TARGET_RATE);
    expect(rms(m)).toBeGreaterThan(0.05);
  });
});

describe('mixAtSnr', () => {
  it('hits the requested ratio', () => {
    const speech = tone(300, 1, TARGET_RATE);
    const noise = synthNoise('room', 1, TARGET_RATE, 11);
    const mixed = mixAtSnr(speech, noise, 12);

    // Recover the noise by subtraction — possible only because the mix is
    // linear and the speech is known exactly.
    const residual = new Float32Array(mixed.length);
    for (let i = 0; i < mixed.length; i++) residual[i] = mixed[i]! - speech[i]!;
    const achievedDb = 20 * Math.log10(rms(speech) / rms(residual));
    expect(achievedDb).toBeCloseTo(12, 0);
  });

  it('keeps the clip length, so nothing is truncated by mixing', () => {
    const speech = tone(300, 1.3, TARGET_RATE);
    // Deliberately shorter noise: it must loop, not pad with silence, or the
    // clip would test two conditions and report one number.
    const mixed = mixAtSnr(speech, synthNoise('room', 0.4, TARGET_RATE), 6);
    expect(mixed.length).toBe(speech.length);
    expect(rms(mixed.subarray(mixed.length - 1000))).toBeGreaterThan(0);
  });

  it('never clips, because distortion is not the thing being tested', () => {
    const mixed = mixAtSnr(tone(300, 0.5, TARGET_RATE, 0.95), synthNoise('room', 0.5, TARGET_RATE), 3);
    for (const v of mixed) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('passes speech through untouched when there is no noise to add', () => {
    const speech = tone(300, 0.2, TARGET_RATE);
    expect([...mixAtSnr(speech, new Float32Array(100), 6)]).toEqual([...speech]);
  });
});

describe('LISTENING_CORPUS', () => {
  it('has unique ids', () => {
    const ids = LISTENING_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every silence clip an empty reference and a synth kind', () => {
    // A silence clip with a reference would be scored as speech, and the
    // fabrication count — the number this corpus exists for — would read zero
    // no matter what the decoder did.
    for (const c of LISTENING_CORPUS.filter((x) => x.group === 'silence')) {
      expect(c.text).toBe('');
      expect(c.synth).toBeDefined();
    }
  });

  it('gives every speech clip something to say and a language', () => {
    for (const c of LISTENING_CORPUS.filter((x) => x.group !== 'silence')) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.synth).toBeUndefined();
      expect(c.lang).toMatch(/^[a-z]{2}$/);
    }
  });

  it('spells numbers out, because there is no honest normaliser for them', () => {
    for (const c of LISTENING_CORPUS) {
      expect(c.text).not.toMatch(/\d/);
    }
  });

  it('covers every group, so a regression cannot hide in an empty one', () => {
    const groups = new Set(LISTENING_CORPUS.map((c) => c.group));
    for (const g of ['short', 'long', 'hanging', 'catalog', 'numbers', 'language', 'silence']) {
      expect(groups).toContain(g);
    }
  });

  it('keeps a clean variant, so a noise regression is separable from a model one', () => {
    expect(VARIANTS.some((v) => v.snrDb === null)).toBe(true);
    expect(VARIANTS.filter((v) => v.snrDb !== null).length).toBeGreaterThan(0);
  });
});
