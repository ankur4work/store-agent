/**
 * Synthesized speech, shared between the turn that produced the words and the
 * request that plays them.
 *
 * ## Why this exists
 *
 * Measured against production, a voice answer took 2352 ms to become audible and
 * **1866 ms of that — 79% — was TTS**, after the page-fact lane had already cut
 * the model down to 486 ms. Three separate things were responsible, and this file
 * addresses all three:
 *
 * 1. **Nothing streamed.** `synthesize` buffered the whole upstream response with
 *    `res.arrayBuffer()`, the gateway sent it with a `content-length`, and the
 *    widget then did `await r.blob()`. Audio existed on the server long before a
 *    single sample reached a speaker.
 * 2. **The format could not stream even in principle.** `opus` was chosen in a
 *    comment claiming it had "the lowest time-to-first-audio of the streaming
 *    formats". Measured, it is the worst: first byte at 2112 ms against 760 ms
 *    for `pcm`, because the encoder cannot emit until it has buffered.
 * 3. **Synthesis started late.** The widget only asked for audio once it had
 *    received the `speak` event, so generation began after the text was already
 *    on screen, and the two never overlapped.
 *
 * So: the gateway starts synthesis the moment an utterance is settled, streams
 * the bytes to whoever is listening as they arrive, and keeps the result for the
 * next shopper who is told the same thing.
 *
 * ## Why one entry can have several listeners
 *
 * The turn announces an utterance and the widget fetches it a few tens of
 * milliseconds later — two arrivals for one synthesis, the second of which must
 * not start another. And because this is a shop, *different* shoppers are told
 * the same sentence constantly: "It's $699.95." is the same string for everyone
 * on that product page, and the deterministic lane makes it character-identical
 * rather than merely similar. A late listener replays the chunks already received
 * and then follows the live ones, so it is progressive whether it arrives first,
 * halfway through, or after the audio is complete.
 *
 * ## What is deliberately not here
 *
 * No disk, and no sharing between processes. The deployment is a single node (see
 * DEPLOY.md §"One node only"), the entries are small and regenerable, and a cache
 * that outlives the process would need invalidating when the voice or model
 * changes. Losing it on restart costs one slow sentence.
 */

/** Begin synthesis. Resolves once bytes are flowing, not once they are complete. */
export type SpeechSource = (text: string) => Promise<ReadableStream<Uint8Array>>;

export interface SpeechListener {
  onChunk(chunk: Uint8Array): void;
  /** Called exactly once. `err` is set only when synthesis failed outright. */
  onEnd(err?: Error): void;
}

interface Entry {
  /** Everything received so far, kept so a late listener can catch up. */
  readonly chunks: Uint8Array[];
  bytes: number;
  done: boolean;
  failed?: Error;
  readonly listeners: Set<SpeechListener>;
  lastUsed: number;
}

export interface SpeechCacheOptions {
  readonly source: SpeechSource;
  /**
   * Ceiling on retained audio.
   *
   * 8 MB is roughly 50 short utterances as 24 kHz mono PCM, which is far more
   * distinct sentences than a storefront assistant produces — the deterministic
   * answers repeat, and the model's are capped at 600 characters.
   */
  readonly maxBytes?: number;
  /**
   * How long an announced id stays fetchable.
   *
   * It only has to outlive the gap between the `speak` event and the widget
   * asking for the audio, plus any queueing behind an utterance still playing.
   * Two minutes is generous for that and short enough that ids do not accumulate.
   */
  readonly idTtlMs?: number;
  readonly now?: () => number;
  readonly log?: { warn(event: string, fields?: Record<string, unknown>): void };
}

export interface SpeechStats {
  /** Synthesis actually started — a listener had to wait for upstream. */
  misses: number;
  /** Served from audio already complete in memory. */
  hits: number;
  /** Joined a synthesis already running, started by the prewarm or another shopper. */
  joins: number;
}

export class SpeechCache {
  private readonly entries = new Map<string, Entry>();
  /**
   * Announced ids, each pointing at the text it was announced for.
   *
   * The id exists so the browser can fetch audio with a **GET** — which is what
   * lets the media element stream it progressively — without the reply text
   * travelling in a URL. That matters here: this project never logs shopper
   * speech, and a querystring is the one place text leaks into an access log at
   * the proxy, outside the logger's reach. An opaque 128-bit id keeps the GET and
   * loses the text.
   */
  private readonly ids = new Map<string, { readonly key: string; readonly expires: number }>();
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly idTtlMs: number;
  private readonly now: () => number;
  readonly stats: SpeechStats = { misses: 0, hits: 0, joins: 0 };

