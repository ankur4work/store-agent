import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Telemetry } from '../src/observability/telemetry.js';

/**
 * Which speech model goes first, decided per shop by what actually works there.
 *
 * `gpt-4o-transcribe` is a language model doing transcription: handed audio it
 * cannot place, it does not fall silent, it writes a fluent sentence in whatever
 * language it lands on. Observed on the live dev store, two of five spoken English
 * turns came back in Arabic script, were caught by the mismatch guard, and were
 * rescued by `whisper-1` — at the cost of a second upload each time (4554 ms and
 * 2067 ms against ~1250 ms for the clean turns).
 *
 * If the acoustic model is what ends up being believed on a shop, it should go
 * first on that shop. These tests are about that promotion happening, being
 * reversible, and not firing for the wrong reasons.
 */

const WAV = (() => {
  // Uploaded as webm, not wav: the WAV path runs a speech-presence check that
  // drops a synthetic tone as a hallucination, which would mask the model choice
  // this file is about. The bytes only have to reach the stub.
  const samples = 3200;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i / 7) * 6000 + (i % 13) * 40), 44 + i * 2);
  }
  return buf;
})();

const SHOP = 'stt.myshopify.com';

describe('choosing the speech model per shop', () => {
  let server: Server;
  let base: string;
  let realFetch: typeof globalThis.fetch;
  /** Models asked for, in order, across every upload. */
  let asked: string[];
  /** What the next upload for each model should return. */
  let replies: Map<string, string>;

  beforeEach(async () => {
    realFetch = globalThis.fetch;
    asked = [];
    replies = new Map();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('127.0.0.1') || url.includes('localhost')) return realFetch(input, init);
      if (!url.includes('/v1/audio/transcriptions')) throw new Error(`unexpected: ${url}`);

      const form = init?.body as FormData;
      const model = String(form.get('model'));
      asked.push(model);
      return new Response(JSON.stringify({ text: replies.get(model) ?? '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-test', PORT: '0' }),
      telemetry: new Telemetry(),
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function speak(): Promise<string> {
    const res = await realFetch(`${base}/api/voice/transcribe?shop=${SHOP}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm', 'x-storefront-lang': 'en' },
      body: WAV,
    });
    return ((await res.json()) as { text?: string }).text ?? '';
  }

  /** The failure seen live: English in, Arabic script out. */
  function primaryInventsArabic(): void {
    replies.set('gpt-4o-transcribe', 'مرحبا كيف حالك');
    replies.set('whisper-1', 'how much is this one');
  }

  it('tries the primary first on a shop that has given no trouble', async () => {
    replies.set('gpt-4o-transcribe', 'how much is this one');
    expect(await speak()).toBe('how much is this one');
    expect(asked).toEqual(['gpt-4o-transcribe']);
  });

  it('puts the acoustic model first once the primary keeps inventing a language', async () => {
    primaryInventsArabic();

    // Two bad turns: each costs the shopper a wasted upload before the rescue.
    expect(await speak()).toBe('how much is this one');
    expect(await speak()).toBe('how much is this one');
    expect(asked).toEqual([
      'gpt-4o-transcribe', 'whisper-1',
      'gpt-4o-transcribe', 'whisper-1',
    ]);

    // Third turn goes straight to the model that was answering anyway — one
    // upload, not two.
    asked.length = 0;
    expect(await speak()).toBe('how much is this one');
    expect(asked).toEqual(['whisper-1']);
  });

  it('does not give up on the primary after a single bad second of audio', async () => {
    // One mismatch is a noisy room, not a pattern about this shop's speakers.
    primaryInventsArabic();
    await speak();
    asked.length = 0;
    await speak();
    expect(asked[0]).toBe('gpt-4o-transcribe');
  });

  it('keeps the demoted model as the fallback, so it can still rescue a turn', async () => {
    primaryInventsArabic();
    await speak();
    await speak();

    // Promoted — but now whisper-1 is the one that cannot read this audio.
    replies.set('whisper-1', '');
    replies.set('gpt-4o-transcribe', 'do you have it in blue');
    asked.length = 0;
    expect(await speak()).toBe('do you have it in blue');
    expect(asked).toEqual(['whisper-1', 'gpt-4o-transcribe']);
  });

  it('keeps each shop’s decision to itself', async () => {
    primaryInventsArabic();
    await speak();
    await speak();

    // Another merchant's customers are different people in a different room.
    asked.length = 0;
    const res = await realFetch(`${base}/api/voice/transcribe?shop=other.myshopify.com`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm', 'x-storefront-lang': 'en' },
      body: WAV,
    });
    await res.json();
    expect(asked[0]).toBe('gpt-4o-transcribe');
  });

  it('does not demote the primary for silence or an upload failure', async () => {
    /**
     * An empty transcript says nothing about which model suits this shop — it is a
     * recording problem. Counting it would move every quiet store onto the
     * acoustic model for no reason.
     */
    replies.set('gpt-4o-transcribe', '');
    replies.set('whisper-1', '');
    await speak();
    await speak();
    await speak();
    asked.length = 0;
    await speak();
    expect(asked[0]).toBe('gpt-4o-transcribe');
  });
});
