import type { ToolDef } from './model.js';

/**
 * Tool definitions exposed to the model.
 *
 * Descriptions are PRESCRIPTIVE about *when* to call, not just what the tool
 * does. Recent Claude models reach for tools more conservatively, and trigger
 * conditions in the description give measurable lift in should-call rate —
 * which for us is grounding rate, since an ungrounded turn fails validation.
 *
 * Order is fixed and sorted: tool definitions render at position 0 of the
 * prompt, so any reordering invalidates the entire prompt cache.
 */

export const SEARCH_CATALOG: ToolDef = {
  name: 'search_catalog',
  description:
    'Search this store\'s live product catalog by natural-language query. ' +
    'Call this whenever the shopper asks what you sell, asks for a recommendation, ' +
    'describes something they want, or mentions a product you have not already looked up ' +
    'this turn. You have NO reliable prior knowledge of this catalog — it changes daily. ' +
    'Prefer calling it and finding nothing over guessing. ' +
    'Results already include each variant with its price and availability, so you can ' +
    'answer price, size, and stock questions directly from them — do NOT call get_product ' +
    'again for detail that is already here. Every extra tool call costs the shopper ' +
    'seconds of waiting.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language description of what the shopper wants.' },
      limit: { type: 'integer', description: 'Max results, 1-250. Default 6 — shoppers do not scroll.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export const GET_PRODUCT: ToolDef = {
  name: 'get_product',
  description:
    'Fetch full detail for ONE product. Use this only when search_catalog results do not ' +
    'already contain what you need — for example a long description, or an option ' +
    'combination that was not listed. If the price, sizes, and availability are already ' +
    'in the search results, answer from those instead: this call adds a full round trip ' +
    'the shopper waits through.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Product id, e.g. gid://shopify/Product/123' },
      // Array of pairs rather than an open map: strict structured-output modes
      // require `additionalProperties: false`, so a free-form
      // `additionalProperties: {type:"string"}` map is not expressible.
      selected: {
        type: 'array',
        description: 'Partial option selection, e.g. [{"name":"Size","value":"M"}].',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, value: { type: 'string' } },
          required: ['name', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

export const GET_POLICY: ToolDef = {
  name: 'get_policy',
  description:
    'Retrieve the merchant\'s authoritative policy text (shipping, returns, warranty, FAQ). ' +
    'Call this before stating any delivery time, return window, or policy detail. ' +
    'Never answer policy questions from general knowledge — every store differs.',
  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: ['shipping', 'returns', 'warranty', 'payment', 'faq'],
      },
      question: { type: 'string', description: 'The shopper\'s question, for retrieval.' },
    },
    required: ['topic', 'question'],
    additionalProperties: false,
  },
};

export const ADD_TO_CART: ToolDef = {
  name: 'add_to_cart',
  description:
    'Add a specific variant to the shopper\'s cart. Only call this on explicit intent ' +
    '("add it", "I\'ll take it", "yes"). Never add speculatively. Confirm the variant first ' +
    'if the shopper has not chosen size or colour.',
  input_schema: {
    type: 'object',
    properties: {
      variant_id: { type: 'string' },
      quantity: { type: 'integer', description: 'Default 1.' },
    },
    required: ['variant_id'],
    additionalProperties: false,
  },
};

export const ESCALATE: ToolDef = {
  name: 'escalate_to_human',
  description:
    'Hand off to the merchant\'s team and capture the shopper\'s email. ' +
    'Call this WHENEVER you are about to tell the shopper you cannot help — because a ' +
    'tool failed, the data is missing, the question needs a person, or they are ' +
    'frustrated. Saying "I can\'t confirm that" WITHOUT calling this tool is a dead end: ' +
    'nothing reaches the team and the shopper leaves with nothing. ' +
    'This is a SUCCESSFUL outcome, not a failure — a captured lead beats a confident ' +
    'wrong answer, and beats an apology even more.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      email: { type: 'string', description: 'If the shopper has provided one.' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

/** Sorted by name — deterministic order keeps the prompt prefix cacheable. */
export const DEFAULT_TOOLS: readonly ToolDef[] = [
  ADD_TO_CART,
  ESCALATE,
  GET_POLICY,
  GET_PRODUCT,
  SEARCH_CATALOG,
].sort((a, b) => a.name.localeCompare(b.name));

/** Executes a tool call. Backed by UcpClient + policy corpus in production. */
export interface ToolExecutor {
  execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
