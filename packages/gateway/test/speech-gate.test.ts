import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const VOICE_SRC = readFileSync(resolve(here, '../public/widget-voice.js'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/**
 * Pull a named function out of the widget by brace matching.
 *
 * Crude on purpose, and identical in spirit to the extractor in
 * widget-capture.test.ts: a real parser would be a dependency, and these are
 * self-contained numeric routines. A failed extraction fails the test loudly
 * rather than silently checking nothing.
 */
function extractFn(name: string): string {
  const at = VOICE_SRC.indexOf(`function ${name}(`);
  expect(at, `function ${name} not found in widget-voice.js`).toBeGreaterThan(-1);
  const open = VOICE_SRC.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < VOICE_SRC.length; i++) {
    if (VOICE_SRC[i] === '{') depth++;
    else if (VOICE_SRC[i] === '}') {
      depth--;
      if (depth === 0) return VOICE_SRC.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

interface Frame {
  level: number;
  at: number;
  dt: number;
}
const names = ['speechThreshold', 'replayCalibration'];
const ctx: Record<string, unknown> = { Math, out: {} };
vm.createContext(ctx);
vm.runInContext(`${names.map(extractFn).join('\n')}\nout = { ${names.join(', ')} };`, ctx);
const fns = ctx['out'] as {
  speechThreshold: (floor: number, peak: number) => number;
  replayCalibration: (
    frames: Frame[],
    threshold: number,
  ) => { spokeMs: number; lastAt: number };
};

/**
 * The gate as the tick composes it: the floor is used AS MEASURED, then the
 * threshold. If a cap on the floor is ever reintroduced this helper is where it
 * has to appear, and the steady-room tests below are what will fail.
 */
const gateFor = (floorRaw: number, peak: number): number =>
  fns.speechThreshold(floorRaw, peak);

/** Mirrors MIN_SPEECH_MS in widget-voice.js, read from source so it cannot drift. */
const MIN_SPEECH_MS = Number(/var MIN_SPEECH_MS = (\d+)/.exec(VOICE_SRC)?.[1]);

/**
 * The microphone gate: what counts as the shopper speaking.
 *
 * Two defects lived here, and both of them read to a shopper as "it is not
 * listening to me". Neither was visible in the listening corpus, because that
 * uploads a finished clip and so has already had this decision made for it.
 */
describe('the speech threshold', () => {
  it('is never cleared by a steady room, at any level', () => {
    /**
     * The regression that matters, and it is arithmetic rather than a judgement.
     *
     * The floor used to be capped with `Math.min(floorRaw, peak * 0.5)`. Work out
     * when that changes the value and it is only ever when `peak < 2 * floorRaw`
     * — only when nothing loud has happened, which is exactly when the floor
     * needs no correcting. For a steady room at level L, peak is also about L:
     *
     *     floor     = min(L, 0.5L)           = 0.5L
     *     threshold = max(6, 0.5L + 6, 0.3L) = 0.5L + 6
     *     speaking <=> L > 0.5L + 6          <=> L > 12
     *
     * So a fan, traffic or shop music above level 12 was heard as a shopper
     * talking, permanently — reinstating the hardcoded `level > 12` this routine
     * was rewritten to remove. `silenceSince` was then reset every frame, nothing
     * ever endpointed, and the capture ran to its 20-second stop with no speech
     * in it at all.
     *
     * With the floor reported as measured, a steady room cannot clear its own
     * threshold, because the threshold is the floor plus headroom.
     */
    for (let level = 0; level <= 200; level++) {
      // A steady room: the quietest frame, the loudest frame and this frame are
      // all the same level. Through the gate as the tick composes it — the cap
      // is part of what is under test, so going via `speechThreshold` alone
      // would pass no matter how the floor was mangled first.
      expect(level, `a steady room at level ${level} registered as speech`).toBeLessThanOrEqual(
        gateFor(level, level),
      );
    }
  });

  it('is not cleared by a room that wanders within the headroom', () => {
    /**
     * Stationary noise is not perfectly flat — the level is an average over the
     * analyser's bins, so it wanders a little, and the floor tracks the quietest
     * of it while the peak tracks the loudest.
     *
     * The guarantee is bounded by the headroom, and stating it honestly matters:
     * the threshold is `floor + 6`, so a room whose peak-to-trough SPREAD stays
     * under 6 can never clear it, at any level. A room that swings wider than
     * that still can — at level 61 a ±5% wander is a spread of 6.1 and reads as
     * speech. That is a far narrower hole than the one this replaced, which was
     * every room above level 12 regardless of how steady it was, but it is not
     * zero and the fixed headroom is why.
     */
    const HEADROOM = 6; // `floor + 6` in speechThreshold
    const drift = HEADROOM / 2 - 0.05; // spread just inside the headroom
    for (let level = 4; level <= 200; level++) {
      // `<=`, because the gate's own test is `level > threshold` — a frame
      // sitting exactly on the threshold is silence, not speech.
      expect(
        level + drift,
        `a room wandering around ${level} registered as speech`,
      ).toBeLessThanOrEqual(gateFor(level - drift, level + drift));
    }
  });

  it('still lets a real voice through, over a quiet room and a loud one', () => {
    // Quiet room, ordinary speech: floor 8, the shopper peaking at 60.
    expect(45).toBeGreaterThan(gateFor(8, 60));
    // Busy shop: the room is loud, the shopper is louder.
    expect(55).toBeGreaterThan(gateFor(25, 70));
    // A soft voice in a quiet room — the case `peak * 0.3` exists for.
    expect(20).toBeGreaterThan(gateFor(8, 24));
  });

  it('keeps a floor of 6, so a dead-silent room needs a real signal', () => {
    expect(fns.speechThreshold(0, 0)).toBe(6);
    expect(5).toBeLessThan(fns.speechThreshold(0, 0));
  });

  it('does not let a near-silent room be cleared by its own noise', () => {
    // Floor 0.4, peak 0.5 — a microphone's own noise, not a person.
    expect(0.5).toBeLessThan(fns.speechThreshold(0.4, 0.5));
  });
});

describe('speech during the calibration window', () => {
  const frame = (level: number, at: number): Frame => ({ level, at, dt: 1000 / 60 });

  it('is counted once there is a threshold to judge it by', () => {
    /**
     * The second defect. Frames in the first 480ms were discarded outright,
     * because the room had not been measured yet — so everything said in that
     * window was erased.
     *
     * A shopper who taps and immediately says one word has the whole word inside
     * it. "medium", "red", "yes" — the entire answer to "which size?" — left
     * `spokeMs` at 0, and the upload gate threw the turn away as silence with
     * "I didn't catch that". The frames were never the problem; judging them with
     * no threshold was.
     */
    const held: Frame[] = [];
    // 500ms of a word, syllables dipping toward a room at level 8.
    for (let at = 0; at < 480; at += 1000 / 60) {
      const phase = (at % 250) / 250;
      const envelope = phase < 0.72 ? Math.sin(Math.PI * (phase / 0.72)) : 0;
      held.push(frame(8 + (45 - 8) * envelope, at));
    }

    const { spokeMs, lastAt } = fns.replayCalibration(held, fns.speechThreshold(8, 45));

    // Enough to clear the upload gate, which is the whole point.
    expect(spokeMs).toBeGreaterThanOrEqual(MIN_SPEECH_MS);
    // And the silence timer is told the shopper was still talking, rather than
    // silent since the tap — otherwise the turn could endpoint immediately.
    expect(lastAt).toBeGreaterThan(0);
  });

  it('counts nothing when the window really was just the room', () => {
    const held = [8, 8.2, 7.9, 8.1, 8].map((l, i) => frame(l, i * 16));
    const { spokeMs, lastAt } = fns.replayCalibration(held, fns.speechThreshold(7.9, 8.2));
    expect(spokeMs).toBe(0);
    // Nothing to report, so the silence timer is left alone.
    expect(lastAt).toBe(0);
  });

  it('reports the LAST speaking frame, not the first', () => {
    const held = [frame(50, 100), frame(8, 200), frame(50, 300), frame(8, 400)];
    const { lastAt } = fns.replayCalibration(held, 20);
    expect(lastAt).toBe(300);
  });

  it('handles an empty window without inventing speech', () => {
    expect(fns.replayCalibration([], 10)).toEqual({ spokeMs: 0, lastAt: 0 });
  });
});

/**
 * Pins on the source, because both defects were single expressions and both
 * would be reintroduced by anyone "simplifying" this back.
 *
 * Checked against the CODE with comments stripped: the notes above each fix
 * quote the expression they removed, and a pin that reads those would be
 * satisfied by the explanation of the bug rather than its absence.
 */
const CODE = VOICE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the gate keeps its shape', () => {
  it('does not cap the floor against the peak', () => {
    expect(CODE, 'capping the floor reinstates `level > 12` for every steady room').not.toMatch(
      /Math\.min\(\s*floorRaw\s*,\s*peak\s*\*\s*0\.5\s*\)/,
    );
    // Positively: the threshold is fed the floor as measured. Without this the
    // check above passes for any other way of pulling the floor downward.
    expect(CODE).toMatch(/voice\.floor = floorRaw;/);
    expect(CODE).toMatch(/speechThreshold\(voice\.floor, peak\)/);
  });

  it('takes the calibration floor as a minimum, not a mean', () => {
    expect(CODE, 'averaging the window makes the floor the shopper’s own voice').not.toMatch(
      /calibSum\s*\/\s*calibFrames/,
    );
    expect(CODE).toMatch(/if \(level < calibMin\) calibMin = level/);
  });

  it('holds calibration frames rather than discarding them', () => {
    // The GUARD, not just the call. A first version of this pin matched
    // `calibHeld.push(` alone, which stayed satisfied when the branch was
    // changed to `if (false)` — it proved the text was present, not that it ran.
    expect(CODE, 'the calibration window must be held, not dropped').toMatch(
      /if \(calibrating\)\s*\{\s*calibHeld\.push\(/,
    );
    expect(CODE, 'held frames must be replayed once a threshold exists').toMatch(
      /else if \(calibHeld\.length > 0\)\s*\{\s*var replay = replayCalibration\(calibHeld, threshold\)/,
    );
    // And the recovered time has to reach the counter the upload gate reads.
    expect(CODE).toMatch(/voice\.spokeMs \+= replay\.spokeMs/);
    expect(CODE).toMatch(/voice\.silenceSince = replay\.lastAt/);
  });

  it('still reports how many frames calibration saw', () => {
    // A zero here means the window never ran, which is a different state from
    // "the room measured zero" — and the diagnostic is the only place it shows.
    expect(CODE).toMatch(/calib: calibFrames/);
  });
});
