import {
  decodeWav,
  looksHallucinated,
  speechPresence,
  type SpeechPresence,
} from '@storeagent/voice';

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
  /** Playback rate for synthesis, 0.25–4.0. See DEFAULT_VOICE.speed. */
  readonly speed?: number;
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
  /**
   * Pure-ASR model tried when the primary invents instead of transcribing.
   *
   * `gpt-4o-transcribe` is a language model doing transcription, and it
   * behaves like one: handed audio it cannot decode it does not fall
   * silent, it writes a fluent sentence in whatever language it lands on.
   * One English question produced Urdu, Turkish, Latvian and Russian on
   * four consecutive attempts. `whisper-1` is an acoustic model with no
   * such instinct — given `language` it either transcribes or returns
   * nothing.
   *
   * Kept as a fallback rather than the default: the primary is better on
   * accented speech and shop vocabulary when the audio is good, and this
   * only costs a second request on turns that already failed.
   */
  readonly fallbackSttModel?: string;
  /** Reports decisions a caller cannot otherwise see. See voice_prompt_echo. */
  readonly log?: { warn(event: string, fields?: Record<string, unknown>): void };
  /**
   * Counts what happened, for `/metrics`.
   *
   * The log lines below already record every outcome, and that turned out not
   * to be enough: a log line answers "did this happen once", and the questions
   * that matter are rates. How often is a transcript discarded as an echo? Is
   * the whisper-1 fallback rescuing one turn a day or one in five? Those are
   * subtractions of two counters, and there was no counter.
   *
   * Deliberately a separate sink from `log` rather than a second call at each
   * site: both go through `note()` below, so the metric and the log cannot
   * drift out of agreement about what happened.
   */
  readonly onOutcome?: (outcome: TranscriptOutcome, fields?: Record<string, unknown>) => void;
}

/**
 * Every way a transcription attempt can end.
 *
 * Kept distinct because the fixes are different and, more importantly, because
 * they are not all *our* failures. An unpaid account and a misheard word are
 * both "no usable transcript" to the shopper and have nothing else in common;
 * one is a billing page and the other is an audio pipeline.
 */
export type TranscriptOutcome =
  /** A usable transcript from the primary model. */
  | 'heard'
  /** The primary produced nothing usable and whisper-1 saved the turn. */
  | 'rescued'
  /** Upstream heard nothing in audio the browser thought was speech. */
  | 'empty'
  /**
   * The audio contained no speech, so nothing was sent.
   *
   * Digital zeros — a muted track, an ended MediaStream, a widget bug. Caught
   * before the API call, because a decoder handed silence does not return
   * nothing, it returns "Covenant."
   */
  | 'no_speech'
  /**
   * A transcript discarded because the audio had no speech in it.
   *
   * The Whisper-family hallucination: "Thank you for watching", learnt from
   * subtitle data and emitted when there is nothing to decode. Plain English, so
   * no text rule can separate it from a shopper saying thank you — only the
   * audio can.
   */
  | 'hallucinated'
  /** The decoder handed our own vocabulary hint back as a shopper message. */
  | 'prompt_echo'
  /** Answered in a language the storefront did not ask for. */
  | 'language_mismatch'
  | 'fallback_failed'
  | 'fallback_unusable'
  /** Upstream refused, transiently or for a reason we cannot classify. */
  | 'upstream_error'
  /**
   * Upstream refused because the account cannot be charged.
   *
   * Arrives as an HTTP 429, which is the same status as a rate limit and is
   * not one: retrying is futile and every voice turn will fail identically
   * until someone visits a billing page. Counting it as a transcription
   * failure hides an operational problem inside a quality metric — and that
   * is exactly how it presented when this was first measured, as four
   * identical 502s that looked like a broken audio pipeline.
   */
  | 'upstream_unpaid';

/**
 * The log event each outcome is reported as.
 *
 * `undefined` means it is not logged here: `heard` would be a line on every
 * voice turn, and the upstream failures are already logged by the caller with
 * the request detail this function does not have.
 */
