import type { UcpClient } from './client.js';
import { UnsafeCartWriteError } from './errors.js';
import type { Cart, CartLineItem, CartResult, CartWritable } from './types.js';

/**
 * Server-computed fields that must NOT be echoed back on a write.
 *
 * We DENYLIST computed fields rather than whitelisting writable ones. This is
 * deliberate: `update_cart` is a full replacement, so if UCP adds a new
 * writable field tomorrow, a whitelist would silently start deleting it on
 * every write. A denylist degrades safely — unknown fields pass through.
 */
const COMPUTED_CART_FIELDS = ['id', 'checkout_url', 'subtotal', 'total', 'currency', 'updated_at'] as const;

/** Server-computed line-item fields, stripped on write for the same reason. */
const COMPUTED_LINE_FIELDS = ['price', 'title'] as const;

/**
 * Reduce a server `Cart` to its writable projection, preserving every field we
 * do not positively know to be computed.
 */
export function projectWritable(cart: Cart): CartWritable {
  const out: Record<string, unknown> = { ...(cart as unknown as Record<string, unknown>) };
  for (const f of COMPUTED_CART_FIELDS) delete out[f];
  out['line_items'] = (cart.line_items ?? []).map((li) => {
    const line: Record<string, unknown> = { ...(li as unknown as Record<string, unknown>) };
    for (const f of COMPUTED_LINE_FIELDS) delete line[f];
    return line as unknown as CartLineItem;
  });
  return out as unknown as CartWritable;
}

/**
 * Guard: assert that `next` preserves every writable key present in `prev`.
 * Throws rather than silently shipping a destructive PUT.
 */
export function assertNoFieldLoss(prev: CartWritable, next: CartWritable): void {
  const prevKeys = Object.keys(prev as unknown as Record<string, unknown>);
  const nextObj = next as unknown as Record<string, unknown>;
  const dropped = prevKeys.filter((k) => !(k in nextObj) || nextObj[k] === undefined);
  if (dropped.length > 0) {
    throw new UnsafeCartWriteError(
      `update_cart would delete ${dropped.length} field(s): ${dropped.join(', ')}. ` +
        `update_cart has PUT semantics — send the complete cart state.`,
      dropped,
    );
  }
}

/** Merge a line into a list, incrementing quantity for an existing variant. */
export function mergeLine(
  lines: readonly CartLineItem[],
  incoming: CartLineItem,
  mode: 'increment' | 'set' = 'increment',
): CartLineItem[] {
  const idx = lines.findIndex(
    (l) => l.variant_id === incoming.variant_id && sameAttributes(l.attributes, incoming.attributes),
  );
  if (idx === -1) return [...lines, incoming];
  const existing = lines[idx]!;
  const quantity = mode === 'increment' ? existing.quantity + incoming.quantity : incoming.quantity;
  const next = [...lines];
  next[idx] = { ...existing, ...incoming, quantity };
  return next;
}

function sameAttributes(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const ak = a ? Object.keys(a).sort() : [];
  const bk = b ? Object.keys(b).sort() : [];
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && a![k] === b![k]);
}

/**
 * Serializes mutations per cart id. Two agent turns (or two browser tabs)
 * racing a read-modify-write would otherwise produce a lost update: both read
 * the same state, both PUT, and the second silently discards the first.
 *
 * In-process only. Production runs multiple orchestrator nodes, so this must be
 * backed by a Redis lock keyed on cart id — tracked as SPIKE-OPEN-QUESTION #2.
 */
class CartMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);

    // The sequencing tail must NEVER reject: a rejected tail would both poison
    // every subsequent mutation on this cart and surface as an unhandled
    // rejection (which crashes Node under --unhandled-rejections=throw).
    // The caller owns `result` and is responsible for its rejection.
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);

    // Drop the entry once this is still the tail, so the map stays bounded.
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });

    return result;
  }
}

/**
 * The ONLY supported way to mutate a cart.
 *
 * Every mutation is read → merge → write-full-state, serialized per cart, with
 * a field-loss guard on the way out. Application code must never call
 * `client.updateCart` directly.
 */
export class SafeCart {
  private readonly mutex = new CartMutex();

  constructor(private readonly client: UcpClient) {}

  /** Read-modify-write with the complete cart state preserved. */
  async mutate(
    cartId: string,
    mutator: (current: CartWritable) => CartWritable,
    signal?: AbortSignal,
  ): Promise<CartResult> {
    return this.mutex.run(cartId, async () => {
      const { cart } = await this.client.getCart(cartId, signal);
      const before = projectWritable(cart);
      const after = mutator(before);
      assertNoFieldLoss(before, after);
      return this.client.updateCart(cartId, after, signal);
    });
  }

  async addLine(cartId: string, line: CartLineItem, signal?: AbortSignal): Promise<CartResult> {
    return this.mutate(cartId, (c) => ({ ...c, line_items: mergeLine(c.line_items, line) }), signal);
  }

  async setQuantity(cartId: string, variantId: string, quantity: number, signal?: AbortSignal): Promise<CartResult> {
    if (quantity <= 0) return this.removeLine(cartId, variantId, signal);
    return this.mutate(
      cartId,
      (c) => ({ ...c, line_items: mergeLine(c.line_items, { variant_id: variantId, quantity }, 'set') }),
      signal,
    );
  }

  async removeLine(cartId: string, variantId: string, signal?: AbortSignal): Promise<CartResult> {
    return this.mutate(
      cartId,
      (c) => ({ ...c, line_items: c.line_items.filter((l) => l.variant_id !== variantId) }),
      signal,
    );
  }

  async applyDiscount(cartId: string, code: string, signal?: AbortSignal): Promise<CartResult> {
    return this.mutate(
      cartId,
      (c) => ({ ...c, discount_codes: [...new Set([...(c.discount_codes ?? []), code])] }),
      signal,
    );
  }

  async setBuyerEmail(cartId: string, email: string, signal?: AbortSignal): Promise<CartResult> {
    return this.mutate(cartId, (c) => ({ ...c, buyer: { ...(c.buyer ?? {}), email } }), signal);
  }
}
