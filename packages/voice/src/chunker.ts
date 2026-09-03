/**
 * Speech chunking.
 *
 * The seam between grounding and audio.
 *
 * The orchestrator already emits *settled* text — prose that has passed the
 * mid-stream grounding tripwire and can no longer change. That output is
 * exactly what is safe to speak, which is why the voice pipeline reuses the
 * text stack unchanged rather than adopting a speech-to-speech model: audio
 * cannot be retracted, so nothing unvalidated may ever reach the speaker.
 *
 * This class turns that trickle of validated text into utterances a TTS engine
 * can voice naturally. Two failure modes it exists to avoid:
 *
 *   - **Speaking fragments.** Sending every delta to TTS produces robotic,
 *     disjointed audio with no sentence prosody. TTS needs whole clauses.
 *   - **Never speaking.** Waiting strictly for a full stop means a long clause
 *     with no terminal punctuation stalls the audio indefinitely. So there is
 *     a soft-boundary escape hatch.
 */

export interface ChunkerOptions {
  /** Emit at a soft boundary once the buffer exceeds this. */
  readonly maxChars?: number;
  /** Never emit a chunk shorter than this unless flushing. */
  readonly minChars?: number;
}

const DEFAULTS = { maxChars: 180, minChars: 2 } as const;

/**
 * Abbreviations whose trailing dot is not a sentence end. Without these,
 * "approx. 3 days" is spoken as two sentences with a hard stop mid-phrase.
 */
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'mt', 'no', 'vs', 'etc', 'inc', 'ltd', 'co',
  'approx', 'est', 'dept', 'fig', 'al', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'e.g', 'i.e', 'a.m', 'p.m',
];

export class SpeechChunker {
  private buffer = '';
  private readonly maxChars: number;
  private readonly minChars: number;

  constructor(opts: ChunkerOptions = {}) {
    this.maxChars = opts.maxChars ?? DEFAULTS.maxChars;
    this.minChars = opts.minChars ?? DEFAULTS.minChars;
  }

  /** Feed validated text; get back complete utterances ready to speak. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];

    for (;;) {
      const cut = this.findBoundary();
      if (cut === -1) break;
      const chunk = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (chunk.length > 0) out.push(chunk);
    }
    return out;
  }

  /** Remaining text at end of stream. Call once the model is done. */
  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest === '' ? undefined : rest;
  }

  /** Discard everything unspoken — used on barge-in. */
  reset(): void {
    this.buffer = '';
  }

  get pending(): string {
    return this.buffer;
  }

  /**
   * Index just past a usable break, or -1.
   *
   * Prefers a real sentence end; falls back to a clause boundary only once the
   * buffer is long enough that waiting would be audible as silence.
   */
  private findBoundary(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i]!;
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;

      // Consume any run of terminals plus a closing quote/bracket: `?!"` .
      let end = i;
      while (end + 1 < this.buffer.length && '.!?'.includes(this.buffer[end + 1]!)) end++;
      if (end + 1 < this.buffer.length && `"'”’)`.includes(this.buffer[end + 1]!)) end++;

      const next = this.buffer[end + 1];
      // A terminal at the very end of the buffer may still be mid-token
      // ("$189." could become "$189.00"), so wait for the following character.
      if (next === undefined) continue;
      if (!/\s/.test(next)) continue;

      if (ch === '.' && this.isNotASentenceEnd(i)) continue;

      // A chunk below the minimum is not worth its own utterance — a lone
      // "Ok." gets a full stop's worth of pause and sounds clipped. Skip this
      // boundary and let it ride along with the next sentence.
      const cut = end + 2; // the terminal plus the following space
      if (this.buffer.slice(0, cut).trim().length < this.minChars) {
        i = end;
        continue;
      }
      return cut;
    }

    if (this.buffer.length >= this.maxChars) {
      const soft = this.findSoftBoundary();
      if (soft !== -1) return soft;
    }
    return -1;
  }

  /** True when a '.' at `i` is a decimal point or an abbreviation. */
  private isNotASentenceEnd(i: number): boolean {
    // Decimal: digit on both sides — "$189.00", "3.5 days".
    const prev = this.buffer[i - 1];
    const next = this.buffer[i + 1];
    if (prev !== undefined && next !== undefined && /\d/.test(prev) && /\d/.test(next)) return true;

    // Abbreviation: the word immediately before the dot.
    const before = this.buffer.slice(0, i).toLowerCase();
    const m = /([a-z.]+)$/.exec(before);
    if (m && ABBREVIATIONS.includes(m[1]!)) return true;

    // Single initial: "J. Crew".
    if (m && m[1]!.length === 1) return true;

    return false;
  }

  /** Latest comma/semicolon/dash within the window, else the last space. */
  private findSoftBoundary(): number {
    const window = this.buffer.slice(0, this.maxChars);
    const clause = Math.max(
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
      window.lastIndexOf(' — '),
      window.lastIndexOf(': '),
    );
    if (clause > this.minChars) return clause + 2;
    const space = window.lastIndexOf(' ');
    return space > this.minChars ? space + 1 : -1;
  }
}
