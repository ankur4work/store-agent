import { describe, expect, it } from 'vitest';
import {
  OpenAIError,
  OpenAIModelClient,
  OpenAITimeoutError,
  fromOpenAIResponse,
  stripNulls,
  toOpenAIRequest,
  toStrictSchema,
} from '../src/providers/openai.js';
import { buildCachedPrefix } from '../src/prompt.js';
import { DEFAULT_TOOLS, SEARCH_CATALOG } from '../src/tools.js';
import { MERCHANT } from './harness.js';
import type { ModelRequest } from '../src/model.js';

const BASE: ModelRequest = {
  model: 'gpt-test',
  system: buildCachedPrefix(MERCHANT),
  messages: [{ role: 'user', content: 'do you have wool coats?' }],
  tools: DEFAULT_TOOLS,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
  max_tokens: 2048,
};

function reply(body: unknown, status = 200): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const OK_RESPONSE = {
  model: 'gpt-test',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe('request translation (Responses API)', () => {
  it('puts the cached prefix in instructions, unchanged', () => {
    const body = toOpenAIRequest(BASE);
    expect(body['instructions']).toBe(BASE.system.map((b) => b.text).join('\n\n'));
  });

  it('is byte-stable across builds so automatic prefix caching can hit', () => {
    // OpenAI caches automatically with no breakpoints — an unstable prefix
    // silently loses the discount with nothing in the response to reveal it.
    expect(JSON.stringify(toOpenAIRequest(BASE))).toBe(JSON.stringify(toOpenAIRequest(BASE)));
  });

  it('emits FLAT function tools (no nested `function` object)', () => {
    const tools = toOpenAIRequest(BASE)['tools'] as { type: string; name: string; strict: boolean }[];
    expect(tools[0]!.type).toBe('function');
    expect(tools[0]!.strict).toBe(true);
    expect(tools.map((t) => t.name)).toEqual(DEFAULT_TOOLS.map((t) => t.name));
  });

  it('maps effort to reasoning.effort', () => {
    expect(toOpenAIRequest(BASE)['reasoning']).toEqual({ effort: 'low' });
  });

  it('maps the structured-output schema to text.format', () => {
    const text = toOpenAIRequest(BASE)['text'] as { format: { type: string; strict: boolean } };
    expect(text.format.type).toBe('json_schema');
    expect(text.format.strict).toBe(true);
  });

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ])('collapses effort %s → %s', (input, expected) => {
    const body = toOpenAIRequest({ ...BASE, output_config: { effort: input as 'low' } });
    expect(body['reasoning']).toEqual({ effort: expected });
  });

  it('uses max_output_tokens', () => {
    expect(toOpenAIRequest(BASE)['max_output_tokens']).toBe(2048);
  });

  it('converts assistant tool_use into function_call items', () => {
    const body = toOpenAIRequest({
      ...BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search_catalog', input: { query: 'wool' } }] },
      ],
    });
    const input = body['input'] as { type?: string; call_id?: string; arguments?: string }[];
    const fc = input.find((i) => i.type === 'function_call')!;
    expect(fc.call_id).toBe('c1');
    expect(JSON.parse(fc.arguments!)).toEqual({ query: 'wool' });
  });

  it('converts tool results into function_call_output items', () => {
    const body = toOpenAIRequest({
      ...BASE,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: '{"a":1}' },
            { type: 'tool_result', tool_use_id: 'c2', content: '{"b":2}' },
          ],
        },
      ],
    });
    const input = body['input'] as { type?: string; call_id?: string }[];
    expect(input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id)).toEqual(['c1', 'c2']);
  });
});

/**
 * OpenAI strict mode requires `required` to list EVERY property and
 * `additionalProperties: false`. Our provider-neutral tool defs use genuinely
 * optional params, so optionality is expressed as a nullable type instead.
 * Discovered live — the API rejects the un-transformed schema outright.
 */
describe('toStrictSchema', () => {
  it('marks every property required', () => {
    const s = toStrictSchema(SEARCH_CATALOG.input_schema);
    expect(s['required']).toEqual(['query', 'limit']);
  });

  it('makes originally-optional properties nullable', () => {
    const s = toStrictSchema(SEARCH_CATALOG.input_schema);
    const props = s['properties'] as Record<string, { type: unknown }>;
    expect(props['query']!.type).toBe('string'); // was required — unchanged
    expect(props['limit']!.type).toEqual(['integer', 'null']); // was optional
  });

  it('forces additionalProperties false', () => {
    expect(toStrictSchema(SEARCH_CATALOG.input_schema)['additionalProperties']).toBe(false);
  });

  it('recurses into array items', () => {
    const s = toStrictSchema({
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } }, required: [] } },
      },
      required: ['rows'],
    });
    const items = (s['properties'] as Record<string, { items: Record<string, unknown> }>)['rows']!.items;
    expect(items['additionalProperties']).toBe(false);
    expect((items['properties'] as Record<string, { type: unknown }>)['a']!.type).toEqual(['string', 'null']);
  });

  it('does not double-add null', () => {
    const s = toStrictSchema({
      type: 'object',
      properties: { a: { type: ['string', 'null'] } },
      required: [],
    });
    expect((s['properties'] as Record<string, { type: unknown }>)['a']!.type).toEqual(['string', 'null']);
  });

  it('leaves every tool schema strict-compliant', () => {
    for (const t of DEFAULT_TOOLS) {
      const s = toStrictSchema(t.input_schema);
      const props = Object.keys(s['properties'] as Record<string, unknown>);
      expect(s['required'], `${t.name}`).toEqual(props);
      expect(s['additionalProperties'], `${t.name}`).toBe(false);
    }
  });
});

