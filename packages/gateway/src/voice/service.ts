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
  /**
   * ISO-639-1 code for the storefront's language.
   *
   * Left unset, transcription auto-detects — and it detects from a few
   * hundred milliseconds of a shopper in a room with background noise, which
   * it gets wrong. A spoken English question came back transcribed in Urdu
   * script; the model then answered in Urdu, correctly, to a shopper who had
   * spoken English.
   *
   * A storefront has one language and we know it, so there is nothing to
   * detect. Auto-detection is only the right default for an app that serves
   * every language at once, which a single merchant's store is not.
   */
  readonly language?: string;
  /**
   * Vocabulary hint for the decoder. Anchors a short, noisy utterance
   * without pinning its language — see the `prompt` field below.
   */
  readonly transcriptionHint?: string;
  /** Reports decisions a caller cannot otherwise see. See voice_prompt_echo. */
  readonly log?: { warn(event: string, fields?: Record<string, unknown>): void };
}

export const DEFAULT_VOICE: Omit<VoiceConfig, 'apiKey'> = {
  // Verified present in GET /v1/models on 2026-09-02.
  sttModel: 'gpt-4o-transcribe',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'alloy',
  /**
   * Unset = detect, which is what a store serving shoppers in several
   * languages needs.
   *
   * Forcing English fixed a real failure — an English question came back in
   * Urdu script — but fixed it by removing the capability. Detection is
   * instead made reliable the way it is meant to be: the `prompt` below
   * carries the storefront's own vocabulary, which is what anchors a short
   * utterance, and a shopper speaking Urdu is then transcribed in Urdu and
   * answered in Urdu.
   *
   * Set VOICE_LANGUAGE to an ISO-639-1 code to pin a single-language store.
   */
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

  /**
   * Strip the codec parameter before uploading.
   *
   * A browser MediaRecorder reports `audio/webm;codecs=opus`, and that string
   * was passed through verbatim as the upload's MIME type. Transcription
   * answered 400 "Audio file might be corrupted or unsupported" for every
   * voice turn — the recording was fine (18KB to 129KB of clean audio, with
   * speech and silence correctly detected), and the parameter alone was
   * enough to have the file rejected.
   *
   * The container is what matters; the codec inside it is the decoder's
   * business. The filename extension must match that container too — our own
   * TTS returns ogg/opus and was once uploaded as `turn.webm`.
   */
  const container = contentType.split(';')[0]!.trim().toLowerCase();

  /**
   * A short list of nouns, not a sentence, and deliberately so.
   *
   * The previous hint was a full English sentence, which did two things
   * wrong at once. It pulled detection toward English — a decoder told to
   * expect English prose will transliterate a Spanish shopper into English
   * rather than transcribe them — and being well-formed prose it was
   * exactly the kind of text the model echoes back verbatim when the audio
   * is unintelligible, which is how it ended up in the chat as a shopper's
   * message.
   *
   * Bare nouns still anchor the shopping vocabulary, carry almost no
   * grammar to pull the language with them, and are short enough that an
   * echo is both rarer and easier to recognise.
   */
  /**
   * NO PROMPT BY DEFAULT. The hint was the bug, not the fix.
   *
   * Every version of this hint came back as a shopper message. The long
   * sentence echoed whole; the bare noun list echoed in fragments —
   * "colours", "availability,", "products, sizes," — and, worse, echoed
   * TRANSLATED: "produkty, rozmiary, kolory, ceny, dostępność, wysyłka"
   * arrived as a Polish shopper's question and was answered at length in
   * Polish, in a store with no Polish shoppers. Each fabrication then set
   * the reply language, so a shopper asking in English watched the
   * assistant answer someone who did not exist, in a language they do not
   * read.
   *
   * A decoder given a prompt will return that prompt when it has nothing
   * to decode. The only version that cannot echo is the one we do not
   * send. Vocabulary anchoring is not worth inventing shoppers, and the
   * language it was protecting is now passed in explicitly by the
   * storefront (see VoiceConfig.language) rather than inferred.
   */
  const hint = cfg.transcriptionHint ?? '';

  const upload = async (type: string): Promise<Response> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type }), `turn.${extensionFor(type)}`);
    form.append('model', cfg.sttModel);
    // Tell it the language rather than letting it guess from a noisy second
    // of audio. See VoiceConfig.language.
    if (cfg.language !== undefined && cfg.language !== '') form.append('language', cfg.language);
    /**
     * Bias transcription toward how shoppers speak to a store assistant.
     *
     * This is what makes detection safe enough to leave on. A second of
     * audio is thin evidence for a language, and the misdetection that put
     * an English question into Urdu script happened on exactly that. A
     * prompt full of the vocabulary actually expected — the shop's own words
     * — anchors the decode without pinning the language, so a shopper who
     * really is speaking another language still gets transcribed in it.
     */
    if (hint !== '') form.append('prompt', hint);
    return doFetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
  };

  let res = await upload(container);

  /**
   * One retry as ogg, for opus specifically.
   *
   * webm and ogg are both just containers around the same opus stream, and a
   * MediaRecorder webm carries no duration in its header — some decoders
   * refuse it. Relabelling costs one request on a path that has already
   * failed, and turns a dead voice turn into a working one. Only attempted
   * for the ambiguous case, and only once.
   */
  if (res.status === 400 && container === 'audio/webm') {
    res = await upload('audio/ogg');
  }
  if (!res.ok) {
    // The reason, truncated and redacted.
    //
    // This used to report the status alone, on the grounds that the upstream
    // body might carry request detail. It carries the answer: "Invalid file
    // format" and "model not found" are the same 400 here and need opposite
    // fixes. A mic that recorded 27KB and silently restarted was diagnosed
    // down to this line, which had thrown the explanation away.
    //
    // The shopper never sees it — it goes to the log, which is why it is
    // stripped of anything key-shaped first.
    let detail = '';
    try {
      detail = (await res.text())
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
        .slice(0, 200)
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      detail = 'no body';
    }
    throw new VoiceError(`transcription failed (${res.status}): ${detail}`, 502);
  }
  const body = (await res.json()) as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '') {
    // Upstream heard nothing in audio the browser thought was speech. A
    // distinct event from the echo filter below, because the fixes are
    // opposite: one is a recording problem, the other is ours.
    cfg.log?.warn('voice_upstream_empty', { bytes: audio.length, container });
  }

  /**
   * Drop a transcript that is just the prompt read back.
   *
   * The `prompt` parameter biases the decode, and when there is nothing
   * intelligible to decode the model returns the prompt itself as the
   * transcript. It is confident, well-formed, and completely fabricated —
   * so "Shopping questions about products, sizes, prices, shipping and
   * returns." appeared in the chat as though the shopper had said it, and
   * the assistant answered it.
   *
   * Silence must read as silence. Compared on words rather than exactly,
   * because the echo comes back with different casing and punctuation.
   */
  if (looksFabricated(text, hint)) {
    // Logged, because "the model heard nothing" and "we discarded what it
    // heard" are the same empty string to every caller — and a filter that
    // silently eats real speech is indistinguishable from a broken
    // microphone. Words only: never the transcript, which is shopper
    // speech.
    cfg.log?.warn('voice_prompt_echo', { words: text.split(/\s+/).length });
    return '';
  }
  return text;
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

