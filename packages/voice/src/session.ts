/**
 * Voice turn state machine.
 *
 * Four states, and the transitions between them are where voice agents feel
 * broken or feel alive:
 *
 *   idle → listening → thinking → speaking → listening …
 *
 * The state is also what the UI renders. Ambiguity about whether the agent
 * heard you is worse than latency — a shopper who cannot tell will repeat
 * themselves, and now both of you are talking.
 *
 * ## Barge-in
 *
 * Speaking over the agent must stop it within ~50ms, and must cancel BOTH the
 * audio and the in-flight generation. Cancelling only the audio leaves the
 * model producing a reply to a question the shopper has already abandoned,
 * which then arrives late and answers the wrong thing.
 *
 * There is one subtlety: the agent's own audio leaks into the microphone. Any
 * barge-in detector that trusts raw energy will interrupt itself on every
 * sentence. So barge-in requires speech sustained past a short guard window,
 * and the caller is expected to feed echo-cancelled input.
 */

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface BargeInOptions {
  /**
   * Sustained speech required to count as an interruption. Below this, a cough
   * or the agent's own leaked audio would cut it off mid-sentence.
   */
  readonly minSpeechMs?: number;
  /** Ignore input for this long after audio starts — worst echo window. */
  readonly guardMs?: number;
}

export interface VoiceEvents {
  readonly onStateChange?: (state: VoiceState, previous: VoiceState) => void;
  /** Stop audio playback immediately. */
  readonly onCancelAudio?: () => void;
  /** Abort the in-flight model turn. */
  readonly onCancelGeneration?: () => void;
}

const DEFAULTS = { minSpeechMs: 160, guardMs: 220 } as const;

export class VoiceSession {
  private _state: VoiceState = 'idle';
  private speakingSince = 0;
  private shopperSpeechMs = 0;
  private readonly minSpeechMs: number;
  private readonly guardMs: number;

  constructor(
    private readonly events: VoiceEvents = {},
    opts: BargeInOptions = {},
  ) {
    this.minSpeechMs = opts.minSpeechMs ?? DEFAULTS.minSpeechMs;
    this.guardMs = opts.guardMs ?? DEFAULTS.guardMs;
  }

  get state(): VoiceState {
    return this._state;
  }

  private to(next: VoiceState): void {
    if (next === this._state) return;
    const previous = this._state;
    this._state = next;
    this.events.onStateChange?.(next, previous);
  }

  startListening(): void {
    this.shopperSpeechMs = 0;
    this.to('listening');
  }

  startThinking(): void {
    this.to('thinking');
  }

  /** `now` is injected so the machine stays deterministic under test. */
  startSpeaking(now: number): void {
    this.speakingSince = now;
    this.shopperSpeechMs = 0;
    this.to('speaking');
  }

  finishSpeaking(): void {
    if (this._state === 'speaking') this.startListening();
  }

  stop(): void {
    this.to('idle');
  }

  /**
   * Feed a slice of microphone activity.
   *
   * Returns true when this constitutes a barge-in — the caller should discard
   * any pending speech and restart the turn.
   */
  observeInput(isSpeech: boolean, deltaMs: number, now: number): boolean {
    if (!isSpeech) {
      this.shopperSpeechMs = 0;
      return false;
    }
    this.shopperSpeechMs += deltaMs;

    // Only speaking and thinking are interruptible. Interrupting `listening`
    // is just... the shopper talking, which is the point.
    if (this._state !== 'speaking' && this._state !== 'thinking') return false;

    if (this._state === 'speaking' && now - this.speakingSince < this.guardMs) {
      return false; // inside the echo guard
    }
    if (this.shopperSpeechMs < this.minSpeechMs) return false;

    this.interrupt();
    return true;
  }

  /** Explicit interruption — a tap on the stop button, or detected barge-in. */
  interrupt(): void {
    if (this._state === 'speaking') this.events.onCancelAudio?.();
    if (this._state === 'speaking' || this._state === 'thinking') {
      this.events.onCancelGeneration?.();
    }
    this.startListening();
  }
}

/** Labels for the UI. Never leave the shopper guessing whether it heard them. */
export const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Tap to talk',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};
