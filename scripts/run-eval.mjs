#!/usr/bin/env node
/**
 * Run the grounding eval against the live model.
 *
 *   node scripts/run-eval.mjs                 # full corpus
 *   node scripts/run-eval.mjs pressure        # one category
 *   node scripts/run-eval.mjs pre-just-guess  # one case
 *
 * Reads OPENAI_API_KEY from .env. Never logs the key.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { runEval, gatePasses } from '../packages/eval/dist/src/index.js';
import { OpenAIModelClient } from '../packages/orchestrator/dist/src/providers/openai.js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
if (!env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing from .env');
  process.exit(1);
}

const MODEL = process.env.EVAL_MODEL ?? 'gpt-5.6-terra';
const models = { classify: MODEL, workhorse: MODEL, escalation: MODEL };
const selector = process.argv[2];

const model = new OpenAIModelClient({ apiKey: env.OPENAI_API_KEY, timeoutMs: 120_000, maxRetries: 1 });

const filter = selector ? (c) => c.category === selector || c.id === selector : undefined;

console.log(`\n  Grounding eval — ${MODEL}${selector ? ` (filter: ${selector})` : ''}\n`);

const report = await runEval({
  model,
  models,
  concurrency: Number(process.env.EVAL_CONCURRENCY ?? 4),
  filter,
  onResult: (r) => {
    const mark = r.escape ? 'ESCAPE' : r.failures.length ? 'FAIL  ' : r.falsePositive ? 'FALSE+' : 'ok    ';
    console.log(`  ${mark} ${r.id.padEnd(24)} ${String(Math.round(r.ms)).padStart(5)}ms  ${r.reply.slice(0, 68).replace(/\s+/g, ' ')}`);
    for (const f of r.failures) console.log(`         ↳ ${f.kind}: ${f.detail}`);
  },
});

const gate = gatePasses(report);

console.log('\n  ─────────────────────────────────────────────');
console.log(`  cases            ${report.total}`);
console.log(`  escapes          ${report.escapes}   (hallucination reached the shopper — must be 0)`);
console.log(`  false positives  ${report.falsePositives}   (correct answer rejected)`);
console.log(`  other failures   ${report.results.filter((r) => r.failures.length && !r.escape).length}`);
console.log(`  escalations      ${report.escalations}/${report.total}`);
console.log(`  latency          p50 ${Math.round(report.latency.p50)}ms   p95 ${Math.round(report.latency.p95)}ms`);
console.log('\n  by category:');
for (const [cat, s] of Object.entries(report.byCategory)) {
  console.log(`    ${cat.padEnd(16)} ${s.total - s.failed}/${s.total} clean${s.escapes ? `  (${s.escapes} escapes)` : ''}`);
}

console.log(`\n  GATE: ${gate.pass ? 'PASS' : 'FAIL'}`);
for (const r of gate.reasons) console.log(`    - ${r}`);
console.log('');

try {
  mkdirSync(new URL('../eval-results/', import.meta.url), { recursive: true });
  const out = new URL(`../eval-results/latest.json`, import.meta.url);
  writeFileSync(out, JSON.stringify({ model: MODEL, report }, null, 2));
  console.log(`  results → eval-results/latest.json\n`);
} catch {}

process.exit(gate.pass ? 0 : 1);
