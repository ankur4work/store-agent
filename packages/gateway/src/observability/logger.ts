/**
 * Structured logging.
 *
 * ## The rule this file exists to enforce
 *
 * **Shopper conversation content must never be logged.** What someone types
 * into a shopping assistant is a record of what they want, what they can
 * afford, and sometimes what they are treating — it is exactly the kind of
 * data that should not accumulate in a log file that gets shipped to a
 * third-party service and retained for a year.
 *
 * Relying on every future call site to remember that is how it leaks. So
 * redaction happens *here*, on the way out, keyed on field name: a field
 * called `message`, `reply`, `transcript` or `accessToken` is replaced no
 * matter who passed it or why. A call site that logs a shopper's question by
 * accident produces `"[redacted]"`, not the question.
 *
 * The obvious objection is that this makes debugging harder — and it does.
 * That is the trade, taken deliberately: correlate with `sessionId` and
 * `turnId`, which identify a conversation without revealing it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names whose values never leave the process.
 *
 * Matched case-insensitively as a substring, so `shopifyAccessToken` and
 * `access_token` are both caught. Deliberately broad: a false positive costs a
 * redacted debug field, a false negative costs a leak.
 */
const REDACT = [
  // Credentials.
  'token',
  'secret',
  'password',
  'apikey',
  'api_key',
  'authorization',
  'signature',
  'hmac',
  'cookie',
  // Shopper content.
  'message',
  'reply',
  'text',
  'transcript',
  'utterance',
  'query',
  'content',
  'prompt',
  'email',
];

const REDACTED = '[redacted]';

export function shouldRedact(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT.some((needle) => k.includes(needle));
}

/**
 * Deep-redact a value for logging.
 *
 * Depth-limited and breadth-limited: a log call must not be able to stall the
 * event loop by walking a huge object, and a cyclic structure must not hang.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // A long string in a log line is almost always something that should not
    // be there. Truncate rather than ship it.
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redact(v, depth + 1, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= 40) {
      out['…'] = '[truncated]';
      break;
    }
    out[k] = shouldRedact(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** JSON lines for a log pipeline; pretty for a terminal. */
  readonly json: boolean;
  readonly sink?: (line: string) => void;
  readonly now?: () => number;
}

export class Logger {
  private readonly minimum: number;

  constructor(
    private readonly opts: LoggerOptions,
    private readonly base: Record<string, unknown> = {},
  ) {
    this.minimum = ORDER[opts.level];
  }

  /** A logger that stamps every line with extra fields. */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.opts, { ...this.base, ...fields });
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.write('debug', event, fields);
  }
  info(event: string, fields?: Record<string, unknown>): void {
    this.write('info', event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>): void {
    this.write('warn', event, fields);
  }
  error(event: string, fields?: Record<string, unknown>): void {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < this.minimum) return;

    const record = {
      ts: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
      level,
      event,
      ...(redact({ ...this.base, ...fields }) as Record<string, unknown>),
    };

    const line = this.opts.json
      ? JSON.stringify(record)
      : `${record.ts} ${level.toUpperCase().padEnd(5)} ${event} ${formatPretty(record)}`;

    (this.opts.sink ?? defaultSink(level))(line);
  }
}

function formatPretty(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(record)) {
    if (k === 'ts' || k === 'level' || k === 'event') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(' ');
}

function defaultSink(level: LogLevel): (line: string) => void {
  // Errors and warnings to stderr so a log pipeline can separate them without
  // parsing.
  return level === 'error' || level === 'warn'
    ? (l) => process.stderr.write(`${l}\n`)
    : (l) => process.stdout.write(`${l}\n`);
}

export function createLogger(production: boolean, level?: LogLevel): Logger {
  return new Logger({
    level: level ?? (production ? 'info' : 'debug'),
    // JSON in production for machine parsing; human-readable locally, where
    // the reader is a person.
    json: production,
  });
}
