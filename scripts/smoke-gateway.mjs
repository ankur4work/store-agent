#!/usr/bin/env node
/**
 * End-to-end smoke test against a running gateway.
 *
 * Exercises the full stack the way the widget does: POST /api/chat, consume the
 * SSE stream, and time the two metrics that actually matter —
 *
 *   TT-products : when renderable product cards arrive (first useful pixel)
 *   TTFT prose  : when the first validated word of the answer arrives
 *
 *   node scripts/smoke-gateway.mjs ["your question"]
 */
const BASE = process.env.GATEWAY ?? 'http://localhost:8787';
const MESSAGE = process.argv[2] ?? 'do you have a warm wool coat? what sizes and how much?';

const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
console.log(`\n=== gateway smoke (${health.mode} mode, ${health.model}) ===\n`);
console.log(`> ${MESSAGE}\n`);

const t0 = performance.now();
const marks = {};
let prose = '';
const trace = [];

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: MESSAGE, page: { type: 'collection', title: 'Outerwear' } }),
});

if (!res.ok || !res.body) {
  console.error(`FAILED: HTTP ${res.status}`);
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let done;

for (;;) {
  const { done: fin, value } = await reader.read();
  if (fin) break;
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
    const payload = JSON.parse(data);

    if (ev === 'products' && marks.products === undefined) {
      marks.products = performance.now() - t0;
      console.log(`[${marks.products.toFixed(0)}ms] products: ${payload.products.map((p) => p.title).join(', ')}\n`);
    } else if (ev === 'delta') {
      if (marks.firstDelta === undefined) marks.firstDelta = performance.now() - t0;
      prose += payload.text;
      process.stdout.write(payload.text);
    } else if (ev === 'trace') {
      trace.push(payload.detail ? `${payload.type}(${payload.detail})` : payload.type);
    } else if (ev === 'reset') {
      prose = '';
      console.log('\n[tripwire fired — partial answer discarded]');
    } else if (ev === 'done') {
      done = payload;
    } else if (ev === 'error') {
      console.error(`\nSTREAM ERROR: ${payload.message}`);
      process.exit(1);
    }
  }
}

const total = performance.now() - t0;
console.log('\n');
console.log('grounded    :', done?.grounded ? 'PASS' : 'FAIL');
console.log('escalated   :', done?.escalated);
console.log('attempts    :', done?.attempts);
console.log('trace       :', trace.join(' -> '));
console.log('usage       :', JSON.stringify(done?.usage));
console.log('TT-products :', marks.products === undefined ? 'n/a' : `${marks.products.toFixed(0)}ms  <- first useful pixel`);
console.log('TTFT prose  :', marks.firstDelta === undefined ? 'n/a' : `${marks.firstDelta.toFixed(0)}ms`);
console.log('total       :', `${total.toFixed(0)}ms`);

const ok = done !== undefined && done.grounded === true && !done.escalated;
console.log(`\n${ok ? 'GATEWAY SMOKE PASS' : 'GATEWAY SMOKE FAIL'}\n`);
process.exit(ok ? 0 : 1);
