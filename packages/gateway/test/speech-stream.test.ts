import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Telemetry } from '../src/observability/telemetry.js';
import { MemorySessionStore } from '../src/sessions.js';

/**
 * Serving speech, over real HTTP, with the speech API stubbed.
 *
 * The claim under test is specifically about *when* bytes move, not whether the
 * right bytes eventually arrive — so most of these assertions are about the
 * response existing before the upstream has finished producing it. TTS was 79% of
 * the wait before a voice answer was audible, and the cause was three layers each
 * waiting for a last byte: the upstream read, the gateway's `content-length`, and
 * the widget's `await r.blob()`.
 */

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

describe('speech, streamed', () => {
  let server: Server;
  let base: string;
  let telemetry: Telemetry;
  let realFetch: typeof globalThis.fetch;
  let upstreamCalls: string[];
  /** Resolve to release the tail of the current synthesis. */
  let release: (() => void) | undefined;

  beforeEach(async () => {
    telemetry = new Telemetry();
    realFetch = globalThis.fetch;
    upstreamCalls = [];
    release = undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('127.0.0.1') || url.includes('localhost')) return realFetch(input, init);
      if (url !== SPEECH_URL) throw new Error(`unexpected host: ${url}`);

      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string; response_format?: string };
      upstreamCalls.push(body.input ?? '');

      /**
       * Two chunks with a gate between them, which is what makes "progressive"
       * testable: the first is released at once and the second only when the test
       * says so, so an assertion that lands in between proves bytes reached the
       * client before synthesis finished.
       */
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(new Uint8Array(1200).fill(0xaa));
          await gate;
          c.enqueue(new Uint8Array(800).fill(0xbb));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'audio/pcm' } });
    }) as typeof globalThis.fetch;

    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-test', PORT: '0' }),
      telemetry,
      sessions: new MemorySessionStore(),
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    release?.();
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Run a voice turn on the deterministic lane and return its SSE events. */
  async function voiceTurn(message = 'what is in my cart') {
    const res = await realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId: `s-${message.slice(0, 8)}`, voice: true }),
    });
    const text = await res.text();
    return [...text.matchAll(/event: (\w+)\ndata: (.*)/g)].map((m) => ({
      event: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }));
  }

  it('announces an audio id with the utterance, and starts making it', async () => {
    const events = await voiceTurn();
    const speak = events.find((e) => e.event === 'speak');
    expect(speak?.data['text']).toBe('Your cart is empty.');
    // The id is what lets the widget use a GET and stream; the text rides along so
    // a client that cannot do that still has something to post.
    expect(speak?.data['audioId']).toMatch(/^[0-9a-f]{32}$/);

    /**
     * Synthesis began during the turn, not when the browser asked. This overlap is
     * the cheapest part of the whole fix: the upstream round trip now runs behind
     * the SSE delivery instead of after it.
     */
    expect(upstreamCalls).toEqual(['Your cart is empty.']);
  });

  it('streams the audio for an announced id, before synthesis has finished', async () => {
    const events = await voiceTurn();
    const id = String(events.find((e) => e.event === 'speak')?.data['audioId']);

    const res = await realFetch(`${base}/api/voice/speak?id=${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    /**
     * No `content-length`, and that absence is the fix rather than an oversight: a
     * length cannot be known while the audio is still being generated, and
     * supplying one is what made the response un-streamable.
     */
    expect(res.headers.get('content-length')).toBeNull();
    // Proxies hold a short response otherwise, which reinstates the whole wait.
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const reader = res.body!.getReader();
    const first = await reader.read();
    // Arrived while the second half is still gated — bytes before completion.
    expect(first.done).toBe(false);
    const head = Buffer.from(first.value!);
    expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(head.subarray(8, 12).toString('ascii')).toBe('WAVE');

    release?.();
    let total = first.value!.length;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
    }
    // 44-byte header + 1200 + 800 of samples.
    expect(total).toBe(44 + 2000);
  });

  it('declares the sample format the upstream actually sends', async () => {
    // A header that disagrees with the samples plays at the wrong pitch rather
    // than failing, so it would never surface as an error.
    const events = await voiceTurn();
    const id = String(events.find((e) => e.event === 'speak')?.data['audioId']);
    release?.();
    const res = await realFetch(`${base}/api/voice/speak?id=${id}`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.readUInt16LE(20)).toBe(1); // PCM, uncompressed
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(24_000); // 24 kHz
    expect(buf.readUInt16LE(34)).toBe(16); // 16-bit
  });

  it('asks the speech API for pcm, which is the format that can stream', async () => {
    /**
     * `opus` was chosen here in a comment claiming it had the lowest
     * time-to-first-audio. Measured against the real API it is the worst of the
     * three — 2112 ms to first byte against 760 ms for pcm — because a compressed
     * format cannot emit anything until its encoder has buffered.
     */
    let format: string | undefined;
    const spy = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === SPEECH_URL) {
        format = (JSON.parse(String(init?.body ?? '{}')) as { response_format?: string }).response_format;
      }
      return spy(input, init);
    }) as typeof globalThis.fetch;

    await voiceTurn();
    expect(format).toBe('pcm');
  });

  it('serves one synthesis to the turn and the playback request alike', async () => {
    const events = await voiceTurn();
    const id = String(events.find((e) => e.event === 'speak')?.data['audioId']);
    release?.();
    await realFetch(`${base}/api/voice/speak?id=${id}`).then((r) => r.arrayBuffer());
    // The prewarm and the fetch are two arrivals for one utterance, and the
    // shopper should not pay for the sentence twice.
    expect(upstreamCalls).toEqual(['Your cart is empty.']);
  });

  it('refuses an id it never announced', async () => {
    /**
     * An id is a capability to replay a sentence the gateway chose to say. Treating
     * an unknown one as text to synthesize would turn this into an open TTS
     * endpoint keyed on a querystring, billable to the merchant.
     */
    const res = await realFetch(`${base}/api/voice/speak?id=${'0'.repeat(32)}`);
    expect(res.status).toBe(404);
    expect(upstreamCalls).toEqual([]);
  });

  it('still answers the posted-text fallback', async () => {
    // The path a client takes when it has no id, or when streamed playback failed.
    // Nothing has synthesized yet here, so the gate only exists once the request
    // has reached the stub — released after the call rather than before it.
    const pending = realFetch(`${base}/api/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Yes, it is in stock.' }),
    });
    for (let i = 0; i < 200 && release === undefined; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    release?.();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(44 + 2000);
  });

  it('rejects empty and over-long text without calling upstream', async () => {
    const post = (text: string) =>
      realFetch(`${base}/api/voice/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });

    expect((await post('')).status).toBe(400);
    expect(upstreamCalls).toEqual([]);

    /**
     * 413 specifically, not a blanket 502. The status is produced inside the
     * synthesis attempt and has to survive being carried out through the cache,
     * which is the only way the endpoint can tell the two apart.
     */
    expect((await post('x'.repeat(5000))).status).toBe(413);
  });

  it('counts time to first audio byte, so this stays measurable', async () => {
    // The number that regressed silently before, because nothing recorded it.
    const events = await voiceTurn();
    const id = String(events.find((e) => e.event === 'speak')?.data['audioId']);
    release?.();
    await realFetch(`${base}/api/voice/speak?id=${id}`).then((r) => r.arrayBuffer());
    expect(telemetry.upstream.count({ target: 'speech' })).toBe(1);
  });
});
