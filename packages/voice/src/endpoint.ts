/**
 * Endpointing — deciding when the shopper has finished speaking.
 *
 * This single decision dominates how a voice agent *feels*. The naive
 * implementation waits for a fixed silence timeout, which forces a choice
 * between two bad outcomes: a long timeout adds 500–800ms of dead air to every
 * turn, and a short one interrupts anyone who pauses mid-sentence.
 *
 * The way out is to stop treating all silence as equal. 400ms after
 * "how much is the wool coat?" means the shopper is done. The same 400ms after
 * "I'm looking for something warm and" means they are mid-thought and cutting
 * in would be rude and wrong.
 *
 * So the threshold moves with what was actually said.
 */

export interface EndpointInput {
  /** Milliseconds since the last speech energy. */
  readonly silenceMs: number;
  /** Best transcript so far, interim or final. */
  readonly transcript: string;
  /** STT has committed this as final. */
  readonly isFinal?: boolean;
  /** Shopper has said nothing at all yet this turn. */
  readonly hasSpoken?: boolean;
}

export interface EndpointDecision {
  readonly endpoint: boolean;
  /** Silence required before ending the turn, given what was said. */
  readonly thresholdMs: number;
  readonly reason: string;
}

export const THRESHOLDS = {
  /** Terminal punctuation, or a recognisably complete question. */
  complete: 260,
  /** Nothing conclusive either way. */
  base: 550,
  /** Ends mid-thought — a conjunction, article, preposition, or filler. */
  hanging: 1100,
} as const;

/**
 * Words that almost never end an utterance. Ending a turn here interrupts
 * someone who is still assembling their sentence.
 */
const HANGING = new Set([
  'and', 'but', 'or', 'so', 'because', 'if', 'when', 'while', 'that', 'which',
  'the', 'a', 'an', 'my', 'your', 'this', 'these', 'those', 'some', 'any',
  'to', 'for', 'with', 'about', 'from', 'in', 'on', 'at', 'of', 'like',
  'um', 'uh', 'er', 'hmm', 'well', 'maybe', 'actually', 'just', 'is', 'are',
  'was', 'were', 'do', 'does', 'can', 'could', 'would', 'should', 'i', "i'm",
  "it's", 'its', 'you', 'we', 'they', 'he', 'she',
]);

/** Openers that make a short utterance a complete question. */
const QUESTION_OPENERS =
  /^(?:do|does|did|is|are|was|were|can|could|will|would|should|have|has|what|when|where|why|who|which|how)\b/i;

export function decideEndpoint(input: EndpointInput): EndpointDecision {
  const text = input.transcript.trim();

  if (text === '' || input.hasSpoken === false) {
    return { endpoint: false, thresholdMs: THRESHOLDS.base, reason: 'nothing said yet' };
  }

  // STT committing a final transcript is the strongest signal there is.
  if (input.isFinal === true) {
    return { endpoint: true, thresholdMs: 0, reason: 'transcript finalised by STT' };
  }

  const thresholdMs = thresholdFor(text);
  return {
    endpoint: input.silenceMs >= thresholdMs,
    thresholdMs,
    reason: reasonFor(text, thresholdMs),
  };
}

export function thresholdFor(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return THRESHOLDS.base;

  const lastWord = (/([a-z']+)[^a-z']*$/i.exec(trimmed)?.[1] ?? '').toLowerCase();
  if (HANGING.has(lastWord)) return THRESHOLDS.hanging;

  // Explicit terminal punctuation — STT emits it when confident.
  if (/[.!?]$/.test(trimmed)) return THRESHOLDS.complete;

  // A well-formed question needs no punctuation to be obviously finished.
  const words = trimmed.split(/\s+/);
  if (QUESTION_OPENERS.test(trimmed) && words.length >= 3) return THRESHOLDS.complete;

  return THRESHOLDS.base;
}

function reasonFor(text: string, thresholdMs: number): string {
  switch (thresholdMs) {
    case THRESHOLDS.complete:
      return 'utterance looks complete';
    case THRESHOLDS.hanging:
      return 'ends mid-thought, waiting longer';
    default:
      return 'no strong signal either way';
  }
}

/**
 * Speculative-start decision.
 *
 * The single biggest latency win available: begin generating on the interim
 * transcript instead of waiting for the endpoint. If the final transcript turns
 * out to differ materially, throw the work away and restart — that costs one
 * wasted request and buys ~150ms on every turn where it holds.
 */
export function shouldSpeculate(input: EndpointInput): boolean {
  const text = input.transcript.trim();
  if (text.split(/\s+/).length < 3) return false; // too little to act on
  const lastWord = (/([a-z']+)[^a-z']*$/i.exec(text)?.[1] ?? '').toLowerCase();
  if (HANGING.has(lastWord)) return false; // clearly still talking
  return input.silenceMs >= 120;
}

/**
 * Did the finalised transcript diverge enough to discard speculative work?
 *
 * Tolerant on purpose: STT routinely tidies punctuation and casing between
 * interim and final, and restarting over "coat" → "coat." would throw away the
 * entire benefit.
 */
export function speculationStillValid(interim: string, final: string): boolean {
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);

  const a = norm(interim);
  const b = norm(final);
  if (a.length === 0) return false;

  // The interim must be a prefix of the final, give or take a trailing word
  // that STT revised.
  const compare = Math.min(a.length, b.length);
  let matching = 0;
  for (let i = 0; i < compare; i++) if (a[i] === b[i]) matching++;
  return matching / Math.max(a.length, b.length) >= 0.8;
}
