import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, OpenAIModelClient, type MerchantPack } from '@storeagent/orchestrator';
import { UcpClient } from '@storeagent/ucp-client';
import type { GatewayConfig } from './config.js';
import { MemorySessionStore, newSession, type SessionStore } from './sessions.js';
import { createToolExecutor } from './tool-executor.js';
import { RateLimiter } from './limits/limiter.js';
import { BillingService } from './billing/service.js';
import { Telemetry } from './observability/telemetry.js';
import { createLogger, type Logger } from './observability/logger.js';
import { PLANS, PLAN_ORDER, isPlanId } from '@storeagent/billing';
import { DEMO_CATALOG } from './catalog-fixture.js';
import { beginInstall, completeInstall } from './shopify/oauth.js';
import { handleWebhook, parseSubscriptionPayload } from './shopify/webhooks.js';
import {
  MemoryNonceStore,
  MemoryShopStore,
  type NonceStore,
  type ShopStore,
} from './shopify/shops.js';
import {
  MemoryAttributionStore,
  analyze,
  assignArm,
  describe as describeLift,
  parseOrderPayload,
  recommendedHoldout,
  type AttributionStore,
} from '@storeagent/attribution';
import { SpeechChunker } from '@storeagent/voice';
import {
  DEFAULT_VOICE,
  MAX_AUDIO_BYTES,
  VoiceError,
  synthesize,
  transcribe,
} from './voice/service.js';
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
  readonly attribution?: AttributionStore;
  /** Injectable so tests can supply a persisted spend store. */
  readonly limiter?: RateLimiter;
  /** Absent in demo mode, where there is no shop to bill. */
  readonly billing?: BillingService;
  readonly telemetry?: Telemetry;
  readonly logger?: Logger;
}

