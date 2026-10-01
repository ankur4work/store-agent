#!/usr/bin/env node
/**
 * Where the time goes between a shopper finishing a sentence and hearing one.
 *
 *   node scripts/check-voice-latency.mjs
 *
 * `check-voice.mjs` proves the voice pipeline works. This one asks why it feels
 * slow, which is a different question and needs a different instrument: the
 * end-to-end number is useless for deciding what to fix, because a 9 s turn made
 * of one 8 s stage and a 9 s turn made of six even stages have nothing in common.
 *
 * So every stage is timed separately, against the real API and a real store:
 *
 *   speak        TTS for one short sentence, whole file, cold
 *   ttft         chat SSE: first `delta` — the panel stops being blank
 *   first_speak  chat SSE: first `speak` — the first WHOLE utterance exists
 *   audible      first_speak + time to the first audio BYTE for it
 *   complete     the same, but waiting for the last byte
 *
 * `audible` is the number the shopper actually experiences, and it is the one no
 * existing check measured. It is deliberately first-byte rather than whole-file:
 * the widget points a media element at the audio URL, so playback begins at the
 * first frames. `complete` is kept alongside it because the gap between the two is
 * exactly what the streaming work bought — they used to be the same number, and
 * the whole 1819 ms was paid before a sound was made.
 */
const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
const SHOP = process.env.SHOP ?? 'test-ankur-grxxuhm3.myshopify.com';

/** The page a shopper asking "how much is it?" is standing on. */
const PAGE = {
  type: 'product',
  title: 'The Complete Snowboard',
  productId: '8944748757044',
  variantName: 'Ice',
};

const QUESTIONS = process.argv.includes('--one')
  ? ['how much is it?']
  : ['how much is it?', 'is this one in stock?', 'what sizes does this come in?'];

const ms = (n) => `${n.toFixed(0)} ms`.padStart(8);

async function timeSpeak(text) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const buf = await res.arrayBuffer();
  return { ms: performance.now() - t0, status: res.status, bytes: buf.byteLength };
}

/**
 * When the first audio BYTE arrives for an announced utterance.
 *
 * This is the number that replaced "how long the whole file took", and the
 * distinction is the entire point of the streaming work: the widget points a
 * media element at this URL, so it starts playing at the first frames rather
 * than at the last. Measuring the complete download here would report a wait
 * nobody experiences any more.
 */
