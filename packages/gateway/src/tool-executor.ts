import { SafeCart, UcpClient } from '@storeagent/ucp-client';
import type { ToolExecutor } from '@storeagent/orchestrator';
import { DEMO_POLICIES, searchDemoCatalog } from './catalog-fixture.js';
import { formatMinor } from '@storeagent/grounding';
import type { Session } from './sessions.js';

/**
 * Wires the model's tool calls to real systems.
 *
 * Two modes:
 *   - **live**   — a SHOP_DOMAIN is configured; catalog and cart go to UCP.
 *   - **demo**   — no shop configured; a fixture catalog stands in.
 *
 * Demo mode exists because the Shopify development store is still outstanding
 * and blocking the entire application on it would be a poor trade. The fixture
 * returns the exact UCP payload shape, so nothing downstream — grounding
 * included — can tell the difference.
 */

export interface ToolExecutorDeps {
  readonly session: Session;
  readonly ucp?: UcpClient | undefined;
  readonly onCartChange?: (cartId: string) => void;
}

/**
 * Attach a ready-to-quote price string to every money object in a catalog
 * payload.
 *
 * The model was being handed minor units (78595) and asked to do the division
 * itself. It mostly did, and then wrote `$785.00` for a `$785.95` board on
 * roughly three turns in five — measured against the live catalog. The tripwire
 * caught every one, so no shopper ever saw a wrong price, but each catch threw
 * the generation away and re-ran the turn: ~5.6k input tokens became ~7.2k, and
 * one run in five gave up and handed off a question the store could answer.
 *
 * Prompting was tried first and reduced it without fixing it, because the ask
 * was still "do this arithmetic correctly every time". This removes the
 * arithmetic. `display` is the exact string to quote, so the model copies
 * rather than computes.
 *
 * Minor units stay in the payload untouched: grounding validates the model's
 * claims against source money, and `collectMoneyFromResult` reads both the
 * structured amount and money written inside strings, so the added field is
 * consistent with what the tripwire already accepts.
 */
function withDisplayPrices<T>(payload: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj['amount'] === 'number' && typeof obj['currency'] === 'string' && obj['display'] === undefined) {
      const symbol = CURRENCY_SYMBOL[obj['currency']] ?? '';
      obj['display'] = `${symbol}${formatMinor(Math.round(obj['amount']))}`;
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(payload);
  return payload;
}

/** Only the symbols we can render unambiguously; anything else falls back to the bare amount. */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  CAD: '$',
  AUD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  JPY: '¥',
};

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const { session, ucp } = deps;
  const safeCart = ucp ? new SafeCart(ucp) : undefined;

  return {
    async execute(name, input, signal) {
      switch (name) {
        case 'search_catalog': {
          const query = String(input['query'] ?? '');
          const limit = typeof input['limit'] === 'number' ? input['limit'] : 6;
          if (ucp) return withDisplayPrices(await ucp.searchCatalog({ query, pagination: { limit } }, signal));
          return withDisplayPrices(searchDemoCatalog(query, limit));
        }

        case 'get_product': {
          const id = String(input['id'] ?? '');
          if (ucp) return withDisplayPrices(await ucp.getProduct({ id }, signal));
          const found = searchDemoCatalog('', 100).products.find((p) => p.id === id);
          if (found === undefined) return { error: true, message: `No product with id ${id}` };
          return withDisplayPrices({ product: found });
        }

        case 'get_policy': {
          const topic = String(input['topic'] ?? 'faq');
          // The owned side of the grounding split (ARCHITECTURE.md §5.1). Small,
          // changes rarely — a per-merchant corpus, not a vector index over the
          // catalog. pgvector retrieval replaces this lookup in Phase 2.
          const text = DEMO_POLICIES[topic];
          if (text === undefined) return { error: true, message: `No policy for topic ${topic}` };
          return { topic, text, source_url: `https://example.test/policies/${topic}` };
        }

        case 'add_to_cart': {
          const variantId = String(input['variant_id'] ?? '');
          const quantity = typeof input['quantity'] === 'number' ? input['quantity'] : 1;
          if (!safeCart || !ucp) {
            // Demo mode: acknowledge without inventing cart totals, so the
            // model has nothing ungrounded to quote.
            return { ok: true, added: { variant_id: variantId, quantity }, demo: true };
          }
          if (session.cartId === undefined) {
            const created = await ucp.createCart(
              {
                line_items: [{ variant_id: variantId, quantity }],
                attribution: { source: 'storeagent', session_id: session.id },
              },
              signal,
            );
            session.cartId = created.cart.id;
            deps.onCartChange?.(created.cart.id);
            return created;
          }
          return safeCart.addLine(session.cartId, { variant_id: variantId, quantity }, signal);
        }

        case 'escalate_to_human': {
          // Phase 2 turns this into a real ticket + email capture. Recording it
          // as a successful outcome matters: an escalation that captures a lead
          // beats a confident wrong answer.
          return { ok: true, escalated: true, reason: String(input['reason'] ?? '') };
        }

        default:
          return { error: true, message: `Unknown tool: ${name}` };
      }
    },
  };
}
