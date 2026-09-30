import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { TARGET_RATE, encodeWav, resample } from '@storeagent/voice';

/**
 * The widget's capture path, which is where a voice turn's latency is decided.
 *
 * It used to record webm/opus through a MediaRecorder, decode that back with
 * `decodeAudioData`, downmix it, and re-encode a WAV at the microphone's own
 * 48 kHz. It now taps raw PCM off the graph the level meter already built and
 * uploads at 16 kHz — three times fewer bytes, which on a phone's uplink is the
 * largest single term in time-to-transcript.
 *
 * Two kinds of test here, and the distinction matters:
 *
 *   - The DSP is **executed**. `resampleTo` and `wavBlob` are hand-mirrored
 *     from packages/voice/src/wav.ts because the widget is a browser IIFE that
 *     cannot import TypeScript, and a mirror that is only checked by reading it
 *     is a mirror that has already drifted. These run both copies on the same
 *     input and compare the output.
 *   - The wiring is **read**. Whether the microphone is routed to the speakers
 *     is a property of which nodes are connected, and asserting on source is
 *     the honest way to check that without a real Web Audio implementation.
 */

/**
 * The voice chunk, not widget.js.
 *
 * Everything in this file is about the microphone, and the microphone moved out
 * of widget.js when it was split: the host ships on every page view against a
 * 15 KB budget, and voice loads on the first mic press. Reading the host here
 * would assert nothing — and would keep passing if this code drifted back into
 * it, which is the one thing the split exists to prevent.
 */
const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/widget-voice.js'),
  'utf8',
).replace(/\r\n/g, '\n');

/**
 * Pull a top-level function out of the widget by brace matching.
 *
 * Crude on purpose: a real parser would be a dependency, and the thing being
 * extracted is a self-contained numeric routine. If the extraction ever fails
 * the test fails loudly rather than silently checking nothing.
 */
