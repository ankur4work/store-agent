import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Telemetry } from '../src/observability/telemetry.js';
import { isUnpaid, transcribe, type TranscriptOutcome } from '../src/voice/service.js';

/**
 * Every outcome in `voice/service.ts` was already distinguished, and reported
 * as a log line. A log line answers "did this happen once"; the questions that
 * matter are rates — what fraction of turns are discarded, is the whisper-1
 * fallback rescuing one turn a day or one in five. These tests pin the counting,
 * because a metric that quietly counts the wrong thing is worse than no metric:
 * it gets believed.
 */

const CFG = { apiKey: 'sk-test', sttModel: 'gpt-4o-transcribe', ttsModel: 't', voice: 'v' };

/** Collects the outcomes a transcription attempt reports. */
function recording(overrides: Record<string, unknown> = {}) {
  const outcomes: TranscriptOutcome[] = [];
  const cfg = {
    ...CFG,
    ...overrides,
    onOutcome: (o: TranscriptOutcome) => outcomes.push(o),
  } as Parameters<typeof transcribe>[2];
  return { cfg, outcomes };
}

function respondWith(bodies: (string | { status: number; body: string })[]) {
  let n = 0;
  return (async () => {
    const next = bodies[Math.min(n++, bodies.length - 1)]!;
    return typeof next === 'string'
      ? new Response(JSON.stringify({ text: next }), { status: 200 })
      : new Response(next.body, { status: next.status });
  }) as unknown as typeof fetch;
}

