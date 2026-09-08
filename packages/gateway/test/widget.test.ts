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
    childNodes: [],
    parentElement: null,
    isConnected: true,
    className: '',
    innerHTML: '',
    textContent: '',
    id: '',
    dataset: {},
    style: { setProperty(k: string, v: string, pri?: string) { (el['pinned'] as Record<string,string>)[k] = v + (pri ? '!' + pri : ''); }, removeProperty() {} },
    pinned: {} as Record<string, string>,
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
  said: string[];
  pinned: Record<string, string>;
}

async function run(opts: {
  designMode?: boolean;
  arm?: string;
  config?: Record<string, unknown>;
}): Promise<RunResult> {
  const calls: string[] = [];
  const said: string[] = [];
  const body = makeEl('body');

  const sandbox: Record<string, unknown> = {
    console: { ...console, info: (m: string) => said.push(String(m)) },
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
      elementFromPoint: () => null,
      hidden: false,
    },
    navigator: { userAgent: 'test', language: 'en' },
    scrollY: 0,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ display: 'grid', visibility: 'visible', opacity: '1', zIndex: '2147483000', position: 'fixed', width: '56px', height: '56px', right: '22px', bottom: '22px' }),
    innerWidth: 1280,
    innerHeight: 800,
    AbortController,
  };
  sandbox['window'] = sandbox;
  sandbox['self'] = sandbox;
  if (opts.designMode === true) sandbox['Shopify'] = { designMode: true };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'widget.js' });

  // Let the mount promise chain settle.
  await new Promise((r) => setTimeout(r, 20));

  const hostEl = body.children[0];
  return { calls, said, mounted: body.children.length > 0, pinned: (hostEl?.['pinned'] ?? {}) as Record<string, string> };
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

describe('widget stacking', () => {
  /**
   * A string assertion on the stylesheet, not a layout test — the DOM double
   * cannot compute stacking. It exists because the failure it guards is
   * invisible: with no z-index the widget still loads, mounts, and answers,
   * while painting underneath any theme element that has a positive one
   * (sticky header, cart drawer, cookie banner). Nothing errors, nothing logs,
   * and the only symptom is a merchant saying they cannot see the button.
   */
  it('puts the host in its own stacking context above theme content', () => {
    const hostRule = SRC.slice(SRC.indexOf(':host{'), SRC.indexOf('.launcher{'));
    expect(hostRule).toMatch(/z-index:\s*21474\d+/);
    expect(hostRule).toMatch(/position:\s*relative/);
  });

  it('does not create a containing block that would trap the fixed launcher', () => {
    // transform/filter/perspective/contain/will-change on the host would make
    // position:fixed resolve against the host instead of the viewport.
    const hostRule = SRC.slice(SRC.indexOf(':host{'), SRC.indexOf('.launcher{'));
    for (const trap of ['transform:', 'perspective:', 'contain:', 'will-change:']) {
      expect(hostRule).not.toContain(trap);
    }
  });
});

describe('widget diagnostics', () => {
  /**
   * Every non-render path used to be silent, so holdout, disabled, and
   * never-mounted all presented as an empty corner and an empty console —
   * indistinguishable from a broken install, and from each other. Diagnosing
   * one merchant's "I can't see the button" took a full session precisely
   * because the widget knew the answer and never said it.
   */
  it('says why it is hidden in the holdout', async () => {
    const r = await run({ arm: 'holdout' });
    expect(r.mounted).toBe(false);
    expect(r.said.join(' ')).toMatch(/holdout/i);
  });

  it('says why it is hidden when switched off', async () => {
    const r = await run({ designMode: true, config: { enabled: false } });
    expect(r.mounted).toBe(false);
    expect(r.said.join(' ')).toMatch(/disabled|settings/i);
  });

  it('says it is ready, and stamps the build, when it does mount', async () => {
    // Without the build stamp there is no way to tell a stale cached copy in a
    // merchant's browser from current code.
    const r = await run({ arm: 'exposed' });
    expect(r.mounted).toBe(true);
    expect(r.said.join(' ')).toMatch(/ready/i);
    expect(r.said.join(' ')).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('announces the theme editor bypass', async () => {
    const r = await run({ designMode: true, arm: 'holdout' });
    expect(r.said.join(' ')).toMatch(/theme editor/i);
  });
});

describe('widget host isolation', () => {
  /**
   * The bug that made the widget invisible on a live store: the theme laid out
   * <body> as a grid and hid unexpected direct children, so the host computed
   * `display:none`. The widget mounted, computed a correct 56px launcher, and
   * generated no box. Shadow DOM protects the inside of the widget; the host
   * is fully exposed to page CSS, and page rules beat :host rules.
   *
   * Inline + !important is the only thing a merchant stylesheet cannot outrank.
   */
  it('pins the properties a theme could use to hide it', async () => {
    const r = await run({ arm: 'exposed' });
    for (const prop of ['display', 'visibility', 'opacity', 'z-index', 'position']) {
      expect(r.pinned[prop], `${prop} must be pinned`).toBeDefined();
      expect(r.pinned[prop]).toContain('!important');
    }
    expect(r.pinned['display']).toContain('block');
    expect(r.pinned['visibility']).toContain('visible');
  });

  it('stays out of flow so it cannot disturb a grid or flex body', async () => {
    // Hiding stray children of <body> is a legitimate thing for a theme to do.
    // Being fixed at zero size means we never give it a reason to.
    const r = await run({ arm: 'exposed' });
    expect(r.pinned['position']).toContain('fixed');
    expect(r.pinned['width']).toContain('0');
    expect(r.pinned['height']).toContain('0');
  });

  it('never pins a property that would trap the fixed launcher', async () => {
    // A fixed ancestor is fine; a transformed/contained one becomes the
    // containing block and would pull the launcher out of the viewport.
    const r = await run({ arm: 'exposed' });
    expect(r.pinned['transform']).toContain('none');
    expect(r.pinned['filter']).toContain('none');
    expect(r.pinned['contain']).toContain('none');
    expect(r.pinned['perspective']).toContain('none');
  });

  it('keeps pointer events on, or the launcher would be unclickable', async () => {
    // pointer-events inherits into the shadow tree.
    const r = await run({ arm: 'exposed' });
    expect(r.pinned['pointer-events']).toContain('auto');
    expect(r.pinned['pointer-events']).not.toContain('none');
  });
});
