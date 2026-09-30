/**
 * Scoring a transcript against what was actually said.
 *
 * ## Why this exists
 *
 * "Improve listen quality" was not a falsifiable claim about this app. Every
 * voice fix so far — the container relabelling, the PCM re-encode, dropping the
 * decoder prompt, the language-mismatch refusal — was justified by a single
 * observed failure and verified by trying it again by hand. That is how the
 * fabrication bugs were found, and it is also why nobody can say whether the
 * fixes made recognition *better* or only made one sentence work.
 *
 * So: word error rate, measured over a fixed set of clips, before and after.
 *
 * ## Two different questions, two different numbers
 *
 * A recogniser can fail in two ways that pull in opposite directions, and one
 * number cannot express both:
 *
 *   1. **It mishears.** "wool coat" → "wolf boat". Measured as WER.
 *   2. **It invents.** Handed silence, `gpt-4o-transcribe` does not return
 *      nothing — it writes a fluent sentence, sometimes in a language nobody
 *      in the conversation speaks. `voice/service.ts` exists largely to catch
 *      this. Measured as the fabrication rate on clips whose correct answer
 *      is the empty string.
 *
 * Tuning for (1) alone makes (2) worse: anything that encourages the decoder
 * to commit to a guess also encourages it to guess at noise. A change is only
 * an improvement if both numbers move the right way, which is why
 * `aggregate()` reports them side by side and never blends them.
 *
 * ## Normalisation, and what it deliberately does not do
 *
 * Case and punctuation are not listening errors — the model downstream reads
 * "how much is the wool coat" and "How much is the wool coat?" identically. So
 * they are normalised away.
 *
 * Numbers are NOT normalised. There is no honest way to decide whether "$50"
 * and "fifty dollars" are the same transcript without building a
 * number-to-words map per language, and a half-built one would quietly score
 * a Hindi clip as a total failure. Fixture references are therefore authored
 * with numbers spelled out, which is also how a shopper says them out loud.
 */

/**
 * Words for comparison: lowercased, punctuation stripped, whitespace collapsed.
 *
 * Intra-word apostrophes and hyphens survive, because "don't" and "open-toe"
 * are single words to a shopper and splitting them would invent two errors out
 * of one correct transcription.
 */
export function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    // Keep letters, digits, marks (Devanagari vowel signs are marks, not
    // letters — dropping them would mangle every Hindi reference), and the two
    // intra-word joiners.
    .replace(/[^\p{L}\p{N}\p{M}'-]+/gu, ' ')
    // A leading or trailing joiner is punctuation wearing a letter's clothes:
    // "coat -" must not become the two-character word "-".
    .replace(/(?<![\p{L}\p{N}\p{M}])['-]+|['-]+(?![\p{L}\p{N}\p{M}])/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
}

export interface ErrorCounts {
  readonly substitutions: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface TranscriptScore extends ErrorCounts {
  /** Words in the reference. Zero for a silence clip. */
  readonly referenceWords: number;
  /** Words the recogniser produced. */
  readonly hypothesisWords: number;
  /** errors / max(1, referenceWords). 0 when both sides are empty. */
  readonly wer: number;
  /**
   * The reference was silence and the recogniser produced words anyway.
   *
   * Tracked separately from WER because it is a different defect with a
   * different fix — and because dividing by an empty reference produces a
   * number that looks like a rate and is not one.
   */
  readonly fabricated: boolean;
}

/**
 * Word-level edit distance, with the three error kinds kept apart.
 *
 * Full DP table rather than the two-row trick: utterances here are a dozen
 * words, the table is free at that size, and keeping it lets the backtrace
 * separate a substitution from an insertion-plus-deletion. Those have
 * different causes — a substitution is mishearing, a run of insertions is the
 * decoder padding — and collapsing them would hide the distinction this whole
 * module exists to make.
 */
export function scoreTranscript(reference: string, hypothesis: string): TranscriptScore {
  const ref = normaliseWords(reference);
  const hyp = normaliseWords(hypothesis);

  const counts = editCounts(ref, hyp);
  const errors = counts.substitutions + counts.insertions + counts.deletions;

  return {
    ...counts,
    referenceWords: ref.length,
    hypothesisWords: hyp.length,
    // max(1, …) rather than a guard clause: a silence clip with 3 invented
    // words scores 3.0, which is nonsense as a *rate* but correct as an
    // ordering — more invention is worse. `aggregate` never sums these
    // per-clip rates, it sums the raw errors, so the nonsense stays local.
    wer: ref.length === 0 && hyp.length === 0 ? 0 : errors / Math.max(1, ref.length),
    fabricated: ref.length === 0 && hyp.length > 0,
  };
}

function editCounts(ref: readonly string[], hyp: readonly string[]): ErrorCounts {
  const n = ref.length;
  const m = hyp.length;

  // cost[i][j] = cheapest edit distance between ref[0..i) and hyp[0..j)
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) cost[i]![0] = i;
  for (let j = 0; j <= m; j++) cost[0]![j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const match = ref[i - 1] === hyp[j - 1];
      cost[i]![j] = Math.min(
        cost[i - 1]![j - 1]! + (match ? 0 : 1), // substitute (or free match)
        cost[i - 1]![j]! + 1, // delete a reference word (recogniser missed it)
        cost[i]![j - 1]! + 1, // insert a hypothesis word (recogniser added it)
      );
    }
  }

  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const match = ref[i - 1] === hyp[j - 1];
      if (cost[i]![j] === cost[i - 1]![j - 1]! + (match ? 0 : 1)) {
        if (!match) substitutions++;
        i--;
        j--;
        continue;
      }
    }
    // Prefer deletions before insertions when both are available, so the
    // backtrace is deterministic. The totals are identical either way; a
    // stable split keeps a regression report from churning between runs.
    if (i > 0 && cost[i]![j] === cost[i - 1]![j]! + 1) {
      deletions++;
      i--;
      continue;
    }
    insertions++;
    j--;
  }

  return { substitutions, insertions, deletions };
}