export function createGateway(deps: GatewayDeps): Server {
  const { config } = deps;
  const sessions = deps.sessions ?? new MemorySessionStore();
  const shops = deps.shops ?? new MemoryShopStore();
  const nonces = deps.nonces ?? new MemoryNonceStore();
  const settings = deps.settings ?? new MemorySettingsStore();
  const attribution = deps.attribution ?? new MemoryAttributionStore();
  const limiter = deps.limiter ?? new RateLimiter(config.rateLimits);
  const billing = deps.billing;
  const metrics = deps.telemetry ?? new Telemetry();
  const log = deps.logger ?? createLogger(config.production);
  const startedAt = Date.now();

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
      metrics.errors.inc({ kind: 'unhandled' });
      log.error('unhandled', { err });
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

    // Admission control, before any work is done. Deliberately ahead of route
    // dispatch so a refused request never reaches a model call — the whole
    // point is to not spend money on it.
    //
    // The shop is taken from the query string where the widget provides it.
    // That is client-supplied and therefore spoofable, but the consequence is
    // bounded: a forged shop can only spend *its own* ceiling, and the global
    // ceiling still applies underneath. Keying on something unforgeable would
    // mean parsing the body before admission, which inverts the ordering.
    const limitShop = url.searchParams.get('shop') ?? config.shopDomain;
    const decision = limiter.check(req, url.pathname, limitShop);
    if (!decision.allowed) {
      metrics.rateLimited.inc({ reason: decision.reason ?? 'unknown' });
      res.setHeader('retry-after', String(decision.retryAfterSec));
      json(res, 429, {
        error: 'rate_limited',
        reason: decision.reason,
        retryAfterSec: decision.retryAfterSec,
      });
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

    /**
     * Prometheus scrape endpoint.
     *
     * **Requires a bearer token**, unlike /healthz. This is not a liveness
     * probe: it exposes conversation volumes, error rates and per-shop token
     * spend — a competitive read on the business and, in aggregate, on each
     * merchant. When no token is configured the route is disabled outright
     * rather than served openly, so forgetting to set one fails closed.
     */
    if (url.pathname === '/metrics' && req.method === 'GET') {
      const expected = config.metricsToken;
      if (expected === undefined) {
        json(res, 404, { error: 'not_found' });
        return;
      }
      if (!timingSafeEqualStr(bearerToken(header(req, 'authorization')) ?? '', expected)) {
        res.setHeader('www-authenticate', 'Bearer');
        json(res, 401, { error: 'unauthorized' });
        return;
      }

      metrics.sample(Date.now(), startedAt);
      metrics.sessions.set(await sessions.size());
      metrics.installs.set(await shops.count());
      metrics.trackedClients.set(limiter.trackedClients);

      const body = metrics.render();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    /** The §12 gates as JSON, for a human or an alert rule. */
    if (url.pathname === '/api/slo' && req.method === 'GET') {
      const expected = config.metricsToken;
      if (expected === undefined || !timingSafeEqualStr(bearerToken(header(req, 'authorization')) ?? '', expected)) {
        json(res, expected === undefined ? 404 : 401, { error: 'unauthorized' });
        return;
      }
      const g = metrics.gates();
      json(res, 200, {
        ...g,
        ttftP50Ms: metrics.ttft.quantile(0.5) ?? null,
        ttftP95Ms: metrics.ttft.quantile(0.95) ?? null,
        turnP50Ms: metrics.turnDuration.quantile(0.5) ?? null,
        tripwireAborts: metrics.tripwireAborts.total(),
        errors: metrics.errors.total(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
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

    // Widget config. One cheap call the widget makes before deciding whether to
    // render, so holdout assignment and appearance come from the server rather
    // than being guessable or edit-able in the page.
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const shop = url.searchParams.get('shop') ?? config.shopDomain ?? 'demo.local';
      const s = await settings.get(shop);
      json(res, 200, {
        enabled: s.enabled,
        accentColor: s.accentColor,
        cornerRadius: s.cornerRadius,
        position: s.position,
        greeting: s.greeting,
        holdoutFraction: s.holdoutFraction,
      });
      return;
    }

    // Exposure beacon. Fired once per session by the widget — in BOTH arms,
    // including holdout, where nothing renders. Without the holdout half there
    // is no control group and no incrementality.
    if (url.pathname === '/api/exposure' && req.method === 'POST') {
      await handleExposure(req, res);
      return;
    }

    // Web pixel: checkout_completed. The only join available for holdout
    // sessions, which by definition have no cart of ours.
    if (url.pathname === '/api/pixel' && req.method === 'POST') {
      await handlePixel(req, res);
      return;
    }

    // Voice I/O, proxied so the API key never reaches the browser.
    if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') {
      await handleTranscribe(req, res);
      return;
    }
    if (url.pathname === '/api/voice/speak' && req.method === 'POST') {
      await handleSpeak(req, res);
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
        metrics.errors.inc({ kind: 'install_rejected' });
        log.warn('install_rejected', { reason: done.reason });
        json(res, done.status, { error: 'install_failed', detail: done.reason });
        return;
      }
      log.info('installed', { shop: done.shop.shop, scopes: done.shop.scopes });
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
        {
          apiSecret: app.apiSecret,
          shops,
          log: (l) => log.info('webhook', { detail: l }),
          // Billing data is not in ShopStore, so redaction must reach it too.
          onPurge: (shopDomain) => billing?.purge(shopDomain),
          // Shopify is the authority on subscription state. Without this,
          // local state drifts: we would keep serving a cancelled shop, or
          // keep a frozen one blocked after they have paid.
          onSubscription: async (shopDomain, payload) => {
            const parsed = parseSubscriptionPayload(payload);
            await billing?.applyWebhook(shopDomain, parsed);
          },
          // Server-side truth for revenue. Joined to a session by cart token
          // where the agent created the cart; the pixel covers everything else.
          onOrder: async (shopDomain, payload) => {
            const { orderId, revenueMinor, cartToken } = parseOrderPayload(payload);
            if (orderId === undefined) return;
            const sessionId =
              cartToken === undefined
                ? undefined
                : await attribution.sessionForCart(shopDomain, cartToken);
            await attribution.recordConversion({
              shop: shopDomain,
              orderId,
              sessionId,
              cartId: cartToken,
              revenueMinor,
              createdAt: Date.now(),
              matchedBy: sessionId === undefined ? 'unmatched' : 'cart',
            });
          },
        },
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
      const totals = await attribution.totals(shop);
      const lift = analyze(totals.exposed, totals.holdout);
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
        lift,
        liftSummary: describeLift(lift),
        recommendedHoldout: recommendedHoldout(totals.exposed.sessions + totals.holdout.sessions),
        unmatchedOrders: await attribution.unmatchedCount(shop),
        // Read straight from the store rather than reconciling with Shopify:
        // the page must render fast, and a network call on the critical path
        // would block it. /admin/billing does the reconciliation.
        ...(billing === undefined ? {} : { billing: billing.summary(shop) }),
        saved: url.searchParams.get('saved') === '1',
      };
      html(res, 200, renderAdmin(vm), shop);
      return;
    }

    // --- billing --------------------------------------------------------

    if (url.pathname === '/admin/billing' && req.method === 'GET') {
      const verified = verifySessionToken(bearerToken(header(req, 'authorization')), auth);
      if (!verified.ok) {
        json(res, 401, { errors: ['Your session expired. Reload the page and try again.'] });
        return;
      }
      if (billing === undefined) {
        json(res, 503, { errors: ['Billing is not configured on this deployment.'] });
        return;
      }
      // Reconcile against Shopify rather than trusting our row: webhooks get
      // missed, and a merchant looking at a stale plan is a support ticket.
      await billing.reconcile(verified.shop).catch(() => undefined);
      json(res, 200, { billing: billing.summary(verified.shop), plans: PLAN_ORDER.map((id) => PLANS[id]) });
      return;
    }

    if (url.pathname === '/admin/billing/subscribe' && req.method === 'POST') {
      const verified = verifySessionToken(bearerToken(header(req, 'authorization')), auth);
      if (!verified.ok) {
        json(res, 401, { errors: ['Your session expired. Reload the page and try again.'] });
        return;
      }
      if (billing === undefined || config.shopify === undefined) {
        json(res, 503, { errors: ['Billing is not configured on this deployment.'] });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(await readBody(req, 4 * 1024)) as Record<string, unknown>;
      } catch {
        json(res, 400, { errors: ['Malformed request.'] });
        return;
      }

      const requested = payload['plan'];
      if (!isPlanId(requested)) {
        json(res, 422, { errors: ['Unknown plan.'] });
        return;
      }
      if (requested === 'free') {
        // Downgrading is a cancellation, not a subscription. Creating a
        // zero-value subscription would send the merchant to an approval
        // screen to approve nothing.
        await billing.cancel(verified.shop);
        json(res, 200, { ok: true, plan: 'free' });
        return;
      }

      try {
        // The shop comes from the VERIFIED token, never the payload — a
        // merchant must not be able to start a subscription on another store.
        const confirmationUrl = await billing.beginUpgrade(
          verified.shop,
          requested,
          `${config.shopify.appUrl}/admin?shop=${encodeURIComponent(verified.shop)}&billing=return`,
        );
        // The merchant approves on Shopify's screen; nothing is charged here.
        json(res, 200, { confirmationUrl });
      } catch (err) {
        metrics.errors.inc({ kind: 'billing_subscribe' });
        log.error('billing_subscribe_failed', { shop: verified.shop, err });
        json(res, 502, { errors: ['Could not start the subscription. Please try again.'] });
      }
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

  const voiceConfig = { apiKey: config.openaiApiKey, ...DEFAULT_VOICE };

  async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const audio = await readRawBody(req, MAX_AUDIO_BYTES);
      const text = await transcribe(audio, header(req, 'content-type') ?? 'audio/webm', voiceConfig);
      json(res, 200, { text });
    } catch (err) {
      const status = err instanceof VoiceError ? err.status : 500;
      json(res, status, { error: 'transcription_failed' });
    }
  }

  async function handleSpeak(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = JSON.parse(await readBody(req, 8 * 1024)) as { text?: unknown };
      const audio = await synthesize(String(body.text ?? ''), voiceConfig);
      const buf = Buffer.from(audio);
      res.writeHead(200, {
        'content-type': 'audio/ogg',
        'content-length': String(buf.length),
        'cache-control': 'no-store',
      });
      res.end(buf);
    } catch (err) {
      const status = err instanceof VoiceError ? err.status : 500;
      json(res, status, { error: 'speech_failed' });
    }
  }

  async function handleExposure(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { sessionId?: unknown; shop?: unknown };
    try {
      body = JSON.parse(await readBody(req, 4 * 1024)) as typeof body;
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (sessionId === '') {
      json(res, 400, { error: 'sessionId required' });
      return;
    }
    const shop = typeof body.shop === 'string' && body.shop !== '' ? body.shop : config.shopDomain ?? 'demo.local';

    // The arm is computed SERVER-SIDE from the shop-salted hash. The widget
    // computes the same value to decide whether to render, but nothing it sends
    // is trusted — otherwise a shopper could put themselves in either arm.
    const s = await settings.get(shop);
    const arm = assignArm(shop, sessionId, s.holdoutFraction);
    await attribution.recordExposure({ shop, sessionId, arm, createdAt: Date.now(), engaged: false });
    json(res, 200, { arm });
  }

  async function handlePixel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { sessionId?: unknown; shop?: unknown; orderId?: unknown; totalMinor?: unknown };
    try {
      body = JSON.parse(await readBody(req, 8 * 1024)) as typeof body;
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const orderId = body.orderId === undefined ? undefined : String(body.orderId);
    if (sessionId === undefined || orderId === undefined) {
      json(res, 400, { error: 'sessionId and orderId required' });
      return;
    }
    const shop = typeof body.shop === 'string' && body.shop !== '' ? body.shop : config.shopDomain ?? 'demo.local';

    // The pixel is client-side and therefore forgeable. It is recorded as a
    // provisional signal; the orders/create webhook is the server-side truth
    // and overwrites revenue when it arrives (same orderId, deduped).
    await attribution.recordConversion({
      shop,
      orderId,
      sessionId,
      cartId: undefined,
      revenueMinor: typeof body.totalMinor === 'number' ? Math.round(body.totalMinor) : 0,
      createdAt: Date.now(),
      matchedBy: 'pixel',
    });
    json(res, 200, { ok: true });
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

    // Entitlement is checked BEFORE any model work: a shop past its allowance
    // must cost nothing to refuse. Checking afterwards would mean paying for
    // the call and then declining to bill for it.
    //
    // 402 rather than 429: this is not "too fast", it is "not entitled", and
    // the widget renders a different, non-alarming message for each. The
    // `reason` is merchant-facing text and is never shown to a shopper.
    if (billing !== undefined) {
      const entitlement = billing.check(session.shopDomain);
      if (!entitlement.allowed) {
        json(res, 402, {
          error: 'billing_required',
          verdict: entitlement.verdict,
          plan: entitlement.plan.id,
          used: entitlement.used,
          included: entitlement.included,
        });
        return;
      }
    }

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

    // Voice turns speak only text that has already passed the grounding
    // tripwire — audio cannot be retracted, so nothing unvalidated may reach
    // the speaker. See voice/service.ts.
    const chunker = body.voice === true ? new SpeechChunker() : undefined;

    // Reaching /api/chat at all means the shopper opened the assistant.
    // Exposure is being shown it; engagement is using it — and only the second
    // has a plausible causal path to a sale.
    void attribution.markEngaged(session.shopDomain, sessionId);

    const products: unknown[] = [];
    const executor = createToolExecutor({
      session,
      ucp,
      onCartChange: (cartId) => {
        send('cart', { cartId });
        // The second join path: order → cart → session, for the exposed arm.
        void attribution.linkCart({
          shop: session.shopDomain,
          sessionId,
          cartId,
          createdAt: Date.now(),
        });
      },
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

    const startedTurnAt = Date.now();
    let firstDeltaAt: number | undefined;
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
          onReplyDelta: (text) => {
            // Time to FIRST token is the number §12 gates on — the moment the
            // shopper stops looking at a blank panel. Recorded unlabelled:
            // this is a system property, and a per-shop label would multiply
            // the series for no question anyone asks.
            if (firstDeltaAt === undefined) {
              firstDeltaAt = Date.now();
              metrics.ttft.observe(firstDeltaAt - startedTurnAt);
            }
            send('delta', { text });
            // Voice turns get the same validated text, chunked into whole
            // utterances. The chunker runs HERE rather than in the widget so
            // the tested implementation is the one in the audio path — and so
            // the widget stays buildless.
            if (chunker !== undefined) {
              for (const utterance of chunker.push(text)) send('speak', { text: utterance });
            }
          },
        },
      );

      // Whatever is left over once the model stops — usually a final clause
      // with no terminal punctuation.
      if (chunker !== undefined) {
        const tail = chunker.flush();
        if (tail !== undefined) send('speak', { text: tail });
      }

      // The tripwire may have aborted a partial message — tell the client to
      // discard whatever it painted before showing the final text.
      if (result.events.some((e) => e.type === 'stream_aborted')) send('reset', {});

      send('done', {
        reply: result.reply,
        escalated: result.escalated,
        grounded: result.verdict.ok,
        attempts: result.attempts,
        ms: Date.now() - startedTurnAt,
        usage: result.usage,
      });

      // The product's core claim, made measurable. Without this, a grounding
      // regression would be invisible until a merchant noticed a wrong price.
      metrics.turns.inc({ shop: session.shopDomain, ok: String(result.verdict.ok) });
      metrics.turnDuration.observe(Date.now() - startedTurnAt);
      if (result.events.some((e) => e.type === 'stream_aborted')) {
        metrics.tripwireAborts.inc({ shop: session.shopDomain });
      }
      if (result.escalated) metrics.escalations.inc({ shop: session.shopDomain });
      if (result.usage !== undefined) {
        const u = result.usage as Record<string, unknown>;
        for (const [key, kind] of [
          ['inputTokens', 'input'],
          ['outputTokens', 'output'],
          ['cachedInputTokens', 'cached'],
        ] as const) {
          const n = Number(u[key] ?? 0);
          if (Number.isFinite(n) && n > 0) {
            metrics.tokens.inc({ shop: session.shopDomain, kind }, n);
          }
        }
      }

      // Never the message or the reply — see observability/logger.ts.
      log.info('turn_complete', {
        shop: session.shopDomain,
        sessionId,
        grounded: result.verdict.ok,
        escalated: result.escalated,
        attempts: result.attempts,
        ttftMs: firstDeltaAt === undefined ? null : firstDeltaAt - startedTurnAt,
        ms: Date.now() - startedTurnAt,
      });

      // Count the conversation only now that it actually resolved. A turn we
      // could not ground, or handed to a human, is not a resolution and is
      // free — billing for those would charge most for the turns we are worst
      // at. Idempotent per session, so a long conversation still bills once.
      if (billing !== undefined) {
        void billing.settle(session.shopDomain, {
          sessionId,
          grounded: result.verdict.ok,
          handedOff: result.handedOff,
          arm: await attribution.armOf(session.shopDomain, sessionId),
        });
      }

      session.history = [
        ...session.history,
        { role: 'user', content: body.message },
        { role: 'assistant', content: result.reply },
      ];
      await sessions.put(session);
    } catch (err) {
      if (!ctl.signal.aborted) {
        // Labelled by CLASS, never by message: an error string can carry
        // upstream detail, and an unbounded label set is a memory leak.
        metrics.errors.inc({ kind: err instanceof Error ? err.name : 'unknown' });
        log.error('turn_failed', { shop: session.shopDomain, sessionId, err });
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
  /** Emit `speak` events with whole utterances alongside the text deltas. */
  voice?: unknown;
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

/**
 * Constant-time string compare for the metrics token.
 *
 * A plain `===` leaks the token a character at a time to anyone who can
 * measure response timing. Lengths are compared first because timingSafeEqual
 * throws on a mismatch — that check is not itself constant-time, but token
 * *length* is not the secret.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
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