const LOG_EVENT: Readonly<Record<TranscriptOutcome, string | undefined>> = {
  heard: undefined,
  rescued: 'voice_fallback_rescued',
  empty: 'voice_upstream_empty',
  no_speech: 'voice_no_speech',
  hallucinated: 'voice_hallucinated',
  prompt_echo: 'voice_prompt_echo',
  language_mismatch: 'voice_language_mismatch',
  fallback_failed: 'voice_fallback_failed',
  fallback_unusable: 'voice_fallback_unusable',
  upstream_error: undefined,
  upstream_unpaid: undefined,
};

/** Report an outcome to both sinks, so they cannot disagree. */
function note(
  cfg: VoiceConfig,
  outcome: TranscriptOutcome,
  fields?: Record<string, unknown>,
): void {
  const event = LOG_EVENT[outcome];
  if (event !== undefined) cfg.log?.warn(event, fields);
  cfg.onOutcome?.(outcome, fields);
}

/**
 * Is this upstream refusal permanent, and about money rather than audio?
 *
 * Matched on the response body rather than the status, because the status is
 * 429 either way. `type` and `code` are the authoritative fields; the human
 * message is matched too, since it is the part that has stayed stable across
 * API revisions while the codes have been renamed.
 */
export function isUnpaid(detail: string): boolean {
  return /billing_not_active|insufficient_quota|account is not active|exceeded your current quota/i.test(
    detail,
  );
}

export const DEFAULT_VOICE: Omit<VoiceConfig, 'apiKey'> = {
  // Verified present in GET /v1/models on 2026-09-02.
  sttModel: 'gpt-4o-transcribe',
  // Verified present in GET /v1/models on 2026-09-12.
  fallbackSttModel: 'whisper-1',
  ttsModel: 'gpt-4o-mini-tts',
  /**
   * Soft, female, unhurried in tone but not in pace.
   *
   * `alloy` is the neutral default and reads flat over a storefront. A
   * shop assistant's voice should sound like someone who works there and
   * is glad to help; `shimmer` is the gentlest of the female voices, and
   * the speed below stops gentle turning into slow.
   */
  voice: 'shimmer',
  /**
   * Slightly quicker than natural. A shopper is waiting on an answer they
   * could have read in two seconds, so the default 1.0 feels padded read
   * aloud — and anything past ~1.2 starts to sound harried.
   */
  speed: 1.15,
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
  constructor(
    message: string,
    readonly status: number,
    /**
     * Which outcome this failure counts as.
     *
     * Carried on the error so the caller can label its metric without parsing
     * the message back apart — a string match on an error message is a
     * classification that breaks silently when the message is reworded.
     */
    readonly outcome: TranscriptOutcome = 'upstream_error',
  ) {
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

  const upload = async (type: string, model: string = cfg.sttModel): Promise<Response> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type }), `turn.${extensionFor(type)}`);
    form.append('model', model);
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

  /**
   * Look at the audio before asking a model to interpret it.
   *
   * Only for WAV, which is what the widget uploads on every path — the PCM rungs
   * write it directly and the MediaRecorder fallback re-encodes to it. An opus
   * container cannot be inspected without a decoder, so those fall through to the
   * text-level defences alone, as before.
   */
  let presence: SpeechPresence | undefined;
  if (/wav|wave|x-pcm/.test(container)) {
    try {
      const pcm = decodeWav(new Uint8Array(audio));
      presence = speechPresence(pcm.samples, pcm.sampleRate);
    } catch {
      // An unreadable WAV is the upload path's problem, not this check's. Let
      // the decoder have it and report what it says.
    }
  }

  /**
   * Digital silence is not sent at all.
   *
   * A real microphone never returns exact zeros, so this cannot reject a genuine
   * recording — and it saves the request as well as the fabrication.
   */
  if (presence?.reason === 'digital_silence') {
    note(cfg, 'no_speech', { bytes: audio.length, container });
    return '';
  }

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
    // An unpaid account is not a transcription problem and must not be counted
    // as one. It also must not be retried on the acoustic model below: that
    // request cannot succeed either, and spending it doubles the latency of
    // every voice turn for as long as the account stays inactive.
    const outcome: TranscriptOutcome = isUnpaid(detail) ? 'upstream_unpaid' : 'upstream_error';
    note(cfg, outcome, { status: res.status, container });
    throw new VoiceError(`transcription failed (${res.status}): ${detail}`, 502, outcome);
  }
  const body = (await res.json()) as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '') {
    // Upstream heard nothing in audio the browser thought was speech. A
    // distinct event from the echo filter below, because the fixes are
    // opposite: one is a recording problem, the other is ours.
    note(cfg, 'empty', { bytes: audio.length, container });
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
  /**
   * Two independent signals agreeing that nothing was said.
   *
   * The audio had no speech structure AND the decoder returned almost nothing.
   * Real speech fails those in opposite directions — the flattest clips measured
   * were the longest ones — which is what makes requiring both safe where either
   * alone was not. Validated on the fixture corpus: 4 of 4 fabrications caught,
   * 63 of 63 real utterances kept.
   *
   * No acoustic-model retry: the audio has no speech in it, so a second request
   * would spend money to hallucinate again.
   */
  if (presence !== undefined && looksHallucinated(presence, text)) {
    note(cfg, 'hallucinated', {
      words: text.split(/\s+/).filter(Boolean).length,
      dynamicRange: Math.round(presence.dynamicRange * 100) / 100,
    });
    return '';
  }

  if (looksFabricated(text, hint)) {
    // Logged, because "the model heard nothing" and "we discarded what it
    // heard" are the same empty string to every caller — and a filter that
    // silently eats real speech is indistinguishable from a broken
    // microphone. Words only: never the transcript, which is shopper
    // speech.
    note(cfg, 'prompt_echo', { words: text.split(/\s+/).length });
    return '';
  }

  /**
   * Answered in a language we did not ask for — treat as not heard.
   *
   * Returning '' puts this on the same path as silence: the widget says it
   * did not catch that and the shopper tries again. Logged with the script
   * rather than the text, which is shopper speech even when invented.
   */
  if (mismatchesLanguage(text, cfg.language)) {
    note(cfg, 'language_mismatch', {
      asked: cfg.language ?? null,
      got: dominantScript(text),
      words: text.split(/\s+/).length,
    });
    return retryWithAcousticModel(audio, container, cfg, doFetch, upload);
  }
  if (text === '') return retryWithAcousticModel(audio, container, cfg, doFetch, upload);
  note(cfg, 'heard', { words: text.split(/\s+/).length, bytes: audio.length });
  return text;
}

