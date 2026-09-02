import type { Message } from '@storeagent/orchestrator';

/**
 * Session state.
 *
 * The interface is deliberately Redis-shaped (async, TTL, string keys) even
 * though the current implementation is a Map. Swapping in Redis for
 * multi-node deployment is then an implementation change, not a refactor of
 * every call site — and the gateway stays stateless in the way that matters:
 * any node can serve any reconnect.
 */

export interface Session {
  readonly id: string;
  readonly shopDomain: string;
  /** Conversation history, capped — retail turns are short. */
  history: Message[];
  /** Cart id, once one exists. Avoids a create_cart round trip per turn. */
  cartId?: string;
  updatedAt: number;
}

export interface SessionStore {
  get(id: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  size(): Promise<number>;
}

const TTL_MS = 30 * 60 * 1000;
/** Keep the last N turns; older context is not worth the tokens in retail. */
const MAX_HISTORY_MESSAGES = 24;

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, Session>();

  constructor(private readonly ttlMs: number = TTL_MS) {}

  async get(id: string): Promise<Session | undefined> {
    const s = this.map.get(id);
    if (s === undefined) return undefined;
    if (Date.now() - s.updatedAt > this.ttlMs) {
      this.map.delete(id);
      return undefined;
    }
    return s;
  }

  async put(session: Session): Promise<void> {
    session.updatedAt = Date.now();
    if (session.history.length > MAX_HISTORY_MESSAGES) {
      session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
    }
    this.map.set(session.id, session);
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }

  async size(): Promise<number> {
    return this.map.size;
  }

  /** Evict expired entries. Call on an interval; Redis would do this for us. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.map) {
      if (now - s.updatedAt > this.ttlMs) {
        this.map.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

export function newSession(id: string, shopDomain: string): Session {
  return { id, shopDomain, history: [], updatedAt: Date.now() };
}
