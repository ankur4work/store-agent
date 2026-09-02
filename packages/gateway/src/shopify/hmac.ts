import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC verification for OAuth callbacks and webhooks.
 *
 * Every comparison is timing-safe. A plain `===` on an HMAC leaks the correct
 * value one byte at a time to an attacker who can measure response time, which
 * turns "unforgeable" into "forgeable in a few thousand requests".
 *
 * `timingSafeEqual` throws on length mismatch, so length is checked first — and
 * length alone is not secret.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the `hmac` parameter on an OAuth callback / embedded app request.
 *
 * Shopify signs the query string with the app's API secret: all parameters
 * except `hmac` and `signature`, sorted by key, joined as `key=value` with `&`.
 *
 * Takes already-decoded params (as URLSearchParams gives them) and re-encodes
 * nothing — Shopify signs the decoded values.
 */
export function verifyQueryHmac(params: URLSearchParams, apiSecret: string): boolean {
  const provided = params.get('hmac');
  if (provided === null || provided === '') return false;

  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === 'hmac' || key === 'signature') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const computed = createHmac('sha256', apiSecret).update(pairs.join('&'), 'utf8').digest('hex');
  return safeEqual(computed, provided.toLowerCase());
}

/**
 * Verify a webhook body signature.
 *
 * MUST be given the RAW body bytes. Parsing to JSON and re-serializing changes
 * whitespace and key order, so the HMAC will never match — and the tempting
 * "fix" is to skip verification, which makes every webhook endpoint forgeable
 * by anyone who knows the URL.
 */
export function verifyWebhookHmac(rawBody: Buffer, headerValue: string | undefined, apiSecret: string): boolean {
  if (headerValue === undefined || headerValue === '') return false;
  const computed = createHmac('sha256', apiSecret).update(rawBody).digest('base64');
  return safeEqual(computed, headerValue);
}
