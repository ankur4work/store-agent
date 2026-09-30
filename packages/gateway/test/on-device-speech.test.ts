import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import {
  DEFAULT_SETTINGS,
  ON_DEVICE_SPEECH_OPTIONS,
  normaliseOnDeviceSpeech,
  validateSettings,
} from '../src/admin/settings.js';
import { renderAdmin } from '../src/admin/render.js';
import { analyze } from '@storeagent/attribution';

/**
 * On-device speech recognition.
 *
 * The browser can recognise speech locally, with a language pack it downloads
 * and manages itself — `processLocally`, `available()` and `install()`. That
 * matters here for a reason that is not obvious: the interim transcript is what
 * lets the endpointer tell a pause mid-sentence from the end of a question, so
 * where the live caption comes from decides how often a shopper gets cut off
 * mid-thought. It also stops their voice leaving their machine.
 *
 * The final transcript is unchanged — still uploaded, still produced
 * server-side. Nothing here can make the answer worse.
 */

/**
 * The voice chunk, not widget.js — the recogniser ladder lives there since the
 * split. The server-side assertions in this file use the gateway directly.
 */
const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/widget-voice.js'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('the setting', () => {
  it('defaults to the value that downloads nothing', () => {
    // A merchant who has not read about this must not be spending their
    // shoppers' bandwidth on a speech model.
    expect(DEFAULT_SETTINGS.onDeviceSpeech).toBe('auto');
  });

  it('accepts only the three real behaviours', () => {
    const base = {
      accentColor: '#1b3a34',
      cornerRadius: 16,
      position: 'right',
      greeting: '',
      enabled: true,
      holdoutFraction: 0.2,
      voiceLanguage: 'en',
    };
    for (const [code] of ON_DEVICE_SPEECH_OPTIONS) {
      const r = validateSettings('s.myshopify.com', { ...base, onDeviceSpeech: code });
      expect(r.ok, `${code} should be accepted`).toBe(true);
      expect(r.settings?.onDeviceSpeech).toBe(code);
    }
    const bad = validateSettings('s.myshopify.com', { ...base, onDeviceSpeech: 'maybe' });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/onDeviceSpeech/);
  });

  it('reads an unknown stored value as the safe default', () => {
    // A row written before the column existed reads NULL, and the widget
    // branches on this string — an unrecognised value must land on the
    // behaviour that downloads nothing, not on whichever `if` catches it.
    expect(normaliseOnDeviceSpeech(null)).toBe('auto');
    expect(normaliseOnDeviceSpeech(undefined)).toBe('auto');
    expect(normaliseOnDeviceSpeech('nonsense')).toBe('auto');
    expect(normaliseOnDeviceSpeech('off')).toBe('off');
    expect(normaliseOnDeviceSpeech('on')).toBe('on');
  });

  it('is offered in the admin with the download cost stated', () => {
    const html = renderAdmin({
      shop: 'acme.myshopify.com',
      apiKey: 'k',
      host: '',
      settings: { shop: 'acme.myshopify.com', ...DEFAULT_SETTINGS, updatedAt: 0 },
      stats: { activeSessions: 0, mode: 'demo' as const, model: 'm' },
      lift: analyze(
        { sessions: 0, conversions: 0, revenueMinor: 0 },
        { sessions: 0, conversions: 0, revenueMinor: 0 },
      ),
      liftSummary: '',
      recommendedHoldout: 0.2,
      unmatchedOrders: 0,
    });

    expect(html).toContain('name="onDeviceSpeech"');
    for (const [code] of ON_DEVICE_SPEECH_OPTIONS) {
      expect(html).toContain(`value="${code}"`);
    }
    // A merchant deciding this needs to know it costs their customer a download.
    expect(html).toMatch(/one-time download/);
    // And that it is about the caption, not the answer.
    expect(html).toMatch(/answer itself is unaffected/i);
  });
});