function extractFn(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  expect(at, `function ${name} not found in widget.js`).toBeGreaterThan(-1);
  const open = SRC.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function widgetFns<T extends Record<string, unknown>>(names: string[]): T {
  const ctx: Record<string, unknown> = {
    Blob,
    DataView,
    ArrayBuffer,
    Float32Array,
    Math,
    // The widget's own mirrored constant, read from source so the test cannot
    // disagree with the code about what rate it uploads at.
    UPLOAD_RATE: Number(/var UPLOAD_RATE = (\d+)/.exec(SRC)?.[1]),
    out: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${names.map(extractFn).join('\n')}\nout = { ${names.join(', ')} };`, ctx);
  return ctx['out'] as T;
}

function tone(hz: number, seconds: number, rate: number, amp = 0.4): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amp;
  return out;
}

const fns = widgetFns<{
  resampleTo: (s: Float32Array, from: number, to: number) => Float32Array;
  wavBlob: (s: Float32Array, rate: number) => Blob;
}>(['resampleTo', 'wavBlob']);

describe('the widget resampler mirrors the one in packages/voice', () => {
  it('produces identical output going 48k to 16k', async () => {
    const input = tone(440, 0.25, 48_000);
    const mine = fns.resampleTo(input, 48_000, TARGET_RATE);
    const theirs = resample(input, 48_000, TARGET_RATE);

    expect(mine.length).toBe(theirs.length);
    for (let i = 0; i < theirs.length; i++) {
      expect(mine[i]).toBeCloseTo(theirs[i]!, 10);
    }
  });

  it('agrees at 44.1k too, where the ratio is not an integer', async () => {
    const input = tone(700, 0.2, 44_100);
    const mine = fns.resampleTo(input, 44_100, TARGET_RATE);
    const theirs = resample(input, 44_100, TARGET_RATE);
    expect(mine.length).toBe(theirs.length);
    for (let i = 0; i < theirs.length; i++) expect(mine[i]).toBeCloseTo(theirs[i]!, 10);
  });

  it('attenuates a tone above the new Nyquist rather than folding it into speech', () => {
    /**
     * The reason the averaging is there at all. A 15 kHz tone cannot be
     * represented at 16 kHz; decimating by picking every third sample makes it
     * reappear at 1 kHz, in the middle of the speech band, as energy nobody
     * produced. Sibilance and room hiss are exactly what would fold down.
     */
    const out = fns.resampleTo(tone(15_000, 0.2, 48_000), 48_000, TARGET_RATE);
    const rms = Math.sqrt([...out].reduce((a, v) => a + v * v, 0) / out.length);
    expect(rms).toBeLessThan(0.1);
  });

  it('is a no-op when the microphone already runs at the upload rate', () => {
    const input = tone(440, 0.05, TARGET_RATE);
    expect(fns.resampleTo(input, TARGET_RATE, TARGET_RATE)).toBe(input);
  });

  it('does not throw on an empty capture', () => {
    expect(fns.resampleTo(new Float32Array(0), 48_000, TARGET_RATE).length).toBe(0);
  });
});

describe('the widget WAV writer mirrors encodeWav', () => {
  it('writes byte-identical files', async () => {
    const samples = tone(440, 0.05, TARGET_RATE);
    const mine = new Uint8Array(await fns.wavBlob(samples, TARGET_RATE).arrayBuffer());
    const theirs = encodeWav(samples, TARGET_RATE);
    // Byte-for-byte, header included. A header that differs by one field is how
    // an upload gets rejected as "corrupted or unsupported" — which is exactly
    // what happened the last time the container was wrong.
    expect([...mine]).toEqual([...theirs]);
  });

  it('labels the blob as WAV, which is what skips the re-encode downstream', async () => {
    expect(fns.wavBlob(tone(440, 0.01, TARGET_RATE), TARGET_RATE).type).toBe('audio/wav');
  });

  it('clamps a hot sample rather than wrapping it', async () => {
    // A wrap turns one loud syllable into full-scale noise, which a recogniser
    // reads as a consonant nobody said.
    const bytes = new Uint8Array(
      await fns.wavBlob(Float32Array.from([2, -2]), TARGET_RATE).arrayBuffer(),
    );
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});

describe('upload rate', () => {
  it('matches TARGET_RATE in packages/voice', () => {
    // Read from the package rather than restated here: two copies of a number
    // is how they drift, and this one decides how many bytes every voice turn
    // on every storefront costs.
    expect(SRC).toContain(`var UPLOAD_RATE = ${TARGET_RATE}`);
  });

  it('asks the microphone for mono at that rate', () => {
    // A hint most browsers ignore, which is why the resample above is not
    // conditional. Asking costs nothing and occasionally works.
    expect(SRC).toMatch(/channelCount: 1/);
    expect(SRC).toMatch(/sampleRate: 16000/);
    // Left to per-browser defaults these differ by OS.
    expect(SRC).toMatch(/echoCancellation: true/);
    expect(SRC).toMatch(/noiseSuppression: true/);
    expect(SRC).toMatch(/autoGainControl: true/);
  });
});

/**
 * The worklet itself, executed.
 *
 * `WORKLET_SRC` is hand-written JavaScript in a string, which means neither the
 * minifier nor a typechecker nor any other test in this repo ever looks inside
 * it — a typo would surface only on a real device with a real microphone, which
 * is the slowest feedback loop this project has. `AudioWorkletProcessor` and
 * `registerProcessor` do not exist in Node, so they are stubbed and the
 * processor is driven directly with the 128-frame blocks a browser would give it.
 */
function loadWorklet(): { name: string; make: () => { process: (i: Float32Array[][]) => boolean }; posted: Float32Array[] } {
  const at = SRC.indexOf('var WORKLET_SRC =');
  expect(at, 'WORKLET_SRC not found').toBeGreaterThan(-1);
  const end = SRC.indexOf(';\n', at);
  const source = vm.runInNewContext(`(${SRC.slice(at + 'var WORKLET_SRC ='.length, end)})`) as string;

  const posted: Float32Array[] = [];
  let registered: { name: string; cls: new () => { process: (i: Float32Array[][]) => boolean } } | undefined;
  const ctx: Record<string, unknown> = {
    Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (d: Float32Array) => posted.push(d) };
    },
    registerProcessor: (name: string, cls: new () => { process: (i: Float32Array[][]) => boolean }) => {
      registered = { name, cls };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  expect(registered, 'the worklet never registered a processor').toBeDefined();
  return { name: registered!.name, make: () => new registered!.cls(), posted };
}

describe('the capture worklet', () => {
  it('registers and runs', () => {
    const { name, make } = loadWorklet();
    expect(name).toBe('sa-capture');
    // A processor that returns false is torn down by the browser after one
    // render quantum, and the capture would stop after 128 frames.
    expect(make().process([[new Float32Array(128)]])).toBe(true);
  });

  it('posts 2048-frame blocks, not one per render quantum', () => {
    // 128 frames at 48 kHz is 375 messages a second across the thread boundary.
    // Buffering to 2048 makes it 23.
    const { make, posted } = loadWorklet();
    const proc = make();
    for (let i = 0; i < 16; i++) proc.process([[new Float32Array(128)]]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.length).toBe(2048);
  });

  it('loses no samples across the block boundary', () => {
    /**
     * The bug this would catch is an off-by-one in the buffer index that drops
     * or repeats a sample every 2048 frames — inaudible, undetectable by ear,
     * and exactly the kind of thing that degrades recognition by a few percent
     * with no visible cause. A ramp makes any gap or repeat obvious.
     */
    const { make, posted } = loadWorklet();
    const proc = make();
    let next = 0;
    for (let i = 0; i < 40; i++) {
      const block = new Float32Array(128);
      for (let j = 0; j < 128; j++) block[j] = next++ / 10000;
      proc.process([[block]]);
    }
    expect(posted.length).toBe(2); // 5120 frames in, two full blocks out
    const flat = [...posted[0]!, ...posted[1]!];
    for (let i = 0; i < flat.length; i++) expect(flat[i]).toBeCloseTo(i / 10000, 6);
  });

  it('posts a copy, not the buffer it keeps filling', () => {
    // Posting the live buffer would hand the main thread a view that the next
    // 2048 frames overwrite, so every block would contain the most recent audio
    // and the recording would be the last fraction of a second repeated.
    const { make, posted } = loadWorklet();
    const proc = make();
    const fill = (v: number) => {
      const b = new Float32Array(128).fill(v);
      for (let i = 0; i < 16; i++) proc.process([[b]]);
    };
    fill(0.25);
    fill(0.75);
    expect(posted).toHaveLength(2);
    expect(posted[0]![0]).toBeCloseTo(0.25, 6);
    expect(posted[1]![0]).toBeCloseTo(0.75, 6);
  });

  it('survives a render quantum with no input connected', () => {
    // Between `connect()` and the first audio, and after a track ends, the
    // input array is empty. Indexing into it unguarded would throw inside the
    // audio thread, which kills capture silently.
    const { make } = loadWorklet();
    expect(() => make().process([])).not.toThrow();
    expect(() => make().process([[]])).not.toThrow();
  });
});

describe('the capture ladder', () => {
  it('prefers a worklet, then a script processor, then the recorder', () => {
    const fn = SRC.slice(SRC.indexOf('async function startPcmCapture'), SRC.indexOf('function pcmToWav'));
    expect(fn.indexOf('AudioWorkletNode')).toBeGreaterThan(-1);
    expect(fn.indexOf('createScriptProcessor')).toBeGreaterThan(fn.indexOf('AudioWorkletNode'));
    // The MediaRecorder is only reached when both PCM rungs returned null.
    expect(SRC).toMatch(/if \(kind === null\) kind = startRecorderCapture\(\)/);
  });

  it('registers the processor name it later constructs', () => {
    // Two string literals that must agree, in a file where a mismatch would
    // throw only on a real device with a real microphone.
    const registered = /registerProcessor\("([^"]+)"/.exec(SRC)?.[1];
    expect(registered).toBe('sa-capture');
    expect(SRC).toContain(`new AudioWorkletNode(ctx, '${registered}')`);
  });

  it('loads the worklet from an inline blob, not a second request', () => {
    // widget.js ships as one asset under a 15 KB gzipped budget, and a network
    // request on the mic path is the latency this change exists to remove.
    expect(SRC).toMatch(/URL\.createObjectURL\(new Blob\(\[WORKLET_SRC\]/);
    expect(SRC).toMatch(/audioWorklet\.addModule/);
  });

  it('reports a worklet that failed for a reason other than support', () => {
    // A merchant's Content-Security-Policy can block the blob URL. Silently
    // falling back would cost every shopper on that store the faster path with
    // nothing anywhere reporting it.
    expect(SRC).toMatch(/voiceDiag\('worklet_failed'/);
  });

  it('never routes the microphone to the speakers', () => {
    const fn = SRC.slice(SRC.indexOf('async function startPcmCapture'), SRC.indexOf('function pcmToWav'));
    // The worklet is connected FROM the source and to nothing else: a worklet
    // runs whether or not its output goes anywhere.
    expect(fn).toMatch(/voice\.source\.connect\(node\)/);
    expect(fn).not.toMatch(/node\.connect\(ctx\.destination\)/);
    // A ScriptProcessorNode does not run unless its output reaches the
    // destination, so that one goes through a zero gain.
    expect(fn).toMatch(/mute\.gain\.value = 0/);
    expect(fn).toMatch(/mute\.connect\(ctx\.destination\)/);
  });

  it('copies each script-processor block instead of keeping the buffer', () => {
    // The buffer is reused by the next callback; holding a reference records
    // the same fragment of audio over and over.
    expect(SRC).toMatch(/new Float32Array\(e\.inputBuffer\.getChannelData\(0\)\)/);
  });

  it('stops buffering rather than growing without bound', () => {
    // If the endpointer ever fails to fire, a held microphone must not become
    // a memory leak on the merchant's page.
    expect(SRC).toMatch(/MAX_CAPTURE_SECONDS/);
  });
});

describe('the primary path does not re-encode', () => {
  it('skips decodeAudioData when the capture is already WAV', () => {
    // Decoding our own file and writing it back at the microphone's rate would
    // undo the entire saving.
    expect(SRC).toMatch(/raw\.type === 'audio\/wav' \? raw : await toWav\(raw\)/);
  });

  it('keeps the fallback re-encode on the same 16 kHz path', () => {
    const fn = SRC.slice(SRC.indexOf('async function toWav'), SRC.indexOf('async function transcribeAndSend'));
    expect(fn).toMatch(/wavBlob\(resampleTo\(mono, audio\.sampleRate, UPLOAD_RATE\), UPLOAD_RATE\)/);
  });
});

describe('cancelling a turn', () => {
  it('discards the recording instead of submitting it', () => {
    /**
     * `stop()` on a MediaRecorder fires `onstop` asynchronously, after
     * `voice.on` has already been cleared — and the old handler uploaded
     * anything over 1200 bytes without asking whether the turn was still
     * wanted. So pressing stop sent the half-sentence anyway and the assistant
     * answered a question the shopper had visibly cancelled.
     */
    expect(SRC).toMatch(/voice\.capture\.stop\(false\)/);
    // The endpointer is the one caller that means "send it".
    expect(SRC).toMatch(/voice\.capture\.stop\(true\)/);
  });

  it('routes every rung through one place, so the gates cannot diverge', () => {
    expect(SRC).toMatch(/function onCaptured\(blob, kind\)/);
    // The silence gate that removed the fabrication class at its source.
    expect(SRC).toMatch(/voiceDiag\('discarded_silence'/);
    // A cancelled turn stops before onCaptured, so null there means one thing.
    const rec = SRC.slice(SRC.indexOf('function startRecorderCapture'), SRC.indexOf('function onCaptured'));
    expect(rec).toMatch(/if \(discard\) return;/);
  });

  it('ends the turn when a capture delivered nothing at all', () => {
    /**
     * A worklet that never ran, a track that ended underneath us, a context
     * left suspended. Returning quietly leaves the panel reading "Listening…"
     * forever with a capture that has already stopped — nothing endpoints
     * again, because nothing is recording. An unexplained dead end is the
     * failure mode this whole path has been fighting.
     */
    const fn = SRC.slice(SRC.indexOf('function onCaptured'), SRC.indexOf('function pickMime'));
    expect(fn).toMatch(/if \(blob === null\) \{/);
    expect(fn).toMatch(/voiceDiag\('capture_empty'/);
    const nullBranch = fn.slice(fn.indexOf('if (blob === null) {'), fn.indexOf('Bytes are not speech'));
    expect(nullBranch).toMatch(/endVoiceTurn\(\)/);
    expect(nullBranch).toMatch(/didn't catch that/);
  });
});

describe('noise floor calibration', () => {
  it('measures the room before it believes anything about the shopper', () => {
    expect(SRC).toMatch(/var CALIBRATE_FROM_MS = (\d+)/);
    const from = Number(/var CALIBRATE_FROM_MS = (\d+)/.exec(SRC)?.[1]);
    const to = Number(/var CALIBRATE_TO_MS = (\d+)/.exec(SRC)?.[1]);
    // Starts after the opening chime, which is an acoustic event of our own
    // making and not the room.
    expect(from).toBeGreaterThan(100);
    expect(to).toBeGreaterThan(from);
    // Short enough that a shopper who talks immediately loses no words: capture
    // runs from t=0 and only the speech accounting waits.
    expect(to).toBeLessThan(700);
  });

  it('does not count speech while it is still measuring', () => {
    // Otherwise the floor calibrates to the shopper's own voice, the threshold
    // demands they exceed it by half again, and the recorder never stops.
    expect(SRC).toMatch(/var speaking = level > threshold && !calibrating/);
  });

  it('reports how many frames the window actually got', () => {
    // Zero frames with a wrong threshold is a different bug from the window
    // measuring the wrong thing, and they look identical without this.
    expect(SRC).toMatch(/calib: calibFrames/);
  });
});

describe('what the shopper actually waited for', () => {
  it('times the upload, which the server-side eval cannot see', () => {
    expect(SRC).toMatch(/voiceDiag\('transcript', \{/);
    const fn = SRC.slice(SRC.indexOf("voiceDiag('transcript'"), SRC.indexOf("voiceDiag('transcript'") + 400);
    expect(fn).toMatch(/ms:/);
    expect(fn).toMatch(/bytes:/);
    // Never the transcript and never the audio.
    expect(fn).not.toMatch(/text:/);
  });

  it('opens the connection on mic press rather than inside the turn', () => {
    expect(SRC).toMatch(/function warmUpload\(\)/);
    expect(SRC).toMatch(/rel = 'preconnect'/);
    expect(SRC).toMatch(/warmUpload\(\);/);
  });
});

describe('the device census', () => {
  it('tests for an adapter, not just for the API', () => {
    // `navigator.gpu` exists on devices that then fail to produce an adapter,
    // and counting those as capable would overstate the local path's reach.
    expect(SRC).toMatch(/navigator\.gpu\.requestAdapter\(\)/);
    // Time-boxed: it is allowed to take as long as it likes.
    expect(SRC).toMatch(/Promise\.race/);
  });

  it('runs after permission and once per page', () => {
    expect(SRC).toMatch(/var capsSent = false/);
    // A shopper who declines the microphone is never profiled.
    const toggle = SRC.slice(SRC.indexOf('async function toggleVoice'), SRC.indexOf('function warmUpload'));
    expect(toggle.indexOf('mic_denied')).toBeLessThan(toggle.indexOf('reportCaps()'));
  });

  it('sends capabilities where the server reads them', () => {
    // The gateway counts `diag.caps`; a rename on either side silently stops
    // the census without breaking anything visible.
    expect(SRC).toMatch(/voiceDiag\('caps', \{ caps: caps \}\)/);
  });
});

/**
 * Barge-in, and the parity that makes voice an option rather than a mode.
 *
 * A voice agent that talks over you is unusable regardless of its latency
 * numbers, and one that takes the keyboard away while it listens has turned an
 * enhancement into a trap. Neither was tested.
 */
describe('speaking over the assistant', () => {
  it('cancels the audio AND the generation behind it', () => {
    /**
     * Stopping the audio alone is not barge-in: the model keeps writing, the
     * tokens are still spent, and the next sentence arrives to be spoken over
     * the shopper who interrupted.
     */
    const tick = SRC.slice(SRC.indexOf('if (speaking) {'), SRC.indexOf('var recording'));
    expect(tick).toMatch(/stopPlayback\(\)/);
    expect(tick).toMatch(/host\.abortInflight\(\)/);
  });

  it('needs more than a cough to trigger', () => {
    // A door, a sneeze or a throat-clear must not cancel an answer the shopper
    // is waiting for.
    expect(SRC).toMatch(/voice\.playing && voice\.spokeMs > 1\d\d/);
  });

  it('invalidates speech already requested, so a retraction cannot arrive late', () => {
    // The grounding tripwire discards a partial answer; audio already in flight
    // would otherwise arrive afterwards and say the retracted sentence.
    const fn = SRC.slice(SRC.indexOf('function stopPlayback'), SRC.indexOf('function stopPlayback') + 600);
    expect(fn).toMatch(/voice\.gen\+\+/);
    expect(fn).toMatch(/voice\.queue\.length = 0/);
  });
});
