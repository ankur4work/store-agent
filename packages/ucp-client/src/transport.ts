import { UcpRpcError, UcpTimeoutError, UcpTransportError, isRetryable } from './errors.js';
import type { UcpMeta, UcpTool } from './types.js';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly method: 'tools/call';
  readonly id: number;
  readonly params: { readonly name: UcpTool; readonly arguments: Record<string, unknown> };
}

export interface JsonRpcResponse<T> {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: { readonly structuredContent?: T; readonly isError?: boolean };
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
   * Build the `meta` block. Encoded as dotted keys — see SPIKE-OPEN-QUESTION #1
   * in types.ts. Isolated here so the alternative nested encoding is a
   * one-function change.
   */
  buildMeta(idempotencyKey?: string): UcpMeta {
    return idempotencyKey === undefined
      ? { 'ucp-agent.profile': this.agentProfile }
      : { 'ucp-agent.profile': this.agentProfile, 'idempotency-key': idempotencyKey };
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
        throw new UcpTransportError(`UCP ${tool} → HTTP ${res.status}`, res.status, { tool });
      }

      const json = (await res.json()) as JsonRpcResponse<T>;

      if (json.error) {
        throw new UcpRpcError(`UCP ${tool} → ${json.error.message}`, {
          tool,
          code: json.error.code,
          data: json.error.data,
        });
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