describe('the widget is told the setting', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createGateway({ config: loadConfig({ OPENAI_API_KEY: 'sk-test', PORT: '0' }) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('carries onDeviceSpeech in the bootstrap config', async () => {
    // The widget cannot ask a merchant; it reads this once before it decides
    // anything about the microphone.
    const cfg = (await fetch(`${base}/api/config?shop=demo.local`).then((r) => r.json())) as {
      onDeviceSpeech?: string;
    };
    expect(cfg.onDeviceSpeech).toBe('auto');
  });
});

describe('the widget ladder', () => {
  it('probes availability once per page and never awaits it', () => {
    /**
     * Awaiting an availability check between the shopper pressing the
     * microphone and the chime that tells them to speak would trade the thing
     * we are buying for the thing we are buying it with. So the first turn
     * behaves exactly as it does today and later turns use what the probe found.
     */
    expect(SRC).toMatch(/if \(!onDevice\.probed\) probeOnDevice\(SR\)/);
    expect(SRC).toMatch(/onDevice\.probed = true/);
    const fn = SRC.slice(SRC.indexOf('function startRecognition'), SRC.indexOf('function stopRecognition'));
    // No await on the path to rec.start(). Word-bounded on both sides: a
    // comment in that function says "never awaited", and matching inside that
    // word would make this test pass or fail on prose rather than on code.
    expect(fn).not.toMatch(/\bawait\b/);
  });

  it('requires local processing rather than hinting at it', () => {
    // A flag that silently fell back to the cloud would make the privacy claim
    // in the admin copy untrue.
    expect(SRC).toMatch(/rec\.processLocally = true/);
  });

  it('falls back to the cloud once if the pack has gone', () => {
    // processLocally makes the recogniser refuse rather than degrade, so an
    // evicted pack throws. A live caption is worth more than where it came from.
    const fn = SRC.slice(SRC.indexOf('function startRecognition'), SRC.indexOf('function stopRecognition'));
    expect(fn).toMatch(/onDevice\.state = 'unavailable'/);
    expect(fn).toMatch(/return startRecognition\(\)/);
    // And the retry cannot recurse: `local` is false once state is unavailable.
    expect(fn).toMatch(/var local = onDevice\.state === 'available'/);
  });

  it('respects a merchant who turned it off', () => {
    expect(SRC).toMatch(/onDeviceMode\(\) !== 'off'/);
    // An unrecognised value behaves as 'auto', matching the server.
    expect(SRC).toMatch(/m === 'off' \|\| m === 'on' \|\| m === 'auto' \? m : 'auto'/);
  });

  it('installs a language pack only between turns, and only when asked', () => {
    // Tens of megabytes. Starting that mid-sentence would compete with the
    // upload the shopper is waiting on.
    expect(SRC).toMatch(/maybeInstallOnDevice\(\);/);
    const end = SRC.slice(SRC.indexOf('function endVoiceTurn'), SRC.indexOf('function enqueueSpeech'));
    expect(end).toMatch(/maybeInstallOnDevice\(\)/);

    const fn = SRC.slice(SRC.indexOf('function maybeInstallOnDevice'), SRC.indexOf('function startRecognition'));
    expect(fn).toMatch(/onDeviceMode\(\) !== 'on'/);
    expect(fn).toMatch(/onDevice\.state !== 'downloadable'/);
    // saveData is the shopper saying they are paying for data.
    expect(fn).toMatch(/saveData === true/);
    expect(fn).toMatch(/slow-2g\|2g\|3g/);
    // Once. An install that failed must not be retried every turn.
    expect(fn).toMatch(/onDevice\.installing/);
  });

  it('asks for the pack in the language the caption uses', () => {
    // Otherwise it captions in one language and recognises locally in another.
    const probe = SRC.slice(SRC.indexOf('function probeOnDevice'), SRC.indexOf('function maybeInstallOnDevice'));
    expect(probe).toMatch(/langs: \[tag\], processLocally: true/);
    expect(probe).toMatch(/var tag = langTag\(\)/);
    const rec = SRC.slice(SRC.indexOf('function startRecognition'), SRC.indexOf('function stopRecognition'));
    expect(rec).toMatch(/rec\.lang =\s*\n?\s*langTag\(\)/);
  });

  it('prefers the regioned locale, because installed packs are regioned', () => {
    // A browser holding "en-US" answers "unavailable" for a bare "en".
    const fn = SRC.slice(SRC.indexOf('function langTag'), SRC.indexOf('function probeOnDevice'));
    expect(fn).toMatch(/nav\.toLowerCase\(\)\.indexOf\(l\.toLowerCase\(\) \+ '-'\) === 0/);
    // 'auto' means the merchant asked for detection: there is no single pack to
    // request, so the browser's own locale is the only honest guess.
    expect(fn).toMatch(/l === 'auto'/);
  });

  it('survives the API being withheld by a Permissions-Policy', () => {
    // Access to install() is gated by the on-device-speech-recognition
    // directive, which a merchant's theme or CDN can withhold. Not something we
    // can fix from here, and the cloud rung must be unaffected.
    expect(SRC).toMatch(/typeof SR\.available !== 'function'/);
    expect(SRC).toMatch(/onDevice\.state = 'error'/);
    expect(SRC).toMatch(/Permissions-Policy/);
  });

  it('reports the rung on the beacon it already sends', () => {
    const fn = SRC.slice(SRC.indexOf("voiceDiag('capture_start'"), SRC.indexOf("voiceDiag('capture_start'") + 400);
    expect(fn).toMatch(/partials:/);
    expect(fn).toMatch(/mode:/);
    expect(fn).toMatch(/state:/);
    // Never a second beacon for the same three fields.
    expect(SRC).not.toMatch(/voiceDiag\('partials'/);
  });
});
