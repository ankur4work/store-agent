/**
 * OpenAI adapter for the provider-neutral `ModelClient` seam.
 *
 * Raw REST rather than the SDK, deliberately: the adapter is a thin translation
 * layer, the wire format is what we actually need to reason about while nothing
 * has been verified live, and it reuses the timeout/retry discipline already
 * established in the UCP transport. Swap to the official SDK when we add
 * streaming (it has better SSE ergonomics than hand-rolled parsing).
 */
import type {
  ContentBlock,
  Message,
  ModelClient,
  ModelRequest,
  ModelResponse,
  StopReason,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../model.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export interface OpenAIClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Per-request deadline. A shopper is waiting. */
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly organization?: string;
}

export class OpenAIError extends Error {
  override readonly name: string = 'OpenAIError';
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
  }
}

export class OpenAITimeoutError extends OpenAIError {
  override readonly name = 'OpenAITimeoutError';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ChatCompletionResponse {
  readonly model: string;
  readonly choices: readonly {
    readonly finish_reason: string;
    readonly message: {
      readonly content: string | null;
      readonly refusal?: string | null;
      readonly tool_calls?: readonly {
        readonly id: string;
        readonly type: 'function';
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
}

export class OpenAIModelClient implements ModelClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(private readonly opts: OpenAIClientOptions) {
    if (!opts.apiKey) throw new TypeError('OpenAIModelClient requires an apiKey');
    this.endpoint = opts.baseUrl ?? ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  async create(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const body = toOpenAIRequest(req);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.once(body, signal);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.maxRetries) break;
        await sleep(Math.random() * Math.min(2 ** attempt * 100, 800));
      }
    }
    throw lastErr;
  }

  private async once(body: Record<string, unknown>, outer?: AbortSignal): Promise<ModelResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const onAbort = (): void => ctl.abort();
    outer?.addEventListener('abort', onAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      };
      if (this.opts.organization !== undefined) headers['openai-organization'] = this.opts.organization;

      const res = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OpenAIError(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
      }
      return fromOpenAIResponse((await res.json()) as ChatCompletionResponse);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (outer?.aborted) throw err;
        throw new OpenAITimeoutError(`OpenAI request exceeded ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

/**
 * OpenAI reasoning effort accepts low | medium | high. Our seam carries the
 * five-level Anthropic ladder, so the top two collapse. Documented rather than
 * silently clamped, because it changes cost.
 */
function mapEffort(effort: string | undefined): 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

export function toOpenAIRequest(req: ModelRequest): Record<string, unknown> {
  // The cached prefix goes first and unchanged. OpenAI caches automatically on
  // prefixes over ~1024 tokens — there are no breakpoints to place, which makes
  // the prefix-stability guard in prompt.ts MORE load-bearing, not less: an
  // unstable prefix silently loses the discount with nothing in the response
  // shape to reveal it.
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: req.system.map((b) => b.text).join('\n\n') },
  ];

  for (const m of req.messages) messages.push(...toOpenAIMessages(m));

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_completion_tokens: req.max_tokens,
  };

  if (req.tools && req.tools.length > 0) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema, strict: true },
    }));
  }

  const effort = mapEffort(req.output_config?.effort);
  if (effort !== undefined) body['reasoning_effort'] = effort;

  const format = req.output_config?.format as { schema?: unknown } | undefined;
  if (format?.schema !== undefined) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: 'grounded_response', schema: format.schema, strict: true },
    };
  }

  return body;
}

function toOpenAIMessages(m: Message): Record<string, unknown>[] {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];

  const blocks = m.content as readonly (ContentBlock | ToolResultBlock)[];

  // Tool results become one `tool` message per result.
  const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result');
  if (toolResults.length > 0) {
    return toolResults.map((r) => ({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content }));
  }

  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');

  const msg: Record<string, unknown> = { role: m.role, content: text === '' ? null : text };
  if (toolUses.length > 0) {
    msg['tool_calls'] = toolUses.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.input) },
    }));
  }
  return [msg];
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string, refused: boolean): StopReason {
  if (refused) return 'refusal';
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function fromOpenAIResponse(res: ChatCompletionResponse): ModelResponse {
  const choice = res.choices[0];
  if (choice === undefined) throw new OpenAIError('OpenAI returned no choices');

  const refusal = choice.message.refusal ?? null;
  const refused = refusal !== null && refusal !== '';

  const content: ContentBlock[] = [];
  if (!refused && choice.message.content !== null && choice.message.content !== '') {
    content.push({ type: 'text', text: choice.message.content });
  }
  for (const call of choice.message.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: safeParseArgs(call.function.arguments),
    });
  }

  const usage: Usage = {
    input_tokens: res.usage?.prompt_tokens ?? 0,
    output_tokens: res.usage?.completion_tokens ?? 0,
    cache_read_input_tokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  const out: ModelResponse = {
    model: res.model,
    stop_reason: mapFinishReason(choice.finish_reason, refused),
    content,
    usage,
  };
  return refused ? { ...out, stop_details: { category: 'refusal' } } : out;
}

/** Tool arguments arrive as a JSON string; a malformed one must not crash the turn. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAITimeoutError) return true;
  if (err instanceof OpenAIError) {
    const s = err.status;
    if (s === undefined) return true;
    return s === 408 || s === 409 || s === 429 || s >= 500;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
