/**
 * Is there speech in this audio at all?
 *
 * ## The bug this exists to kill
 *
 * Measured against the fixture corpus, `gpt-4o-transcribe` handed four seconds
 * of silence returned:
 *
 *     silence-room       -> "Thank you for watching."
 *     silence-room-loud  -> "Thanks for watching!"
 *     silence-digital    -> "Covenant."
 *
 * "Thank you for watching" is the single most famous Whisper-family
 * hallucination — subtitle boilerplate learnt from video training data, emitted
 * when the model is handed something it cannot decode. Four of four silence
 * clips produced text.
 *
 * None of the existing defences can catch it. `mismatchesLanguage` compares
 * writing systems and this is plain ASCII English. `looksFabricated` looks for
 * our own vocabulary hint echoed back, and no hint is sent any more. So a
 * shopper who said nothing gets a confident English sentence, read aloud.
 *
 * ## Why the check is acoustic and not textual
 *
 * There is no text rule that separates "Thank you for watching" from a shopper
 * actually saying thank you. There is an obvious ACOUSTIC one: the first came
 * from audio with no speech in it.
 *
 * So this decides, before the API call, whether the audio contains speech. It is
 * cheaper (a skipped request), language-agnostic (it never looks at words), and
 * it removes the whole class rather than the examples we happened to see.
 *
 * ## What makes speech recognisable without recognising it
 *
 * Not loudness — a shop is louder than a quiet room, and a whisper is quieter
 * than a fan. **Structure.** Speech is syllables and gaps: frame energy swings
 * by an order of magnitude several times a second. Stationary noise — a fan,
 * traffic, a fridge, digital zero — is flat.
 *
 * So the test is peak-to-median frame energy. Speech clears it comfortably even
 * buried in noise; stationary noise cannot produce it by definition, because
 * being stationary is what "flat" means.
 *
 * ## The failure it prefers
 *
 * Rejecting real speech costs the shopper one repeat, and shows up as `empty` in
 * the metrics. Accepting a fabrication means answering a question nobody asked,
 * out loud — which has already happened to real shoppers. The thresholds are
 * therefore set to reject only what is unmistakably not speech, and validated
 * against 63 speech clips including ones at 6 dB SNR, where noise fills the gaps
 * and this test is hardest.
 */

/** 20 ms frames: shorter than a syllable, longer than a pitch period. */
const FRAME_MS = 20;

/**
 * Below this, the audio is digital silence and nothing acoustic is present.
 *
 * A real microphone never returns exactly zero — there is always a noise floor —
 * so this cannot reject a genuine recording. It exists because a widget bug, a
 * muted track or an ended MediaStream produces literal zeros, and asking a model
 * to transcribe those is how "Covenant." happened.
 */
export const SILENCE_RMS = 0.0005;

/**
 * How much louder the loudest moment must be than the typical one.
 *
 * MEASURED, not chosen. Across the fixture corpus:
 *
 *     speech      max/median   min 1.84   p10 2.20   median 3.65
 *     non-speech  max/median             max 1.57
 *
 * 1.7 sits in that gap. Two earlier attempts are worth recording because both
 * were wrong in ways that only measurement showed:
 *
 *   - **95th percentile instead of the maximum**, chosen so a single click could
 *     not make silence look like speech. It destroyed the signal: for speech the
 *     peak IS in the top 5%, so speech fell to 1.46 and non-speech reached 1.48 —
 *     the distributions crossed, and 26 of 63 real speech clips were rejected.
 *   - **Pitch periodicity** (autocorrelation in the 70–300 Hz range), on the
 *     theory that speech is voiced and noise is not. Music is also periodic, and
 *     scored 0.53 against a speech floor of 0.12. Worse than useless.
 *
 * The gap is real but narrow — 1.57 to 1.84 — and this corpus is synthesised.
 * Real speech has breaths and pauses and should score higher; real room noise is
 * about as stationary as the synthetic kind. That is an argument, not a
 * measurement, which is precisely why this test does not act alone. See
 * `looksHallucinated`.
 */
export const MIN_DYNAMIC_RANGE = 1.7;

export interface SpeechPresence {
  /** Overall root-mean-square amplitude. */
  readonly rms: number;
  /** Loudest frame over the typical frame. The structure measure. */
  readonly dynamicRange: number;
  readonly frames: number;
  /** Does this contain speech? */
  readonly speech: boolean;
  /** Why not, when it does not. Reported as a metric, never to the shopper. */
  readonly reason?: 'digital_silence' | 'no_dynamic_range' | 'too_short';
}

export function speechPresence(samples: Float32Array, sampleRate: number): SpeechPresence {
  const frameLength = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const frameCount = Math.floor(samples.length / frameLength);

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i]! * samples[i]!;
  const rms = samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);

  if (rms < SILENCE_RMS) {
    return { rms, dynamicRange: 0, frames: frameCount, speech: false, reason: 'digital_silence' };
  }

  /**
   * Too short to have structure.
   *
   * Under about a fifth of a second there are not enough frames for "peak versus
   * typical" to mean anything, and a single syllable is a legitimate answer
   * ("yes", "black"). So short audio is PASSED to the decoder rather than judged
   * here — the widget's own minimum-speech gate already covers the cough case.
   */
  if (frameCount < 10) {
    return { rms, dynamicRange: 0, frames: frameCount, speech: true };
  }

  const energies: number[] = [];
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * frameLength;
    for (let i = start; i < start + frameLength; i++) sum += samples[i]! * samples[i]!;
    energies.push(Math.sqrt(sum / frameLength));
  }

  const sorted = [...energies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  /**
   * The maximum, not a percentile.
   *
   * The 95th percentile was tried first, to stop a single click making silence
   * look like speech. It cannot work: for speech the loudest frame is in the top
   * 5% by definition, so trimming it collapsed speech to the same range as noise
   * and the test rejected a third of real utterances. A click surviving into this
   * number is handled by not letting this test decide alone.
   */
  const peak = sorted[sorted.length - 1]!;
  const dynamicRange = median <= 0 ? Number.POSITIVE_INFINITY : peak / median;

  if (dynamicRange < MIN_DYNAMIC_RANGE) {
    return { rms, dynamicRange, frames: frameCount, speech: false, reason: 'no_dynamic_range' };
  }
  return { rms, dynamicRange, frames: frameCount, speech: true };
}

/**
 * Two weak signals agreeing, rather than one thin one deciding.
 *
 * The acoustic gap between speech and stationary noise is real but narrow (1.57
 * to 1.84 on the corpus), and narrow enough that a single threshold applied to a
 * shopper's real microphone would eventually eat a real question. So a transcript
 * is only discarded when BOTH are true:
 *
 *   1. the audio had no speech structure, AND
 *   2. the decoder returned almost nothing
 *
 * That combination is what a hallucination looks like and what real speech does
 * not. Every fabrication measured was four words or fewer — "Covenant.", "sr",
 * "Thank you for watching." — while the speech clips that scored lowest
 * acoustically were the LONGEST ones, because continuous narration is exactly
 * what has little frame-to-frame variation. The two signals fail in opposite
 * directions, which is what makes requiring both safe.
 *
 * Digital silence is handled before this and needs no second opinion: a real
 * microphone never returns exact zeros.
 */
const HALLUCINATION_MAX_WORDS = 5;

export function looksHallucinated(presence: SpeechPresence, text: string): boolean {
  if (presence.speech) return false;
  if (presence.reason === 'digital_silence') return true;
  const words = text.trim().split(/\s+/).filter((w) => w !== '');
  return words.length > 0 && words.length <= HALLUCINATION_MAX_WORDS;
}