describe('transcription outcomes', () => {
  it('counts a usable transcript as heard', async () => {
    const { cfg, outcomes } = recording();
    const text = await transcribe(
      Buffer.from('audio'),
      'audio/wav',
      cfg,
      respondWith(['how much is the snowboard']),
    );
    expect(text).toBe('how much is the snowboard');
    expect(outcomes).toEqual(['heard']);
  });

  it('counts an empty upstream answer, then the fallback that rescued it', async () => {
    const { cfg, outcomes } = recording({ fallbackSttModel: 'whisper-1' });
    const text = await transcribe(
      Buffer.from('audio'),
      'audio/wav',
      cfg,
      respondWith(['', 'do you have it in blue']),
    );
    expect(text).toBe('do you have it in blue');
    // Both, in order: the primary heard nothing AND the acoustic model saved
    // the turn. Collapsing them would hide how often the primary is failing.
    expect(outcomes).toEqual(['empty', 'rescued']);
  });

  it('counts a language mismatch, then an unusable fallback', async () => {
    // The real failure: an English question on an `en` storefront came back as
    // Turkish, then the fallback came back empty.
    const { cfg, outcomes } = recording({ language: 'en', fallbackSttModel: 'whisper-1' });
    const text = await transcribe(
      Buffer.from('audio'),
      'audio/wav',
      cfg,
      respondWith(['Konuşmamı da bırakmam', '']),
    );
    expect(text).toBe('');
    expect(outcomes).toEqual(['language_mismatch', 'fallback_unusable']);
  });

  it('counts a prompt echo as its own outcome, not as silence', async () => {
    // One is a recording problem and the other is ours; the fixes are opposite.
    const hint = 'Shopping questions about products, sizes, prices, shipping and returns.';
    const { cfg, outcomes } = recording({ transcriptionHint: hint });
    await transcribe(Buffer.from('a'), 'audio/wav', cfg, respondWith([hint]));
    expect(outcomes).toEqual(['prompt_echo']);
  });

  it('separates an unpaid account from a transcription failure', async () => {
    /**
     * Measured live: four identical 502s that read as a broken audio pipeline
     * and were an inactive billing account. The status is 429, which is also
     * what a rate limit looks like, so only the body distinguishes them.
     */
    const { cfg, outcomes } = recording();
    const body = JSON.stringify({
      error: { message: 'Your account is not active, please check your billing details on our website.', type: 'billing_not_active' },
    });
    await expect(
      transcribe(Buffer.from('a'), 'audio/wav', cfg, respondWith([{ status: 429, body }])),
    ).rejects.toMatchObject({ outcome: 'upstream_unpaid', status: 502 });
    expect(outcomes).toEqual(['upstream_unpaid']);
  });

  it('does not spend the fallback request on an account that cannot be charged', async () => {
    // That request cannot succeed either, and spending it doubles the latency
    // of every voice turn for as long as the account stays inactive.
    let calls = 0;
    const doFetch = (async () => {
      calls++;
      return new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 });
    }) as unknown as typeof fetch;
    const { cfg } = recording({ fallbackSttModel: 'whisper-1' });
    await expect(transcribe(Buffer.from('a'), 'audio/wav', cfg, doFetch)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('still counts an unclassifiable upstream refusal', async () => {
    const { cfg, outcomes } = recording();
    await expect(
      transcribe(Buffer.from('a'), 'audio/mp4', cfg, respondWith([{ status: 503, body: 'gateway down' }])),
    ).rejects.toMatchObject({ outcome: 'upstream_error' });
    expect(outcomes).toEqual(['upstream_error']);
  });

  it('keeps logging exactly what it logged before', async () => {
    // The log lines are load-bearing for diagnosis and their names appear in
    // runbooks. The metric is additive; it must not have renamed anything.
    const events: string[] = [];
    const cfg = {
      ...CFG,
      language: 'en',
      log: { warn: (e: string) => events.push(e) },
    } as Parameters<typeof transcribe>[2];
    await transcribe(Buffer.from('a'), 'audio/wav', cfg, respondWith(['']));
    expect(events).toContain('voice_upstream_empty');
  });
});

describe('isUnpaid', () => {
  it('recognises the ways an account failure is worded', () => {
    expect(isUnpaid('{"error":{"type":"billing_not_active"}}')).toBe(true);
    expect(isUnpaid('{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(isUnpaid('You exceeded your current quota')).toBe(true);
    expect(isUnpaid('Your account is not active')).toBe(true);
  });

  it('does not mistake a real rate limit for one', () => {
    // Both are HTTP 429 and they need opposite responses: one is waited out,
    // the other is a billing page.
    expect(isUnpaid('Rate limit reached for gpt-4o-transcribe')).toBe(false);
    expect(isUnpaid('Audio file might be corrupted or unsupported')).toBe(false);
  });
});

describe('device capability census', () => {
  let server: Server;
  let base: string;
  let telemetry: Telemetry;

  beforeEach(async () => {
    telemetry = new Telemetry();
    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-test', PORT: '0' }),
      telemetry,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const send = (diag: unknown) =>
    fetch(`${base}/api/diag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shop: 'acme.myshopify.com', diag }),
    });

  it('counts a device that could run Whisper locally', async () => {
    const res = await send({
      voice: 'mic_on',
      caps: { webgpu: true, worklet: true, net: '4g', saveData: false },
    });
    expect(res.status).toBe(204);
    expect(
      telemetry.deviceCaps.get({ webgpu: 'yes', worklet: 'yes', net: '4g', savedata: 'no' }),
    ).toBe(1);
  });

  it('counts one that could not', async () => {
    await send({ voice: 'mic_on', caps: { webgpu: false, worklet: true, net: '3g', saveData: true } });
    expect(
      telemetry.deviceCaps.get({ webgpu: 'no', worklet: 'yes', net: '3g', savedata: 'yes' }),
    ).toBe(1);
  });

  it('refuses to turn client input into an unbounded label set', async () => {
    // A label taken straight from a request body is a memory leak wearing a
    // useful name. Anything outside the Network Information API's own values
    // collapses to one series.
    for (const net of ['wifi', 'ethernet', '../../etc', 'x'.repeat(500)]) {
      await send({ caps: { webgpu: false, worklet: false, net, saveData: false } });
    }
    expect(
      telemetry.deviceCaps.get({ webgpu: 'no', worklet: 'no', net: 'unknown', savedata: 'no' }),
    ).toBe(4);
  });

  it('records unknown rather than guessing when a field is missing', async () => {
    await send({ caps: {} });
    expect(
      telemetry.deviceCaps.get({
        webgpu: 'unknown',
        worklet: 'unknown',
        net: 'unknown',
        savedata: 'unknown',
      }),
    ).toBe(1);
  });

  it('ignores the diagnostics that carry no capabilities', async () => {
    // Most beacons are endpointing readings sent every three seconds. Counting
    // those as devices would make the census a function of how long people talk.
    await send({ voice: 'listening', level: 12 });
    await send('not an object');
    expect(telemetry.deviceCaps.total()).toBe(0);
  });
});
