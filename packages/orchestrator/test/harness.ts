import type { ModelClient, ModelRequest, ModelResponse } from '../src/model.js';
import type { ToolExecutor } from '../src/tools.js';
import type { MerchantPack } from '../src/prompt.js';

export const MERCHANT: MerchantPack = {
  merchantId: 'acme',
  brandVoice: 'Warm, direct, never pushy. No emoji.',
  policySummary: 'Free returns within 30 days. Ships worldwide.',
  locale: 'en-US',
  currency: 'USD',
};

/** A scripted model. Records every request so we can assert on prompt shape. */
export class MockModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly queue: ModelResponse[]) {}

  async create(req: ModelRequest): Promise<ModelResponse> {
    // Deep-freeze what we record. If the caller ever hands us a live reference
    // again, a later mutation throws here instead of silently rewriting
    // history and making request-level assertions meaningless.
    this.requests.push({ ...req, messages: Object.freeze([...req.messages]) });
    const next = this.queue.shift();
    if (next === undefined) throw new Error('MockModel: script exhausted');
    return next;
  }
}

/** A tool executor that records calls and returns canned payloads. */
export class MockTools implements ToolExecutor {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  constructor(
    private readonly handlers: Record<string, (input: Record<string, unknown>) => unknown> = {},
  ) {}

  async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, input });
    const h = this.handlers[name];
    if (h === undefined) throw new Error(`MockTools: no handler for ${name}`);
    return h(input);
  }

  countOf(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }
}

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 12_000 };

export function textResponse(payload: unknown): ModelResponse {
  return {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: USAGE,
  };
}

export function rawTextResponse(text: string): ModelResponse {
  return {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: USAGE,
  };
}

export function toolCallResponse(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  return {
    model: 'claude-sonnet-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
    usage: USAGE,
  };
}

export function refusalResponse(): ModelResponse {
  return {
    model: 'claude-sonnet-5',
    stop_reason: 'refusal',
    content: [],
    usage: USAGE,
    stop_details: { category: 'cyber' },
  };
}

/** A realistic search_catalog payload — prices in minor units. */
export const CATALOG_PAYLOAD = {
  products: [
    {
      id: 'gid://shopify/Product/1',
      title: 'Merino Wool Overcoat',
      price_range: { min: { amount: 18900, currency: 'USD' }, max: { amount: 18900, currency: 'USD' } },
      variants: [
        { id: 'v-coat-m', title: 'M', price: { amount: 18900, currency: 'USD' }, available: true },
        { id: 'v-coat-l', title: 'L', price: { amount: 18900, currency: 'USD' }, available: false },
      ],
    },
  ],
};
