import { describe, expect, it, vi } from 'vitest';
import { SpeechChunker } from '../src/chunker.js';
import {
  THRESHOLDS,
  decideEndpoint,
  shouldSpeculate,
  speculationStillValid,
  thresholdFor,
} from '../src/endpoint.js';
import { VoiceSession } from '../src/session.js';

/**
 * The chunker is the seam between grounding and audio. It only ever receives
 * text the tripwire has already validated — its job is to voice that naturally
 * without ever stalling.
 */
describe('SpeechChunker', () => {
  it('emits a complete sentence', () => {
    const c = new SpeechChunker();
    expect(c.push('The coat is warm. ')).toEqual(['The coat is warm.']);
  });

  it('holds a fragment until it terminates', () => {
    const c = new SpeechChunker();
    expect(c.push('The coat is ')).toEqual([]);
    expect(c.push('warm. ')).toEqual(['The coat is warm.']);
  });

  it('emits several sentences at once', () => {
    const c = new SpeechChunker();
    expect(c.push('One. Two. Three. ')).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('survives being fed one character at a time', () => {
    const c = new SpeechChunker();
    const out: string[] = [];
    for (const ch of 'Yes, we do. It is warm. ') out.push(...c.push(ch));
    expect(out).toEqual(['Yes, we do.', 'It is warm.']);
  });

  it('does NOT split a price mid-number', () => {
    // "$189." must never be spoken as a sentence — the "00" is still coming.
    const c = new SpeechChunker();
    expect(c.push('It costs $189.')).toEqual([]);
    expect(c.push('00 today. ')).toEqual(['It costs $189.00 today.']);
  });

  it('does not split on a decimal that is already complete', () => {
    const c = new SpeechChunker();
    expect(c.push('Rated 4.6 by shoppers. ')).toEqual(['Rated 4.6 by shoppers.']);
  });

  it.each([
    'Ships in approx. 3 days. ',
    'See fig. 2 for sizing. ',
    'Delivered by 5 p.m. tomorrow. ',
    'Contact Dr. Chen for details. ',
  ])('does not split on an abbreviation: %s', (text) => {
    const c = new SpeechChunker();
    expect(c.push(text)).toHaveLength(1);
  });

  it('handles a question and an exclamation', () => {
    const c = new SpeechChunker();
    expect(c.push('Want it? Great! ')).toEqual(['Want it?', 'Great!']);
  });

  it('keeps a closing quote with its sentence', () => {
    const c = new SpeechChunker();
    expect(c.push('She said "yes." Then left. ')).toEqual(['She said "yes."', 'Then left.']);
  });

  it('emits at a clause boundary rather than stalling on a long run', () => {
    // Without this the audio waits indefinitely for a full stop that may not
    // arrive, and the shopper hears silence.
    const c = new SpeechChunker({ maxChars: 60 });
    const long = 'we have wool coats, cashmere scarves, leather gloves and a rain shell in stock ';
    const out = c.push(long);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.length).toBeLessThanOrEqual(60);
  });

  it('flushes the tail at end of stream', () => {
    const c = new SpeechChunker();
    c.push('No terminal punctuation here');
    expect(c.flush()).toBe('No terminal punctuation here');
  });

  it('flushes to undefined when nothing is pending', () => {
    expect(new SpeechChunker().flush()).toBeUndefined();
  });

  it('discards unspoken text on barge-in', () => {
    const c = new SpeechChunker();
    c.push('Half a sentence');
    c.reset();
    expect(c.flush()).toBeUndefined();
  });

  it('never emits a lone fragment shorter than the minimum', () => {
    const c = new SpeechChunker({ minChars: 4 });
    expect(c.push('Ok. ')).toEqual([]);
    expect(c.push('It is warm. ')).toEqual(['Ok. It is warm.']);
  });

  it('waits for the character after a terminal before committing', () => {
    // A '.' at the very end of the buffer may still be mid-token.
    const c = new SpeechChunker();
    expect(c.push('Done.')).toEqual([]);
    expect(c.push(' ')).toEqual(['Done.']);
  });
});

/**
 * Endpointing decides how a voice agent *feels*. A fixed silence timeout forces
 * a choice between dead air and interrupting people mid-sentence.
 */
describe('endpointing', () => {
  it.each([
    'how much is the wool coat?',
    'do you have this in medium?',
    'what is your return policy?',
  ])('ends a turn fast on a complete question: %s', (t) => {
    expect(thresholdFor(t)).toBe(THRESHOLDS.complete);
  });

  it.each([
    "I'm looking for something warm and",
    'do you have anything in',
    'I want the one with the',
    'um',
  ])('waits longer mid-thought: %s', (t) => {
    // Cutting in here interrupts someone still assembling their sentence.
    expect(thresholdFor(t)).toBe(THRESHOLDS.hanging);
  });

  it('falls back to the base threshold with no strong signal', () => {
    expect(thresholdFor('wool coat medium')).toBe(THRESHOLDS.base);
  });

  it('does not end a turn before the threshold', () => {
    const d = decideEndpoint({ silenceMs: 200, transcript: 'wool coat medium' });
    expect(d.endpoint).toBe(false);
  });

  it('ends a turn once silence passes the threshold', () => {
    expect(decideEndpoint({ silenceMs: 600, transcript: 'wool coat medium' }).endpoint).toBe(true);
  });

  it('ends a complete question sooner than an ambiguous fragment', () => {
    const input = { silenceMs: 300 };
    expect(decideEndpoint({ ...input, transcript: 'do you have wool coats?' }).endpoint).toBe(true);
    expect(decideEndpoint({ ...input, transcript: 'wool coat medium' }).endpoint).toBe(false);
  });

  it('does not interrupt a hanging phrase at the base threshold', () => {
    const d = decideEndpoint({ silenceMs: 600, transcript: 'I want something warm and' });
    expect(d.endpoint).toBe(false);
    expect(d.reason).toContain('mid-thought');
  });

  it('ends immediately on a final transcript from STT', () => {
    const d = decideEndpoint({ silenceMs: 0, transcript: 'anything', isFinal: true });
    expect(d.endpoint).toBe(true);
    expect(d.thresholdMs).toBe(0);
  });

  it('never ends a turn before anything is said', () => {
    expect(decideEndpoint({ silenceMs: 5_000, transcript: '' }).endpoint).toBe(false);
  });
});

describe('speculative start', () => {
  it('starts early on a settled phrase', () => {
    expect(shouldSpeculate({ silenceMs: 150, transcript: 'do you have wool coats' })).toBe(true);
  });

  it('does not start mid-thought', () => {
    expect(shouldSpeculate({ silenceMs: 300, transcript: 'I am looking for something and' })).toBe(false);
  });

  it('does not start on too little input', () => {
    expect(shouldSpeculate({ silenceMs: 300, transcript: 'wool' })).toBe(false);
  });

  it('keeps speculative work when STT only tidies punctuation', () => {
    // Restarting over "coat" -> "coat." would throw away the whole benefit.
    expect(speculationStillValid('do you have wool coats', 'Do you have wool coats?')).toBe(true);
  });

  it('discards speculative work when the meaning changed', () => {
    expect(speculationStillValid('do you have wool coats', 'where is my order number 1234')).toBe(false);
  });

  it('discards when the final is much longer than the interim', () => {
    expect(
      speculationStillValid('do you have', 'do you have anything in cashmere for a winter wedding'),
    ).toBe(false);
  });
});

describe('VoiceSession', () => {
  it('walks the expected states', () => {
    const seen: string[] = [];
    const s = new VoiceSession({ onStateChange: (next) => seen.push(next) });
    s.startListening();
    s.startThinking();
    s.startSpeaking(1_000);
    s.finishSpeaking();
    expect(seen).toEqual(['listening', 'thinking', 'speaking', 'listening']);
  });

  it('cancels BOTH audio and generation on barge-in', () => {
    // Cancelling only audio leaves the model answering an abandoned question.
    const onCancelAudio = vi.fn();
    const onCancelGeneration = vi.fn();
    const s = new VoiceSession({ onCancelAudio, onCancelGeneration });
    s.startSpeaking(0);
    const interrupted = s.observeInput(true, 200, 1_000);
    expect(interrupted).toBe(true);
    expect(onCancelAudio).toHaveBeenCalled();
    expect(onCancelGeneration).toHaveBeenCalled();
    expect(s.state).toBe('listening');
  });

  it('ignores microphone input inside the echo guard', () => {
    // The agent's own audio leaks into the mic; without a guard it interrupts
    // itself on its own first syllable.
    const s = new VoiceSession({}, { guardMs: 300 });
    s.startSpeaking(0);
    expect(s.observeInput(true, 200, 100)).toBe(false);
    expect(s.state).toBe('speaking');
  });

  it('ignores a brief noise below the sustained-speech threshold', () => {
    const s = new VoiceSession({}, { minSpeechMs: 200, guardMs: 0 });
    s.startSpeaking(0);
    expect(s.observeInput(true, 80, 500)).toBe(false);
    expect(s.state).toBe('speaking');
  });

  it('accumulates sustained speech across slices', () => {
    const s = new VoiceSession({}, { minSpeechMs: 200, guardMs: 0 });
    s.startSpeaking(0);
    expect(s.observeInput(true, 100, 500)).toBe(false);
    expect(s.observeInput(true, 120, 620)).toBe(true);
  });

  it('resets the speech counter on a gap', () => {
    const s = new VoiceSession({}, { minSpeechMs: 200, guardMs: 0 });
    s.startSpeaking(0);
    s.observeInput(true, 150, 500);
    s.observeInput(false, 100, 600);
    expect(s.observeInput(true, 150, 700)).toBe(false);
  });

  it('interrupts while thinking, before any audio exists', () => {
    const onCancelGeneration = vi.fn();
    const s = new VoiceSession({ onCancelGeneration }, { minSpeechMs: 100, guardMs: 0 });
    s.startThinking();
    expect(s.observeInput(true, 150, 100)).toBe(true);
    expect(onCancelGeneration).toHaveBeenCalled();
  });

  it('does not treat talking while listening as an interruption', () => {
    const s = new VoiceSession({}, { minSpeechMs: 50, guardMs: 0 });
    s.startListening();
    expect(s.observeInput(true, 500, 100)).toBe(false);
    expect(s.state).toBe('listening');
  });

  it('stops cleanly', () => {
    const s = new VoiceSession();
    s.startSpeaking(0);
    s.stop();
    expect(s.state).toBe('idle');
  });
});