/**
 * Which writing system each language is actually written in.
 *
 * Only the codes a storefront realistically declares. An unlisted code is
 * not guessed at — the check simply does not run, because a wrong guess
 * here silently eats real speech.
 */
const SCRIPT_FOR_LANGUAGE: Readonly<Record<string, string>> = {
  en: 'Latin', fr: 'Latin', es: 'Latin', de: 'Latin', it: 'Latin', pt: 'Latin',
  nl: 'Latin', sv: 'Latin', da: 'Latin', nb: 'Latin', fi: 'Latin', pl: 'Latin',
  cs: 'Latin', tr: 'Latin', id: 'Latin', ms: 'Latin', vi: 'Latin', ro: 'Latin',
  hu: 'Latin', hr: 'Latin', sk: 'Latin', lt: 'Latin', lv: 'Latin', et: 'Latin',
  hi: 'Devanagari', mr: 'Devanagari', ne: 'Devanagari',
  ur: 'Arabic', ar: 'Arabic', fa: 'Arabic',
  ru: 'Cyrillic', uk: 'Cyrillic', bg: 'Cyrillic', sr: 'Cyrillic',
  el: 'Greek', he: 'Hebrew', th: 'Thai', ko: 'Hangul',
  zh: 'Han', ja: 'Han',
};

const SCRIPT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['Latin', /\p{Script=Latin}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Han', /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Thai', /\p{Script=Thai}/u],
];

