#!/usr/bin/env node
/**
 * Measure how well the gateway hears.
 *
 *   node scripts/check-listening.mjs                    # run the corpus
 *   node scripts/check-listening.mjs --save-baseline    # and pin it as the baseline
 *   node scripts/check-listening.mjs --group silence    # one group only
 *   node scripts/check-listening.mjs --real             # only real recordings
 *   node scripts/check-listening.mjs --rate 48000       # upload at the widget's old rate
 *
 * ## --rate, and what it can and cannot tell you
 *
 * The widget used to upload at the microphone's native rate — 48 kHz — and now
 * uploads at 16 kHz, which is what every speech recogniser resamples to
 * internally anyway. That is a 3x reduction in bytes and, on a phone's uplink,
 * the largest single term in time-to-transcript.
 *
 * `--rate 48000` reproduces the old upload so the two can be compared over real
 * HTTP. What it compares is **bytes and latency**, which is the point. It does
 * NOT compare recognition quality: these clips are synthesised at the TTS
 * engine's own rate, so asking for a higher upload rate resamples upward and
 * adds no information a recogniser could use. A WER difference between rates
 * above the clip's native rate is run-to-run noise, not a finding.
 *
 * Requires a running gateway (GATEWAY, default http://localhost:8787) and
 * OPENAI_API_KEY in .env for the one-time text-to-speech generation. Generated
 * clips are cached under voice-fixtures/ and reused, so a second run costs
 * nothing but transcription.
 *
 * ## What this measures, and what it cannot
 *
 * It measures the SERVER rung: audio in, transcript out, including the
 * fabrication filters and the whisper-1 fallback in voice/service.ts. That is
 * the whole path today and the floor under every later one.
 *
 * It does NOT measure endpointing. Deciding when the shopper has stopped
 * talking happens in the browser against a live signal, and a complete clip
 * uploaded in one piece has already had that decision made for it. The
 * `hanging` clips here verify something adjacent and still worth knowing — that
 * a pause mid-utterance does not get truncated or invented across — but the
 * endpointer itself is covered by `decideEndpoint` unit tests and by the hand
 * check in docs/PHASE-6-PLAN.md.
 *
 * ## The synthetic-audio caveat, stated once and loudly
 *
 * Speech clips are text-to-speech: no accent, no mouth noise, no room, no
 * shopper turning away from the phone. **The absolute WER printed here is a
 * floor, not an estimate of reality.** Its job is comparison — this build
 * against the last one. Drop real phone recordings into voice-fixtures/real/
 * (a .wav plus a .txt of what was said, optionally a .lang) and they are
 * scored alongside, reported separately, and are the number to quote.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LISTENING_CORPUS,
  VARIANTS,
  TARGET_RATE,
  aggregate,
  decodeWav,
  encodeWav,
  mixAtSnr,
  resample,
  scoreTranscript,
  synthNoise,
} from '../packages/voice/dist/src/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, 'voice-fixtures');
const REAL = resolve(CACHE, 'real');
const RESULTS = resolve(ROOT, 'eval-results');
const BASELINE = resolve(RESULTS, 'listening-baseline.json');

const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
const SHOP = process.env.SHOP ?? 'demo.local';
const CONCURRENCY = Number(process.env.LISTEN_CONCURRENCY ?? 3);
const TTS_MODEL = process.env.LISTEN_TTS_MODEL ?? 'gpt-4o-mini-tts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const onlyGroup = value('group');
const realOnly = flag('real');
const UPLOAD_RATE = Number(value('rate') ?? TARGET_RATE);
if (!Number.isFinite(UPLOAD_RATE) || UPLOAD_RATE < 8000 || UPLOAD_RATE > 48000) {
  console.error('--rate must be between 8000 and 48000');
  process.exit(1);
}

// --- env ------------------------------------------------------------------

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(resolve(ROOT, '.env'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } catch {
    return {};
  }
}
const env = loadEnv();
const API_KEY = process.env.OPENAI_API_KEY ?? env.OPENAI_API_KEY;

// --- clip preparation ------------------------------------------------------

/**
 * A pause is rendered as real silence rather than trusted to the synthesiser.
 *
 * The `hanging` clips exist to put a gap in the middle of a sentence. Handing
 * an ellipsis to TTS and hoping it pauses would make the test's own premise
 * unverifiable — sometimes there would be a gap and sometimes there would not,
 * and a clip that scores differently between runs measures nothing.
 */
