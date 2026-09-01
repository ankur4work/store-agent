import { describe, expect, it } from 'vitest';
import { ESCALATION_REPLY, Orchestrator, parseGrounded } from '../src/loop.js';
import { detectFrustration, route } from '../src/router.js';
import { OPENAI_MODELS, resolveModels } from '../src/model.js';
import { planSpeculation, speculationMatches } from '../src/speculate.js';
import {
  CATALOG_PAYLOAD,
  MERCHANT,
  MockModel,
  MockTools,
  rawTextResponse,
  refusalResponse,
  textResponse,
  toolCallResponse,
} from './harness.js';
import type { TurnInput } from '../src/loop.js';

const INPUT: TurnInput = {
  message: 'looking for a warm wool coat',
  context: { sessionId: 'sess_1', page: { type: 'collection', title: 'Outerwear' } },
  merchant: MERCHANT,
};

function tools(): MockTools {
  return new MockTools({
    search_catalog: () => CATALOG_PAYLOAD,
    get_product: () => ({ product: CATALOG_PAYLOAD.products[0] }),
    get_policy: () => ({ topic: 'shipping', text: 'Arrives in 3-5 business days.' }),
    escalate_to_human: () => ({ ok: true }),
  });
}

const GOOD_REPLY = {
  reply: 'The Merino Wool Overcoat is $189.00 and size M is available.',
  claims: [
    { assertion: 'overcoat is $189.00', kind: 'price', source_tool_call_id: 'call_1' },
    { assertion: 'size M is available', kind: 'stock', source_tool_call_id: 'call_1' },
  ],
};

describe('happy path', () => {
  it('calls a tool, grounds the answer, and returns it', async () => {
    const model = new MockModel([
      toolCallResponse('call_1', 'search_catalog', { query: 'warm wool coat' }),
      textResponse(GOOD_REPLY),
    ]);
    const t = tools();
    const res = await new Orchestrator({ model, tools: t }).runTurn(INPUT);

    expect(res.escalated).toBe(false);
    expect(res.verdict.ok).toBe(true);
    expect(res.reply).toContain('$189.00');
    expect(res.attempts).toBe(1);
    expect(res.toolResults).toHaveLength(1);
  });

  it('sends the cached prefix and a deterministic tool list on every request', async () => {
    const model = new MockModel([
      toolCallResponse('call_1', 'search_catalog', { query: 'warm wool coat' }),
      textResponse(GOOD_REPLY),
    ]);
    await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);

    const [a, b] = model.requests;
    expect(a!.system[0]!.cache_control).toBeDefined();
    expect(a!.system[0]!.text).toBe(b!.system[0]!.text);
    expect(a!.tools!.map((t) => t.name)).toEqual(b!.tools!.map((t) => t.name));
  });

  it('keeps adaptive thinking ON and uses effort as the latency lever', async () => {
    const model = new MockModel([textResponse({ reply: 'What size?', claims: [] })]);
    await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);

    // Disabling thinking on Sonnet 5 makes it less likely to call tools, which
    // would silently degrade grounding. See ARCHITECTURE.md §7.2.
    expect(model.requests[0]!.thinking).toEqual({ type: 'adaptive' });
    expect(model.requests[0]!.output_config?.effort).toBe('low');
  });

  it('reports cache-read tokens so a caching regression is observable', async () => {
    const model = new MockModel([textResponse({ reply: 'What size?', claims: [] })]);
    const res = await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);
    expect(res.usage.cacheRead).toBeGreaterThan(0);
    expect(res.prefixFingerprint).toHaveLength(16);
  });
});

describe('speculative tool execution', () => {
  it('serves the model a prefetched search without a second call', async () => {
    const model = new MockModel([
      toolCallResponse('call_1', 'search_catalog', { query: 'warm wool coat' }),
      textResponse(GOOD_REPLY),
    ]);
    const t = tools();
    const res = await new Orchestrator({ model, tools: t }).runTurn(INPUT);

    // Speculation fired once; the model's call was served from it.
    expect(t.countOf('search_catalog')).toBe(1);
    expect(res.events.some((e) => e.type === 'speculation_hit')).toBe(true);
  });

  it('falls back to a real call when the model searches for something else', async () => {
    const model = new MockModel([
      toolCallResponse('call_1', 'search_catalog', { query: 'silk evening gown formal' }),
      textResponse({ ...GOOD_REPLY, claims: [] , reply: 'Here are some options.' }),
    ]);
    const t = tools();
    const res = await new Orchestrator({ model, tools: t }).runTurn(INPUT);

    expect(t.countOf('search_catalog')).toBe(2); // speculation + real
    expect(res.events.some((e) => e.type === 'speculation_miss')).toBe(true);
  });

  it('does not speculate on support intent', async () => {
    const model = new MockModel([textResponse({ reply: 'Let me check that.', claims: [] })]);
    const t = tools();
    await new Orchestrator({ model, tools: t }).runTurn({
      ...INPUT,
      message: 'where is my order?',
    });
    expect(t.countOf('search_catalog')).toBe(0);
  });
});

