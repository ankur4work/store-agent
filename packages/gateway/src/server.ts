import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, OpenAIModelClient, type MerchantPack } from '@storeagent/orchestrator';
import { UcpClient } from '@storeagent/ucp-client';
import type { GatewayConfig } from './config.js';
import { MemorySessionStore, newSession, type SessionStore } from './sessions.js';
import { createToolExecutor } from './tool-executor.js';
import { DEMO_CATALOG } from './catalog-fixture.js';
import { beginInstall, completeInstall } from './shopify/oauth.js';
import { handleWebhook } from './shopify/webhooks.js';
import {
  MemoryNonceStore,
  MemoryShopStore,
  type NonceStore,
  type ShopStore,
} from './shopify/shops.js';
import { bearerToken, verifySessionToken } from './admin/session-token.js';
import { renderAdmin, renderUnauthenticated } from './admin/render.js';
import {
  MemorySettingsStore,
  accentIsAccessible,
  contrastWithWhite,
  validateSettings,
  type SettingsStore,
} from './admin/settings.js';

/**
 * Gateway.
 *
 * **Transport: SSE over a plain POST, not WebSocket.**
 * The architecture specifies WebSocket, and voice (Phase 3) will genuinely need
 * a bidirectional channel. Text chat does not: the client sends one message and
 * consumes one stream. SSE-over-POST is dependency-free, survives proxies that
 * mangle upgrade requests, and needs no session-correlation dance. Revisit when
 * voice lands.
 *
 * **Runtime: Node, not Go.**
 * Also a deviation. Go's advantage is connection density at 100k+ sockets/node,
 * which is a scale problem we do not have — and a Go gateway would put a
 * process boundary between itself and the TypeScript orchestrator for no
 * present benefit. The connection-termination layer can be extracted later;
 * that is a contained change.
 */

const DEMO_MERCHANT: MerchantPack = {
  merchantId: 'demo',
  brandVoice:
    'Warm, direct, never pushy. Short sentences. No emoji. Sound like a knowledgeable shop assistant, not a brochure.',
  policySummary:
    'Free shipping over $75. Free returns within 30 days. Two-year warranty on outerwear.',
  locale: 'en-US',
  currency: 'USD',
};

export interface GatewayDeps {
  readonly config: GatewayConfig;
  readonly sessions?: SessionStore;
  readonly shops?: ShopStore;
  readonly nonces?: NonceStore;
  readonly settings?: SettingsStore;
}

