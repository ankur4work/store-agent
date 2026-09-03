#!/usr/bin/env node
/**
 * Verify the voice pipeline against a running gateway and the live API.
 *
 * Checks the round trip that matters: text -> speech -> text, and that a voice
 * chat turn emits whole, grounded utterances rather than raw deltas.
 *
 *   node scripts/check-voice.mjs
 */
const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
let failures = 0;

function check(label, actual, expected) {
  const pass = expected === undefined ? Boolean(actual) : actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(40)} ${actual}`);
}

console.log('\n=== voice pipeline ===\n');

// --- TTS ------------------------------------------------------------------
const PHRASE = 'The Merino Wool Overcoat is one hundred and eighty nine dollars.';
const t0 = performance.now();
const tts = await fetch(`${BASE}/api/voice/speak`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: PHRASE }),
});
const ttsMs = performance.now() - t0;
check('speak returns audio', tts.status, 200);
check('audio content type', tts.headers.get('content-type'), 'audio/ogg');
const audio = Buffer.from(await tts.arrayBuffer());
check('audio is non-trivial', audio.length > 2000, true);
console.log(`       ${audio.length} bytes in ${ttsMs.toFixed(0)}ms`);

// --- rejections -----------------------------------------------------------
const empty = await fetch(`${BASE}/api/voice/speak`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '' }),
});
check('rejects empty text', empty.status, 400);

const huge = await fetch(`${BASE}/api/voice/speak`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'x'.repeat(5000) }),
});
check('rejects over-long text', huge.status, 413);

// --- STT: feed the synthesized audio straight back ------------------------
const t1 = performance.now();
const stt = await fetch(`${BASE}/api/voice/transcribe`, {
  method: 'POST',
  headers: { 'content-type': 'audio/ogg' },
  body: audio,
});
const sttMs = performance.now() - t1;
check('transcribe returns 200', stt.status, 200);
const { text: heard } = await stt.json();
console.log(`       heard: "${heard}" (${sttMs.toFixed(0)}ms)`);
check('round trip recovered the price', /189|eighty[- ]?nine/i.test(heard ?? ''), true);
check('round trip recovered the product', /overcoat/i.test(heard ?? ''), true);

const emptyAudio = await fetch(`${BASE}/api/voice/transcribe`, {
  method: 'POST',
  headers: { 'content-type': 'audio/webm' },
  body: Buffer.alloc(0),
});
check('rejects empty audio', emptyAudio.status, 400);

// --- a voice chat turn emits whole utterances -----------------------------
const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: 'do you have a warm wool coat and how much is it?',
    page: { type: 'collection', title: 'Outerwear' },
    voice: true,
  }),
});

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const spoken = [];
let deltas = 0;
let grounded = null;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const record = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let ev = '';
    let data = '';
    for (const line of record.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    const d = JSON.parse(data);
    if (ev === 'speak') spoken.push(d.text);
    else if (ev === 'delta') deltas++;
    else if (ev === 'done') grounded = d.grounded;
  }
}

console.log('\n  utterances queued for speech:');
for (const s of spoken) console.log(`    · ${s}`);

check('turn was grounded', grounded, true);
check('emitted speak events', spoken.length > 0, true);
check('more deltas than utterances', deltas > spoken.length, true);
check(
  'every utterance is a whole clause',
  spoken.every((s) => s.trim().length > 3 && !/\s$/.test(s)),
  true,
);
check(
  'no utterance splits a price mid-number',
  spoken.every((s) => !/\$\d+\.$/.test(s.trim())),
  true,
);

console.log(`\n${failures === 0 ? 'VOICE CHECK PASS' : `VOICE CHECK FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
