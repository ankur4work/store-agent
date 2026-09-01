import { OPENAI_MODELS, type Effort, type ModelTierMap } from './model.js';

/**
 * Model routing (ARCHITECTURE.md §7.1).
 *
 * ~92% of turns are Sonnet 5 at low effort. Escalation is triggered by
 * evidence, never by default — Opus costs 1.7× Sonnet on input and output.
 */

export type Tier = 'classify' | 'workhorse' | 'escalation';

export interface RouteSignals {
  /** How many tool round trips this turn has already taken. */
  readonly toolDepth: number;
  /** Shopper expressed frustration, or asked for a human. */
  readonly frustration?: boolean;
  /** Multi-constraint product fit, returns edge case, policy conflict. */
  readonly complex?: boolean;
  /** A prior attempt failed grounding — think harder on the retry. */
  readonly groundingRetry?: boolean;
}

export interface Route {
  readonly tier: Tier;
  readonly model: string;
  readonly effort: Effort;
  readonly maxTokens: number;
  readonly reason: string;
}

export function route(signals: RouteSignals, models: ModelTierMap = OPENAI_MODELS): Route {
  const workhorse: Route = {
    tier: 'workhorse',
    model: models.workhorse,
    effort: 'low',
    maxTokens: 2048,
    reason: 'default conversational turn',
  };

  const escalate = (reason: string): Route => ({
    tier: 'escalation',
    model: models.escalation,
    effort: 'medium',
    maxTokens: 4096,
    reason,
  });

  if (signals.frustration === true) return escalate('shopper frustration — get this right');
  if (signals.complex === true) return escalate('multi-constraint reasoning');
  if (signals.toolDepth > 3) {
    return escalate(`tool loop depth ${signals.toolDepth} — the workhorse is stuck`);
  }
  if (signals.groundingRetry === true) {
    // Same model, more effort. Switching models mid-conversation would also
    // invalidate the prompt cache — caches are model-scoped on every provider.
    return { ...workhorse, effort: 'medium', reason: 'grounding retry — more effort, same model' };
  }
  return workhorse;
}

/** Cheap keyword frustration detector; the classifier refines it. */
export function detectFrustration(text: string): boolean {
  return /\b(?:speak|talk) to (?:a|someone|a real) (?:human|person|agent)\b|\bthis is (?:useless|ridiculous)\b|\bnot helping\b|\bfrustrat/i.test(
    text,
  );
}