  constructor(private readonly opts: SpeechCacheOptions) {
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    this.idTtlMs = opts.idTtlMs ?? 120_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The cache key for an utterance.
   *
   * The text alone, because voice, model and speed are fixed for the life of the
   * process — they come from config at boot. If they ever become per-shop this
   * has to take them too, or one merchant's voice will answer in another's.
   */
  private static keyFor(text: string): string {
    return text.trim();
  }

  /**
   * Announce an utterance that is about to be spoken, and start making it.
   *
   * Called at the moment the text is settled, which is the whole point: the
   * upstream round trip then overlaps the SSE delivery, the widget's own request,
   * and anything still playing ahead of it in the queue.
   */
  announce(text: string): string {
    const key = SpeechCache.keyFor(text);
    const id = randomId();
    this.ids.set(id, { key, expires: this.now() + this.idTtlMs });
    this.sweepIds();
    // Start now, listener or not. An utterance queued behind another one still
    // benefits, and a shopper who closes the panel costs us one synthesis.
    this.begin(key);
    return id;
  }

  /** The utterance an announced id refers to, if it has not expired. */
  textForId(id: string): string | undefined {
    const found = this.ids.get(id);
    if (found === undefined) return undefined;
    if (found.expires <= this.now()) {
      this.ids.delete(id);
      return undefined;
    }
    return found.key;
  }

  /**
   * Listen to the audio for an utterance, from the beginning.
   *
   * Returns a cancel function. Cancelling only detaches this listener — the
   * synthesis continues, because another listener may be mid-playback and the
   * result is worth keeping either way.
   */
  listen(text: string, listener: SpeechListener): () => void {
    const key = SpeechCache.keyFor(text);
    const entry = this.begin(key);
    entry.lastUsed = this.now();

    if (entry.done && entry.failed === undefined) this.stats.hits++;
    else if (entry.chunks.length > 0 || !entry.done) this.stats.joins++;

    /**
     * Replay synchronously, before returning.
     *
     * A listener that arrives after the audio is complete must still receive all
     * of it, and one that arrives halfway must not miss the first half — which is
     * the ordinary case, since the prewarm starts before anyone is listening.
     */
    for (const chunk of entry.chunks) listener.onChunk(chunk);
    if (entry.done) {
      listener.onEnd(entry.failed);
      return () => {};
    }
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /** Start synthesis for a key if it is not already running or finished. */
  private begin(key: string): Entry {
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;

    const entry: Entry = {
      chunks: [],
      bytes: 0,
      done: false,
      listeners: new Set(),
      lastUsed: this.now(),
    };
    this.entries.set(key, entry);
    this.stats.misses++;

    void this.pump(key, entry);
    return entry;
  }

  private async pump(key: string, entry: Entry): Promise<void> {
    try {
      const stream = await this.opts.source(key);
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value === undefined || value.length === 0) continue;
        entry.chunks.push(value);
        entry.bytes += value.length;
        this.totalBytes += value.length;
        for (const l of entry.listeners) {
          // One listener's failure — a closed socket, usually — must not stop
          // the others or abandon the cache entry mid-way.
          try {
            l.onChunk(value);
          } catch {
            entry.listeners.delete(l);
          }
        }
      }
      entry.done = true;
      this.finish(entry);
      this.evict();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      entry.done = true;
      entry.failed = error;
      this.opts.log?.warn('speech_synthesis_failed', { reason: error.message });
      /**
       * A failure is not cached. The next attempt must be allowed to reach
       * upstream — the common causes are transient, and a cached failure would
       * make one bad second silence the same sentence for as long as the entry
       * lived.
       */
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      this.finish(entry);
    }
  }

  private finish(entry: Entry): void {
    for (const l of entry.listeners) {
      try {
        l.onEnd(entry.failed);
      } catch {
        // Nothing left to do for a listener that throws on completion.
      }
    }
    entry.listeners.clear();
  }

  /** Drop the least recently used finished entries until back under the cap. */
  private evict(): void {
    if (this.totalBytes <= this.maxBytes) return;
    const done = [...this.entries]
      .filter(([, e]) => e.done && e.listeners.size === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, e] of done) {
      if (this.totalBytes <= this.maxBytes) break;
      this.entries.delete(key);
      this.totalBytes -= e.bytes;
    }
  }

  private sweepIds(): void {
    if (this.ids.size < 256) return;
    const now = this.now();
    for (const [id, v] of this.ids) if (v.expires <= now) this.ids.delete(id);
  }

  /** For tests and `/metrics`. */
  get bytes(): number {
    return this.totalBytes;
  }
}

/**
 * 128 bits from the platform CSPRNG.
 *
 * Unguessable rather than merely unique: an id is a capability to fetch one
 * synthesized sentence, and sequential ids would let anyone enumerate what other
 * shoppers were told.
 */
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