const PAUSE = '…';
const PAUSE_MS = 700;

async function speakOnce(text, voice) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice,
      input: text,
      // WAV so it can be decoded with our own reader and degraded predictably.
      // Opus would mean a decode dependency here and a second container format
      // in a test suite whose whole subject is container bugs.
      response_format: 'wav',
      instructions:
        'A shopper in a shop, speaking to an assistant. Ordinary pace, ' +
        'conversational, not announcing. Do not add words.',
    }),
  });
  if (!res.ok) {
    throw new Error(`tts failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The floor on how long a segment of N words may be.
 *
 * Generous on purpose — a check for gross truncation, not a style guide. Real
 * segments in this corpus run 0.24-0.88 s/word including their own lead-in and
 * trailing silence, so this is well below anything a synthesiser produces when it
 * is actually saying the words.
 */
const MIN_SECONDS_PER_WORD = 0.12;

/**
 * How wrong a fresh clip may read back before it is rejected as mis-synthesised.
 *
 * Deliberately loose. The job is to catch a clip with WORDS MISSING, not to
 * demand a perfect round trip — the corpus intentionally keeps references that no
 * recogniser reproduces verbatim ("one hundred and fifty dollars" comes back as
 * "$150", "grey" as "gray"), and rejecting those would throw away the clips that
 * make the `numbers` group worth having. Half the words wrong is far outside that
 * and is what truncation looks like.
 */
const MAX_GENERATION_WER = 0.5;

/**
 * Did the synthesiser actually say the words, or only some of them?
 *
 * ## Why this check exists
 *
 * `hanging-thinking.wav` was generated once, cached, and quietly wrong for as long
 * as it existed. Taken apart, the clip contained:
 *
 *     0.00s "Do you have"        gap 1080ms
 *     2.30s "Sari"               gap 1940ms
 *     4.82s "Do you have these"  gap  420ms   <- "in a" was never spoken
 *     6.50s "Medium"
 *
 * The reference said "do you have these in a medium?" and the audio did not. Both
 * recognisers read it as "Do you have these idiom?" on every single run — a fair
 * reading of audio with a hole in it — and the corpus reported that as the product
 * failing to listen, at 43% WER for the whole group. Freshly synthesised, the same
 * words in the same voice transcribe perfectly.
 *
 * A fixture that does not contain its own reference does not measure the product.
 * It is worse than no test, because it spends an afternoon on a bug that is not
 * there.
 *
 * ## Why it reads the clip back, and why that is not circular
 *
 * Two cheaper signals were tried first and both are unsafe. A duration floor
 * cannot see it: the broken clip ran 0.70 s/word, comfortably normal, because the
 * inserted gap replaced the missing words. A "no long silence inside a phrase"
 * rule looked precise and would have rejected good fixtures — `long-returns`,
 * `short-greet` and six others pause naturally at a comma, and every one of them
 * scores 0% WER. Only "the words are not in there" separates the bad clip from
 * those, and reading it back is what detects that.
 *
 * The circularity objection is real but narrow. This runs ONCE, at generation, on
 * the clean clip at its native rate. What the suite then measures is the product
 * on degraded variants of it — room noise, 6 dB SNR, resampled to 16 kHz, through
 * the container handling, the fabrication filters and the whisper-1 fallback —
 * none of which this check exercises. So a real recognition failure can still be
 * found; what can no longer happen is a mis-synthesised clip being reported as
 * one. The case this forecloses — a phrase the recogniser cannot hear even in
 * perfect conditions, cleanly synthesised — is indistinguishable from a TTS defect
 * on synthetic audio, and the evidence above is that it was a TTS defect.
 */
async function clipComplaint(samples, rate, text, bytes, lang) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const seconds = samples.length / rate;
  if (words > 0 && seconds / words < MIN_SECONDS_PER_WORD) {
    return `${seconds.toFixed(2)}s for ${words} words is too short to contain them`;
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', 'gpt-4o-transcribe');
  // The clip's OWN language. Pinning 'en' here would transliterate the Hindi and
  // Spanish fixtures and reject them as corrupt when they are nothing of the kind.
  if (lang) form.append('language', lang);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    // Cannot verify is not the same as corrupt. Say so and keep the clip rather
    // than failing a run over a transient 429 on the check itself.
    process.stdout.write(`  (could not verify generation: http ${res.status})\n`);
    return undefined;
  }
  const heard = (await res.json()).text ?? '';
  const { wer } = scoreTranscript(text, heard);
  if (wer > MAX_GENERATION_WER) {
    return `reads back as "${heard.trim()}" (wer ${(wer * 100).toFixed(0)}%) — words are missing`;
  }
  return undefined;
}

/** How many times to re-ask for a segment the synthesiser mangled. */
const TTS_ATTEMPTS = 3;

/**
 * Synthesise one segment, and refuse to return one that is missing words.
 *
 * Retried rather than failed on, because this is a sampled model and a mangled
 * take is not a permanent property of the text — the same words came back clean
 * on the next attempt. Failing loudly after that, because caching a bad clip is
 * how this went unnoticed in the first place.
 */
async function synthesizeSpeech(text, voice, clipId, lang) {
  let last;
  for (let attempt = 1; attempt <= TTS_ATTEMPTS; attempt++) {
    const bytes = await speakOnce(text, voice);
    const { samples, sampleRate } = decodeWav(bytes);
    last = await clipComplaint(samples, sampleRate, text, bytes, lang);
    if (last === undefined) return bytes;
    process.stdout.write(
      `  retry ${clipId} (${attempt}/${TTS_ATTEMPTS}): ${last}\n`,
    );
  }
  throw new Error(
    `tts kept mangling "${text}" for ${clipId} after ${TTS_ATTEMPTS} attempts: ${last}. ` +
      `Not caching it — a fixture that does not contain its reference measures nothing.`,
  );
}

/** Voices rotate by clip so the corpus is not one speaker read twenty times. */
const VOICES = ['shimmer', 'alloy', 'verse', 'sage'];

/**
 * Get a clip's clean mono samples at their NATIVE rate, generating and caching
 * if needed.
 *
 * Native, not 16 kHz, because the upload rate is now a variable (`--rate`) and
 * resampling twice — down to 16 kHz on generation and back up on upload — would
 * bake a loss into the cache that no real clip has. Resampling happens once, at
 * upload time.
 *
 * Cached as WAV on disk rather than as samples: a WAV is inspectable, playable,
 * and the thing you want in your hand when a clip scores badly and you need to
 * know whether the audio or the recogniser is at fault.
 */
async function cleanSamples(spec, index) {
  if (spec.synth !== undefined) {
    const seconds = spec.id.endsWith('-loud') ? 4 : 3;
    const noise = synthNoise(spec.synth, seconds, TARGET_RATE, 1000 + index);
    if (spec.id.endsWith('-loud')) {
      for (let i = 0; i < noise.length; i++) noise[i] = Math.max(-1, Math.min(1, noise[i] * 4));
    }
    return { samples: noise, rate: TARGET_RATE };
  }

  const path = resolve(CACHE, 'tts', `${spec.id}.wav`);
  if (!existsSync(path)) {
    if (API_KEY === undefined) {
      throw new Error(`no cached clip for ${spec.id} and OPENAI_API_KEY is unset`);
    }
    mkdirSync(dirname(path), { recursive: true });
    const segments = spec.text.split(PAUSE).map((s) => s.trim()).filter(Boolean);
    const voice = VOICES[index % VOICES.length];
    const parts = [];
    for (const segment of segments) {
      parts.push(decodeWav(await synthesizeSpeech(segment, voice, spec.id, spec.lang)));
    }
    const rate = parts[0].sampleRate;
    const gap = Math.round((PAUSE_MS / 1000) * rate);
    const total =
      parts.reduce((n, p) => n + p.samples.length, 0) + gap * (parts.length - 1);
    const joined = new Float32Array(total);
    let at = 0;
    parts.forEach((p, i) => {
      joined.set(p.samples, at);
      at += p.samples.length + (i < parts.length - 1 ? gap : 0);
    });
    writeFileSync(path, encodeWav(joined, rate));
    process.stdout.write(`  generated ${spec.id}\n`);
  }
  const { samples, sampleRate } = decodeWav(new Uint8Array(readFileSync(path)));
  return { samples, rate: sampleRate };
}

/** Real recordings: a .wav plus a .txt of what was actually said. */
function realClips() {
  if (!existsSync(REAL)) return [];
  return readdirSync(REAL)
    .filter((f) => extname(f).toLowerCase() === '.wav')
    .map((f) => {
      const stem = basename(f, extname(f));
      const refPath = resolve(REAL, `${stem}.txt`);
      if (!existsSync(refPath)) {
        console.log(`  skipped real/${f} — no ${stem}.txt saying what was said`);
        return undefined;
      }
      const langPath = resolve(REAL, `${stem}.lang`);
      return {
        id: `real-${stem}`,
        group: 'real',
        text: readFileSync(refPath, 'utf8').trim(),
        lang: existsSync(langPath) ? readFileSync(langPath, 'utf8').trim() : 'en',
        file: resolve(REAL, f),
      };
    })
    .filter(Boolean);
}

// --- transcription ---------------------------------------------------------

async function transcribe(wav, lang) {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const res = await fetch(`${BASE}/api/voice/transcribe?shop=${encodeURIComponent(SHOP)}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', 'x-storefront-lang': lang },
      body: wav,
    });
    const latencyMs = performance.now() - started;

    // A 429 here is the gateway's own rate limiter, not a recognition failure.
    // Counting it as one would make the corpus score a function of how fast we
    // asked. Set RATE_LIMIT_ENABLED=false for local runs to avoid the wait.
    if (res.status === 429 && attempt < 3) {
      const wait = 1000 * 2 ** attempt;
      process.stdout.write(`  rate limited, waiting ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      return { text: '', latencyMs, error: `http ${res.status}` };
    }
    const body = await res.json();
    return { text: typeof body.text === 'string' ? body.text : '', latencyMs };
  }
}

// --- run -------------------------------------------------------------------

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

const jobs = [];

if (!realOnly) {
  const specs = LISTENING_CORPUS.filter((c) => onlyGroup === undefined || c.group === onlyGroup);
  for (const [index, spec] of specs.entries()) {
    for (const variant of VARIANTS) {
      // A silence clip is already noise. Mixing more noise into it produces
      // three clips testing the same thing and inflates the fabrication
      // denominator, which would make the rate look better than it is.
      if (spec.synth !== undefined && variant.snrDb !== null) continue;
      jobs.push({ spec, index, variant });
    }
  }
}

for (const clip of realClips()) {
  if (onlyGroup !== undefined && onlyGroup !== 'real') continue;
  // Real recordings are not degraded. They already contain whatever room they
  // were recorded in, and adding synthetic noise on top would measure a
  // condition that has never existed.
  jobs.push({ spec: clip, index: 0, variant: { name: 'as-recorded', snrDb: null } });
}

if (jobs.length === 0) {
  console.error('nothing to run — check --group, or add clips to voice-fixtures/real/');
  process.exit(1);
}

console.log(
  `\n  Listening eval — ${jobs.length} clips against ${BASE}, uploading at ${UPLOAD_RATE} Hz\n`,
);

// Generation is serial and cached; transcription is the parallel part. Doing
// them in one pass would fire every TTS request at once on a cold cache.
const prepared = [];
for (const job of jobs) {
  const clean =
    job.spec.file !== undefined
      ? (() => {
          const { samples, sampleRate } = decodeWav(new Uint8Array(readFileSync(job.spec.file)));
          return { samples, rate: sampleRate };
        })()
      : await cleanSamples(job.spec, job.index);

  // Noise is generated at the clip's own rate so the mix is sample-aligned.
  // Mixing a 16 kHz noise bed into 24 kHz speech would pitch-shift the noise
  // and change the SNR the clip is labelled with.
  const degraded =
    job.variant.snrDb === null
      ? clean.samples
      : mixAtSnr(
          clean.samples,
          synthNoise('room', 3, clean.rate, 2000 + job.index),
          job.variant.snrDb,
        );

  const wav = encodeWav(resample(degraded, clean.rate, UPLOAD_RATE), UPLOAD_RATE);
  prepared.push({ ...job, wav, seconds: clean.samples.length / clean.rate });
}

const results = await pool(prepared, CONCURRENCY, async (job) => {
  const { text, latencyMs, error } = await transcribe(job.wav, job.spec.lang);
  const score = scoreTranscript(job.spec.text, text);
  const id = `${job.spec.id}/${job.variant.name}`;

  const mark = error
    ? 'ERR '
    : score.fabricated
      ? 'INVT'
      : job.spec.text !== '' && text.trim() === ''
        ? 'MISS'
        : score.wer === 0
          ? 'ok  '
          : score.wer <= 0.25
            ? 'near'
            : 'BAD ';

  console.log(
    `  ${mark} ${id.padEnd(30)} ${String(Math.round(score.wer * 100)).padStart(4)}%wer ` +
      `${String(Math.round(latencyMs)).padStart(5)}ms  ${(error ?? text).slice(0, 52).replace(/\s+/g, ' ')}`,
  );

  return {
    id,
    group: job.spec.group,
    variant: job.variant.name,
    reference: job.spec.text,
    hypothesis: text,
    seconds: Math.round(job.seconds * 100) / 100,
    bytes: job.wav.byteLength,
    score,
    latencyMs,
    empty: text.trim() === '',
    ...(error ? { error } : {}),
  };
});

// --- report ----------------------------------------------------------------

const synthetic = results.filter((r) => !r.id.startsWith('real-'));
const real = results.filter((r) => r.id.startsWith('real-'));
const overall = aggregate(synthetic);
const realOverall = real.length > 0 ? aggregate(real) : undefined;

const byGroup = {};
for (const r of results) {
  (byGroup[r.group] ??= []).push(r);
}

console.log('\n  ─────────────────────────────────────────────');
console.log('  group            clips   wer   invented  missed');
for (const [group, rows] of Object.entries(byGroup)) {
  const a = aggregate(rows);
  const wer = a.referenceWords === 0 ? '   —' : `${String(Math.round(a.wer * 100)).padStart(3)}%`;
  console.log(
    `  ${group.padEnd(16)} ${String(rows.length).padStart(4)}  ${wer}   ` +
      `${String(a.fabricated).padStart(5)}/${String(a.silenceClips).padEnd(3)} ${String(a.missed).padStart(5)}`,
  );
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log('\n  ─────────────────────────────────────────────');
console.log(`  synthetic WER      ${pct(overall.wer)}   (floor, not reality — see header)`);
console.log(`    substitutions    ${overall.substitutions}`);
console.log(`    insertions       ${overall.insertions}`);
console.log(`    deletions        ${overall.deletions}`);
console.log(`  invented           ${overall.fabricated}/${overall.silenceClips}   (must be 0)`);
console.log(`  missed             ${overall.missed}/${synthetic.length - overall.silenceClips}`);
console.log(
  `  time to transcript p50 ${Math.round(overall.latencyP50Ms ?? 0)}ms   p95 ${Math.round(overall.latencyP95Ms ?? 0)}ms`,
);
// Bytes, because on a phone's uplink they ARE the latency. Reported as the mean
// per second of audio so it is comparable across runs with different clips.
const totalBytes = results.reduce((n, r) => n + r.bytes, 0);
const totalSeconds = results.reduce((n, r) => n + r.seconds, 0);
console.log(
  `  upload             ${UPLOAD_RATE} Hz, ${Math.round(totalBytes / 1024)} KB over ` +
    `${totalSeconds.toFixed(1)}s of audio (${Math.round(totalBytes / totalSeconds / 1024)} KB/s)`,
);
if (realOverall !== undefined) {
  console.log(`\n  REAL recordings    ${pct(realOverall.wer)} wer over ${real.length} clips`);
  console.log('  ^ this is the number to quote');
}

// --- gate ------------------------------------------------------------------

const reasons = [];

// Non-negotiable, and the only absolute threshold here. A fabrication is not a
// degraded answer, it is the assistant answering a question nobody asked — out
// loud, in whatever language the decoder landed on.
if (overall.fabricated > 0) {
  reasons.push(`${overall.fabricated} fabricated transcript(s) on silence clips`);
}

let baseline;
if (existsSync(BASELINE)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    console.log('\n  baseline unreadable — treating this run as unbaselined');
  }
}

if (baseline !== undefined) {
  const before = baseline.overall;
  const werDelta = overall.wer - before.wer;
  const p95Delta = (overall.latencyP95Ms ?? 0) - (before.latencyP95Ms ?? 0);
  console.log('\n  ─────────────────────────────────────────────');
  console.log(`  vs baseline (${baseline.at}, ${baseline.uploadRate ?? 'unknown'} Hz)`);
  console.log(`    wer   ${pct(before.wer)} → ${pct(overall.wer)}   ${werDelta <= 0 ? '▼' : '▲'} ${pct(Math.abs(werDelta))}`);
  console.log(
    `    p95   ${Math.round(before.latencyP95Ms ?? 0)}ms → ${Math.round(overall.latencyP95Ms ?? 0)}ms   ` +
      `${p95Delta <= 0 ? '▼' : '▲'} ${Math.abs(Math.round(p95Delta))}ms`,
  );

  // One point of WER is inside the run-to-run variation of a decoder that is
  // not deterministic. Anything larger is a regression, and treating it as
  // noise is how a regression ships.
  if (werDelta > 0.01) reasons.push(`WER regressed by ${pct(werDelta)} against the baseline`);
  // A baseline taken at a different upload rate is exactly the comparison
  // `--rate` exists for, so it is not an error — but a WER gate across rates is
  // meaningless, so say which one this is rather than letting it read as a
  // like-for-like run.
  if ((baseline.uploadRate ?? UPLOAD_RATE) !== UPLOAD_RATE) {
    console.log(
      `    note: rates differ, so the latency and byte deltas are the finding;\n` +
        `          the WER delta across rates is noise, not a result.`,
    );
  }
  if (p95Delta > 250) reasons.push(`p95 time-to-transcript regressed by ${Math.round(p95Delta)}ms`);
} else {
  console.log('\n  no baseline — run with --save-baseline to pin this run as the comparison');
}

const pass = reasons.length === 0;
console.log(`\n  GATE: ${pass ? 'PASS' : 'FAIL'}`);
for (const r of reasons) console.log(`    - ${r}`);
console.log('');

// --- persist ---------------------------------------------------------------

const report = {
  at: new Date().toISOString(),
  gateway: BASE,
  ttsModel: TTS_MODEL,
  uploadRate: UPLOAD_RATE,
  bytesPerSecond: Math.round(totalBytes / totalSeconds),
  overall,
  real: realOverall,
  byGroup: Object.fromEntries(Object.entries(byGroup).map(([g, rows]) => [g, aggregate(rows)])),
  results,
};

try {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, 'listening.json'), JSON.stringify(report, null, 2));
  console.log('  results → eval-results/listening.json');
  if (flag('save-baseline')) {
    writeFileSync(BASELINE, JSON.stringify(report, null, 2));
    console.log('  baseline → eval-results/listening-baseline.json');
  }
  console.log('');
} catch (err) {
  console.log(`  could not write results: ${err.message}\n`);
}

process.exit(pass ? 0 : 1);