describe('grounding gate', () => {
  it('retries once with the specific violations as feedback', async () => {
    const model = new MockModel([
      toolCallResponse('call_1', 'search_catalog', { query: 'warm wool coat' }),
      textResponse({ reply: 'It is $129.00.', claims: [] }), // fabricated price
      toolCallResponse('call_2', 'search_catalog', { query: 'warm wool coat' }),
      textResponse(GOOD_REPLY),
    ]);
    const res = await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);

    expect(res.attempts).toBe(2);
    expect(res.escalated).toBe(false);
    expect(res.verdict.ok).toBe(true);
    expect(res.events.some((e) => e.type === 'grounding_retry')).toBe(true);

    // The retry prompt names the failure rather than saying "try again".
    const retryMsg = model.requests[2]!.messages.at(-1)!.content as string;
    expect(retryMsg).toContain('uncited_price');
  });

  it('escalates rather than shipping an ungrounded answer twice', async () => {
    const model = new MockModel([
      toolCallResponse('call_1', 'search_catalog', { query: 'warm wool coat' }),
      textResponse({ reply: 'It is $129.00.', claims: [] }),
      toolCallResponse('call_2', 'search_catalog', { query: 'warm wool coat' }),
      textResponse({ reply: 'Actually it is $139.00.', claims: [] }),
    ]);
    const res = await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);

    expect(res.escalated).toBe(true);
    expect(res.reply).toBe(ESCALATION_REPLY);
    expect(res.reply).not.toContain('$129');
    expect(res.reply).not.toContain('$139');
  });

  it('never returns a dead end — the escalation offers a next step', () => {
    expect(ESCALATION_REPLY).toMatch(/email|team/i);
  });
});

describe('failure modes', () => {
  it('escalates on a model refusal instead of reading empty content', async () => {
    const model = new MockModel([refusalResponse()]);
    const res = await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);
    expect(res.escalated).toBe(true);
    expect(res.reply).toBe(ESCALATION_REPLY);
  });

  it('escalates on unparseable structured output', async () => {
    const model = new MockModel([rawTextResponse('I am not JSON at all')]);
    const res = await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);
    expect(res.escalated).toBe(true);
  });

  it('survives a failing tool by handing the error to the model', async () => {
    const failing = new MockTools({
      search_catalog: () => {
        throw new Error('UCP 503');
      },
    });
    const model = new MockModel([
      toolCallResponse('call_1', 'search_catalog', { query: 'warm wool coat' }),
      textResponse({ reply: 'I could not reach the catalog just now.', claims: [] }),
    ]);
    const res = await new Orchestrator({ model, tools: failing }).runTurn(INPUT);

    expect(res.escalated).toBe(false);
    expect(res.toolResults[0]!.result).toMatchObject({ error: true });
  });

  it('escalates when the model loops on tools without answering', async () => {
    const model = new MockModel(
      Array.from({ length: 12 }, (_, i) => toolCallResponse(`call_${i}`, 'search_catalog', { query: 'x' })),
    );
    const res = await new Orchestrator({ model, tools: tools() }).runTurn(INPUT);
    expect(res.escalated).toBe(true);
  });
});

describe('routing', () => {
  // Provider-neutral: assert against the configured tier map, never a literal
  // model id. Ids are configuration and change without notice.
  const MODELS = { classify: 'tier-classify', workhorse: 'tier-workhorse', escalation: 'tier-escalation' };

  it('defaults to the workhorse tier at low effort', () => {
    const r = route({ toolDepth: 0 }, MODELS);
    expect(r.model).toBe(MODELS.workhorse);
    expect(r.effort).toBe('low');
  });

  it('escalates on frustration', () => {
    expect(route({ toolDepth: 0, frustration: true }, MODELS).model).toBe(MODELS.escalation);
  });

  it('escalates when the tool loop is stuck', () => {
    expect(route({ toolDepth: 4 }, MODELS).tier).toBe('escalation');
  });

  it('raises effort but keeps the model on a grounding retry', () => {
    // Switching models mid-conversation would invalidate the prompt cache —
    // caches are model-scoped on every provider.
    const r = route({ toolDepth: 0, groundingRetry: true }, MODELS);
    expect(r.model).toBe(MODELS.workhorse);
    expect(r.effort).toBe('medium');
  });

  it('defaults to the OpenAI tier map when none is supplied', () => {
    expect(route({ toolDepth: 0 }).model).toBe(OPENAI_MODELS.workhorse);
  });

  it('resolves model ids from env so they never require a code change', () => {
    const m = resolveModels({ MODEL_WORKHORSE: 'custom-model' });
    expect(m.workhorse).toBe('custom-model');
    expect(m.escalation).toBe(OPENAI_MODELS.escalation);
  });

  it.each([
    'can I speak to a human',
    'this is useless',
    'you are not helping',
  ])('detects frustration: %s', (t) => {
    expect(detectFrustration(t)).toBe(true);
  });

  it('does not see frustration in an ordinary question', () => {
    expect(detectFrustration('do you have this in medium?')).toBe(false);
  });
});

describe('speculation planning', () => {
  it.each([
    'looking for a warm coat',
    'show me something under $100',
    'do you have wool scarves',
    'recommend a gift for my mum',
  ])('speculates on: %s', (m) => {
    expect(planSpeculation(m).shouldSearch).toBe(true);
  });

  it.each([
    'where is my order',
    'what is your return policy',
    'I want a refund',
    'can I speak to someone',
  ])('does not speculate on: %s', (m) => {
    expect(planSpeculation(m).shouldSearch).toBe(false);
  });

  it('ignores trivially short input', () => {
    expect(planSpeculation('hi').shouldSearch).toBe(false);
  });

  it('matches a rephrased query', () => {
    expect(speculationMatches('warm wool coat', 'wool coat warm winter')).toBe(true);
  });

  it('rejects an unrelated query', () => {
    expect(speculationMatches('warm wool coat', 'silk evening gown')).toBe(false);
  });
});

describe('parseGrounded', () => {
  it('parses a valid payload', () => {
    expect(parseGrounded('{"reply":"hi","claims":[]}')).toEqual({ reply: 'hi', claims: [] });
  });
  it.each(['', 'not json', '{"reply":123,"claims":[]}', '{"reply":"x"}', 'null'])(
    'rejects invalid payload: %s',
    (t) => {
      expect(parseGrounded(t)).toBeUndefined();
    },
  );
});