/** The writing system most of this text is in, or '' if it has no letters. */
export function dominantScript(text: string): string {
  const counts = new Map<string, number>();
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    for (const [name, re] of SCRIPT_PATTERNS) {
      if (re.test(ch)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  let best = '';
  let most = 0;
  for (const [name, n] of counts) {
    if (n > most) {
      most = n;
      best = name;
    }
  }
  return best;
}

/**
 * Did the decoder answer in a language we did not ask for?
 *
 * We send `language`, and `gpt-4o-transcribe` treats it as a hint rather
 * than a constraint. On quiet or unclear audio it stops transcribing and
 * starts inventing, and what it invents lands in an arbitrary language: an
 * English question on an `en` storefront came back as Urdu once and as
 * Turkish the next time — "Konuşmamı da bırakmam", which is not a
 * translation of anything that was said. The server log confirmed
 * `header:"en" using:"en"` for both.
 *
 * We cannot make the model obey. We can refuse to believe an answer that
 * is obviously not what we asked for, and a shopper repeating themselves
 * once is far better than the assistant answering a question nobody asked
 * in a language nobody in the conversation speaks.
 *
 * Two checks, because there are two ways to be wrong. A different writing
 * system is conclusive. Turkish is the harder case — it is Latin script,
 * like English — so for English alone an unusual density of non-ASCII
 * letters (ş, ı, ğ) is taken as the same evidence. Ratio, not presence, so
 * "café" or "naïve" in a real sentence survives.
 */
export function mismatchesLanguage(text: string, language?: string): boolean {
  if (language === undefined || language === '') return false;
  const expected = SCRIPT_FOR_LANGUAGE[language];
  if (expected === undefined) return false;

  const actual = dominantScript(text);
  if (actual === '') return false;
  if (actual !== expected) return true;

  if (language === 'en') {
    const letters = [...text].filter((c) => /\p{L}/u.test(c));
    if (letters.length < 6) return false;
    /**
     * 15% was too generous. "Kaņepju piens." — Latvian for hemp milk,
     * invented on an English storefront with English selected — carries one
     * diacritic in twelve letters, so it scored 8% and was let through,
     * answered in Latvian.
     *
     * English is written in ASCII. A borrowed "café" inside a real sentence
     * is a handful of letters among thirty and still passes; a two-word
     * fragment built around an accented letter is not English, and the
     * shopper asked for English.
     */
    const foreign = letters.filter((c) => !/[a-zA-Z]/.test(c)).length;
    return foreign / letters.length > 0.05;
  }
  return false;
}

/**
 * Second attempt on a model that does not make things up.
 *
 * Reached only when the primary returned nothing usable — either an empty
 * transcript or a confident sentence in a language the shopper did not ask
 * for. Both mean the same thing: the audio did not decode into what the
 * primary expected, and being a language model, it wrote something anyway.
 *
 * whisper-1 is acoustic. Told the language, it transcribes that language
 * or returns nothing, which is the behaviour a shopper needs — being asked
 * to repeat yourself is recoverable, being answered in Latvian is not.
 *
 * The result is held to the same standard: a fallback that also comes back
 * in the wrong language is discarded too, rather than trusted for having
 * been the second opinion.
 */
async function retryWithAcousticModel(
  audio: Buffer,
  container: string,
  cfg: VoiceConfig,
  doFetch: typeof globalThis.fetch,
  upload: (type: string, model: string) => Promise<Response>,
): Promise<string> {
  const fallback = cfg.fallbackSttModel;
  if (fallback === undefined || fallback === '' || fallback === cfg.sttModel) return '';

  try {
    const res = await upload(container, fallback);
    if (!res.ok) {
      note(cfg, 'fallback_failed', { model: fallback, status: res.status });
      return '';
    }
    const body = (await res.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text === '' || mismatchesLanguage(text, cfg.language)) {
      note(cfg, 'fallback_unusable', {
        model: fallback,
        got: text === '' ? 'empty' : dominantScript(text),
      });
      return '';
    }
    note(cfg, 'rescued', { model: fallback, words: text.split(/\s+/).length });
    return text;
  } catch (err: unknown) {
    note(cfg, 'fallback_failed', {
      model: fallback,
      reason: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
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

/**
 * Raw PCM, as the speech endpoint emits it: 24 kHz, 16-bit signed, mono, LE.
 *
 * Not configurable, because it is a property of the upstream format rather than
 * a choice of ours — and a WAV header that disagrees with the samples produces
 * audio that plays at the wrong pitch rather than an error.
 */
const PCM_SAMPLE_RATE = 24_000;
const PCM_BITS = 16;
const PCM_CHANNELS = 1;

/** `audio/wav`, the container we wrap the upstream PCM in. */
export const SPEECH_CONTENT_TYPE = 'audio/wav';

/**
 * A 44-byte WAV header for a stream of unknown length.
 *
 * The two size fields are the maximum a uint32 can hold, which is the
 * conventional way to say "play until the connection closes" — we are forwarding
 * samples as they are generated, so the real length is not known until the last
 * one has already been sent, and a header cannot be rewritten after the fact.
 * Browsers treat these as an open-ended stream and begin playing at the first
 * frames; the element's reported duration is meaningless until `ended`, which
 * costs nothing because nothing seeks within a spoken sentence.
 */
export function wavHeader(): Uint8Array {
  const bytesPerSample = PCM_BITS / 8;
  const byteRate = PCM_SAMPLE_RATE * PCM_CHANNELS * bytesPerSample;
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  const UNKNOWN = 0xffffffff;
  ascii(0, 'RIFF');
  view.setUint32(4, UNKNOWN, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, PCM_CHANNELS, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, PCM_CHANNELS * bytesPerSample, true); // block align
  view.setUint16(34, PCM_BITS, true);
  ascii(36, 'data');
  view.setUint32(40, UNKNOWN, true);
  return new Uint8Array(buf);
}

/**
 * Start synthesis and return the audio as it is produced.
 *
 * ## Why `pcm` and not `opus`
 *
 * `opus` was chosen here with a comment asserting it had "the lowest
 * time-to-first-audio of the streaming formats". Measured against the real API
 * with one short sentence, that is backwards:
 *
 * | format | first byte | complete |
 * |---|---:|---:|
 * | opus   | 2112 ms | 2539 ms |
 * | mp3    | 1309 ms | 1974 ms |
 * | pcm    |  760 ms | 1819 ms |
 *
 * A compressed format cannot emit anything until its encoder has buffered enough
 * to encode, so choosing one costs 1.3 s before the first sample exists. PCM is
 * the samples themselves, available as fast as they are generated. It is about
 * five times the bytes — 169 KB against 34 KB for a short sentence — which is the
 * right trade for a sentence a shopper is waiting on, and is why this is not used
 * for anything that is merely downloaded.
 *
 * Returns the stream rather than a buffer so nothing in the path waits for the
 * last byte. See speech-cache.ts for why that was most of the 1866 ms.
 */
export async function synthesizeStream(
  text: string,
  cfg: VoiceConfig,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ReadableStream<Uint8Array>> {
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
      response_format: 'pcm',
      ...(cfg.speed === undefined ? {} : { speed: cfg.speed }),
      instructions:
        'Warm, gentle shop assistant. Friendly and brisk, never breathless. ' +
        'No salesy lilt, no upward inflection at the end of statements.',
    }),
  });
  if (!res.ok) throw new VoiceError(`speech synthesis failed (${res.status})`, 502);
  const upstream = res.body;
  if (upstream === null) throw new VoiceError('speech synthesis returned no body', 502);

  /**
   * The header goes out ahead of the first sample, in its own chunk.
   *
   * A listener must be able to hand what it receives straight to a media element,
   * so the very first bytes have to be a valid WAV header — not a header that
   * arrives once the upstream has answered.
   */
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(wavHeader());
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value !== undefined && value.length > 0) controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}

/**
 * The whole utterance as one buffer.
 *
 * Kept for callers that genuinely need the complete audio — the non-streaming
 * fallback, and `check-voice.mjs`, which feeds synthesized speech back through
 * transcription and therefore needs a finished file. Built on the streaming path
 * so there is exactly one place that talks to the speech API.
 */
export async function synthesize(
  text: string,
  cfg: VoiceConfig,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ArrayBuffer> {
  const stream = await synthesizeStream(text, cfg, doFetch);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }

  /**
   * Replace the streaming placeholders with the real sizes.
   *
   * The header was written before the length was knowable; here it is known, and a
   * complete file should say so. `decodeWav` copes with the placeholder, but other
   * readers are not obliged to — transcription is handed one of these by
   * `check-voice.mjs`, which is exactly a reader we do not control.
   */
  if (total > 44) {
    const view = new DataView(out.buffer);
    view.setUint32(4, total - 8, true);
    view.setUint32(40, total - 44, true);
  }
  return out.buffer;
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
