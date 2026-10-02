/**
 * Which speech model to try first for a shop, decided by its recent hit rate.
 *
 * ## Why not the circuit breaker
 *
 * This was first built on `CircuitBreaker`, and it did not fire once in live use.
 * A breaker opens on CONSECUTIVE failures, and this failure is not consecutive —
 * it is intermittent. Measured on the dev store across two sessions:
 *
 *     stt: gpt-4o-transcribe → "Arabic"      → rescued by whisper-1
 *     stt: gpt-4o-transcribe → fine
 *     stt: gpt-4o-transcribe → "Devanagari"  → rescued by whisper-1
 *
 * Roughly two turns in five come back in a script nobody asked for, and the good
 * turn in the middle reset the counter every time. A speaker the primary model
 * half-understands is exactly the case worth switching on, and a breaker is
 * structurally blind to it.
 *
 * So this counts over a window instead: of the last N turns, how many came back in
 * the wrong script. Two in five is not bad luck, it is this person's accent, or
 * their room, or their microphone — and `whisper-1` is already the model being
 * believed on those turns, after the shopper has waited for both.
 *
 * ## Why it stays reversible
 *
 * `gpt-4o-transcribe` is better on shop vocabulary where it works, so a shop it
 * suits must keep it. The window only ever holds the last N outcomes, so a store
 * that improves — a quieter room, a better mic — drifts back on its own without
 * anything being reset by hand.
 */

export interface SttPreferenceOptions {
  /** How many recent turns to judge on. */
  readonly window?: number;
  /** Mismatches within that window before the acoustic model goes first. */
  readonly trigger?: number;
  /** Cap on tracked shops, so this cannot grow with install count. */
  readonly maxShops?: number;
}

export class SttPreference {
  /** Per shop, newest last: `true` for a language mismatch. */
  private readonly recent = new Map<string, boolean[]>();
  private readonly window: number;
  private readonly trigger: number;
  private readonly maxShops: number;

  constructor(opts: SttPreferenceOptions = {}) {
    this.window = opts.window ?? 5;
    /**
     * Two in five, not one. A single mismatch is a bad second of audio — a door,
     * a cough, a word half-said — and switching on it would move stores the
     * primary serves well onto the acoustic model for one unlucky turn.
     */
    this.trigger = opts.trigger ?? 2;
    this.maxShops = opts.maxShops ?? 512;
  }

  /** Should the primary model go first for this shop? */
  primaryFirst(shop: string): boolean {
    const seen = this.recent.get(shop);
    if (seen === undefined) return true;
    return seen.filter(Boolean).length < this.trigger;
  }

  /** Record how a turn was decoded. Only these two outcomes carry information. */
  record(shop: string, outcome: 'mismatch' | 'ok'): void {
    const seen = this.recent.get(shop) ?? [];
    seen.push(outcome === 'mismatch');
    while (seen.length > this.window) seen.shift();
    this.recent.set(shop, seen);

    if (this.recent.size > this.maxShops) {
      // Oldest insertion first; a Map preserves it, and a shop that has not been
      // heard from in a long time is the cheapest one to forget.
      const oldest = this.recent.keys().next();
      if (!oldest.done) this.recent.delete(oldest.value);
    }
  }

  /** For logs and tests: how this shop currently looks. */
  stateOf(shop: string): { mismatches: number; of: number } {
    const seen = this.recent.get(shop) ?? [];
    return { mismatches: seen.filter(Boolean).length, of: seen.length };
  }
}
