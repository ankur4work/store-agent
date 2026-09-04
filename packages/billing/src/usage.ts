/**
 * Counting resolved conversations.
 *
 * This is the billing unit, so the definition has to be exact — everything the
 * merchant pays is derived from it.
 *
 * ## A conversation is resolved when the assistant first answers it properly
 *
 *   counted   — the first assistant reply in a session that is grounded and
 *               was not handed off to a human
 *   not       — every subsequent turn in that same session
 *   not       — ungrounded turns, tripwire aborts, and errors
 *   not       — sessions handed off to a human on that first turn
 *   not       — holdout sessions, which never see the assistant at all
 *
 * **Counted once per session, never per message.** A 20-message conversation
 * bills exactly the same as a 1-message one. This is the point of §13's first
 * departure: per-message billing makes a merchant hope their shoppers use the
 * product as little as possible, which is a strange thing to sell someone.
 *
 * **Failures are free.** If we could not ground the answer, we did not resolve
 * anything, and billing for it would mean charging most for the turns we are
 * worst at. The incentive has to point the other way.
 *
 * ## The known soft spot
 *
 * A session that resolves and *later* escalates to a human still counts. The
 * alternative — refunding on a subsequent handoff — sounds fairer but is worse
 * in practice: an overage may already have been charged to Shopify, and usage
 * records cannot be retracted. So the rule is "value was delivered before the
 * handoff", which is defensible, states itself plainly to the merchant, and
 * errs small.
 *
 * ## The abuse the ceiling exists for
 *
 * Session ids come from the client, so someone could mint them to inflate a
 * competitor's bill. Three things bound it: each fake session must extract a
 * genuinely grounded reply, the per-client rate limits apply, and — the actual
 * backstop — nothing is ever billed beyond the cap the merchant approved.
 */

export interface UsageStore {
  /**
   * Record a resolved conversation.
   *
   * Returns true only if this session had not already been counted, so callers
   * can charge overage exactly once. Must be idempotent: retries, reconnects
   * and duplicate deliveries are all normal.
   */
  markResolved(shop: string, period: string, sessionId: string): boolean;
  resolvedCount(shop: string, period: string): number;
  /** Add to the overage charged this period and return the new total, in cents. */
  addOverage(shop: string, period: string, minor: number): number;
  overageCharged(shop: string, period: string): number;
}

/** What the caller knows about a turn, for the counting decision. */
export interface TurnOutcome {
  readonly sessionId: string;
  readonly grounded: boolean;
  readonly handedOff: boolean;
  /** Holdout sessions never see the assistant, so they can never resolve. */
  readonly arm: 'exposed' | 'holdout' | undefined;
}

/**
 * Is this turn a resolution worth billing?
 *
 * Pure, so the rule can be tested exhaustively without a store. Idempotency is
 * the store's job; this only decides eligibility.
 */
export function isBillable(turn: TurnOutcome): boolean {
  if (turn.arm === 'holdout') return false;
  if (!turn.grounded) return false;
  if (turn.handedOff) return false;
  return true;
}

export class MemoryUsageStore implements UsageStore {
  private readonly counted = new Set<string>();
  private readonly overage = new Map<string, number>();

  private key(shop: string, period: string): string {
    return `${shop} ${period}`;
  }

  markResolved(shop: string, period: string, sessionId: string): boolean {
    const k = `${this.key(shop, period)} ${sessionId}`;
    if (this.counted.has(k)) return false;
    this.counted.add(k);
    return true;
  }

  resolvedCount(shop: string, period: string): number {
    const prefix = `${this.key(shop, period)} `;
    let n = 0;
    for (const k of this.counted) if (k.startsWith(prefix)) n++;
    return n;
  }

  addOverage(shop: string, period: string, minor: number): number {
    const k = this.key(shop, period);
    const next = (this.overage.get(k) ?? 0) + minor;
    this.overage.set(k, next);
    return next;
  }

  overageCharged(shop: string, period: string): number {
    return this.overage.get(this.key(shop, period)) ?? 0;
  }
}