export function createGateway(deps: GatewayDeps): Server {
  const { config } = deps;
  const sessions = deps.sessions ?? new MemorySessionStore();
  const shops = deps.shops ?? new MemoryShopStore();
  const nonces = deps.nonces ?? new MemoryNonceStore();
  const settings = deps.settings ?? new MemorySettingsStore();

  const model = new OpenAIModelClient({
    apiKey: config.openaiApiKey,
    timeoutMs: 90_000,
    maxRetries: 1,
  });

  const ucp =
    config.shopDomain === undefined
      ? undefined
      : new UcpClient({ shopDomain: config.shopDomain, agentProfile: config.agentProfile });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Never leak a stack trace to a storefront.
      console.error('[gateway] unhandled', err);
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    cors(res, req.headers.origin, config.allowedOrigins);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        mode: ucp ? 'live' : 'demo',
        shop: config.shopDomain ?? null,
        sessions: await sessions.size(),
        model: config.models.workhorse,
        // Never echo the secret — only whether install is wired up.
        install: config.shopify === undefined ? 'disabled' : 'ready',
        installedShops: await shops.count(),
      });
      return;
    }

    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      // Lets the demo page render a storefront without a Shopify store.
      json(res, 200, { products: DEMO_CATALOG });
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      await handleChat(req, res);
      return;
    }

    if (url.pathname.startsWith('/shopify/')) {
      await handleShopify(url, req, res);
      return;
    }

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      await handleAdmin(url, req, res);
      return;
    }

    if (req.method === 'GET' && serveStatic(url.pathname, res)) return;

    json(res, 404, { error: 'not_found' });
  }

  /**
   * Shopify install + webhooks.
   *
   * Disabled wholesale when the app is not fully configured — a half-configured
   * OAuth flow fails confusingly, and at the worst possible moment (a merchant
   * clicking Install).
   */
  async function handleShopify(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const app = config.shopify;
    if (app === undefined) {
      json(res, 503, {
        error: 'install_not_configured',
        detail: 'Set SHOPIFY_API_KEY, SHOPIFY_API_SECRET and SHOPIFY_APP_URL to enable installs.',
      });
      return;
    }
    const oauthDeps = { config: app, shops, nonces };

    if (url.pathname === '/shopify/auth' && req.method === 'GET') {
      const begun = await beginInstall(url.searchParams.get('shop'), oauthDeps);
      if (!begun.ok) {
        json(res, begun.status, { error: 'invalid_install_request', detail: begun.reason });
        return;
      }
      res.writeHead(302, { location: begun.redirectTo }).end();
      return;
    }

    if (url.pathname === '/shopify/auth/callback' && req.method === 'GET') {
      const done = await completeInstall(url.searchParams, oauthDeps);
      if (!done.ok) {
        console.warn(`[shopify] install rejected: ${done.reason}`);
        json(res, done.status, { error: 'install_failed', detail: done.reason });
        return;
      }
      console.log(`[shopify] installed ${done.shop.shop} (scopes: ${done.shop.scopes})`);
      res.writeHead(302, { location: done.redirectTo }).end();
      return;
    }

    if (url.pathname === '/shopify/webhooks' && req.method === 'POST') {
      // RAW bytes. Parsing and re-serializing changes whitespace and key order,
      // so the HMAC can never match.
      const rawBody = await readRawBody(req, 1024 * 1024);
      const outcome = await handleWebhook(
        {
          topic: header(req, 'x-shopify-topic') ?? '',
          shopHeader: header(req, 'x-shopify-shop-domain'),
          hmacHeader: header(req, 'x-shopify-hmac-sha256'),
          rawBody,
        },
        { apiSecret: app.apiSecret, shops, log: (l) => console.log(l) },
      );
      json(res, outcome.status, outcome.body);
      return;
    }

    json(res, 404, { error: 'not_found' });
  }

  /**
   * Merchant admin. Embedded inside the Shopify admin iframe.
   *
   * Authenticated by App Bridge session token, never by a `shop` query
   * parameter alone — that would let anyone view or change any merchant's
   * settings by guessing a store name.
   */
  async function handleAdmin(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const app = config.shopify;
    if (app === undefined) {
      json(res, 503, { error: 'admin_not_configured' });
      return;
    }
    const auth = { apiKey: app.apiKey, apiSecret: app.apiSecret };

    if (url.pathname === '/admin' && req.method === 'GET') {
      // Shopify puts `id_token` on the embedded app URL. Fall back to a bearer
      // header for direct fetches.
      const token = url.searchParams.get('id_token') ?? bearerToken(header(req, 'authorization'));
      const verified = verifySessionToken(token ?? undefined, auth);

      if (!verified.ok) {
        // No frame-ancestors here: we do not know which shop to trust yet.
        html(res, 401, renderUnauthenticated(verified.reason));
        return;
      }

      const shop = verified.shop;
      const vm = {
        shop,
        apiKey: app.apiKey,
        host: url.searchParams.get('host') ?? '',
        settings: await settings.get(shop),
        stats: {
          activeSessions: await sessions.size(),
          mode: (ucp ? 'live' : 'demo') as 'live' | 'demo',
          model: config.models.workhorse,
        },
        saved: url.searchParams.get('saved') === '1',
      };
      html(res, 200, renderAdmin(vm), shop);
      return;
    }

    if (url.pathname === '/admin/settings' && req.method === 'POST') {
      const verified = verifySessionToken(bearerToken(header(req, 'authorization')), auth);
      if (!verified.ok) {
        json(res, 401, { errors: ['Your session expired. Reload the page and try again.'] });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(await readBody(req, 32 * 1024)) as Record<string, unknown>;
      } catch {
        json(res, 400, { errors: ['Malformed request.'] });
        return;
      }

      // The shop comes from the VERIFIED token, never from the payload — a
      // merchant must not be able to write another store's settings by
      // editing a hidden field.
      const result = validateSettings(verified.shop, payload);
      if (!result.ok) {
        json(res, 422, { errors: result.errors });
        return;
      }
      if (!accentIsAccessible(result.settings!.accentColor)) {
        json(res, 422, {
          errors: [
            `That accent is too light for white text (${contrastWithWhite(
              result.settings!.accentColor,
            ).toFixed(1)}:1, needs 4.5:1). Pick a darker shade.`,
          ],
        });
        return;
      }

      await settings.put(result.settings!);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'not_found' });
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: ChatRequest;
    try {
      body = JSON.parse(await readBody(req, 64 * 1024)) as ChatRequest;
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }
    if (typeof body.message !== 'string' || body.message.trim() === '') {
      json(res, 400, { error: 'message_required' });
      return;
    }

    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : randomUUID();
    const session =
      (await sessions.get(sessionId)) ?? newSession(sessionId, config.shopDomain ?? 'demo.local');

    // SSE. Headers go out immediately so the client can start rendering state
    // before the model produces anything.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // defeat nginx proxy buffering
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('session', { sessionId });

    // Abort the model turn if the shopper closes the tab or navigates away.
    const ctl = new AbortController();
    req.on('close', () => ctl.abort());

    const products: unknown[] = [];
    const executor = createToolExecutor({
      session,
      ucp,
      onCartChange: (cartId) => send('cart', { cartId }),
    });

    // Wrap the executor so product results can be pushed to the UI the moment
    // they exist — skeleton cards render seconds before the prose arrives.
    const observing = {
      async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
        const result = await executor.execute(name, input, signal);
        if (name === 'search_catalog' || name === 'get_product') {
          const extracted = extractProducts(result);
          if (extracted.length > 0 && products.length === 0) {
            products.push(...extracted);
            send('products', { products: extracted });
          }
        }
        return result;
      },
    };

    const orchestrator = new Orchestrator({
      model,
      tools: observing,
      models: config.models,
      onEvent: (e) => send('trace', e),
    });

    const startedAt = Date.now();
    try {
      const result = await orchestrator.runTurn(
        {
          message: body.message,
          context: {
            sessionId,
            ...(body.page ? { page: body.page } : {}),
            ...(body.justNavigated === true ? { justNavigated: true } : {}),
          },
          merchant: DEMO_MERCHANT,
          history: session.history,
        },
        {
          signal: ctl.signal,
          onReplyDelta: (text) => send('delta', { text }),
        },
      );

      // The tripwire may have aborted a partial message — tell the client to
      // discard whatever it painted before showing the final text.
      if (result.events.some((e) => e.type === 'stream_aborted')) send('reset', {});

      send('done', {
        reply: result.reply,
        escalated: result.escalated,
        grounded: result.verdict.ok,
        attempts: result.attempts,
        ms: Date.now() - startedAt,
        usage: result.usage,
      });

      session.history = [
        ...session.history,
        { role: 'user', content: body.message },
        { role: 'assistant', content: result.reply },
      ];
      await sessions.put(session);
    } catch (err) {
      if (!ctl.signal.aborted) {
        console.error('[gateway] turn failed', err);
        send('error', { message: 'Something went wrong on our side.' });
      }
    } finally {
      res.end();
    }
  }

  return server;
}

