import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseShopDomain } from '../shopify/domain.js';

/**
 * Shopify App Bridge session token (JWT) verification.
 *
 * This is the auth boundary for the merchant admin: everything a merchant can
 * see or change sits behind it. App Bridge mints a short-lived HS256 JWT signed
 * with the app's API secret and sends it as `Authorization: Bearer <token>`.
 *
 * Hand-rolled rather than pulling a JWT library, for one reason: the algorithm
 * check. Generic libraries have historically accepted whatever `alg` the token
 * *claims*, which is the classic forgery — a token with `"alg":"none"` and no
 * signature, or `"alg":"RS256"` verified with our HMAC secret as if it were a
 * public key. Here HS256 is the only accepted value and everything else is
 * rejected before a single byte is verified.
 */

export interface SessionTokenClaims {
  /** `https://{shop}/admin` */
  readonly iss: string;
  /** `https://{shop}` */
  readonly dest: string;
  /** Our client id. */
  readonly aud: string;
  readonly sub: string;
  readonly exp: number;
  readonly nbf: number;
  readonly iat: number;
  readonly jti?: string;
  readonly sid?: string;
}

export type VerifyResult =
  | { readonly ok: true; readonly shop: string; readonly claims: SessionTokenClaims }
  | { readonly ok: false; readonly reason: string };

/** Tolerance for clock drift between Shopify and us. */
const LEEWAY_SECONDS = 10;

export function verifySessionToken(
  token: string | undefined,
  opts: { readonly apiKey: string; readonly apiSecret: string; readonly now?: number },
): VerifyResult {
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlToBuffer(rawHeader).toString('utf8')) as typeof header;
    claims = JSON.parse(b64urlToBuffer(rawPayload).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed token' };
  }

  // Algorithm is pinned, not read. `none` and any asymmetric alg are refused
  // outright — this is the check that makes the rest meaningful.
  if (header.alg !== 'HS256') return { ok: false, reason: `unsupported alg: ${String(header.alg)}` };

  const expected = createHmac('sha256', opts.apiSecret)
    .update(`${rawHeader}.${rawPayload}`, 'utf8')
    .digest();
  const provided = b64urlToBuffer(rawSignature);
  if (expected.length !== provided.length) return { ok: false, reason: 'bad signature' };
  if (!timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad signature' };

  // --- claims -------------------------------------------------------------
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  if (typeof claims['exp'] !== 'number' || now >= claims['exp'] + LEEWAY_SECONDS) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof claims['nbf'] !== 'number' || now + LEEWAY_SECONDS < claims['nbf']) {
    return { ok: false, reason: 'token not yet valid' };
  }

  // `aud` must be OUR client id. Without this, a valid token minted for a
  // different app on the same store would authenticate here.
  if (claims['aud'] !== opts.apiKey) return { ok: false, reason: 'audience mismatch' };

  const dest = claims['dest'];
  if (typeof dest !== 'string') return { ok: false, reason: 'missing dest' };

  let destUrl: URL;
  try {
    destUrl = new URL(dest);
  } catch {
    return { ok: false, reason: 'malformed dest' };
  }
  if (destUrl.protocol !== 'https:') return { ok: false, reason: 'dest must be https' };

  const shop = parseShopDomain(destUrl.hostname);
  if (!shop.ok) return { ok: false, reason: `dest is not a shop domain: ${shop.reason ?? ''}` };

  // `iss` identifies the admin of the same shop. A mismatch means the token was
  // issued for one store and is being presented as another's.
  const iss = claims['iss'];
  if (typeof iss !== 'string' || !iss.startsWith(`${destUrl.origin}/`)) {
    return { ok: false, reason: 'iss does not match dest' };
  }

  return {
    ok: true,
    shop: shop.shop!,
    claims: claims as unknown as SessionTokenClaims,
  };
}

/** Extract a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Test/dev helper — mints a token the verifier will accept. */
export function signSessionToken(
  claims: Partial<SessionTokenClaims> & { dest: string; aud: string },
  apiSecret: string,
  alg = 'HS256',
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg, typ: 'JWT' })));
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        iss: `${claims.dest}/admin`,
        sub: '1',
        exp: now + 60,
        nbf: now - 5,
        iat: now,
        ...claims,
      }),
    ),
  );
  if (alg === 'none') return `${header}.${body}.`;
  const sig = createHmac('sha256', apiSecret).update(`${header}.${body}`, 'utf8').digest();
  return `${header}.${body}.${b64url(sig)}`;
}

function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