/**
 * Is this transcript just the prompt being read back?
 *
 * Compared on word overlap rather than string equality: the echo returns
 * with different casing, punctuation and occasionally a dropped clause, so
 * an exact match would catch almost none of them. A genuine shopper
 * question shares a few words with the hint at most — "prices", "shipping"
 * — and never most of it.
 */
/**
 * Is this transcript something the decoder invented rather than heard?
 *
 * `echoesPrompt` below catches a whole prompt read back, and caught none of
 * what actually reached shoppers. Recovered from one live session, every one
 * of these arrived as a "shopper message" and was answered:
 *
 *     "colours"        "availability,"        "products, sizes,"
 *     "###"            "context:"             "produkte,"
 *     "produkty, rozmiary, kolory, ceny, dostępność, wysyłka"
 *
 * Three holes, all in the same `if`. Fragments fell under the five-word
 * floor. Translations shared no words with an English hint, so overlap read
 * zero. Punctuation-only junk is not an echo of anything and was never
 * considered.
 *
 * The rules below are deliberately structural rather than lexical, because a
 * fabrication in Polish is still a fabrication and we cannot enumerate every
 * language. The cost of a false positive is one dropped turn on audio the
 * shopper can simply repeat. The cost of a false negative is the assistant
 * answering a question nobody asked — which is what they saw.
 */
export function looksFabricated(text: string, hint: string): boolean {
  const t = text.trim();
  if (t === '') return false;

  // No letters at all: "###", "...", "—". Nothing was heard; something was
  // emitted. There is no shopper question without a letter in it.
  if (!/\p{L}/u.test(t)) return true;

  const said = t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  /**
   * A bare comma list is the hint's shape, in any language.
   *
   * Three or more comma-separated items with no sentence to hold them is how
   * the vocabulary hint comes back, translated or not. Shoppers speak in
   * sentences — "do you have these in black" — and a spoken list of six
   * nouns with no verb is not a question anyone asks out loud.
   */
  const items = t.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length >= 3 && said.length <= 12 && items.every((s) => s.split(/\s+/).length <= 3)) {
    return true;
  }

  const prompt = new Set(
    hint
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );

  const overlap =
    prompt.size === 0 ? 0 : said.filter((w) => prompt.has(w)).length / said.length;

  /**
   * A comma list that trails off into a sentence is still the hint.
   *
   * The string actually seen live was the list plus one more clause —
   * "…shipping and returns. Product names may be brand names." That last
   * clause drops whole-prompt overlap to about half and makes the final
   * comma item a six-word sentence, so the two rules either side of this
   * one both miss it, and it reached a shopper as a question.
   *
   * Three or more comma items AND half the words being our own vocabulary
   * is not a sentence a shopper speaks.
   */
  if (items.length >= 3 && overlap >= 0.5) return true;

  /**
   * A short transcript made ENTIRELY of hint words is the hint, not a
   * question. "colours" and "availability," are the clearest cases: alone,
   * they are our own vocabulary handed back. A shopper who really did say
   * only "colours" loses one turn and repeats it; the alternative is
   * answering a phantom.
   *
   * Only applies while a hint is being sent at all — with `hint` empty the
   * set is empty and this cannot fire.
   */
  if (prompt.size > 0 && said.length <= 3 && said.every((w) => prompt.has(w))) return true;

  return echoesPrompt(text, hint);
}

export function echoesPrompt(text: string, hint: string): boolean {
  const words = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const said = words(text);
  const prompt = new Set(words(hint));
  if (said.length === 0 || prompt.size === 0) return false;
  // Short utterances are the risky ones to judge, but they are also where a
  // real question lives ("how much is this"), so require real length before
  // calling it an echo.
  if (said.length < 5) return false;

  const overlap = said.filter((w) => prompt.has(w)).length / said.length;
  return overlap >= 0.8;
}
