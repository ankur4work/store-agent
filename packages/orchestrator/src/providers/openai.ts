/**
 * OpenAI adapter for the provider-neutral `ModelClient` seam.
 *
 * Targets the Responses API (`POST /v1/responses`), NOT Chat Completions.
 *
 * That is forced, not stylistic: on Chat Completions, function tools and
 * `reasoning_effort` are mutually exclusive for the gpt-5.6 family —
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-terra
 *    in /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * We need both. Every turn is tool-driven (tool-calling rate *is* grounding
 * rate) and effort is our latency/cost lever (ARCHITECTURE.md §7.2), so
 * dropping either is not on the table.
 *
 * Raw REST rather than the SDK: the adapter is a thin translation layer, the
 * wire shape is exactly what we need to reason about, and it reuses the
 * timeout/retry discipline from the UCP transport. Revisit when we add
 * streaming — the SDK has better SSE ergonomics than hand-rolled parsing.
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

const ENDPOINT = 'https://api.openai.com/v1/responses';

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

interface ResponsesOutputContent {
  readonly type: string;
  readonly text?: string;
  readonly refusal?: string;
}

interface ResponsesOutputItem {
  readonly type: string;
  readonly role?: string;
  readonly content?: readonly ResponsesOutputContent[];
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

interface ResponsesApiResponse {
  readonly model: string;
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string };
  readonly output?: readonly ResponsesOutputItem[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
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
        throw new OpenAIError(`OpenAI HTTP ${res.status}: ${text.slice(0, 400)}`, res.status, text);
      }
      return fromOpenAIResponse((await res.json()) as ResponsesApiResponse);
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
 * Our seam carries the five-level Anthropic effort ladder; OpenAI exposes
 * three. The top two collapse. Documented rather than silently clamped,
 * because it changes cost.
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
  // The cached prefix goes in `instructions`, first and unchanged. OpenAI
  // caches automatically on prefixes over ~1024 tokens — there are no
  // breakpoints to place, which makes the prefix-stability guard in prompt.ts
  // MORE load-bearing, not less: an unstable prefix silently loses the discount
  // with nothing in the response shape to reveal it.
  const input: Record<string, unknown>[] = [];
  for (const m of req.messages) input.push(...toResponsesInput(m));

  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system.map((b) => b.text).join('\n\n'),
    input,
    max_output_tokens: req.max_tokens,
    store: false,
  };

  if (req.tools && req.tools.length > 0) {
    // Responses API takes a FLAT function tool — no nested `function` object.
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: toStrictSchema(t.input_schema),
      strict: true,
    }));
  }

  const effort = mapEffort(req.output_config?.effort);
  if (effort !== undefined) body['reasoning'] = { effort };

  const format = req.output_config?.format as { schema?: unknown } | undefined;
  if (format?.schema !== undefined) {
    body['text'] = {
      format: { type: 'json_schema', name: 'grounded_response', schema: format.schema, strict: true },
    };
  }

  return body;
}

/**
 * Rewrite a JSON Schema for OpenAI strict mode.
 *
 * Strict mode requires `required` to list EVERY key in `properties`, and
 * `additionalProperties: false` on every object. Our tool definitions are
 * provider-neutral and use genuinely optional parameters, so we express
 * optionality the way strict mode demands: keep the key required, but widen its
 * type to include `null`.
 *
 * Dropping `strict` would have been the easy fix. It's the wrong one — invalid
 * tool arguments produce bad tool calls, and bad tool calls produce ungrounded
 * answers, which is the exact failure this product exists to prevent.
 *
 * `null` therefore means "not supplied" on the way back; see stripNulls().
 */
export function toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const node = { ...schema };

  if (node['type'] === 'object' && typeof node['properties'] === 'object' && node['properties'] !== null) {
    const props = node['properties'] as Record<string, Record<string, unknown>>;
    const originallyRequired = new Set((node['required'] as string[] | undefined) ?? []);
    const rewritten: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(props)) {
      const child = toStrictSchema(value);
      if (!originallyRequired.has(key)) child['type'] = nullable(child['type']);
      rewritten[key] = child;
    }

    node['properties'] = rewritten;
    node['required'] = Object.keys(props);
    node['additionalProperties'] = false;
  }

  if (node['type'] === 'array' && typeof node['items'] === 'object' && node['items'] !== null) {
    node['items'] = toStrictSchema(node['items'] as Record<string, unknown>);
  }

  return node;
}

function nullable(type: unknown): unknown {
  if (typeof type === 'string') return type === 'null' ? type : [type, 'null'];
  if (Array.isArray(type)) return type.includes('null') ? type : [...type, 'null'];
  return type;
}

/**
 * Remove keys the model set to `null`. Under toStrictSchema(), null is how an
 * optional parameter is omitted — it is never a meaningful value in our tools.
 */
export function stripNulls(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null) continue;
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v)
      ? stripNulls(v as Record<string, unknown>)
      : v;
  }
  return out;
}

function toResponsesInput(m: Message): Record<string, unknown>[] {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];

  const blocks = m.content as readonly (ContentBlock | ToolResultBlock)[];

  // Tool results are top-level items, not a message role.
  const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result');
  if (toolResults.length > 0) {
    return toolResults.map((r) => ({
      type: 'function_call_output',
      call_id: r.tool_use_id,
      output: r.content,
    }));
  }

  const out: Record<string, unknown>[] = [];
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (text !== '') out.push({ role: m.role, content: text });

  for (const t of blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')) {
    out.push({
      type: 'function_call',
      call_id: t.id,
      name: t.name,
      arguments: JSON.stringify(t.input),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

export function fromOpenAIResponse(res: ResponsesApiResponse): ModelResponse {
  const items = res.output ?? [];
  const content: ContentBlock[] = [];
  let refused = false;

  for (const item of items) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'refusal' && c.refusal) {
          refused = true;
        } else if (c.type === 'output_text' && c.text) {
          content.push({ type: 'text', text: c.text });
        }
      }
    } else if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: item.call_id ?? '',
        name: item.name ?? '',
        input: stripNulls(safeParseArgs(item.arguments ?? '{}')),
      });
    }
    // `reasoning` items carry no content we surface — skip.
  }

  const usage: Usage = {
    input_tokens: res.usage?.input_tokens ?? 0,
    output_tokens: res.usage?.output_tokens ?? 0,
    cache_read_input_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
  };

  const out: ModelResponse = {
    model: res.model,
    stop_reason: deriveStopReason(res, content, refused),
    content: refused ? [] : content,
    usage,
  };
  return refused ? { ...out, stop_details: { category: 'refusal' } } : out;
}

function deriveStopReason(
  res: ResponsesApiResponse,
  content: readonly ContentBlock[],
  refused: boolean,
): StopReason {
  if (refused) return 'refusal';
  if (res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens';
  }
  if (res.incomplete_details?.reason === 'content_filter') return 'refusal';
  return content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
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
