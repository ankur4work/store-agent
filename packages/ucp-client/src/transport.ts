import { UcpRpcError, UcpTimeoutError, UcpTransportError, isRetryable } from './errors.js';
import type { UcpMeta, UcpTool } from './types.js';

/**
 * Longest we will sit on a Retry-After before giving up.
 *
 * A shopper waiting three seconds for an answer is fine. A shopper waiting
 * thirty is gone, and an honest "I can't reach the catalog" beats a spinner.
 */
const MAX_RETRY_AFTER_MS = 3000;

/** Retry-After the storefront asked for, in ms, if it asked for one. */
function retryAfterMsOf(err: unknown): number | undefined {
  const ms = (err as { detail?: { retryAfterMs?: unknown } } | undefined)?.detail?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly method: 'tools/call';
  readonly id: number;
  readonly params: { readonly name: UcpTool; readonly arguments: Record<string, unknown> };
}

export interface JsonRpcResponse<T> {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: {
    readonly structuredContent?: T;
    readonly isError?: boolean;
    /**
     * Where a tool-level failure explains itself. An MCP tool error comes
     * back as a normal JSON-RPC RESULT carrying `isError: true` and prose
     * here — there is no `error` member and no `structuredContent`.
     */
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface TransportOptions {
  /** Shop domain, e.g. `acme.myshopify.com`. */
  readonly shopDomain: string;
  /** Our published UCP agent profile URI. */
  readonly agentProfile: string;
  /** Per-request deadline. Default 2500ms — a shopper is waiting. */
  readonly timeoutMs?: number;
  /** Retry attempts for retryable failures. Default 2. */
  readonly maxRetries?: number;
  /** Injectable for tests / mock server. */
  readonly fetch?: typeof globalThis.fetch;
  /** Override the endpoint entirely (mock server in tests). */
  readonly endpoint?: string;
  readonly onTiming?: (t: ToolTiming) => void;
}

export interface ToolTiming {
  readonly tool: UcpTool;
  readonly ms: number;
  readonly attempt: number;
  readonly ok: boolean;
}

let nextId = 1;

export class UcpTransport {
  readonly endpoint: string;
  private readonly agentProfile: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly onTiming: ((t: ToolTiming) => void) | undefined;

  constructor(opts: TransportOptions) {
    this.endpoint = opts.endpoint ?? `https://${opts.shopDomain}/api/ucp/mcp`;
    this.agentProfile = opts.agentProfile;
    this.timeoutMs = opts.timeoutMs ?? 2500;
    this.maxRetries = opts.maxRetries ?? 2;
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.onTiming = opts.onTiming;
  }

  /**
   * Build the `meta` block.
   *
   * **SPIKE-OPEN-QUESTION #1 is resolved.** The docs write this as
   * `meta.ucp-agent.profile`, which reads equally as a literal dotted key or as
   * a path through nested objects. It is the path: `ucp-agent` is an object
   * with a `profile` field.
   *
   * Settled empirically against a live store on 2026-09-05, because the two
   * encodings fail differently and that difference is the evidence:
   *
   *   {"ucp-agent.profile": url}      → "Missing profile uri"  (never found)
   *   {"ucp-agent": {profile: url}}   → "Http error"           (found, fetched)
   *
   * The second reached the fetch, which is only possible if the URI was read.
   * Phase 0 guessed the dotted form and it would have failed against every
   * real store — the spike could not settle it because it never had one.
   */
  buildMeta(idempotencyKey?: string): UcpMeta {
    return idempotencyKey === undefined
      ? { 'ucp-agent': { profile: this.agentProfile } }
      : { 'ucp-agent': { profile: this.agentProfile }, 'idempotency-key': idempotencyKey };
  }

  async call<T>(
    tool: UcpTool,
    args: Record<string, unknown>,
    opts?: { readonly idempotencyKey?: string; readonly signal?: AbortSignal },
  ): Promise<T> {
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: nextId++,
      params: {
        name: tool,
        arguments: { meta: this.buildMeta(opts?.idempotencyKey), ...args },
      },
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const started = performance.now();
      try {
        const result = await this.once<T>(tool, body, opts?.signal);
        this.onTiming?.({ tool, ms: performance.now() - started, attempt, ok: true });
        return result;
      } catch (err) {
        this.onTiming?.({ tool, ms: performance.now() - started, attempt, ok: false });
        lastErr = err;
        if (!isRetryable(err) || attempt === this.maxRetries) break;
        /**
         * Honour Retry-After, capped. A rate limit is not a failure, it is
         * an instruction to wait — and a shopper will wait two seconds far
         * more happily than they will accept "I can't load the catalog".
         * Capped so a long Retry-After does not strand the turn; past the
         * cap we fail and the answer degrades honestly.
         */
        const wait = retryAfterMsOf(err);
        if (wait !== undefined) {
          await sleep(Math.min(wait, MAX_RETRY_AFTER_MS));
          continue;
        }
        // Exponential backoff with full jitter. A shopper is waiting, so the
        // ceiling is deliberately low.
        const backoff = Math.min(2 ** attempt * 50, 400);
        await sleep(Math.random() * backoff);
      }
    }
    throw lastErr;
  }

  private async once<T>(tool: UcpTool, body: JsonRpcRequest, outer?: AbortSignal): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const onOuterAbort = () => ctl.abort();
    outer?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const res = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });

      if (!res.ok) {
        /**
         * Carry Retry-After forward when the storefront rate-limits us.
         *
         * A 429 was retryable already, but with the same 50-400ms jittered
         * backoff as everything else — which is nothing against a limit
         * measured in seconds. Every search then failed all three attempts
         * in under a second, and the shopper was told the catalog could not
         * be loaded and offered a human, for a condition that clears on its
         * own.
         *
         * Shopify says how long to wait. Waiting is the whole fix.
         */
        const retryAfter = res.headers.get('retry-after');
        const parsed = retryAfter === null ? NaN : Math.round(Number(retryAfter) * 1000);
        throw new UcpTransportError(`UCP ${tool} → HTTP ${res.status}`, res.status, {
          tool,
          ...(Number.isFinite(parsed) && parsed > 0 ? { retryAfterMs: parsed } : {}),
        });
      }

      const json = (await res.json()) as JsonRpcResponse<T>;

      if (json.error) {
        throw new UcpRpcError(`UCP ${tool} → ${json.error.message}`, {
          tool,
          code: json.error.code,
          data: json.error.data,
        });
      }
      // A tool-level failure is a RESULT, not a JSON-RPC error: `isError:
      // true` with the reason in `content`. Both were declared and neither
      // was read, so every one of them surfaced as the same opaque "missing
      // result.structuredContent" — which is true, and says nothing. A cart
      // that would not open cost an afternoon for exactly that reason.
      if (json.result?.isError === true || json.result?.content !== undefined) {
        const said = (json.result.content ?? [])
          .map((c) => c.text)
          .filter((t): t is string => typeof t === 'string' && t !== '')
          .join('; ');
        if (json.result.structuredContent === undefined) {
          throw new UcpRpcError(`UCP ${tool} → ${said === '' ? 'tool reported an error' : said}`, {
            tool,
          });
        }
      }
      if (json.result?.structuredContent === undefined) {
        throw new UcpTransportError(`UCP ${tool} → missing result.structuredContent`, res.status, { tool });
      }
      return json.result.structuredContent;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (outer?.aborted) throw err;
        throw new UcpTimeoutError(`UCP ${tool} → timeout after ${this.timeoutMs}ms`, undefined, { tool });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