async function timeFirstAudioByte(audioId) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/voice/speak?id=${encodeURIComponent(audioId)}`);
  if (!res.ok) return { error: `${res.status}` };
  const reader = res.body.getReader();
  let first;
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (first === undefined) first = performance.now() - t0;
    bytes += value.length;
  }
  return { first, total: performance.now() - t0, bytes };
}

/**
 * Drive one chat turn and record WHEN each event arrived, not just that it did.
 *
 * Read incrementally rather than with `res.text()`: the whole point is the
 * arrival time of the first event, and buffering the stream to completion
 * destroys exactly that.
 */
async function timeTurn(message, sessionId) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shop: SHOP, sessionId, message, voice: true, page: PAGE }),
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };

  const marks = {};
  const mark = (k) => {
    if (marks[k] === undefined) marks[k] = performance.now() - t0;
  };
  const utterances = [];
  let done;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += dec.decode(value, { stream: true });
    // SSE frames are blank-line separated; keep the trailing partial.
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const ev = /(?:^|\n)event:\s*(\S+)/.exec(frame)?.[1];
      const dataLine = /(?:^|\n)data:\s*(.*)/.exec(frame)?.[1];
      if (ev === undefined) continue;
      mark(ev);
      let data;
      try {
        data = JSON.parse(dataLine ?? '{}');
      } catch {
        data = {};
      }
      if (ev === 'speak' && typeof data.text === 'string') utterances.push(data);
      if (ev === 'done') done = data;
    }
  }
  return { marks, utterances, done, total: performance.now() - t0 };
}

console.log(`\n=== voice turn latency ===\n${BASE}  ${SHOP}\n`);

// --- TTS, cold then warm --------------------------------------------------
// Two calls because the first pays for whatever the upstream does once per
// connection, and attributing that to the model would send the fix the wrong way.
const cold = await timeSpeak('It is six hundred and ninety nine dollars and ninety five cents.');
const warm = await timeSpeak('Yes, the Ice option is in stock.');
console.log(`  speak  cold  ${ms(cold.ms)}   ${cold.bytes} bytes  (status ${cold.status})`);
console.log(`  speak  warm  ${ms(warm.ms)}   ${warm.bytes} bytes  (status ${warm.status})\n`);

if (cold.status !== 200) {
  console.log('  TTS is not answering; the rest of these numbers would be meaningless.');
  process.exit(1);
}

// --- the turns -------------------------------------------------------------
const rows = [];
for (const [i, q] of QUESTIONS.entries()) {
  const turn = await timeTurn(q, `lat-${i}-${process.pid}`);
  if (turn.error !== undefined) {
    console.log(`  "${q}"\n    FAILED ${turn.error}\n`);
    continue;
  }
  const first = turn.utterances[0];
  /**
   * What the widget pays before the shopper hears anything.
   *
   * Streamed off the announced id where the gateway offers one — that is what the
   * widget does, so it is what this has to measure. Falling back to the buffered
   * POST keeps the script honest against an older deployment rather than
   * reporting a number the running code cannot produce.
   */
  const audio =
    first === undefined
      ? undefined
      : first.audioId
        ? await timeFirstAudioByte(first.audioId)
        : await timeSpeak(first.text).then((r) => ({ first: r.ms, total: r.ms, bytes: r.bytes }));
  const audible =
    first === undefined || audio?.first === undefined ? undefined : turn.marks['speak'] + audio.first;

  rows.push({ q, marks: turn.marks, audible, total: turn.total, done: turn.done });

  console.log(`  "${q}"`);
  console.log(`    ttft         ${ms(turn.marks['delta'] ?? NaN)}`);
  console.log(`    first speak  ${ms(turn.marks['speak'] ?? NaN)}   "${(first?.text ?? '').slice(0, 60)}"`);
  if (audible !== undefined) {
    console.log(
      `    AUDIBLE      ${ms(audible)}   (+${ms(audio.first).trim()} to first audio byte` +
        `${first.audioId ? ', streamed' : ', buffered'})`,
    );
    console.log(`    complete     ${ms(turn.marks['speak'] + audio.total)}   ${audio.bytes} bytes`);
  }
  console.log(`    done         ${ms(turn.total)}   grounded=${turn.done?.grounded} handedOff=${turn.done?.handedOff}`);
  console.log(`    utterances   ${turn.utterances.length}\n`);
}

// --- what to fix -----------------------------------------------------------
if (rows.length > 0) {
  const avg = (f) => rows.reduce((s, r) => s + (f(r) ?? 0), 0) / rows.length;
  const aTtft = avg((r) => r.marks['delta']);
  const aSpeak = avg((r) => r.marks['speak']);
  const aAudible = avg((r) => r.audible);
  console.log('  --- average, and what each stage owns ---');
  console.log(`    model to first token      ${ms(aTtft)}`);
  console.log(`    + rest of first utterance ${ms(aSpeak - aTtft)}`);
  console.log(`    + first audio byte        ${ms(aAudible - aSpeak)}`);
  console.log(`    = heard by the shopper    ${ms(aAudible)}\n`);

  // Name the dominant term rather than leaving it to be eyeballed.
  const stages = [
    ['the model reaching its first token', aTtft],
    ['finishing the first sentence', aSpeak - aTtft],
    ['reaching the first audio byte', aAudible - aSpeak],
  ].sort((a, b) => b[1] - a[1]);
  console.log(`  dominant: ${stages[0][0]} — ${ms(stages[0][1]).trim()}, ${((stages[0][1] / aAudible) * 100).toFixed(0)}% of the wait\n`);
}
