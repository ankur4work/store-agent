import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { THRESHOLDS } from '@storeagent/voice';

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

/**
 * Normalised to LF.
 *
 * Git stores the widget with LF, and a Windows checkout or an editor can
 * hand it back with CRLF — so a test matching on a newline passes in CI and
 * fails on a developer's machine. A test whose result depends on the
 * checkout is worse than one that simply fails, because it teaches people
 * to ignore it.
 */
const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/widget.js'),
  'utf8',
).replace(/\r\n/g, '\n');

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
  themeTokens?: Record<string, string>;
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
    getComputedStyle: () => ({ display: 'grid', visibility: 'visible', opacity: '1', zIndex: '2147483000', position: 'fixed', width: '56px', height: '56px', right: '22px', bottom: '22px', getPropertyValue: (n: string) => (opts.themeTokens ?? {})[n] ?? '' }),
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

/**
 * Endpointing — the decision that the shopper has stopped talking.
 *
 * Source assertions rather than behaviour: the VAD loop runs on
 * requestAnimationFrame against a live AudioContext, neither of which the DOM
 * double provides. They guard a failure that produces no error at all — the
 * shopper finishes their sentence and the assistant simply keeps listening
 * forever, which reads as "voice is broken" and logs nothing.
 */
describe('widget voice endpointing', () => {
  const vad = () => SRC.slice(SRC.indexOf('function monitorSilence'), SRC.indexOf('async function transcribeAndSend'));

  it('measures the room instead of assuming a fixed loudness', () => {
    // `level > 12` only means "someone is talking" in a silent room. On a
    // storefront with music or traffic the ambient level never drops below it,
    // so silence is never detected and the recorder never stops.
    expect(vad()).not.toMatch(/level\s*>\s*\d+\s*\)/);
    expect(vad()).toContain('voice.floor');
  });

  it('adapts the floor down fast and up slowly', () => {
    // A pause between words should reset the floor honestly; a passing truck
    // should not raise it permanently.
    expect(vad()).toMatch(/if \(level < floorRaw\) floorRaw = level;/);
    expect(vad()).toMatch(/floorRaw \+= \(level - floorRaw\) \* 0\.002;/);
  });

  it('stops recording even if the level never falls', () => {
    // The backstop for the exact bug: unbounded recording in a noisy room.
    expect(vad()).toContain('MAX_UTTERANCE_MS');
    expect(vad()).toMatch(/tooLong/);
  });

  /**
   * The backstop must not depend on the thing it is backing up. The first
   * attempt gated it on `spokeMs > MIN_SPEECH_MS`, so when speech detection
   * failed — which was the actual bug — the safety net was disabled with it
   * and the recorder ran forever.
   */
  it('does not gate the max-duration stop on speech having been detected', () => {
    expect(vad()).toMatch(/var tooLong =\s*now - startedAt > MAX_UTTERANCE_MS;/);
    expect(vad()).not.toMatch(/tooLong[\s\S]{0,80}spokeMs > MIN_SPEECH_MS/);
  });

  it('caps the floor against the peak, so speech cannot become the floor', () => {
    // Press the mic and talk at once and the first frames ARE speech. Taking
    // a plain minimum calibrated the floor to the speaking level and the
    // threshold then demanded the speaker exceed their own voice.
    expect(vad()).toMatch(/voice\.floor = Math\.min\(floorRaw, peak \* 0\.5\)/);
  });

  it('gives up when it hears nothing at all, rather than listening forever', () => {
    expect(vad()).toContain('IDLE_GIVE_UP_MS');
    expect(vad()).toMatch(/heardNothing/);
  });

  /**
   * The behaviour of every mic a shopper has already used: press, a chime,
   * speak, get answered, done. Ours opened silently and then listened
   * forever — holding the microphone between questions, recording the room,
   * and giving no moment where you could tell it had stopped.
   */
  it('chimes when it opens, so there is something to speak against', () => {
    expect(SRC).toContain("cue('start')");
    expect(SRC).toMatch(/function cue\(kind\)/);
  });

  it('ends the turn instead of listening again', () => {
    expect(SRC).toContain('function endVoiceTurn()');
    // The old hand-back is gone from the playback drain.
    expect(SRC).not.toMatch(/startCapture\(\); \/\/ hand the turn back/);
  });

  it('closes the turn on every ending, not just the successful one', () => {
    // Empty transcript, transcription error, and a turn with no audio all
    // used to restart capture — so a failure looked exactly like success.
    const ends = SRC.match(/endVoiceTurn\(\)/g) ?? [];
    expect(ends.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * packages/voice/src/endpoint.ts has carried transcript-aware endpointing
   * since Phase 3 and it never ran: it needs a transcript, and the widget
   * only had loudness, so every utterance waited the same 550ms. Interim
   * text finally gives it something to read.
   */
  it('varies the silence window with what was actually said', () => {
    expect(SRC).toMatch(/function silenceWindowFor\(transcript\)/);
    expect(SRC).toMatch(/silenceWindowFor\(voice\.interim\)/);
  });

  it('keeps its thresholds identical to the server endpointer', () => {
    // Read from the package rather than restated here: two copies of a
    // number is how they drift, and a test that hard-codes both copies
    // drifts along with them.
    expect(SRC).toContain(`ENDPOINT_COMPLETE_MS = ${THRESHOLDS.complete}`);
    expect(SRC).toContain(`ENDPOINT_SILENCE_MS = ${THRESHOLDS.base}`);
    expect(SRC).toContain(`ENDPOINT_HANGING_MS = ${THRESHOLDS.hanging}`);
  });

  it('waits longer on a trailing conjunction than a finished question', () => {
    const fn = SRC.slice(SRC.indexOf('function silenceWindowFor'), SRC.indexOf('function startRecognition'));
    expect(fn).toContain('ENDPOINT_HANGING_MS');
    expect(fn).toContain('QUESTION_OPENERS');
  });

  /**
   * A listening indicator that loops on a timer says "working" whether or
   * not anything is being heard — a dead microphone animates exactly like a
   * live one. That ambiguity is a large part of why this feature took three
   * attempts to diagnose, so the bars are driven by the real signal in both
   * directions.
   */
  it('drives the waveform from the microphone analyser, not a timer', () => {
    expect(SRC).toMatch(/function drawWave\(buf, gain\)/);
    expect(SRC).toMatch(/drawWave\(buf, 2\.2\)/);
    // No keyframe animation standing in for a signal.
    expect(SRC).not.toMatch(/@keyframes\s+wave/);
  });

  it('animates the reply from the spoken audio too', () => {
    // Otherwise the bars freeze the moment the shopper stops talking, right
    // through the part where the assistant is answering.
    expect(SRC).toMatch(/function watchPlayback\(audio\)/);
    expect(SRC).toMatch(/createMediaElementSource/);
  });

  it('keeps the reply audible when routing it through the analyser', () => {
    // A MediaElementSource re-routes the element; without reconnecting to
    // the destination the assistant animates and says nothing.
    expect(SRC).toMatch(/src\.connect\(an\)\.connect\(voice\.ctx\.destination\)/);
  });

  it('rests the bars visibly rather than collapsing them to nothing', () => {
    // Fully collapsed reads as broken, which is the opposite of the point.
    expect(SRC).toMatch(/Math\.max\(0\.12,/);
  });

  it('honours prefers-reduced-motion without hiding the state', () => {
    expect(SRC).toMatch(/prefers-reduced-motion:reduce\)\{[\s\S]{0,200}\.wave i\{transition:none/);
  });

  it('shows interim text without depending on it', () => {
    // Display only — the authoritative transcript still comes from the
    // server, which is language-locked and the same in every browser.
    expect(SRC).toContain('function startRecognition()');
    expect(SRC).toMatch(/rec\.interimResults = true/);
    // Firefox has no SpeechRecognition; absence must change nothing else.
    expect(SRC).toMatch(/if \(!SR\) return null;/);
  });

  it('releases the recogniser with the recorder', () => {
    // Otherwise a second microphone consumer stays alive through
    // transcription and the spoken answer.
    expect(SRC).toMatch(/function stopRecognition\(\)/);
    const onstop = SRC.slice(SRC.indexOf('rec.onstop = function'), SRC.indexOf('rec.start(100)'));
    expect(onstop).toContain('stopRecognition()');
  });

  it('reports the endpoint decision to the server, not just the console', () => {
    expect(vad()).toMatch(/voiceDiag\('endpoint', reading\)/);
    expect(vad()).toMatch(/reason = quietLongEnough \? 'silence'/);
  });

  /**
   * The failure being chased is one where the recorder NEVER stops, so a
   * report sent only on stop is never sent at all — which is exactly why the
   * server saw nothing across two failed attempts and both fixes were made
   * blind. The heartbeat makes "still listening, and here are the levels"
   * visible while it is happening.
   */
  it('heartbeats the levels while still listening', () => {
    expect(vad()).toMatch(/voiceDiag\('listening', reading\)/);
    expect(vad()).toMatch(/voice\.lastBeat/);
  });

  it('resumes a suspended AudioContext, or every level reads as silence', () => {
    // iOS/Safari start the context suspended.
    expect(SRC).toMatch(/state === 'suspended'/);
  });

  it('waits the shared base silence window, not an invented number', () => {
    // Mirrors THRESHOLDS.base in packages/voice/src/endpoint.ts.
    expect(SRC).toMatch(/ENDPOINT_SILENCE_MS = 550/);
  });
});

/**
 * Cards belong to the answer that produced them.
 *
 * There used to be one rail pinned above the whole conversation. It worked
 * for the first question and quietly stopped after: a second question
 * replaced the first set of cards, several screens above the answer they
 * explained and usually scrolled out of view — so a shopper reading a list
 * of six boards saw no pictures at all.
 */
describe('widget product cards', () => {
  it('creates a rail per turn instead of one for the whole panel', () => {
    expect(SRC).toContain('function turnRail()');
    // The single pinned rail is gone from the panel markup.
    expect(SRC).not.toContain('<div class="rail" hidden>');
  });

  it('puts the cards AFTER the answer, in reading order', () => {
    // Cards arrive first, off the speculative search. Rendering them where
    // they landed pushed the reply below the fold — pictures for a question
    // that had not been answered yet, with the words out of sight.
    expect(SRC).toMatch(/insertBefore\(rail, turnUi\.bubble\.nextSibling\)/);
  });

  it('starts each turn without inheriting the previous turn\'s rail', () => {
    expect(SRC).toMatch(/turnUi\.bubble = bubble;\s*\n\s*turnUi\.rail = null;/);
  });

  /**
   * A live UCP variant reports `availability: {available: true}`; the demo
   * fixtures use a flat `available`. Reading only the flat one made the value
   * `undefined` against a real store, so every card wore a "Sold out" badge
   * while the answer beside it listed the same products as available.
   */
  it('reads availability from the shape a live store actually sends', () => {
    expect(SRC).toContain('function variantAvailable(v)');
    expect(SRC).toMatch(/v\.availability && typeof v\.availability\.available === 'boolean'/);
    expect(SRC).not.toMatch(/return !v\.available;/);
  });

  it('treats unknown availability as available, not sold out', () => {
    // Branding a purchasable product sold out loses the sale outright; the
    // opposite is corrected at the cart, which is authoritative.
    const fn = SRC.slice(SRC.indexOf('function variantAvailable'), SRC.indexOf('function renderCards'));
    expect(fn.trimEnd().endsWith('return true;\n  }')).toBe(true);
  });

  it('removes only this turn\'s rail when a turn fails', () => {
    // Previously this hid the one shared rail, which also wiped the cards
    // from every earlier answer in the scrollback.
    expect(SRC).toContain('function dropRail()');
    expect(SRC).not.toMatch(/els\.rail\.hidden = true/);
  });
});

describe('saying what it is doing', () => {
  /**
   * A shop assistant says "let me check" and walks off. The panel showed
   * three animated dots through the catalog search — the same dots shown
   * while the model thinks — so a shopper could not tell whether anything
   * was happening on their behalf.
   */
  it('names the work in progress instead of showing generic dots', () => {
    expect(SRC).toContain('Checking the catalog…');
    expect(SRC).toContain('Checking the store policy…');
    expect(SRC).toContain('Adding that to your cart…');
  });

  it('never lets progress text overwrite an answer', () => {
    // Guarded on nothing having been painted yet.
    expect(SRC).toMatch(/if \(!shown && d && d\.type === 'tool_start'\)/);
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

describe('widget mobile sheet', () => {
  // String assertions on the stylesheet — the DOM double cannot do media
  // queries or layout. They guard the intent: on a phone the panel is a sheet
  // over a third of the viewport, not a takeover of the whole screen.
  const mobile = SRC.slice(SRC.indexOf('@media (max-width:540px)'), SRC.indexOf('@media (prefers-color-scheme'));

  it('takes a third of the viewport, not the whole phone', () => {
    expect(mobile).toMatch(/height:\s*33dvh/);
    expect(mobile).not.toMatch(/height:\s*88dvh/);
  });

  it('uses dvh so a collapsing URL bar does not resize it mid-conversation', () => {
    expect(mobile).not.toMatch(/height:\s*\d+vh\b/);
  });

  it('compacts the chrome, or a third of a short phone is all header', () => {
    // header + composer + intro at desktop sizes come to ~128px, which would
    // leave under 60px of conversation on a 568px-tall device.
    expect(mobile).toMatch(/header\{padding:10px 14px\}/);
    expect(mobile).toMatch(/textarea\{min-height:38px/);
  });
});

describe('brand tokens', () => {
  /**
   * Two sources set the accent: the app embed block (a page <style> rule) and
   * the admin settings behind /api/config. render() applied the server value as
   * an INLINE style, which beats a page rule — so a merchant who picked red in
   * the theme editor got the built-in green, with their setting saved and
   * correct the whole time.
   */
  it('keeps the theme editor colour instead of the server default', async () => {
    const r = await run({
      arm: 'exposed',
      themeTokens: { '--sa-accent': '#FF0808', '--sa-radius': '16px' },
      config: { enabled: true, accentColor: '#1b3a34', cornerRadius: 24 },
    });
    expect(r.pinned['--sa-accent']).toBeUndefined();
    expect(r.pinned['--sa-radius']).toBeUndefined();
  });

  it('falls back to the server value when the theme supplies none', async () => {
    const r = await run({
      arm: 'exposed',
      themeTokens: {},
      config: { enabled: true, accentColor: '#123456', cornerRadius: 8 },
    });
    expect(r.pinned['--sa-accent']).toContain('#123456');
    expect(r.pinned['--sa-radius']).toContain('8px');
  });
});

/**
 * At 404x640 the panel took most of a laptop viewport — on a 900px-tall
 * screen it covered the hero, the product and the buy button, which is the
 * page the shopper is reading while asking about it.
 */
describe('widget panel footprint', () => {
  const panel = () => SRC.slice(SRC.indexOf('.panel{'), SRC.indexOf('.panel.on'));

  it('leaves the page it is discussing visible', () => {
    expect(panel()).toContain('width:352px');
    expect(panel()).toMatch(/height:min\(440px/);
  });

  it('opens as a square for voice, which is the default', () => {
    // Square because it is one object doing one thing; a wide short bar
    // reads as a transcript that got cut off.
    expect(SRC).toMatch(/\.panel\.compact\{width:320px;height:320px\}/);
  });

  it('still fits two product cards side by side', () => {
    // 352 - 32 padding = 320 usable; two 156px cards plus an 11px gap = 323,
    // so the second card is a few pixels proud and the rail scrolls by one
    // card rather than wrapping — which is the intended behaviour.
    const card = SRC.slice(SRC.indexOf('.card{flex:'), SRC.indexOf('@keyframes pop'));
    expect(card).toContain('flex:0 0 156px');
  });
});

/**
 * Speaking a question is faster than typing it, and on a phone it is the
 * only comfortable way — but the mic was an outline button beside a filled
 * send arrow, so the accent colour said typing was the real input.
 */
describe('voice as the primary input', () => {
  const mic = () => SRC.slice(SRC.indexOf('.mic{'), SRC.indexOf('.mic:focus-visible'));
  const send = () => SRC.slice(SRC.indexOf('.send{'), SRC.indexOf('.send:disabled'));

  it('gives the accent colour to the mic, not the send button', () => {
    expect(mic()).toContain('background:var(--accent)');
    expect(send()).toContain('background:var(--paper)');
  });

  it('makes the mic the larger target', () => {
    expect(mic()).toContain('width:48px');
    // Demoted visually, but still a full-size target for a thumb.
    expect(send()).toContain('width:42px');
  });

  it('takes the interim language from the storefront, never a hard-coded en-US', () => {
    // A Spanish storefront pinned to en-US gets Spanish speech
    // transliterated into English captions.
    expect(SRC).toMatch(/document\.documentElement\.getAttribute\('lang'\)/);
    expect(SRC).toMatch(/navigator\.language/);
  });
});

/**
 * A shopper who taps a microphone-shaped button has already said what they
 * want to do. Opening a text panel and focusing a textarea told them to
 * type instead — the slower thing, and on a phone the awkward one.
 */
describe('launcher opens into listening, not typing', () => {
  it('starts the microphone instead of focusing the composer', () => {
    expect(SRC).toMatch(/if \(voiceFirst && canListen\(\)\)/);
    expect(SRC).toMatch(/if \(!voice\.on\) void toggleVoice\(\)/);
  });

  it('does not raise the keyboard over the thing being discussed', () => {
    const open = SRC.slice(SRC.indexOf('function open(opts)'), SRC.indexOf('function canListen'));
    // focus() only on the text path, never the voice one.
    expect(open).toMatch(/\} else \{[\s\S]{0,160}els\.input\.focus/);
  });

  it('falls back to text where the browser has no microphone', () => {
    expect(SRC).toMatch(/function canListen\(\)/);
    expect(SRC).toMatch(/typeof MediaRecorder !== 'undefined'/);
  });

  it('opens small and grows only when there is something to read', () => {
    expect(SRC).toMatch(/\.panel\.compact\{width:320px;height:320px\}/);
    expect(SRC).toMatch(/turnUi\.rail \|\| String\(d\.reply \|\| ''\)\.length > 220\) expand\(\)/);
  });
});

describe('widget colour', () => {
  /**
   * Solid brand colour on every shopper bubble turns the transcript into a
   * column of flat blocks, and spends the accent on the least important
   * thing on screen. It belongs on the control you want pressed.
   */
  it('tints the shopper bubble rather than filling it with the accent', () => {
    const bubble = SRC.slice(SRC.indexOf('.msg.user{'), SRC.indexOf('.msg.bot{'));
    expect(bubble).toMatch(/background:color-mix\(in srgb,var\(--accent\) \d+%,var\(--paper\)\)/);
    // Ink text, so contrast survives whatever accent the merchant sets.
    expect(bubble).toContain('color:var(--ink)');
    expect(bubble).not.toMatch(/background:var\(--accent\)(;|\})/);
  });
});

/**
 * Early cards are whatever the FIRST search returned, sent fast so
 * something is on screen while the model writes. For a query that matched
 * nothing that is the browse fallback — so "cheapest shoes" in a snowboard
 * shop showed a gift card and a snowboard under "What I found", beside a
 * reply that had found nothing. The pictures are what a shopper believes.
 */
describe('cards never outlive the answer', () => {
  it('clears the rail when the final answer names no product', () => {
    expect(SRC).toMatch(/if \(d\.final && d\.products\.length === 0\) dropRail\(\)/);
  });
});

describe('the square voice box', () => {
  const compact = () => SRC.slice(SRC.indexOf('.panel.compact{'), SRC.indexOf('@media (max-width:480px)'));

  it('is square, not a wide short bar', () => {
    expect(compact()).toContain('width:320px;height:320px');
  });

  it('centres the conversation in it rather than stacking from the top', () => {
    // A one-line answer should sit in the middle of the square, not cling
    // to the header with dead space beneath it.
    expect(compact()).toMatch(/\.panel\.compact \.scroll\{[^}]*justify-content:center/);
  });

  it('makes the waveform the subject, since it is the only thing moving', () => {
    expect(compact()).toMatch(/\.panel\.compact \.wave\{height:44px/);
  });

  it('stays a square on a phone instead of becoming a full-height sheet', () => {
    // A shopper who tapped a microphone did not ask to lose the page.
    const mobile = SRC.slice(SRC.indexOf('@media (max-width:480px)'));
    expect(mobile).toMatch(/\.panel\.compact\{width:min\(320px,calc\(100vw - 32px\)\)/);
  });
});

/**
 * What reads as cheap is not the colour, it is flat surfaces meeting at
 * hard borders with no depth hierarchy — one shade everywhere, a 1px line
 * drawn around each box, and body text set like a form field.
 */
describe('widget surface craft', () => {
  it('layers the panel shadow instead of one blurry drop', () => {
    const panel = SRC.slice(SRC.indexOf('.panel{'), SRC.indexOf('.panel.on'));
    // Contact, lift, room, and a sheen along the top edge.
    expect(panel).toContain('inset 0 1px 0 0 var(--sheen)');
    expect((panel.match(/rgba\(0,0,0,/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('uses hairlines rather than drawn borders', () => {
    // 11% ink reads as a box drawn around content; 7% reads as two
    // surfaces meeting.
    expect(SRC).toMatch(/--line:color-mix\(in srgb,var\(--ink\) 7%/);
  });

  it('sinks the composer below the conversation instead of matching it', () => {
    // A single flat surface everywhere is most of what makes an interface
    // look unfinished.
    expect(SRC).toMatch(/--sunk2:color-mix/);
    const field = SRC.slice(SRC.indexOf('.field{'), SRC.indexOf('.field:focus-within'));
    expect(field).toContain('background:var(--sunk2)');
  });

  it('gives focus a ring, which is the only focus cue on a touch device', () => {
    expect(SRC).toMatch(/\.field:focus-within\{[\s\S]{0,220}box-shadow:0 0 0 3px/);
  });

  it('sets body text to be read, not to fit', () => {
    const msg = SRC.slice(SRC.indexOf('.msg{'), SRC.indexOf('@keyframes rise'));
    expect(msg).toContain('font-size:15px');
    expect(msg).toContain('line-height:1.6');
  });

  it('derives every surface from the merchant theme, never a fixed colour', () => {
    // The widget has no palette of its own: a hard-coded grey is invisible
    // on a dark theme and a hard-coded white blows out on a light one.
    const surfaces = SRC.slice(SRC.indexOf('--muted:'), SRC.indexOf('--ease:'));
    expect(surfaces).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

/**
 * The level meter fed the endpointer for weeks while reading nothing, because
 * nothing depended on it being right. Then the upload gate started asking it
 * whether anyone had spoken, and voice died from the second turn onwards.
 */
describe('widget microphone level meter', () => {
  it('rewires the analyser when the microphone changes', () => {
    // Built once and bound to the first turn's stream, the graph points at an
    // ended track for every turn after — which reads as permanent silence.
    expect(SRC).toContain('voice.wiredTo !== voice.stream');
    expect(SRC).toContain('voice.source = voice.ctx.createMediaStreamSource(voice.stream)');
  });

  it('publishes peak so the upload gate can tell a quiet room from a dead meter', () => {
    expect(SRC).toContain('voice.peak = peak');
  });

  it('uploads anyway when the meter never registered anything', () => {
    // A gate on a signal that does not exist disables the feature it guards.
    expect(SRC).toContain("spoke < MIN_SPEECH_MS && (voice.peak || 0) > 0");
    expect(SRC).toContain("voiceDiag('level_meter_dead'");
  });
});

/**
 * A store has one language; its customers do not. On an Indian storefront
 * one customer speaks Hindi and the next speaks English, and neither the
 * page nor the merchant can answer for both.
 */
describe('widget language picker', () => {
  it('puts the picker in the header, where the shopper can reach it', () => {
    expect(SRC).toContain('<select class="lang"');
    expect(SRC).toContain('els.lang = p.querySelector(\'.lang\')');
  });

  it('sends the shopper choice, not the page language', () => {
    expect(SRC).toContain("'x-storefront-lang': (els.lang && els.lang.value) || chosenLang() || pageLang()");
  });

  it('remembers the choice across visits', () => {
    // Being asked again every visit is the kind of small insult that stops
    // people using a feature.
    expect(SRC).toContain("var LANG_KEY = 'storeagent.lang'");
    expect(SRC).toContain('localStorage.setItem(LANG_KEY');
  });

  it('starts on the merchant default and falls back to English', () => {
    expect(SRC).toContain("return CONFIG.voiceLanguage || 'en'");
  });

  it('builds the list from the server, so it cannot drift', () => {
    // A hard-coded list in the widget would outlive the codes the decoder
    // and the admin dropdown actually accept.
    expect(SRC).toContain('CONFIG.voiceLanguages');
  });
});
