import { describe, expect, it } from 'vitest';
import {
  OpenAIError,
  OpenAIModelClient,
  OpenAITimeoutError,
  fromOpenAIResponse,
  toOpenAIRequest,
} from '../src/providers/openai.js';
import { buildCachedPrefix } from '../src/prompt.js';
import { DEFAULT_TOOLS } from '../src/tools.js';
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

describe('request translation', () => {
  it('puts the cached prefix first and unchanged', () => {
    const body = toOpenAIRequest(BASE);
    const messages = body['messages'] as { role: string; content: string }[];
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe(BASE.system.map((b) => b.text).join('\n\n'));
  });

  it('is byte-stable across builds so automatic prefix caching can hit', () => {
    // OpenAI caches automatically with no breakpoints — an unstable prefix
    // silently loses the discount with nothing in the response to reveal it.
    const a = JSON.stringify(toOpenAIRequest(BASE));
    const b = JSON.stringify(toOpenAIRequest(BASE));
    expect(a).toBe(b);
  });

  it('maps tools to strict function definitions', () => {
    const tools = toOpenAIRequest(BASE)['tools'] as { type: string; function: { name: string; strict: boolean } }[];
    expect(tools[0]!.type).toBe('function');
    expect(tools[0]!.function.strict).toBe(true);
    expect(tools.map((t) => t.function.name)).toEqual(DEFAULT_TOOLS.map((t) => t.name));
  });

  it('maps the structured-output schema to response_format', () => {
    const rf = toOpenAIRequest(BASE)['response_format'] as { type: string; json_schema: { strict: boolean } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
  });

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ])('collapses effort %s → %s', (input, expected) => {
    const body = toOpenAIRequest({ ...BASE, output_config: { effort: input as 'low' } });
    expect(body['reasoning_effort']).toBe(expected);
  });

  it('uses max_completion_tokens, not the legacy max_tokens', () => {
    const body = toOpenAIRequest(BASE);
    expect(body['max_completion_tokens']).toBe(2048);
    expect(body['max_tokens']).toBeUndefined();
  });

  it('converts assistant tool_use blocks into tool_calls', () => {
    const body = toOpenAIRequest({
      ...BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search_catalog', input: { query: 'wool' } }] },
      ],
    });
    const msgs = body['messages'] as { role: string; tool_calls?: { id: string; function: { arguments: string } }[] }[];
    const assistant = msgs.at(-1)!;
    expect(assistant.tool_calls![0]!.id).toBe('c1');
    expect(JSON.parse(assistant.tool_calls![0]!.function.arguments)).toEqual({ query: 'wool' });
  });

  it('converts tool results into one tool message per result', () => {
    const body = toOpenAIRequest({
      ...BASE,
      messages: [
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'c1', content: '{"a":1}' },
          { type: 'tool_result', tool_use_id: 'c2', content: '{"b":2}' },
        ] },
      ],
    });
    const msgs = body['messages'] as { role: string; tool_call_id?: string }[];
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2']);
  });
});

describe('response translation', () => {
  it('maps a plain completion to end_turn text', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      choices: [{ finish_reason: 'stop', message: { content: '{"reply":"hi","claims":[]}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 90 } },
    });
    expect(res.stop_reason).toBe('end_turn');
    expect(res.content[0]).toEqual({ type: 'text', text: '{"reply":"hi","claims":[]}' });
    expect(res.usage.cache_read_input_tokens).toBe(90);
  });

  it('maps tool_calls to tool_use blocks', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'search_catalog', arguments: '{"query":"wool"}' } },
            ],
          },
        },
      ],
    });
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content[0]).toMatchObject({ type: 'tool_use', name: 'search_catalog', input: { query: 'wool' } });
  });

  it('maps a refusal so the loop escalates instead of reading empty content', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }],
    });
    expect(res.stop_reason).toBe('refusal');
    expect(res.content).toHaveLength(0);
  });

  it('maps content_filter to refusal', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      choices: [{ finish_reason: 'content_filter', message: { content: null } }],
    });
    expect(res.stop_reason).toBe('refusal');
  });

  it('maps length to max_tokens', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      choices: [{ finish_reason: 'length', message: { content: 'truncated' } }],
    });
    expect(res.stop_reason).toBe('max_tokens');
  });

  it('survives malformed tool arguments rather than crashing the turn', () => {
    const res = fromOpenAIResponse({
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: 'not json' } }],
          },
        },
      ],
    });
    expect(res.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('throws when there are no choices', () => {
    expect(() => fromOpenAIResponse({ model: 'gpt-test', choices: [] })).toThrow(OpenAIError);
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
        return new Response(
          JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }),
          { status: 200 },
        );
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
        return new Response(
          JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }),
          { status: 200 },
        );
      },
    });
    const res = await client.create(BASE);
    expect(calls).toBe(2);
    expect(res.stop_reason).toBe('end_turn');
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
    const client = new OpenAIModelClient({
      apiKey: 'sk-test',
      fetch: reply({
        model: 'gpt-test',
        choices: [{ finish_reason: 'stop', message: { content: '{"reply":"hi","claims":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    });
    const res = await client.create(BASE);
    expect(res.model).toBe('gpt-test');
    expect(res.usage.input_tokens).toBe(10);
  });
});
