export class UcpError extends Error {
  override readonly name: string = 'UcpError';
  constructor(
    message: string,
    readonly detail?: { readonly tool?: string; readonly code?: number | string; readonly data?: unknown },
  ) {
    super(message);
  }
}

/** JSON-RPC returned an `error` member. */
export class UcpRpcError extends UcpError {
  override readonly name: string = 'UcpRpcError';
}

/**
 * Non-2xx HTTP, or a malformed envelope.
 * `name` is widened to `string` so subclasses can narrow it.
 */
export class UcpTransportError extends UcpError {
  override readonly name: string = 'UcpTransportError';
  constructor(message: string, readonly status?: number, detail?: UcpError['detail']) {
    super(message, detail);
  }
}

/** Request exceeded its deadline. */
export class UcpTimeoutError extends UcpTransportError {
  override readonly name: string = 'UcpTimeoutError';
}

/**
 * Raised by the cart safety layer when a write would destroy data.
 * This should never surface in production — it means a caller bypassed
 * SafeCart and hand-built an `update_cart` payload.
 */
export class UnsafeCartWriteError extends UcpError {
  override readonly name = 'UnsafeCartWriteError';
  constructor(message: string, readonly droppedFields: readonly string[]) {
    super(message, { tool: 'update_cart', data: { droppedFields } });
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof UcpTimeoutError) return true;
  if (err instanceof UcpTransportError) {
    // 408 / 429 / 5xx are retryable; 4xx otherwise is not.
    const s = err.status;
    if (s === undefined) return true; // network-level failure
    return s === 408 || s === 429 || s >= 500;
  }
  return false;
}