interface ChatRequest {
  message?: unknown;
  sessionId?: unknown;
  page?: { type: 'product' | 'collection' | 'cart' | 'other'; title?: string; productId?: string };
  justNavigated?: unknown;
}

/** Pull renderable product cards out of a catalog tool result. */
function extractProducts(result: unknown): unknown[] {
  if (result === null || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj['products'])) return obj['products'];
  if (obj['product'] !== undefined) return [obj['product']];
  return [];
}

/**
 * Locate `public/` without depending on output depth.
 *
 * This module runs from `src/` under vitest and `dist/src/` when built, so a
 * fixed `../../public` works in exactly one of those. Walking up until the
 * directory is found works in both — and fails loudly (returns undefined)
 * rather than silently serving from the wrong place.
 */
let cachedPublicRoot: string | null | undefined;
function publicRoot(): string | undefined {
  if (cachedPublicRoot !== undefined) return cachedPublicRoot ?? undefined;
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'public');
    if (existsSync(candidate)) {
      cachedPublicRoot = candidate;
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  cachedPublicRoot = null;
  return undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/**
 * Serve the demo storefront and widget bundle from `public/`.
 *
 * Path handling is deliberately strict: resolve, then verify the result is
 * still inside the root. Model- or user-supplied paths never get to touch the
 * filesystem directly.
 */
function serveStatic(pathname: string, res: ServerResponse): boolean {
  const root = publicRoot();
  if (root === undefined) return false;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(root, rel);
  if (!target.startsWith(resolve(root))) return false; // traversal attempt

  try {
    const body = readFileSync(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send an HTML page.
 *
 * When a shop is known, `frame-ancestors` is set so the Shopify admin (and only
 * the Shopify admin, for that one store) may iframe us. Getting this wrong
 * either breaks embedding entirely or leaves the page clickjackable from
 * anywhere — Shopify checks for it during app review.
 */
function html(res: ServerResponse, status: number, body: string, shop?: string): void {
  const buf = Buffer.from(body, 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(buf.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  headers['content-security-policy'] =
    shop === undefined
      ? "frame-ancestors 'none';"
      : `frame-ancestors https://${shop} https://admin.shopify.com;`;
  res.writeHead(status, headers);
  res.end(buf);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

function cors(res: ServerResponse, origin: string | undefined, allowed: readonly string[]): void {
  const ok = allowed.includes('*') ? (origin ?? '*') : allowed.includes(origin ?? '') ? origin! : '';
  if (ok !== '') res.setHeader('access-control-allow-origin', ok);
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('vary', 'origin');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Raw bytes, required for webhook HMAC verification. */
function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
