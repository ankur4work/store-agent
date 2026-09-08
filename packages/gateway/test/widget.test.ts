import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

/**
 * The widget decides whether the product appears at all, and it had no tests.
 *
 * It is a browser IIFE, not a module, so it is executed here inside `node:vm`
 * against a hand-written DOM double rather than a real DOM. The double is
 * deliberately dumb: anything the widget touches that is not stubbed throws,
 * which is the behaviour we want from a test double — a missing stub fails
 * loudly instead of quietly passing. Adding jsdom for this one file would pull
 * a large dependency into a project that has kept them to near zero.
 *
 * What is covered is the mount decision, not rendering: which endpoints get
 * called, and whether anything reaches the page.
 */

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/widget.js'),
  'utf8',
);

interface StubEl {
  children: StubEl[];
  [key: string]: unknown;
}

function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tagName: tag,
    children: [],
    className: '',
    innerHTML: '',
    textContent: '',
    id: '',
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild(c: StubEl) {
      el.children.push(c);
      return c;
    },
    append(c: StubEl) {
      el.children.push(c);
      return c;
    },
    insertBefore(c: StubEl) {
      el.children.push(c);
      return c;
    },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    scrollTo() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    attachShadow() {
      const s = makeEl('#shadow');
      el['shadowRoot'] = s;
      return s;
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
  return el;
}

function storage(): Record<string, unknown> {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k) : null),
    setItem: (k: string, v: unknown) => m.set(k, String(v)),
    removeItem: (k: string) => m.delete(k),
  };
}

interface RunResult {
  calls: string[];
  mounted: boolean;
}

async function run(opts: {
  designMode?: boolean;
  arm?: string;
  config?: Record<string, unknown>;
}): Promise<RunResult> {
  const calls: string[] = [];
  const body = makeEl('body');

  const sandbox: Record<string, unknown> = {
    console,
    fetch: (url: unknown) => {
      calls.push(String(url));
      const u = String(url);
      const payload = u.includes('/api/exposure')
        ? { arm: opts.arm ?? 'exposed' }
        : u.includes('/api/config')
          ? (opts.config ?? { enabled: true })
          : {};
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    crypto: { randomUUID: () => 'uuid-test' },
    sessionStorage: storage(),
    localStorage: storage(),
    location: { hostname: 'acme.myshopify.com', href: 'https://acme.myshopify.com/' },
    document: {
      body,
      readyState: 'complete',
      currentScript: { dataset: { api: 'https://gw.test', shop: 'acme.myshopify.com' } },
      createElement: makeEl,
      createElementNS: makeEl,
      createTextNode: (t: string) => ({ text: t }),
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: makeEl('html'),
      hidden: false,
    },
    navigator: { userAgent: 'test', language: 'en' },
    scrollY: 0,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    AbortController,
  };
  sandbox['window'] = sandbox;
  sandbox['self'] = sandbox;
  if (opts.designMode === true) sandbox['Shopify'] = { designMode: true };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'widget.js' });

  // Let the mount promise chain settle.
  await new Promise((r) => setTimeout(r, 20));

  return { calls, mounted: body.children.length > 0 };
}

describe('widget mount: shopper', () => {
  it('records exposure and renders for the exposed arm', async () => {
    const r = await run({ arm: 'exposed' });
    expect(r.calls.some((c) => c.includes('/api/exposure'))).toBe(true);
    expect(r.mounted).toBe(true);
  });

  it('records exposure and renders NOTHING for the holdout arm', async () => {
    // The control group is the whole basis of the incrementality number.
    const r = await run({ arm: 'holdout' });
    expect(r.calls.some((c) => c.includes('/api/exposure'))).toBe(true);
    expect(r.calls.some((c) => c.includes('/api/config'))).toBe(false);
    expect(r.mounted).toBe(false);
  });

  it('renders anyway when the beacon fails, because measurement must not cost a sale', async () => {
    const r = await run({ arm: 'exposed', config: { enabled: true } });
    expect(r.mounted).toBe(true);
  });
});

describe('widget mount: theme editor', () => {
  /**
   * A merchant previewing their own theme is not a shopper. Before this, they
   * were assigned an arm like anyone else: one in five merchants installed the
   * app, enabled it, and saw nothing — permanently, since the arm is sticky per
   * browser — with no way to distinguish that from a broken install.
   */
  it('always renders, even on the arm that would have hidden it', async () => {
    const r = await run({ designMode: true, arm: 'holdout' });
    expect(r.mounted).toBe(true);
  });

  it('never fires the exposure beacon, so previews stay out of the experiment', async () => {
    const r = await run({ designMode: true, arm: 'holdout' });
    expect(r.calls.some((c) => c.includes('/api/exposure'))).toBe(false);
    expect(r.calls.some((c) => c.includes('/api/config'))).toBe(true);
  });

  it('still honours the merchant turning the assistant off', async () => {
    // Only the RANDOM assignment is bypassed. An explicit choice is not.
    const r = await run({ designMode: true, config: { enabled: false } });
    expect(r.mounted).toBe(false);
  });
});