describe('stripNulls', () => {
  it('drops nulls, which is how strict mode omits an optional param', () => {
    expect(stripNulls({ query: 'wool', limit: null })).toEqual({ query: 'wool' });
  });
  it('recurses into nested objects', () => {
    expect(stripNulls({ a: { b: null, c: 1 } })).toEqual({ a: { c: 1 } });
  });
  it('leaves arrays alone', () => {
    expect(stripNulls({ a: [1, null, 2] })).toEqual({ a: [1, null, 2] });
  });
});

describe('response translation (Responses API)', () => {
  it('maps output_text to end_turn text', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      status: 'completed',
      output: [
        { type: 'reasoning' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"reply":"hi","claims":[]}' }] },
      ],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 90 } },
    });
    expect(res.stop_reason).toBe('end_turn');
    expect(res.content[0]).toEqual({ type: 'text', text: '{"reply":"hi","claims":[]}' });
    expect(res.usage.cache_read_input_tokens).toBe(90);
  });

  it('maps function_call to tool_use and infers tool_use stop reason', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'c1', name: 'search_catalog', arguments: '{"query":"wool","limit":null}' },
      ],
    });
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content[0]).toMatchObject({ type: 'tool_use', name: 'search_catalog', input: { query: 'wool' } });
    // null was stripped — it means "omitted" under toStrictSchema.
    expect((res.content[0] as { input: Record<string, unknown> }).input).not.toHaveProperty('limit');
  });

  it('maps a refusal so the loop escalates instead of reading empty content', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help.' }] }],
    });
    expect(res.stop_reason).toBe('refusal');
    expect(res.content).toHaveLength(0);
  });

  it('maps truncation to max_tokens', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
    });
    expect(res.stop_reason).toBe('max_tokens');
  });

  it('survives malformed tool arguments rather than crashing the turn', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      output: [{ type: 'function_call', call_id: 'c1', name: 'x', arguments: 'not json' }],
    });
    expect(res.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('handles an empty output array', () => {
    const res = fromOpenAIResponse({ model: 'gpt-test', output: [] });
    expect(res.content).toHaveLength(0);
    expect(res.stop_reason).toBe('end_turn');
  });
});

describe('transport', () => {
  it('requires an api key', () => {
    expect(() => new OpenAIModelClient({ apiKey: '' })).toThrow(TypeError);
  });

  it('sends a bearer token', async () => {
    let seen: Record<string, string> | undefined;
    const client = new OpenAIModelClient({
      apiKey: 'sk-test',
      maxRetries: 0,
      fetch: async (_u, init) => {
        seen = init?.headers as Record<string, string>;
        return new Response(JSON.stringify(OK_RESPONSE), { status: 200 });
      },
    });
    await client.create(BASE);
    expect(seen!['authorization']).toBe('Bearer sk-test');
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const client = new OpenAIModelClient({
      apiKey: 'sk-test',
      maxRetries: 3,
      fetch: async () => {
        calls++;
        return new Response('bad request', { status: 400 });
      },
    });
    await expect(client.create(BASE)).rejects.toBeInstanceOf(OpenAIError);
    expect(calls).toBe(1);
  });

  it('retries a 429 then succeeds', async () => {
    let calls = 0;
    const client = new OpenAIModelClient({
      apiKey: 'sk-test',
      maxRetries: 2,
      fetch: async () => {
        calls++;
        if (calls === 1) return new Response('slow down', { status: 429 });
        return new Response(JSON.stringify(OK_RESPONSE), { status: 200 });
      },
    });
    expect((await client.create(BASE)).stop_reason).toBe('end_turn');
    expect(calls).toBe(2);
  });

  it('times out rather than making a shopper wait', async () => {
    const client = new OpenAIModelClient({
      apiKey: 'sk-test',
      timeoutMs: 30,
      maxRetries: 0,
      fetch: (_u, init) =>
        new Promise((_resolve, rejectFn) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            rejectFn(e);
          });
        }),
    });
    await expect(client.create(BASE)).rejects.toBeInstanceOf(OpenAITimeoutError);
  });

  it('parses a successful response end to end', async () => {
    const client = new OpenAIModelClient({ apiKey: 'sk-test', fetch: reply(OK_RESPONSE) });
    const res = await client.create(BASE);
    expect(res.model).toBe('gpt-test');
    expect(res.usage.input_tokens).toBe(10);
  });
});
