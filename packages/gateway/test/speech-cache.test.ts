import { describe, expect, it } from 'vitest';
import { SpeechCache, type SpeechListener } from '../src/voice/speech-cache.js';
import { VoiceError } from '../src/voice/service.js';

/**
 * The cache that made TTS stop being 79% of the wait.
 *
 * Three claims are tested here, and they are the three reasons it exists: one
 * synthesis can serve several listeners, a listener gets audio *as it arrives*
 * rather than at the end, and nothing is remembered that should not be — a failed
 * synthesis above all, because caching one bad second would silence the same
 * sentence for as long as the entry lived.
 */

/** A stream whose chunks are released one at a time, under the test's control. */
function controlled(): {
  stream: ReadableStream<Uint8Array>;
  push(byte: number): void;
  close(): void;
  fail(err: Error): void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (byte) => controller.enqueue(new Uint8Array([byte])),
    close: () => controller.close(),
    fail: (err) => controller.error(err),
  };
}

/** Let queued microtasks run — the cache's fan-out is promise-driven. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Collected {
  chunks: number[];
  ended: boolean;
  err: Error | undefined;
  listener: SpeechListener;
}

/** Records what one listener received, so the assertions can read as prose. */
function collector(): Collected {
  const out: Collected = {
    chunks: [],
    ended: false,
    err: undefined,
    listener: { onChunk: () => {}, onEnd: () => {} },
  };
  out.listener = {
    onChunk: (c) => {
      out.chunks.push(...c);
    },
    onEnd: (e) => {
      out.ended = true;
      out.err = e;
    },
  };
  return out;
}

describe('one synthesis, several listeners', () => {
  it('calls upstream once for an utterance however many ask for it', async () => {
    const src = controlled();
    let calls = 0;
    const cache = new SpeechCache({
      source: () => {
        calls++;
        return Promise.resolve(src.stream);
      },
    });

    const a = collector();
    const b = collector();
    cache.listen('hello', a.listener);
    cache.listen('hello', b.listener);
    await settle();
    src.push(1);
    src.close();
    await settle();

    // The whole point of the prewarm: the turn announces, the widget asks, and
    // that is two arrivals for one upstream call.
    expect(calls).toBe(1);
    expect(a.chunks).toEqual([1]);
    expect(b.chunks).toEqual([1]);
  });

  it('announcing starts synthesis before anyone is listening', async () => {
    const src = controlled();
    let calls = 0;
    const cache = new SpeechCache({
      source: () => {
        calls++;
        return Promise.resolve(src.stream);
      },
    });

    // No listener yet — this is the overlap that hides the upstream round trip
    // behind the SSE delivery and the widget's own request.
    const id = cache.announce('hello');
    await settle();
    expect(calls).toBe(1);
    expect(cache.textForId(id)).toBe('hello');
  });

  it('replays what a late listener missed, then follows the live chunks', async () => {
    /**
     * The ordinary case, not an edge case: synthesis starts at the `speak` event
     * and the widget arrives tens of milliseconds later. Without the replay it
     * would miss the opening of the sentence — audible as a clipped first word.
     */
    const src = controlled();
    const cache = new SpeechCache({ source: () => Promise.resolve(src.stream) });

    cache.announce('hello');
    await settle();
    src.push(1);
    src.push(2);
    await settle();

    const late = collector();
    cache.listen('hello', late.listener);
    expect(late.chunks).toEqual([1, 2]); // synchronously, before any await
    expect(late.ended).toBe(false);

    src.push(3);
    src.close();
    await settle();
    expect(late.chunks).toEqual([1, 2, 3]);
    expect(late.ended).toBe(true);
  });

  it('serves a completed utterance in full, with no upstream call', async () => {
    const src = controlled();
    let calls = 0;
    const cache = new SpeechCache({
      source: () => {
        calls++;
        return Promise.resolve(src.stream);
      },
    });

    cache.listen('hello', collector().listener);
    await settle();
    src.push(7);
    src.close();
    await settle();

    // A second shopper told the same thing. "It's $699.95." is character-identical
    // for everyone on that product page, which is what makes this worth keeping.
    const second = collector();
    cache.listen('hello', second.listener);
    expect(calls).toBe(1);
    expect(second.chunks).toEqual([7]);
    expect(second.ended).toBe(true);
    expect(cache.stats.hits).toBe(1);
  });

  it('delivers the first chunk before the stream is complete', async () => {
    // Progressive, which is the claim the whole fix rests on. Buffering is what
    // made a 760 ms first byte cost 1819 ms of silence.
    const src = controlled();
    const cache = new SpeechCache({ source: () => Promise.resolve(src.stream) });
    const c = collector();
    cache.listen('hello', c.listener);
    await settle();

    src.push(1);
    await settle();
    expect(c.chunks).toEqual([1]);
    expect(c.ended).toBe(false); // still generating
  });

  it('keeps going for the others when one listener throws', async () => {
    // A listener is a socket, and sockets close mid-sentence.
    const src = controlled();
    const cache = new SpeechCache({ source: () => Promise.resolve(src.stream) });
    cache.listen('hello', {
      onChunk: () => {
        throw new Error('socket closed');
      },
      onEnd: () => {},
    });
    const good = collector();
    cache.listen('hello', good.listener);
    await settle();
    src.push(5);
    src.close();
    await settle();
    expect(good.chunks).toEqual([5]);
    expect(good.ended).toBe(true);
  });

  it('stops feeding a cancelled listener without abandoning the audio', async () => {
    const src = controlled();
    const cache = new SpeechCache({ source: () => Promise.resolve(src.stream) });
    const quitter = collector();
    const cancel = cache.listen('hello', quitter.listener);
    const stayer = collector();
    cache.listen('hello', stayer.listener);
    await settle();

    cancel();
    src.push(9);
    src.close();
    await settle();

    expect(quitter.chunks).toEqual([]);
    // The synthesis was still worth finishing — someone else was mid-playback,
    // and the result is worth keeping for the next shopper either way.
    expect(stayer.chunks).toEqual([9]);
  });
});

