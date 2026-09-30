/**
 * Deterministic room noise, for measuring listening under the conditions a
 * storefront actually has.
 *
 * ## Why synthesise noise rather than record it
 *
 * The recogniser does not fail on clean speech. It fails when a shopper is in
 * a room with a fan, a till, traffic, or the shop's own music — and that is
 * exactly when `gpt-4o-transcribe` stops transcribing and starts writing. Every
 * fabricated transcript recovered from a live session came from a capture with
 * no speech in it at all.
 *
 * A recorded noise bed would be more realistic and would also be a binary in
 * the repository that nobody can diff, regenerate, or reason about. Synthesised
 * noise is a few lines, seeded, and identical on every machine — so two runs a
 * week apart are comparable, which is the entire point of the exercise.
 *
 * ## What it is not
 *
 * This is coloured noise, not a real room. It has no reverb, no impulse
 * response, and no competing speech. A clip that survives 6 dB SNR here has
 * not been proven to survive a café; it has been proven not to have regressed.
 */

/**
 * Seeded PRNG.
 *
 * `Math.random()` would make every run produce a different corpus, so a WER
 * that moved two points would be indistinguishable from noise — in both senses.
 * mulberry32 because it is eight lines and passes enough of SmallCrush for
 * generating a noise bed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseKind = 'silence' | 'room' | 'music';

/**
 * Generate a noise-only clip of a given kind.
 *
 * `silence` is true digital zero. It is the purest fabrication test there is:
 * there is no acoustic content whatsoever, so any word that comes back was
 * written rather than heard. It is also the least realistic — a real
 * microphone never returns zeros — which is why `room` exists beside it.
 */
export function synthNoise(
  kind: NoiseKind,
  seconds: number,
  sampleRate: number,
  seed = 1,
): Float32Array {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  if (kind === 'silence') return out;

  const rng = mulberry32(seed);

  if (kind === 'room') {
    /**
     * One-pole low-passed white noise, plus a low hum.
     *
     * Real room noise is not white — it slopes down with frequency, because
     * the loud things in a room are large and slow: ventilation, traffic,
     * a fridge. White noise would put most of its energy above the speech
     * band where it is easy to ignore, which would make this test easier
     * than reality rather than harder.
     */
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const white = rng() * 2 - 1;
      lp += 0.06 * (white - lp);
      const hum = Math.sin((2 * Math.PI * 50 * i) / sampleRate) * 0.08;
      out[i] = lp * 3 + hum;
    }
    return normalise(out, 0.08);
  }

  /**
   * Music: a slow minor chord with tremolo.
   *
   * Sustained pitched tones are the hardest noise for a speech recogniser to
   * dismiss, because harmonic structure is what it is looking for. A shop
   * playing music over the speakers is the single most common non-speech
   * condition a storefront microphone is in.
   */
  const chord = [220, 261.63, 329.63];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (const hz of chord) v += Math.sin(2 * Math.PI * hz * t);
    // Tremolo, so it is not a stationary signal a noise gate trivially removes.
    out[i] = (v / chord.length) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 1.7 * t));
  }
  return normalise(out, 0.12);
}

/** Root mean square — the only loudness measure that means anything here. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

function normalise(samples: Float32Array, targetRms: number): Float32Array {
  const current = rms(samples);
  if (current === 0) return samples;
  const gain = targetRms / current;
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * gain;
  return samples;
}

/**
 * Mix noise under speech at a given signal-to-noise ratio.
 *
 * SNR is computed over the speech clip's RMS **including its silences**, which
 * understates the ratio during the loud parts and overstates it during the
 * quiet ones — the same thing a real room does. Measuring only over voiced
 * frames would produce a flattering number that no shopper experiences.
 *
 * The result is scaled back if the mix would clip. Clipping is not noise, it is
 * distortion, and it would make a 6 dB clip fail for a reason that has nothing
 * to do with the noise floor being tested.
 */
export function mixAtSnr(
  speech: Float32Array,
  noise: Float32Array,
  snrDb: number,
): Float32Array {
  const speechRms = rms(speech);
  const noiseRms = rms(noise);
  const out = new Float32Array(speech.length);
  if (speechRms === 0 || noiseRms === 0) {
    out.set(speech.subarray(0, out.length));
    return out;
  }

  const wanted = speechRms / 10 ** (snrDb / 20);
  const gain = wanted / noiseRms;

  let peak = 0;
  for (let i = 0; i < speech.length; i++) {
    // Noise shorter than the speech is looped rather than padded with silence:
    // a clip that goes quiet halfway through would test two conditions and
    // report one number.
    const v = speech[i]! + noise[i % noise.length]! * gain;
    out[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }

  if (peak > 0.99) {
    const trim = 0.99 / peak;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * trim;
  }
  return out;
}
