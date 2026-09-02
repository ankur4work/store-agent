#!/usr/bin/env node
/**
 * Live smoke test: one real conversational turn, end to end.
 *
 * Verifies the three things that no mock can:
 *   1. the OpenAI adapter's request shape is accepted by the real API
 *   2. the model honours strict structured outputs and emits usable `claims`
 *   3. the grounding validator accepts real model output
 *
 * Reads OPENAI_API_KEY from .env (gitignored). Never logs the key.
 *   node scripts/smoke-openai.mjs [model-id]
 */
import { readFileSync } from 'node:fs';
import { Orchestrator } from '../packages/orchestrator/dist/src/index.js';
import { OpenAIModelClient } from '../packages/orchestrator/dist/src/providers/openai.js';

// --- env ------------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const apiKey = env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY missing from .env');
  process.exit(1);
}

const MODEL = process.argv[2] ?? 'gpt-5.6-terra';

// --- realistic UCP tool payloads (prices in MINOR units) ------------------
const CATALOG = {
  products: [
    {
      id: 'gid://shopify/Product/1',
      title: 'Merino Wool Overcoat',
      description: 'Full-length wool overcoat, water resistant.',
      price_range: { min: { amount: 18900, currency: 'USD' }, max: { amount: 18900, currency: 'USD' } },
      variants: [
        { id: 'v-coat-s', title: 'S', price: { amount: 18900, currency: 'USD' }, available: true },
        { id: 'v-coat-m', title: 'M', price: { amount: 18900, currency: 'USD' }, available: true },
        { id: 'v-coat-l', title: 'L', price: { amount: 18900, currency: 'USD' }, available: false },
      ],
    },
  ],
};

export const timings = { firstToolResultAt: undefined };

const tools = {
  calls: [],
  async execute(name, input) {
    this.calls.push({ name, input });
    // Time-to-first-useful-pixel: when product data is available to render
    // skeleton cards, independent of when prose starts.
    if (timings.firstToolResultAt === undefined) timings.firstToolResultAt = performance.now();
    if (name === 'search_catalog') return CATALOG;
    if (name === 'get_product') return { product: CATALOG.products[0] };
    if (name === 'get_policy') return { topic: input.topic, text: 'Standard shipping arrives in 3-5 business days.' };
    return { ok: true };
  },
};

const MERCHANT = {
  merchantId: 'acme',
  brandVoice: 'Warm, direct, never pushy. No emoji.',
  policySummary: 'Free returns within 30 days. Ships worldwide.',
  locale: 'en-US',
  currency: 'USD',
};

// --- run ------------------------------------------------------------------
const model = new OpenAIModelClient({ apiKey, timeoutMs: 90_000, maxRetries: 1 });
const events = [];
const orch = new Orchestrator({
  model,
  tools,
  models: { classify: MODEL, workhorse: MODEL, escalation: MODEL },
  onEvent: (e) => events.push(e),
});

console.log(`\n=== live smoke: ${MODEL} ===\n`);
const t0 = performance.now();
let ttft;
let streamedChars = 0;

try {
  const res = await orch.runTurn(
    {
      message: 'do you have a warm wool coat? what size options and how much?',
      context: { sessionId: 'smoke_1', page: { type: 'collection', title: 'Outerwear' } },
      merchant: MERCHANT,
    },
    {
      onReplyDelta: (t) => {
        if (ttft === undefined) ttft = performance.now() - t0;
        streamedChars += t.length;
        process.stdout.write(t);
      },
    },
  );
  const ms = performance.now() - t0;
  if (streamedChars > 0) process.stdout.write('\n\n');

  console.log('reply      :', JSON.stringify(res.reply));
  console.log('escalated  :', res.escalated);
  console.log('attempts   :', res.attempts);
  console.log('grounding  :', res.verdict.ok ? 'PASS' : 'FAIL');
  if (res.verdict.violations.length) {
    for (const v of res.verdict.violations) console.log(`   [${v.severity}] ${v.code}: ${v.message}`);
  }
  console.log('tool calls :', tools.calls.map((c) => c.name).join(', ') || '(none)');
  console.log('claims     :', res.toolResults.length, 'tool result(s) recorded');
  console.log('usage      :', JSON.stringify(res.usage));
  console.log('events     :', events.map((e) => (e.detail ? `${e.type}(${e.detail})` : e.type)).join(' -> '));
  console.log('tool args  :', JSON.stringify(tools.calls));
  console.log('streamed   :', `${streamedChars} chars`);
  console.log('model calls:', `${tools.calls.length + 1} (tool round trips + final answer)`);
  console.log(
    'TT-products:',
    timings.firstToolResultAt === undefined
      ? 'n/a'
      : `${(timings.firstToolResultAt - t0).toFixed(0)}ms  <- first renderable product data`,
  );
  console.log('TTFT prose :', ttft === undefined ? 'n/a (not streamed)' : `${ttft.toFixed(0)}ms`);
  console.log('latency    :', `${ms.toFixed(0)}ms total`);

  const ok = !res.escalated && res.verdict.ok && tools.calls.length > 0;
  console.log(`\n${ok ? 'SMOKE PASS' : 'SMOKE FAIL'}\n`);
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('\nTHREW:', err.message);
  if (err.body) console.error('body :', String(err.body).slice(0, 1200));
  process.exit(1);
}
