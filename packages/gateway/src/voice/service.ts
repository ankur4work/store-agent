/**
 * Voice I/O.
 *
 * Both directions are PROXIED through the gateway rather than called from the
 * browser. A realtime speech-to-speech session would need an ephemeral client
 * credential in the page; proxying keeps the API key server-side entirely,
 * which is worth the extra hop.
 *
 * ## Why this is a pipeline and not speech-to-speech
 *
 * `gpt-realtime-2.1` exists and would be faster. It is also unusable for this
 * product: it emits audio, not text, so there is no structured output to
 * validate, no `claims` to check, and nothing for the mid-stream grounding
 * tripwire to inspect. Worse, **audio cannot be retracted** — in chat a
 * tripwire trip clears the bubble, but a spoken price is already in the
 * shopper's ear.
 *
 * So voice reuses the text stack unchanged: STT in, the same grounded
 * orchestrator, and TTS applied ONLY to text the tripwire has already settled
 * and validated. We trade a few hundred milliseconds for the guarantee the
 * whole product rests on.
 */

export interface VoiceConfig {
  readonly apiKey: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly voice: string;
}

export const DEFAULT_VOICE: Omit<VoiceConfig, 'apiKey'> = {
  // Verified present in GET /v1/models on 2026-09-02.
  sttModel: 'gpt-4o-transcribe',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'alloy',
};

export class VoiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Longest single utterance we will synthesize. Chunks are sentence-sized. */
const MAX_TTS_CHARS = 600;
/** Cap on uploaded audio — a voice turn is seconds, not minutes. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export async function transcribe(
  audio: Buffer,
  contentType: string,
  cfg: VoiceConfig,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  if (audio.length === 0) throw new VoiceError('empty audio', 400);
  if (audio.length > MAX_AUDIO_BYTES) throw new VoiceError('audio too large', 413);

  const form = new FormData();
  // The filename extension must match the actual container, not just the
  // declared MIME type — a mislabelled upload is rejected upstream, and the
  // failure surfaces as an opaque 502. Found by the round-trip check: our own
  // TTS returns ogg/opus, which was being uploaded as `turn.webm`.
  form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), `turn.${extensionFor(contentType)}`);
  form.append('model', cfg.sttModel);
  // Bias transcription toward how shoppers actually speak to a store assistant.
  form.append('prompt', 'Shopping questions about products, sizes, prices, shipping and returns.');

  const res = await doFetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    // Never echo the upstream body — it can contain request detail we do not
    // want in logs, and the shopper cannot act on it anyway.
    throw new VoiceError(`transcription failed (${res.status})`, 502);
  }
  const body = (await res.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text.trim() : '';
}

/** Container extensions the transcription endpoint accepts. */
const EXTENSIONS: readonly (readonly [RegExp, string])[] = [
  [/ogg|opus/, 'ogg'],
  [/webm/, 'webm'],
  [/wav|wave|x-pcm/, 'wav'],
  [/mp4|m4a|aac/, 'mp4'],
  [/mpeg|mp3|mpga/, 'mp3'],
  [/flac/, 'flac'],
];

export function extensionFor(contentType: string): string {
  const ct = contentType.toLowerCase();
  for (const [re, ext] of EXTENSIONS) if (re.test(ct)) return ext;
  return 'webm'; // what MediaRecorder produces by default in the browser
}

export async function synthesize(
  text: string,
  cfg: VoiceConfig,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ArrayBuffer> {
  const trimmed = text.trim();
  if (trimmed === '') throw new VoiceError('empty text', 400);
  if (trimmed.length > MAX_TTS_CHARS) throw new VoiceError('text too long', 413);

  const res = await doFetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.ttsModel,
      voice: cfg.voice,
      input: trimmed,
      // Opus in a webm container: lowest time-to-first-audio of the streaming
      // formats, which is the metric that matters in a conversation.
      response_format: 'opus',
      instructions: 'Warm, clear, unhurried retail assistant. Natural pace, no salesy lilt.',
    }),
  });
  if (!res.ok) throw new VoiceError(`speech synthesis failed (${res.status})`, 502);
  return res.arrayBuffer();
}
