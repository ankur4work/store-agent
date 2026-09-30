import type { Message, Preferences } from '@storeagent/orchestrator';

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
  /**
   * The products the shopper is currently looking at.
   *
   * Held so that "just the blue ones" can be answered by narrowing what is on
   * screen instead of by a model round trip. It has to live here rather than
   * being sent back by the widget: a client that supplies the products it then
   * gets answered about could alter a price, and the assistant would repeat it.
   * That is precisely the claim the grounding layer exists to prevent.
   *
   * Capped, because these are whole catalog objects with descriptions and image
   * urls, and a session row is not a product cache. See MAX_VISIBLE_PRODUCTS.
   */
  products?: unknown[];
  /**
   * What the shopper has told us about what they want.
   *
   * Session-scoped and short-lived by design: this is a handful of facts they
   * volunteered about one purchase, for thirty minutes, held by the session that
   * heard them. It is not a profile — see `preferences.ts` for what is
   * deliberately never recorded.
   */
  preferences?: Preferences;
  updatedAt: number;
}

/**
 * How many products a session remembers.
 *
 * The rail shows six and scrolls; a shopper narrowing "the blue ones" is
 * pointing at what they can see. Twelve covers a widened search without turning
 * the sessions table into a catalog mirror.
 */
export const MAX_VISIBLE_PRODUCTS = 12;

/**
 * Read a stored visible set back, tolerating everything it might be.
 *
 * NULL on a row written before the column existed, and that is not an error —
 * it means the first narrowing turn after a deploy goes to the model, which is
 * the correct behaviour rather than a degraded one. Unparseable JSON is treated
 * the same way: a session that cannot be read is not a turn that should fail.
 *
 * Capped on the way in as well as out, so a row written by another version
 * cannot hand a shopper a hundred products to narrow.
 */
export function readVisibleProducts(raw: unknown): { products?: unknown[] } {
  if (raw === null || raw === undefined || raw === '') return {};
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || parsed.length === 0) return {};
    return { products: parsed.slice(0, MAX_VISIBLE_PRODUCTS) };
  } catch {
    return {};
  }
}

/**
 * Read stored preferences back, keeping only the four fields we recognise.
 *
 * Filtered rather than trusted wholesale: this JSON reaches the model as an
 * instruction about the shopper, and a row written by a different version — or
 * by a bug — must not be able to put an arbitrary key in front of it. Absent or
 * unreadable means the assistant asks once more, which is a small cost.
 */
export function readPreferences(raw: unknown): { preferences?: Preferences } {
  if (raw === null || raw === undefined || raw === '') return {};
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const p = parsed as Record<string, unknown>;
    const out: Preferences = {};
    if (typeof p['size'] === 'string') out.size = p['size'].slice(0, 12);
    if (typeof p['budgetMaxMinor'] === 'number' && Number.isFinite(p['budgetMaxMinor'])) {
      out.budgetMaxMinor = p['budgetMaxMinor'];
    }
    if (typeof p['colour'] === 'string') out.colour = p['colour'].slice(0, 20);
    if (typeof p['occasion'] === 'string') out.occasion = p['occasion'].slice(0, 20);
    return Object.keys(out).length === 0 ? {} : { preferences: out };
  } catch {
    return {};
  }
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
    if (session.products !== undefined && session.products.length > MAX_VISIBLE_PRODUCTS) {
      session.products = session.products.slice(0, MAX_VISIBLE_PRODUCTS);
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
