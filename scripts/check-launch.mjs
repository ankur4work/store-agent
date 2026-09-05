#!/usr/bin/env node
/**
 * Launch readiness audit.
 *
 * Checks the App Store and Built for Shopify requirements that are decidable
 * from the code and a running server. It exists so "are we ready for review?"
 * stops being an opinion.
 *
 * It deliberately does NOT claim readiness. Several requirements — install
 * counts, review counts, real-world Web Vitals at p75 — cannot be evaluated
 * before the app has merchants, and a script that quietly skipped those would
 * be worse than no script. Those are printed as an explicit "cannot be checked
 * here" list.
 *
 *   node scripts/check-launch.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'storeagent-launch-'));
let failures = 0;
let warnings = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`);
}
function warn(label, ok, detail = '') {
  if (!ok) warnings++;
  console.log(`  ${ok ? 'ok  ' : 'WARN'} ${label.padEnd(52)} ${detail}`);
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const widget = read('packages/gateway/public/widget.js');
const liquid = read('extensions/storeagent-widget/blocks/storeagent.liquid');
const admin = read('packages/gateway/src/admin/render.ts');
const webhooks = read('packages/gateway/src/shopify/webhooks.ts');
const appToml = read('shopify.app.toml');
const pixel = read('extensions/storeagent-pixel/src/index.js');

console.log('\n=== launch readiness ===\n');

// --- storefront performance ------------------------------------------------
// "Cannot reduce Lighthouse score by more than 10 points."
console.log('storefront performance (CWV)');
const gz = gzipSync(Buffer.from(widget), { level: 9 }).length;
check('widget under the 15 KB gzip budget', gz < 15 * 1024, `${(gz / 1024).toFixed(2)} KB`);
check('script is deferred, never parser-blocking', /<script[^>]*\bdefer\b/.test(liquid));
check('no render-blocking stylesheet link', !/rel=["']stylesheet["']/.test(liquid));
check('no webfont loaded', !/fonts\.googleapis|@font-face/.test(liquid + widget));
check('preconnect to the gateway', /rel=["']preconnect["']/.test(liquid));
// CLS is scored on layout movement; a fixed, reserved launcher contributes 0.
check('launcher is position:fixed (0 CLS)', /\.launcher\{[^}]*position:fixed/.test(widget));
check('animates transform/opacity only', !/transition:[^;]*\b(width|height|top|left|margin)\b/.test(widget));
check('no document.write', !/document\.write/.test(widget));
// INP: flushing per token would blow the 200ms interaction budget.
check('streaming text flushed on rAF', /requestAnimationFrame/.test(widget));
check('honours prefers-reduced-motion', /prefers-reduced-motion/.test(widget));
// A broken agent must never break the merchant's checkout.
check('widget self-removes on failure', /catch|onerror/.test(widget));

// --- embedding / App Bridge -------------------------------------------------
console.log('\nadmin integration');
check('App Bridge loaded from Shopify CDN', /cdn\.shopify\.com\/shopifycloud\/app-bridge\.js/.test(admin));
check('App Bridge is not bundled or pinned to a version', !/app-bridge@\d/.test(admin));
check('declares s-app-nav', /<s-app-nav>/.test(admin));
check('forms use the Contextual Save Bar', /data-save-bar/.test(admin));
check('destructive discard is confirmed', /data-discard-confirmation/.test(admin));
check('uses ID token auth', /idToken\(\)/.test(admin));
// "No unsolicited modals" — and errors belong next to the field.
check('no alert() modals', !/[^/]\balert\(/.test(admin.replace(/\/\/.*$/gm, '')));
check('errors render inline near the fields', /id="formErrors"/.test(admin));
check('error region is announced to screen readers', /role="alert"/.test(admin));
check('enforces WCAG AA contrast', /accentIsAccessible/.test(admin));

// --- extensions, not script tags -------------------------------------------
console.log('\nextensions');
check('storefront ships as a theme app extension', existsSync('extensions/storeagent-widget/shopify.extension.toml'));
check('tracking uses a Web Pixel extension', existsSync('extensions/storeagent-pixel/shopify.extension.toml'));
check('no ScriptTag API use', !/ScriptTag|scriptTagCreate/.test(admin + widget + appToml));
check('no Asset API use', !/\/assets\.json|assetUpdate/.test(admin));
// `browser.localStorage` IS the sandboxed Web Pixel API and is correct; bare
// `localStorage` or `document.cookie` would mean reaching outside the sandbox.
check(
  'pixel stays inside the sandbox API',
  !/document\.cookie/.test(pixel) && !/(?<!browser\.)localStorage/.test(pixel.replace(/^\s*\*.*$/gm, '')),
);

// --- container build -------------------------------------------------------
//
// These exist because the Dockerfile silently broke the deploy twice: a
// hand-written per-package COPY list went stale when packages were added, and
// tsconfig.base.json was never copied at all. Both produced a failed build, no
// container, and a bare 503 from the proxy with nothing obvious to read.
console.log('\ncontainer build');
const dockerfile = read('Dockerfile');
check('copies tsconfig.base.json', /tsconfig\.base\.json/.test(dockerfile));
check(
  'does not hand-enumerate workspace manifests',
  !/COPY packages\/[a-z-]+\/package\.json/.test(dockerfile),
);
check('asserts its build artefacts', /RUN test -f/.test(dockerfile));
// npm omits devDependencies when NODE_ENV=production, which hosts inject into
// the build. Without --include=dev there is no tsc and the build dies with a
// misleading "not found".
check('build stage installs devDependencies', /npm ci --include=dev/.test(dockerfile));
check('runtime stage omits them', /npm ci --omit=dev/.test(dockerfile));
check('mounts a volume for the database', /VOLUME \[/.test(dockerfile));
check('runs as a non-root user', /^USER (?!root)/m.test(dockerfile));
check('has a healthcheck', /HEALTHCHECK/.test(dockerfile));
check('build context excludes secrets', /^\.env$/m.test(read('.dockerignore')));

// --- mandatory webhooks -----------------------------------------------------
console.log('\nmandatory webhooks');
for (const topic of ['app/uninstalled', 'shop/redact', 'customers/redact', 'customers/data_request']) {
  check(`handles ${topic}`, webhooks.includes(`'${topic}'`));
}
check('verifies HMAC before acting', /verifyWebhookHmac/.test(webhooks));
check('unverified webhooks get 401 with no detail', /401[\s\S]{0,80}unauthorized/.test(webhooks));

// --- API version ------------------------------------------------------------
console.log('\napi version');
const version = /api_version\s*=\s*"([^"]+)"/.exec(appToml)?.[1] ?? '';
check('app declares an API version', version !== '', version);
// Shopify supports the four most recent quarterly versions.
const [vy, vm] = version.split('-').map(Number);
const ageQuarters = vy && vm ? (2026 - vy) * 4 + Math.floor((9 - vm) / 3) : 99;
check('API version is within the supported window', ageQuarters <= 3, `${ageQuarters} quarter(s) old`);
const extVersion = /api_version\s*=\s*"([^"]+)"/.exec(
  read('extensions/storeagent-widget/shopify.extension.toml'),
)?.[1];
check('extension API version matches the app', extVersion === version, extVersion ?? 'missing');

// --- listing copy -----------------------------------------------------------
console.log('\nlisting and copy');
// "No countdown timers or guilt-inducing language."
//
// Scan only merchant-facing copy. LISTING.md ends with a "Copy rules observed"
// section that NAMES the forbidden patterns in order to document them, and a
// linter that trips on its own rulebook trains people to ignore it.
const copy = admin + read('docs/LISTING.md').split('## Copy rules observed')[0];
check('no countdown or urgency pressure', !/countdown|hurry|expires in|only \d+ left/i.test(copy));
check('no false guarantees', !/guaranteed (?:increase|results|sales)|100% (?:accurate|guaranteed)/i.test(copy));
check('app name is short enough for the sidebar', (/name = "([^"]+)"/.exec(appToml)?.[1] ?? '').length <= 30);
warn('listing copy exists', existsSync('docs/LISTING.md'), 'docs/LISTING.md');
warn('privacy policy exists', existsSync('docs/PRIVACY.md'), 'docs/PRIVACY.md');
warn('support/help docs exist', existsSync('docs/SUPPORT.md'), 'docs/SUPPORT.md');

// --- live server ------------------------------------------------------------
console.log('\nrunning server');
const child = spawn(process.execPath, ['packages/gateway/dist/src/main.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STOREAGENT_DB: join(dir, 'launch.db'),
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'sk-test-not-used',
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
    SHOPIFY_APP_URL: 'https://example.com',
    SHOPIFY_BILLING_TEST: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('gateway did not start');
    await new Promise((r) => setTimeout(r, 150));
  }

  const adminRes = await fetch(`${BASE}/admin?shop=x.myshopify.com`);
  // 401 is correct: the page authenticates through Shopify and must refuse a
  // direct hit rather than rendering a shell.
  check('admin refuses an unauthenticated hit', adminRes.status === 401, String(adminRes.status));
  const adminHtml = await adminRes.text();
  check('unauthenticated admin shows no shop data', !adminHtml.includes('Accent colour'));

  check('settings write rejects a missing token', (await fetch(`${BASE}/admin/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })).status === 401);

  const health = await (await fetch(`${BASE}/healthz`)).json();
  check('health endpoint is public and honest', health.ok === true && health.install === 'ready');

  const widgetRes = await fetch(`${BASE}/widget.js`);
  check('widget is served', widgetRes.status === 200);
  const cc = widgetRes.headers.get('cache-control') ?? 'none';
  // widget.js loads on every storefront page; no-cache costs a revalidation
  // round trip on every product click.
  check('widget is cacheable', /max-age=\d+/.test(cc), cc);
  check('and revalidates without blocking', /stale-while-revalidate/.test(cc));
  const etag = widgetRes.headers.get('etag');
  check('widget sends an ETag', etag !== null, etag ?? 'none');

  const revalidated = await fetch(`${BASE}/widget.js`, { headers: { 'if-none-match': etag ?? '' } });
  check('and answers 304 to a matching ETag', revalidated.status === 304, String(revalidated.status));
  await revalidated.body?.cancel().catch(() => undefined);
} finally {
  // Let in-flight keep-alive sockets settle before signalling; killing mid
  // response trips a libuv assertion on Windows.
  await new Promise((r) => setTimeout(r, 150));
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  rmSync(dir, { recursive: true, force: true });
}

// --- what this cannot decide ------------------------------------------------
console.log(`
cannot be checked here — needs a live, installed app:
  · 50 net installs from paid shops       (Built for Shopify prerequisite)
  · 5 reviews and a minimum rating        (Built for Shopify prerequisite)
  · admin Web Vitals at p75 over 28 days  (LCP ≤2.5s, CLS ≤0.1, INP ≤200ms)
  · storefront Lighthouse delta ≤10 pts   (needs a real theme + Chrome)
  · OAuth install completing end to end
  · a real subscription approved by a merchant`);

console.log(
  `\n${failures === 0 ? 'LAUNCH CHECK PASS' : `LAUNCH CHECK FAIL (${failures})`}` +
    `${warnings > 0 ? ` — ${warnings} warning(s)` : ''}\n`,
);
process.exit(failures === 0 ? 0 : 1);
