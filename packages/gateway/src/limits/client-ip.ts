import type { IncomingMessage } from 'node:http';

/**
 * Identify the client for rate-limiting purposes.
 *
 * This is the piece that decides whether the limiter is real or decorative.
 * `X-Forwarded-For` is a request header, so anyone can send one. A limiter that
 * trusts it blindly can be evaded completely by varying a forged header, and is
 * *worse* than no limiter — it fills the bucket store with attacker-chosen keys
 * while letting every request through.
 *
 * So the header is trusted only as far as the deployment actually warrants:
 *
 *   client → Traefik → app        TRUST_PROXY_HOPS=1
 *   client → Cloudflare → Traefik → app   TRUST_PROXY_HOPS=2
 *   app exposed directly          TRUST_PROXY_HOPS=0  (default)
 *
 * Each proxy *appends* the address it saw. With one trusted hop the only
 * trustworthy entry is therefore the last one — our own proxy wrote it, and
 * everything to its left is attacker-supplied. With N hops, the client sits N
 * from the right.
 *
 * The default of 0 ignores the header entirely and uses the socket address,
 * which cannot be forged. Getting this wrong in the safe direction throttles a
 * shared proxy's users together; getting it wrong in the unsafe direction
 * disables the limiter silently.
 */

export interface ClientIdOptions {
  /** Number of proxies between the internet and this process. */
  readonly trustProxyHops: number;
}

export function clientKey(req: IncomingMessage, opts: ClientIdOptions): string {
  return normalize(rawClientIp(req, opts.trustProxyHops));
}

function rawClientIp(req: IncomingMessage, hops: number): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (hops <= 0) return socketIp;

  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  if (chain.length === 0) return socketIp;

  // N trusted hops → the client is N from the right. If the chain is shorter
  // than expected the request did not traverse the proxies we think it did, so
  // fall back to the leftmost entry rather than reaching past the start.
  const index = chain.length - hops;
  return chain[Math.max(0, index)] ?? socketIp;
}

/**
 * Reduce an address to the unit worth limiting.
 *
 * For IPv6 that unit is the `/64` prefix, not the individual address. Residential
 * IPv6 allocations are a /64 at minimum and often a /56, so limiting per
 * address lets a single attacker rotate through billions of addresses for free
 * — the limiter would never fire and the bucket store would balloon.
 */
export function normalize(ip: string): string {
  let addr = ip.trim().toLowerCase();

  // Strip a bracketed port: [::1]:443
  const bracket = /^\[(.+)\](?::\d+)?$/.exec(addr);
  if (bracket?.[1] !== undefined) addr = bracket[1];

  // IPv4-mapped IPv6, which is how Node reports IPv4 on a dual-stack socket.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1] !== undefined) addr = mapped[1];

  // Bare IPv4 with a port.
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(addr);
  if (v4WithPort?.[1] !== undefined) addr = v4WithPort[1];

  if (!addr.includes(':')) return addr; // IPv4 — limit per address

  return ipv6Prefix64(addr);
}

/** First four hextets of an IPv6 address, expanded through any `::`. */
function ipv6Prefix64(addr: string): string {
  const [head = '', tail = ''] = addr.includes('::') ? addr.split('::', 2) : [addr, undefined as never];

  let groups: string[];
  if (addr.includes('::')) {
    const left = head === '' ? [] : head.split(':');
    const right = tail === '' ? [] : tail.split(':');
    const missing = Math.max(0, 8 - left.length - right.length);
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    groups = addr.split(':');
  }

  return groups
    .slice(0, 4)
    .map((g) => (g === '' ? '0' : g.replace(/^0+(?=.)/, '')))
    .join(':');
}
