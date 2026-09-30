import { describe, expect, it } from 'vitest';
import { TARGET_RATE, decodeWav, encodeWav, resample } from '../src/wav.js';

/**
 * The upload format is where voice has broken most often — a codec parameter
 * rejected every request once, and a container with no duration had a decoder
 * inventing Latvian. WAV is the format chosen to end that, so the header it
 * writes is verified by reading it back rather than by trusting the offsets.
 */

/** A sine wave, which is the only signal whose resampled shape is predictable. */
function tone(hz: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.5;
  return out;
}

describe('encodeWav / decodeWav', () => {
  it('round-trips samples and the rate', () => {
    const samples = tone(440, 0.05, TARGET_RATE);
    const decoded = decodeWav(encodeWav(samples, TARGET_RATE));

    expect(decoded.sampleRate).toBe(TARGET_RATE);
    expect(decoded.samples.length).toBe(samples.length);
    /**
     * Quantisation is the only loss, and the bound is TWO steps rather than
     * one: positives scale by 0x7fff and negatives by 0x8000, so a positive
     * sample loses a step to truncation and a further `v/32768` to the
     * asymmetry. The asymmetry is deliberate — it is what lets -1.0 encode
     * exactly — and 6e-5 of error is 84 dB below full scale, which no
     * recogniser can see.
     */
    for (let i = 0; i < samples.length; i++) {
      expect(Math.abs(decoded.samples[i]! - samples[i]!)).toBeLessThan(2 / 32768);
    }
  });

  it('writes a header a decoder can find its way through', () => {
    const bytes = encodeWav(tone(440, 0.01, TARGET_RATE), TARGET_RATE);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE');
    // The length written down — the thing a fragmented webm never had.
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(view.getUint32(40, true)).toBe(bytes.byteLength - 44);
  });

  it('clamps rather than wraps a hot sample', () => {
    // A wrap turns one loud syllable into full-scale noise, which a recogniser
    // reads as a consonant nobody said.
    const decoded = decodeWav(encodeWav(Float32Array.from([2, -2]), TARGET_RATE));
    expect(decoded.samples[0]!).toBeCloseTo(1, 3);
    expect(decoded.samples[1]!).toBeCloseTo(-1, 3);
  });

  it('skips a chunk between fmt and data instead of reading it as audio', () => {
    // A LIST chunk there is legal and common. Assuming data starts at offset
    // 36 would shift every sample.
    const real = encodeWav(tone(440, 0.02, TARGET_RATE), TARGET_RATE);
    const listSize = 10;
    const withList = new Uint8Array(real.byteLength + 8 + listSize);
    withList.set(real.subarray(0, 36), 0);
    withList.set(new TextEncoder().encode('LIST'), 36);
    new DataView(withList.buffer).setUint32(40, listSize, true);
    withList.set(real.subarray(36), 36 + 8 + listSize);
    new DataView(withList.buffer).setUint32(4, withList.byteLength - 8, true);

    const decoded = decodeWav(withList);
    expect(decoded.sampleRate).toBe(TARGET_RATE);
    expect(decoded.samples.length).toBe(Math.round(0.02 * TARGET_RATE));
  });

  it('refuses a file it cannot read rather than returning silence', () => {
    // Silence and "we could not parse this" must not look alike; one is a quiet
    // room and the other is a bug.
    expect(() => decodeWav(new Uint8Array(10))).toThrow(/too short/);
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/);
  });

  it('downmixes stereo to mono', () => {
    // Two channels of opposite phase sum to silence; that is the arithmetic
    // being checked, not a claim that it sounds good.
    const bytes = encodeWav(Float32Array.from([0.5, 0.5]), TARGET_RATE);
    new DataView(bytes.buffer).setUint16(22, 2, true); // relabel as stereo
    new DataView(bytes.buffer).setInt16(46, -0x4000, true); // second sample = -0.5
    const decoded = decodeWav(bytes);
    expect(decoded.samples.length).toBe(1);
    expect(decoded.samples[0]!).toBeCloseTo(0, 3);
  });
});

describe('resample', () => {
  it('is a no-op at the same rate', () => {
    const s = tone(440, 0.01, TARGET_RATE);
    expect(resample(s, TARGET_RATE, TARGET_RATE)).toBe(s);
  });

  it('produces the expected number of samples going 48k to 16k', () => {
    const s = tone(440, 0.5, 48_000);
    const out = resample(s, 48_000, TARGET_RATE);
    expect(out.length).toBe(8_000);
  });

  it('keeps a speech-band tone intact through a 3x downsample', () => {
    // 440 Hz is well under the 8 kHz Nyquist of 16 kHz, so it must survive.
    const out = resample(tone(440, 0.2, 48_000), 48_000, TARGET_RATE);
    const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
    // 0.5 amplitude sine has RMS 0.354; the box filter costs a little.
    expect(rms).toBeGreaterThan(0.3);
  });

  it('attenuates a tone above the new Nyquist instead of folding it into speech', () => {
    // THE reason the box filter is there. A 15 kHz tone cannot be represented
    // at 16 kHz; without the filter it reappears at 1 kHz, right in the middle
    // of the speech band, as energy nobody produced.
    const out = resample(tone(15_000, 0.2, 48_000), 48_000, TARGET_RATE);
    const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
    expect(rms).toBeLessThan(0.1);
  });

  it('handles an empty clip without throwing', () => {
    expect(resample(new Float32Array(0), 48_000, TARGET_RATE).length).toBe(0);
  });
});