describe('what it refuses to remember', () => {
  it('does not cache a failure, so the next attempt can succeed', async () => {
    let calls = 0;
    const cache = new SpeechCache({
      source: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new VoiceError('speech synthesis failed (502)', 502))
          : Promise.resolve(
              new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(new Uint8Array([4]));
                  c.close();
                },
              }),
            );
      },
    });

    const first = collector();
    cache.listen('hello', first.listener);
    await settle();
    expect(first.ended).toBe(true);
    expect(first.err).toBeInstanceOf(VoiceError);

    /**
     * The retry must reach upstream. A cached failure would make one transient
     * 502 mute this exact sentence for every shopper until the entry aged out.
     */
    const second = collector();
    cache.listen('hello', second.listener);
    await settle();
    expect(calls).toBe(2);
    expect(second.chunks).toEqual([4]);
    expect(second.err).toBeUndefined();
  });

  it('carries the upstream status out to the caller', async () => {
    // So an over-long utterance still answers 413 rather than a blanket 502 —
    // the endpoint has no other way to know which it was.
    const cache = new SpeechCache({
      source: () => Promise.reject(new VoiceError('text too long', 413)),
    });
    const c = collector();
    cache.listen('x'.repeat(700), c.listener);
    await settle();
    expect((c.err as VoiceError).status).toBe(413);
  });

  it('forgets an id once it has expired', () => {
    let now = 1000;
    const cache = new SpeechCache({
      source: () => Promise.resolve(new ReadableStream<Uint8Array>({ start: (c) => c.close() })),
      idTtlMs: 500,
      now: () => now,
    });
    const id = cache.announce('hello');
    expect(cache.textForId(id)).toBe('hello');
    now += 501;
    // An id is a capability to replay one sentence; it should not be one forever.
    expect(cache.textForId(id)).toBeUndefined();
  });

  it('treats an unannounced id as unknown rather than as text to speak', () => {
    const cache = new SpeechCache({
      source: () => Promise.resolve(new ReadableStream<Uint8Array>({ start: (c) => c.close() })),
    });
    expect(cache.textForId('00000000000000000000000000000000')).toBeUndefined();
  });

  it('issues unguessable, distinct ids', () => {
    const cache = new SpeechCache({
      source: () => Promise.resolve(new ReadableStream<Uint8Array>({ start: (c) => c.close() })),
    });
    const ids = new Set(Array.from({ length: 50 }, (_, i) => cache.announce(`line ${i}`)));
    expect(ids.size).toBe(50);
    // 128 bits of hex. Sequential ids would let anyone enumerate what other
    // shoppers were told.
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('evicts the least recently used audio once over its byte ceiling', async () => {
    let n = 0;
    const cache = new SpeechCache({
      source: () =>
        Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(100).fill(++n));
              c.close();
            },
          }),
        ),
      maxBytes: 250,
    });

    for (const line of ['one', 'two', 'three']) {
      cache.listen(line, collector().listener);
      await settle();
    }
    // 300 bytes retained against a 250 ceiling, so the oldest goes.
    expect(cache.bytes).toBeLessThanOrEqual(250);

    const misses = cache.stats.misses;
    cache.listen('one', collector().listener);
    await settle();
    expect(cache.stats.misses).toBe(misses + 1); // re-synthesized, as expected

    const hits = cache.stats.hits;
    cache.listen('three', collector().listener);
    await settle();
    expect(cache.stats.hits).toBe(hits + 1); // the newest survived
  });
});
