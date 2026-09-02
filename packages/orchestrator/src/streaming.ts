/**
 * Streaming primitives.
 *
 * ## The problem
 *
 * Our answers are structured output — `{"reply": "...", "claims": [...]}` — so
 * the model streams JSON, not prose. Rendering deltas naively shows the shopper
 * `{"reply":"The Mer`. Waiting for valid JSON before rendering anything throws
 * away the entire time-to-first-token budget.
 *
 * ## The resolution
 *
 * `reply` is deliberately the FIRST property in the schema, so its characters
 * arrive first. `ReplyExtractor` pulls that string value out of a growing,
 * still-invalid JSON buffer and emits decoded prose incrementally — correct
 * across chunk boundaries, including a chunk that ends mid-escape-sequence.
 *
 * The rest of the payload (`claims`) arrives after and is parsed normally for
 * grounding validation.
 */

type State = 'seeking_key' | 'seeking_colon' | 'seeking_open_quote' | 'in_string' | 'done';

const KEY = '"reply"';

/**
 * Incrementally extracts the `reply` string from a partial JSON document.
 *
 * Feed it raw chunks; it returns only the newly decoded characters, so callers
 * can append straight to the UI.
 */
export class ReplyExtractor {
  private buf = '';
  private state: State = 'seeking_key';
  private cursor = 0;
  /** Set when a chunk ends on a lone backslash — resolve it next chunk. */
  private pendingEscape = false;

  get finished(): boolean {
    return this.state === 'done';
  }

  push(chunk: string): string {
    this.buf += chunk;
    let out = '';

    // Non-string states operate on the raw buffer and can be re-scanned safely.
    if (this.state === 'seeking_key') {
      const i = this.buf.indexOf(KEY, this.cursor);
      if (i === -1) {
        // Keep a tail long enough to match the key across a chunk boundary.
        this.cursor = Math.max(0, this.buf.length - KEY.length);
        return '';
      }
      this.cursor = i + KEY.length;
      this.state = 'seeking_colon';
    }

    if (this.state === 'seeking_colon') {
      while (this.cursor < this.buf.length && /\s/.test(this.buf[this.cursor]!)) this.cursor++;
      if (this.cursor >= this.buf.length) return '';
      if (this.buf[this.cursor] !== ':') {
        // Not the key we wanted (e.g. a nested "reply" inside a string) — resume.
        this.state = 'seeking_key';
        return '';
      }
      this.cursor++;
      this.state = 'seeking_open_quote';
    }

    if (this.state === 'seeking_open_quote') {
      while (this.cursor < this.buf.length && /\s/.test(this.buf[this.cursor]!)) this.cursor++;
      if (this.cursor >= this.buf.length) return '';
      if (this.buf[this.cursor] !== '"') {
        this.state = 'seeking_key';
        return '';
      }
      this.cursor++;
      this.state = 'in_string';
    }

    if (this.state === 'in_string') {
      while (this.cursor < this.buf.length) {
        const ch = this.buf[this.cursor]!;

        if (this.pendingEscape) {
          const decoded = decodeEscape(this.buf, this.cursor);
          if (decoded === undefined) return out; // \uXXXX split across chunks
          out += decoded.text;
          this.cursor += decoded.consumed;
          this.pendingEscape = false;
          continue;
        }

        if (ch === '\\') {
          this.cursor++;
          if (this.cursor >= this.buf.length) {
            // Chunk ended on a lone backslash — wait for the escape body.
            this.pendingEscape = true;
            return out;
          }
          const decoded = decodeEscape(this.buf, this.cursor);
          if (decoded === undefined) {
            this.pendingEscape = true;
            return out;
          }
          out += decoded.text;
          this.cursor += decoded.consumed;
          continue;
        }

        if (ch === '"') {
          this.state = 'done';
          this.cursor++;
          return out;
        }

        out += ch;
        this.cursor++;
      }
    }

    return out;
  }
}

/** Decode one escape body at `i` (the char AFTER the backslash). */
function decodeEscape(buf: string, i: number): { text: string; consumed: number } | undefined {
  const c = buf[i];
  if (c === undefined) return undefined;
  switch (c) {
    case 'n':
      return { text: '\n', consumed: 1 };
    case 't':
      return { text: '\t', consumed: 1 };
    case 'r':
      return { text: '\r', consumed: 1 };
    case 'b':
      return { text: '\b', consumed: 1 };
    case 'f':
      return { text: '\f', consumed: 1 };
    case '"':
      return { text: '"', consumed: 1 };
    case '\\':
      return { text: '\\', consumed: 1 };
    case '/':
      return { text: '/', consumed: 1 };
    case 'u': {
      if (i + 4 >= buf.length) return undefined; // split across chunks
      const hex = buf.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { text: '', consumed: 5 };
      return { text: String.fromCharCode(Number.parseInt(hex, 16)), consumed: 5 };
    }
    default:
      return { text: c, consumed: 1 };
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Incremental SSE parser. Handles records split across network chunks, which
 * naive `split('\n\n')` on each chunk gets wrong.
 */
export class SseParser {
  private buf = '';

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];

    let idx: number;
    while ((idx = indexOfRecordEnd(this.buf)) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^(?:\r?\n){2}/, '');

      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue; // comment / heartbeat
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length > 0) out.push({ event, data: dataLines.join('\n') });
    }
    return out;
  }
}

function indexOfRecordEnd(s: string): number {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}
