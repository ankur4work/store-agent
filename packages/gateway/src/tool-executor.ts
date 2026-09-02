import { SafeCart, UcpClient } from '@storeagent/ucp-client';
import type { ToolExecutor } from '@storeagent/orchestrator';
import { DEMO_POLICIES, searchDemoCatalog } from './catalog-fixture.js';
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

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const { session, ucp } = deps;
  const safeCart = ucp ? new SafeCart(ucp) : undefined;

  return {
    async execute(name, input, signal) {
      switch (name) {
        case 'search_catalog': {
          const query = String(input['query'] ?? '');
          const limit = typeof input['limit'] === 'number' ? input['limit'] : 6;
          if (ucp) return ucp.searchCatalog({ query, pagination: { limit } }, signal);
          return searchDemoCatalog(query, limit);
        }

        case 'get_product': {
          const id = String(input['id'] ?? '');
          if (ucp) return ucp.getProduct({ id }, signal);
          const found = searchDemoCatalog('', 100).products.find((p) => p.id === id);
          if (found === undefined) return { error: true, message: `No product with id ${id}` };
          return { product: found };
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
