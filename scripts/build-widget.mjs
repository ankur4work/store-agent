#!/usr/bin/env node
/**
 * Minify the storefront widget.
 *
 * ## Why this exists
 *
 * `widget.js` loads on every page of every storefront, and the §12 contract
 * gives it 15 KB gzipped. It was 5.7 KB at Phase 1 and 11.8 KB at launch
 * review. Voice landed and it reached 32.35 KB — over twice the budget —
 * because nothing failed when it crossed the line. `check-launch` noticed, but
 * only as one red line in a report nobody had to act on.
 *
 * So the budget is enforced HERE, in the build, where going over stops the
 * deploy instead of decorating a report.
 *
 * ## Why it is not a refactor
 *
 * More than half the file is prose comments, and the CSS carries its own
 * reasoning about why a panel is 352px wide and why a hairline is 7% ink.
 * That commentary is the reason this code can be changed safely, and shipping
 * it to shoppers is what is actually wasteful — not the code. Minifying gets
 * 32.35 KB down to ~13 KB with the source untouched, which is a better trade
 * than deleting explanations or splitting the file to hit a number.
 *
 * The CSS is minified separately first: it lives inside a template literal, so
 * the JS minifier sees an opaque string and leaves all 21 KB of it alone.
 * That one step is most of the saving.
 */
import { transform } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'packages/gateway/public/widget.js');
const OUT = resolve(ROOT, 'packages/gateway/public/widget.min.js');
const VOICE_SRC = resolve(ROOT, 'packages/gateway/public/widget-voice.js');
const VOICE_OUT = resolve(ROOT, 'packages/gateway/public/widget-voice.min.js');

/** §12. Gzipped, because that is what a storefront actually downloads. */
export const BUDGET_BYTES = 15 * 1024;

/**
 * The voice chunk's own ceiling, from `perf/size-limit.json`.
 *
 * Generous compared to the widget's because it is paid by a shopper who has
 * deliberately pressed a microphone, and only once — not by every visitor to
 * every page. That is the whole reason the split exists: the two files have
 * genuinely different audiences, and holding them to one number meant the
 * rarely-used half was rationed by the cost of the always-shipped half.
 */
export const VOICE_BUDGET_BYTES = 40 * 1024;

/**
 * Pull the stylesheet out of `var CSS = ` ... ` `.
 *
 * Anchored on the declaration rather than "the first backtick" so a template
 * literal added elsewhere cannot silently become the stylesheet. Throws rather
 * than falling back to the un-minified source: a build that quietly stops
 * minifying is how the budget was blown in the first place.
 */
function extractCss(source) {
  const open = source.indexOf('var CSS = `');
  if (open === -1) throw new Error('widget.js: could not find `var CSS = ` — has the stylesheet moved?');
  const start = open + 'var CSS = `'.length;
  const end = source.indexOf('`', start);
  if (end === -1) throw new Error('widget.js: the CSS template literal is unterminated');
  const css = source.slice(start, end);
  // An interpolation would be a value decided at runtime, and minifying around
  // it would either corrupt it or silently drop it.
  if (css.includes('${')) throw new Error('widget.js: the CSS literal interpolates; this script cannot minify it safely');
  return { css, start, end };
}

export async function buildWidget({ write = true } = {}) {
  const source = readFileSync(SRC, 'utf8');
  const { css, start, end } = extractCss(source);

  const minCss = await transform(css, { loader: 'css', minify: true });
  const spliced = source.slice(0, start) + minCss.code + source.slice(end);

  // es2019: Shopify storefronts still see Safari 13 and older Android
  // WebViews. Down-levelling further would add helper code for syntax the
  // widget does not use.
  const minJs = await transform(spliced, { loader: 'js', minify: true, target: 'es2019' });

  const bytes = Buffer.from(minJs.code);
  const gz = gzipSync(bytes, { level: 9 }).length;
  if (write) writeFileSync(OUT, bytes);

  return { code: minJs.code, raw: bytes.length, gzip: gz, sourceGzip: gzipSync(Buffer.from(source), { level: 9 }).length };
}

/**
 * Minify the voice chunk.
 *
 * No CSS to extract — the stylesheet ships with the panel, because a shopper
 * who presses the microphone is looking at a panel that is already styled.
 */
export async function buildVoice({ write = true } = {}) {
  const source = readFileSync(VOICE_SRC, 'utf8');
  const minJs = await transform(source, { loader: 'js', minify: true, target: 'es2019' });
  const bytes = Buffer.from(minJs.code);
  const gz = gzipSync(bytes, { level: 9 }).length;
  if (write) writeFileSync(VOICE_OUT, bytes);
  return { code: minJs.code, raw: bytes.length, gzip: gz, sourceGzip: gzipSync(Buffer.from(source), { level: 9 }).length };
}

// Only when run directly, so tests and check-launch can import the builder.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kb = (n) => `${(n / 1024).toFixed(2)} KB`;

  const r = await buildWidget();
  console.log(
    `widget.min.js        ${kb(r.raw)} raw, ${kb(r.gzip)} gzipped ` +
      `(source ${kb(r.sourceGzip)} — ${Math.round((1 - r.gzip / r.sourceGzip) * 100)}% smaller)`,
  );

  const v = await buildVoice();
  console.log(
    `widget-voice.min.js  ${kb(v.raw)} raw, ${kb(v.gzip)} gzipped ` +
      `(source ${kb(v.sourceGzip)} — ${Math.round((1 - v.gzip / v.sourceGzip) * 100)}% smaller)`,
  );
  console.log(
    `\nevery page view pays ${kb(r.gzip)} of ${kb(BUDGET_BYTES)}; ` +
      `pressing the mic adds ${kb(v.gzip)} of ${kb(VOICE_BUDGET_BYTES)}`,
  );

  let over = false;
  if (r.gzip >= BUDGET_BYTES) {
    console.error(
      `\nWIDGET OVER BUDGET: ${kb(r.gzip)} gzipped against a ${kb(BUDGET_BYTES)} ceiling.\n` +
        'This file loads on every page of every storefront. Take something out, or\n' +
        'move it into widget-voice.js and load it on demand — do not raise the ceiling.',
    );
    over = true;
  }
  if (v.gzip >= VOICE_BUDGET_BYTES) {
    console.error(
      `\nVOICE CHUNK OVER BUDGET: ${kb(v.gzip)} gzipped against a ${kb(VOICE_BUDGET_BYTES)} ceiling.\n` +
        'A shopper waits for this between pressing the microphone and being able\n' +
        'to speak. A model belongs behind its own fetch, not in this bundle.',
    );
    over = true;
  }
  if (over) process.exit(1);
}
