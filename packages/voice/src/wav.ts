/**
 * 16-bit PCM WAV, written and read.
 *
 * ## Why this format, of all the ones available
 *
 * The browser can hand us opus in a webm container for free, and that is what
 * the widget used to upload. Every voice bug worth its own commit came from
 * that decision:
 *
 *   - `audio/webm;codecs=opus` passed through verbatim had *every* upload
 *     rejected with "file might be corrupted or unsupported" — the codec
 *     parameter alone was enough.
 *   - A `MediaRecorder` webm carries no duration in its header, and a
 *     fragmented one (which is what a timeslice produces) is a file a decoder
 *     may stop reading partway through. It does not say so. It transcribes
 *     what it managed to read and invents the rest, which is how one English
 *     sentence came back as Urdu, then Turkish, then Latvian.
 *
 * WAV has no opinions. A header, then samples, with the length written down.
 * There is nothing left to misparse, and being uncompressed is not a cost
 * worth caring about at 16 kHz mono for a few seconds of speech — see
 * `TARGET_RATE`.
 */

/**
 * The sample rate we upload at, and why it is not the microphone's.
 *
 * A browser hands back 44.1 or 48 kHz because that is what the hardware runs
 * at. Every speech recogniser in use — Whisper and its descendants included —
 * resamples to 16 kHz internally before it looks at the audio, so the extra
 * bandwidth carries no information the decoder will ever read.
 *
 * It does carry three times the bytes. A four-second turn is 384 KB at 48 kHz
 * and 128 KB at 16 kHz, and on a phone's uplink that difference is seconds of
 * a shopper waiting — the single largest term in time-to-transcript on mobile,
 * larger than the model's own latency.
 */
export const TARGET_RATE = 16_000;

export interface Pcm {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/**
 * Write mono 16-bit PCM WAV.
 *
 * Samples outside [-1, 1] are clamped rather than wrapped. A wrap turns one
 * loud syllable into a burst of full-scale noise, which a recogniser reads as
 * a consonant that was never spoken; clamping degrades gracefully into the
 * distortion the shopper's own microphone would have produced anyway.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate: rate × channels × 2
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return bytes;
}

export class WavError extends Error {
  override readonly name = 'WavError';
}

/**
 * Read a 16-bit PCM WAV back, downmixed to mono.
 *
 * Exists so the header this module writes can be verified by reading it rather
 * than by asserting on byte offsets — an assertion on offset 24 passes just as
 * happily when the value written there is wrong.
 *
 * Chunks are walked rather than assumed at offset 36: a `LIST` chunk between
 * `fmt ` and `data` is legal, common in files that have been through an
 * editor, and would silently shift every sample if skipped over.
 */
export function decodeWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

  if (bytes.byteLength < 44) throw new WavError('too short to be a WAV file');
  if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE') throw new WavError('not a RIFF/WAVE file');

  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 0;
  let dataAt = -1;
  let dataLength = 0;

  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (view.getUint16(body, true) !== 1) throw new WavError('only uncompressed PCM is supported');
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataAt = body;
      // A writer that streamed the file may have left the length at 0 or at
      // 0xFFFFFFFF because it did not know it yet. Trust the file's real size
      // over a placeholder rather than returning an empty clip.
      dataLength = Math.min(size, bytes.byteLength - body);
      if (size === 0 || size === 0xffffffff) dataLength = bytes.byteLength - body;
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    at = body + size + (size % 2);
  }

  if (dataAt === -1) throw new WavError('no data chunk');
  if (bitsPerSample !== 16) throw new WavError(`expected 16-bit samples, got ${bitsPerSample}`);
  if (channels < 1) throw new WavError('no channels');

  const frames = Math.floor(dataLength / 2 / channels);
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += view.getInt16(dataAt + (f * channels + c) * 2, true) / 0x8000;
    }
    samples[f] = sum / channels;
  }
  return { samples, sampleRate };
}

/**
 * Resample by linear interpolation.
 *
 * Not a windowed-sinc resampler, and the difference matters less than it
 * sounds. Going 48 kHz → 16 kHz without a low-pass first aliases everything
 * above 8 kHz back down into the speech band, so a one-line box filter runs
 * first — averaging each output sample's input window, which is exactly the
 * anti-alias step the naive version omits. Speech energy that matters for
 * recognition sits under 4 kHz; what aliasing would fold in is sibilance and
 * room hiss, and the filter removes it for one multiply per input sample.
 *
 * Upsampling is a pass-through interpolation with no filter, because there is
 * nothing above the input's own Nyquist to fold.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);

  if (ratio <= 1) {
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const lo = Math.floor(pos);
      const hi = Math.min(samples.length - 1, lo + 1);
      const frac = pos - lo;
      out[i] = samples[lo]! * (1 - frac) + samples[hi]! * frac;
    }
    return out;
  }

  // Downsampling: average the whole input window that maps to each output
  // sample. This is the anti-alias filter and the decimation in one pass.
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j]!;
    out[i] = end > start ? sum / (end - start) : samples[start] ?? 0;
  }
  return out;
}