export interface ClipResult {
  readonly id: string;
  /** What was said. Empty string for a silence or noise clip. */
  readonly reference: string;
  readonly score: TranscriptScore;
  /** Milliseconds from upload start to transcript in hand. */
  readonly latencyMs: number;
  /** The clip produced no transcript at all. */
  readonly empty: boolean;
}

export interface Aggregate {
  readonly clips: number;
  /**
   * Corpus WER: total errors over total reference words.
   *
   * NOT the mean of per-clip WER. Averaging rates weights a three-word clip
   * the same as a twenty-word one, so one short misheard utterance can move
   * the headline number by ten points and a real regression on long speech
   * can hide behind it.
   */
  readonly wer: number;
  readonly referenceWords: number;
  readonly substitutions: number;
  readonly insertions: number;
  readonly deletions: number;
  /** Clips whose reference was speech but which came back empty. */
  readonly missed: number;
  /** Clips whose reference was silence but which came back with words. */
  readonly fabricated: number;
  /** Silence clips in the set. The denominator for `fabricated`. */
  readonly silenceClips: number;
  readonly latencyP50Ms: number | undefined;
  readonly latencyP95Ms: number | undefined;
}

export function aggregate(results: readonly ClipResult[]): Aggregate {
  let referenceWords = 0;
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let missed = 0;
  let fabricated = 0;
  let silenceClips = 0;

  for (const r of results) {
    // Silence clips are excluded from the WER numerator AND denominator. Their
    // reference has no words, so every invented word would be an insertion
    // against a zero denominator — it would make corpus WER a function of how
    // many silence clips are in the set rather than of how well we hear.
    if (r.score.referenceWords === 0) {
      silenceClips++;
      if (r.score.fabricated) fabricated++;
      continue;
    }
    referenceWords += r.score.referenceWords;
    substitutions += r.score.substitutions;
    insertions += r.score.insertions;
    deletions += r.score.deletions;
    if (r.empty) missed++;
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    clips: results.length,
    wer:
      referenceWords === 0
        ? 0
        : (substitutions + insertions + deletions) / referenceWords,
    referenceWords,
    substitutions,
    insertions,
    deletions,
    missed,
    fabricated,
    silenceClips,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

/**
 * Nearest-rank percentile over the exact samples.
 *
 * Deliberately not the bucketed-histogram estimate used in `/metrics`: here we
 * hold every measurement in memory, so there is no reason to approximate, and
 * the gate for Level 1 is a comparison of two p95 numbers that need to be
 * exact enough to trust a 25% claim.
 */
export function percentile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}
