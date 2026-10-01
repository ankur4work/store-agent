import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Orchestrator,
  OpenAIModelClient,
  applyFilter,
  buildCachedPrefix,
  answerPageFact,
  classifyIntent,
  classifyPageFact,
  extractPreferences,
  suggestChips,
  mergePreferences,
  reachedHuman,
  renderPreferences,
  type Chip,
  type FastIntent,
  type MerchantPack,
  type PageFactRequest,
  type ProductFilter,
} from '@storeagent/orchestrator';
import { UcpClient } from '@storeagent/ucp-client';
import type { GatewayConfig } from './config.js';
import {
  MAX_VISIBLE_PRODUCTS,
  MemorySessionStore,
  newSession,
  type Session,
  type SessionStore,
} from './sessions.js';
import { createToolExecutor } from './tool-executor.js';
import { RateLimiter } from './limits/limiter.js';
import { BillingService } from './billing/service.js';
import { Telemetry } from './observability/telemetry.js';
import { CircuitBreaker, decideLevel, shopperMessage, tierFor } from '@storeagent/resilience';
import { createLogger, type Logger } from './observability/logger.js';
import { PLANS, PLAN_ORDER, isPlanId } from '@storeagent/billing';
import { DEMO_CATALOG } from './catalog-fixture.js';
import { beginInstall, completeInstall } from './shopify/oauth.js';
import { isValidShopDomain, parseShopDomain } from './shopify/domain.js';
import { exchangeSessionToken } from './shopify/token-exchange.js';
import { handleWebhook, parseSubscriptionPayload } from './shopify/webhooks.js';
import {
  MemoryNonceStore,
  MemoryShopStore,
  isLegacyToken,
  type NonceStore,
  type ShopStore,
} from './shopify/shops.js';
import {
  MemoryAttributionStore,
  analyze,
  assignArm,
  describe as describeLift,
  isFunnelStep,
  parseOrderPayload,
  recommendedHoldout,
  type AttributionStore,
  type FunnelCounts,
} from '@storeagent/attribution';
import { SpeechChunker } from '@storeagent/voice';
import {
  DEFAULT_VOICE,
  MAX_AUDIO_BYTES,
  SPEECH_CONTENT_TYPE,
  VoiceError,
  synthesizeStream,
  transcribe,
  type TranscriptOutcome,
} from './voice/service.js';
import { SpeechCache } from './voice/speech-cache.js';
import { bearerToken, verifySessionToken } from './admin/session-token.js';
import { renderAdmin, renderUnauthenticated } from './admin/render.js';
import { pricingPlansUrl } from './billing/managed.js';
import type { CatalogIndex } from './search/catalog-index.js';
import { CatalogSnapshot } from './search/catalog-snapshot.js';
import {
  CatalogRefreshQueue,
  refreshCatalogIndex,
  type CatalogSource,
} from './search/refresh.js';
import { withVariantImages } from './search/variant-image.js';
import { BillingApiError } from './billing/shopify-billing.js';
import {
  MemorySettingsStore,
  VOICE_LANGUAGES,
  accentIsAccessible,
  merchantPackFrom,
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
  /** Semantic catalog search. Absent leaves search keyword-only. */
  readonly catalogIndex?: CatalogIndex;
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

  /**
   * Catalog freshness, driven by Shopify's own webhooks.
   *
   * The semantic index used to rebuild only on a six-hour TTL, so a merchant who
   * changed a price or added a line was invisible to meaning-based search for up
   * to six hours — findable by keyword the whole time, which reads as an
   * assistant that does not know about products in the merchant's own admin.
   *
   * Changes are coalesced per shop: a CSV import of four hundred products sends
   * four hundred webhooks in seconds, and rebuilding on each would embed the
   * whole catalog four hundred times to reach the same index one rebuild
   * produces.
   */
  const catalogQueue = new CatalogRefreshQueue({
    log,
    refresh: async (shop) => {
      const ucp = ucpFor(shop);
      if (ucp === undefined || deps.catalogIndex === undefined) return;
      const count = await refreshCatalogIndex(shop, ucp as unknown as CatalogSource, deps.catalogIndex);
      metrics.catalogRefreshes.inc({ shop });
      log.info('catalog_refresh_done', { shop, products: count });
    },
  });

  // Per merchant: a storefront that keeps failing must not hold connections
  // and starve every other merchant's turns. See resilience/breaker.ts.
  const catalogBreaker = new CircuitBreaker();

  /**
   * Whether a storefront's own `get_product` is worth attempting.
   *
   * A separate breaker from `catalogBreaker` because it guards a *capability*, not
   * a failing upstream, and the two want opposite policies. One failure is enough
   * to stop asking — a store that answers "Invalid params" will answer it again —
   * and the window is long, because this is not a blip that clears in half a
   * minute, it is a tool the store does not implement. Measured on the dev store,
   * attempting it cost 176-349 ms of every page-grounded turn.
   *
   * Still a breaker rather than a latch: UCP is mid-rollout, so after the window
   * one probe decides again, and a store that gains the capability starts using it
   * with nothing to redeploy.
   */
  const productLookupBreaker = new CircuitBreaker({
    threshold: 1,
    resetAfterMs: 30 * 60_000,
    successesToClose: 1,
  });

  /**
   * One catalog browse, reused across turns and shoppers.
   *
   * The other half of that 450 ms: resolving the product a shopper is standing on
   * meant downloading all 23 products — 170 KB — on every single turn, because the
   * store offers no way to fetch one by id.
   */
  const catalogSnapshot = new CatalogSnapshot({ log });

  const model = new OpenAIModelClient({
    apiKey: config.openaiApiKey,
    timeoutMs: 90_000,
    maxRetries: 1,
  });

  /**
   * One UCP client per shop, built on demand.
   *
   * There used to be exactly one, built from SHOP_DOMAIN at boot, and every
   * chat turn in every storefront used it. On a single-tenant deployment that
   * is invisible. As a public app it means each merchant's assistant answers
   * out of whichever store the env var happens to name — the wrong catalog,
   * the wrong prices, the wrong stock, stated with total confidence, and one
   * merchant's storefront quietly advertising another's.
   *
   * UCP is unauthenticated public storefront data: the endpoint is derived
   * from the domain and carries no token, so a client is little more than a
   * URL and memoizing them costs nothing. That also means this deliberately
   * does NOT require an install record — a shop whose row was lost to a
   * redeploy gets a thin catalog, not somebody else's.
   */
  const ucpClients = new Map<string, UcpClient>();
  function ucpFor(shop: string | undefined): UcpClient | undefined {
    // No shop at all, or a placeholder like `demo.local`: the fixture catalog
    // stands in. See tool-executor.ts.
    if (shop === undefined) return undefined;
    // Anything that arrived in a request becomes an outbound URL, so it has to
    // clear the domain grammar first — that check is the whole point of
    // shopify/domain.ts. SHOP_DOMAIN is operator-set and may legitimately be a
    // custom domain, so it is trusted as configured.
    if (shop !== config.shopDomain && !isValidShopDomain(shop)) return undefined;
    let client = ucpClients.get(shop);
    if (client === undefined) {
      client = new UcpClient({ shopDomain: shop, agentProfile: config.agentProfile });
      ucpClients.set(shop, client);
    }
    return client;
  }
  const ucp = ucpFor(config.shopDomain);

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
    await cors(res, req.headers.origin, url, config.allowedOrigins, shops);

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

    /**
     * Liveness: is this process up and serving HTTP? Nothing else.
     *
     * Deliberately touches no database. `/healthz` below awaits two SQLite
     * reads, and on a single-node SQLite deployment a write holding the lock
     * is enough to stall them — which would answer "should Docker kill this
     * container?" with "yes" over a hiccup that resolves itself. Liveness and
     * readiness are different questions, so they get different routes.
     */
    if (url.pathname === '/livez') {
      json(res, 200, { ok: true });
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
      metrics.breakersOpen.set(catalogBreaker.openKeys().length);

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
    // A tap on a product card. Deterministic because a tap names an exact
    // variant, which is the ambiguity that keeps "add this" out of the lane.
    if (url.pathname === '/api/cart/add' && req.method === 'POST') {
      await handleCartAdd(req, res);
      return;
    }

    /**
     * A funnel step the server cannot see for itself.
     *
     * Only `card_tapped` today: a shopper following a card to the product page is
     * a navigation away from us, so nothing server-side observes it. Client
     * reported and therefore forgeable, like any analytics of behaviour — which
     * is what it is for. Every revenue figure still comes from the
     * `orders/create` webhook and none of them pass through here.
     *
     * The step name is checked against a closed list, so this cannot become a
     * way to write arbitrary rows.
     */
    if (url.pathname === '/api/event' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req, 2 * 1024)) as {
          shop?: unknown;
          sessionId?: unknown;
          step?: unknown;
        };
        const claimed = parseShopDomain(body.shop);
        const shop = claimed.ok ? claimed.shop! : (config.shopDomain ?? 'demo.local');
        if (typeof body.sessionId === 'string' && body.sessionId !== '' && isFunnelStep(body.step)) {
          // Only the steps a client is allowed to report. `cards_shown` and
          // `cart_add` are recorded by the server from things the server did, and
          // accepting them here would let a client inflate its own funnel.
          if (body.step === 'card_tapped') {
            await attribution.recordStep(shop, body.sessionId, body.step);
          }
        }
      } catch {
        // A malformed beacon is not worth an error response.
      }
      json(res, 204, {});
      return;
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      const shop = url.searchParams.get('shop') ?? config.shopDomain ?? 'demo.local';
      const s = await settings.get(shop);
      // Proof of life for the widget bootstrap. This request can ONLY happen if
      // widget.js was injected into a storefront page and executed, so its
      // presence or absence in the logs separates "the script never reached the
      // page" from "the script ran and something else went wrong" — a
      // distinction that otherwise needs the merchant's browser console.
      log.info('widget_bootstrap', {
        shop,
        enabled: s.enabled,
        referer: header(req, 'referer') ?? null,
      });
      json(res, 200, {
        enabled: s.enabled,
        accentColor: s.accentColor,
        cornerRadius: s.cornerRadius,
        position: s.position,
        greeting: s.greeting,
        holdoutFraction: s.holdoutFraction,
        // The shopper picks their own language in the widget; this is only
        // what the picker starts on. A merchant selling mostly in Hindi
        // sets Hindi here, and an English-speaking customer still switches.
        voiceLanguage: s.voiceLanguage,
        voiceLanguages: VOICE_LANGUAGES,
        // Whether the widget may use the browser's own recogniser for the live
        // caption and the endpointer. See ShopSettings.onDeviceSpeech.
        onDeviceSpeech: s.onDeviceSpeech,
      });
      return;
    }

    /**
     * Layout self-check from the widget, sent only from a merchant's theme
     * editor preview. "It mounted" and "the merchant can see it" are different
     * claims; this carries the measurements that tell them apart — position,
     * size, computed style, and what is on top at the launcher's own centre.
     * Diagnostic only: nothing here is stored or used for anything else.
     */
    if (url.pathname === '/api/diag' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req, 4 * 1024)) as { shop?: unknown; diag?: unknown };
        log.info('widget_selfcheck', {
          shop: typeof body.shop === 'string' ? body.shop : null,
          diag: body.diag,
        });
        recordDeviceCaps(body.diag);
        recordPartials(body.diag);
      } catch {
        // A malformed diagnostic is not worth an error response.
      }
      json(res, 204, {});
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
      await handleTranscribe(url, req, res);
      return;
    }
    if (url.pathname === '/api/voice/speak' && (req.method === 'POST' || req.method === 'GET')) {
      await handleSpeak(url, req, res);
      return;
    }

    /**
     * `/admin/shopify/...` is the same endpoint, reached the other way.
     *
     * A webhook `uri` in the app manifest is resolved against the App URL
     * held in the Partner Dashboard, and ours is https://storeagent.tech
     * /admin because that is what opens the embedded app. So Shopify
     * subscribes every webhook to /admin/shopify/webhooks, hits the admin
     * router, and gets a 404 — which failed app review's HMAC check with
     * "Expected HTTP 401, received HTTP 404" against an endpoint that has
     * always answered 401 correctly at its real path.
     *
     * Making the manifest absolute fixes it for a future `shopify app
     * deploy`, but a subscription already registered keeps the old url,
     * and Shopify will go on delivering real GDPR webhooks to it. A
     * compliance webhook that 404s is not a review problem, it is a
     * deletion request we never received — so the path has to work
     * whatever it was registered as.
     *
     * Rewritten rather than special-cased so it goes through exactly the
     * same HMAC verification, not a lookalike beside it.
     */
    if (url.pathname.startsWith('/admin/shopify/')) {
      url.pathname = url.pathname.slice('/admin'.length);
      await handleShopify(url, req, res);
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

    if (req.method === 'GET' && serveStatic(url.pathname, req, res)) return;

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
          /**
           * Queued, not awaited. Shopify expects a webhook acknowledged in
           * seconds and re-embedding a catalog takes longer than that — a slow
           * 200 becomes a retry, and a retried topic eventually gets its
           * subscription disabled.
           */
          onCatalogChange: (shopDomain, topic) => {
            log.info('catalog_changed', { shop: shopDomain, topic });
            catalogQueue.touch(shopDomain);
            // Immediately, not on the index's debounce: this one can be quoted
            // from, so a corrected price must not wait out even a short TTL.
            catalogSnapshot.invalidate(shopDomain);
          },
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

    /** Shopify puts `id_token` on the embedded URL; fetches send a bearer. */
    function sessionTokenFrom(u: URL, r: IncomingMessage): string | undefined {
      const t = u.searchParams.get('id_token') ?? bearerToken(header(r, 'authorization'));
      return t === null || t === '' ? undefined : t;
    }

    /**
     * Mint and store an offline access token from a VERIFIED session token.
     *
     * Returns whether a token was stored. Never throws: a dashboard that
     * renders without a token is better than one that 500s.
     */
    async function provisionShop(
      shopDomain: string,
      sessionToken: string | undefined,
      why: string,
    ): Promise<boolean> {
      if (sessionToken === undefined || app === undefined || app.apiSecret === '') return false;
      const exchanged = await exchangeSessionToken(shopDomain, sessionToken, {
        apiKey: app.apiKey,
        apiSecret: app.apiSecret,
      });
      if (!exchanged.ok) {
        log.warn('token_exchange_failed', { shop: shopDomain, reason: exchanged.reason, why });
        return false;
      }
      await shops.put(exchanged.shop);
      log.info('installed', {
        shop: shopDomain,
        scopes: exchanged.shop.scopes,
        via: 'token_exchange',
        why,
      });
      return true;
    }

    /**
     * Reconcile, and re-mint the access token if Shopify rejects it.
     *
     * A stored offline token stops working whenever the app is reinstalled or
     * its scopes change — Shopify issues a new one and invalidates the old.
     * Provisioning only ran when NO shop row existed, so the first dead token
     * became permanent: every Admin API call 401'd forever, `reconcile` could
     * never read the subscription, and a merchant on a paid plan was shown
     * "Free" with no way back. Reinstalling did not help, because the row
     * still existed and the stale token was never replaced.
     *
     * A 401 is not a failure to retry, it is a token to replace. The embedded
     * admin carries a verified session token on every request, so a fresh
     * offline token is always one exchange away — and the retry is bounded to
     * one attempt, because if the new token is refused too the problem is not
     * the token.
     *
     * Swallowed at the end, because a Shopify outage must not stop the
     * dashboard rendering — but never silently.
     */
    async function reconcileRepairingToken(
      shopDomain: string,
      sessionToken: string | undefined,
    ): Promise<void> {
      if (billing === undefined) return;
      try {
        await billing.reconcile(shopDomain);
      } catch (err) {
        if (!(err instanceof BillingApiError && err.unauthorized)) {
          log.error('billing_reconcile_failed', { shop: shopDomain, err });
          return;
        }
        log.warn('access_token_rejected', { shop: shopDomain, action: 'reprovisioning' });
        if (!(await provisionShop(shopDomain, sessionToken, 'token rejected'))) return;
        try {
          await billing.reconcile(shopDomain);
        } catch (retryErr) {
          log.error('billing_reconcile_failed', {
            shop: shopDomain,
            err: retryErr,
            afterReprovision: true,
          });
        }
      }
    }

    /**
     * The Plan route. Same shell, same auth, plan chooser instead of the
     * dashboard — reachable from the app nav, so billing is somewhere a
     * merchant goes rather than something in the way of everything else.
     *
     * Reconciles on load like `/admin` does: this is the page where a stale
     * plan is most visible and most consequential.
     */
    if (url.pathname === '/admin/plan' && req.method === 'GET') {
      const token = url.searchParams.get('id_token') ?? bearerToken(header(req, 'authorization'));
      const verified = verifySessionToken(token ?? undefined, auth);
      if (!verified.ok) {
        const named = parseShopDomain(url.searchParams.get('shop'));
        const installUrl =
          named.ok && named.shop !== undefined
            ? `/shopify/auth?shop=${encodeURIComponent(named.shop)}`
            : undefined;
        html(
          res,
          401,
          renderUnauthenticated(verified.reason, installUrl, app.apiKey),
          named.ok ? named.shop : undefined,
        );
        return;
      }

      const shop = verified.shop;
      await reconcileRepairingToken(shop, sessionTokenFrom(url, req));

      const totals = await attribution.totals(shop);
      const lift = analyze(totals.exposed, totals.holdout);
      html(
        res,
        200,
        renderAdmin({
          page: 'plan',
          shop,
          apiKey: app.apiKey,
          host: url.searchParams.get('host') ?? '',
          settings: await settings.get(shop),
          stats: {
            activeSessions: await sessions.size(),
            mode: (ucpFor(shop) ? 'live' : 'demo') as 'live' | 'demo',
            model: config.models.workhorse,
          },
          lift,
          liftSummary: describeLift(lift),
          recommendedHoldout: recommendedHoldout(totals.exposed.sessions + totals.holdout.sessions),
          unmatchedOrders: await attribution.unmatchedCount(shop),
        ...(await funnelFor(shop)),
          // Absent when nothing has been measured, so a shop that installed
          // today sees no card rather than a table of zeroes.
          ...(await funnelFor(shop)),
          ...(billing === undefined ? {} : { billing: billing.summary(shop) }),
        }),
        shop,
      );
      return;
    }

    if (url.pathname === '/admin' && req.method === 'GET') {
      // Shopify puts `id_token` on the embedded app URL. Fall back to a bearer
      // header for direct fetches.
      const token = url.searchParams.get('id_token') ?? bearerToken(header(req, 'authorization'));
      const verified = verifySessionToken(token ?? undefined, auth);

      if (!verified.ok) {
        // The session token did not verify, but Shopify still puts `shop` on
        // the embedded URL, and it goes through the same strict allowlist as
        // every other untrusted shop input. That is enough to do two things the
        // bare 401 could not:
        //
        //   - let the admin iframe actually DISPLAY this page. Under
        //     `frame-ancestors 'none'` the browser blocks the frame and
        //     substitutes its own security warning, so the merchant gets a
        //     generic scare instead of our explanation. This page carries no
        //     secrets — it is a static "connect me" prompt — so letting the
        //     named shop frame it costs nothing.
        //   - offer the install link, which is the actual remedy in the case
        //     that produces this 401 almost every time: never connected.
        // `ShopDomainResult` is not a discriminated union, so `ok` alone does
        // not narrow `shop` — check both rather than asserting.
        const named = parseShopDomain(url.searchParams.get('shop'));
        if (named.ok && named.shop !== undefined) {
          const installUrl = `/shopify/auth?shop=${encodeURIComponent(named.shop)}`;
          html(res, 401, renderUnauthenticated(verified.reason, installUrl, app.apiKey), named.shop);
          return;
        }
        // No trustworthy shop named: keep the page unframeable.
        html(res, 401, renderUnauthenticated(verified.reason, undefined, app.apiKey));
        return;
      }

      const shop = verified.shop;

      /**
       * Provision the shop on first authenticated load.
       *
       * Under Shopify managed installation the OAuth callback never fires, so
       * an app can be fully installed — theme extension rendering, admin page
       * loading, a subscription paid for — while the server holds no access
       * token and every server-side call silently short-circuits. Exchanging
       * the session token we just VERIFIED for an offline token closes that
       * gap, and works whichever way the merchant installed.
       *
       * A failure here is logged and ignored rather than blocking the page:
       * the dashboard is still readable without a token, and the next load
       * tries again.
       */
      if (app.apiSecret !== '') {
        const existing = await shops.get(shop);
        // A legacy non-expiring token is worth no more than no token at all:
        // Shopify refuses it on every Admin API call. Replacing it needs a
        // session token, and this is the one place we reliably have one.
        if (existing === undefined) {
          await provisionShop(shop, sessionTokenFrom(url, req), 'first load');
        } else if (isLegacyToken(existing)) {
          await provisionShop(shop, sessionTokenFrom(url, req), 'non-expiring token');
        }
      }

      /**
       * Returning from a plan change, so the local record is known-stale:
       * Shopify has just created or cancelled the subscription and our copy
       * still says whatever it said before. Managed pricing sends the merchant
       * back with `charge_id`, and showing them "Free" on the page they land on
       * after paying is the one moment the cached value is certainly wrong.
       */
      const returningFromBilling =
        url.searchParams.has('charge_id') || url.searchParams.get('billing') === 'return';
      if (billing !== undefined && returningFromBilling) {
        await reconcileRepairingToken(shop, sessionTokenFrom(url, req));
      }

      const totals = await attribution.totals(shop);
      const lift = analyze(totals.exposed, totals.holdout);
      const vm = {
        shop,
        apiKey: app.apiKey,
        host: url.searchParams.get('host') ?? '',
        settings: await settings.get(shop),
        stats: {
          activeSessions: await sessions.size(),
          mode: (ucpFor(shop) ? 'live' : 'demo') as 'live' | 'demo',
          model: config.models.workhorse,
        },
        lift,
        liftSummary: describeLift(lift),
        recommendedHoldout: recommendedHoldout(totals.exposed.sessions + totals.holdout.sessions),
        unmatchedOrders: await attribution.unmatchedCount(shop),
        ...(await funnelFor(shop)),
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
      await reconcileRepairingToken(verified.shop, bearerToken(header(req, 'authorization')));
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

      /**
       * Under Shopify App Pricing, Shopify owns plan selection and creates the
       * subscription. This app must not — a subscription we create that
       * managed pricing did not expect leaves the two disagreeing about the
       * merchant's plan, which is what Shopify's readiness checklist is asking
       * an app to confirm it has stopped doing.
       *
       * Every plan change, including dropping to free, goes to Shopify's
       * picker: it is the one screen that can move a merchant between plans.
       * Returned as `confirmationUrl` — the same field the approval URL used —
       * so the admin UI, which just assigns it to window.top.location, needs no
       * change and cannot end up half-migrated.
       */
      if (config.shopify.managedPricing) {
        const handle = config.shopify.appHandle;
        if (handle === undefined || handle === '') {
          log.error('managed_pricing_misconfigured', { shop: verified.shop });
          json(res, 503, {
            errors: ['Billing is not fully configured. Set SHOPIFY_APP_HANDLE on the deployment.'],
          });
          return;
        }
        json(res, 200, { confirmationUrl: pricingPlansUrl(verified.shop, handle) });
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

  // VOICE_LANGUAGE overrides the storefront language for transcription; the
  // empty string restores auto-detection for a genuinely multilingual store.
  const voiceConfig = {
    apiKey: config.openaiApiKey,
    ...DEFAULT_VOICE,
    ...(process.env['VOICE_LANGUAGE'] === undefined
      ? {}
      : { language: process.env['VOICE_LANGUAGE'] }),
  };

  /**
   * Speech, started as soon as the words are settled rather than when the browser
   * asks for them.
   *
   * TTS was 79% of the wait before a voice answer was audible, measured in
   * production after the page-fact lane had already cut the model to 486 ms. Most
   * of that was structural rather than upstream: synthesis did not begin until the
   * widget had received the text and asked, and then every stage waited for the
   * last byte. See voice/speech-cache.ts.
   */
  const speech = new SpeechCache({
    source: (text) => synthesizeStream(text, voiceConfig),
    log,
  });

  /**
   * Count what the shopper's device can do, from the widget's mic-press beacon.
   *
   * This exists to answer one question with evidence instead of an assumption:
   * **should on-device transcription be the primary path, or a desktop
   * accelerator?** Whisper in the browser needs a WebGPU adapter and a
   * connection that can afford the model download, and the honest answer
   * differs per store — a store whose shoppers are all on mid-range Android
   * would be shipped a feature that silently never engages.
   *
   * Every label is a closed set, so the series count is bounded no matter how
   * many shoppers arrive. The raw values stay in the log; only the buckets are
   * counted. Nothing here identifies a device — these are four booleans and a
   * connection class, which is why it is safe to count at all.
   */
  function recordDeviceCaps(diag: unknown): void {
    if (typeof diag !== 'object' || diag === null) return;
    const caps = (diag as { caps?: unknown }).caps;
    if (typeof caps !== 'object' || caps === null) return;

    const c = caps as Record<string, unknown>;
    const yesNo = (v: unknown): string => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
    // Whatever the browser reports, reduced to the set the Network Information
    // API actually defines. An unrecognised value becomes 'unknown' rather than
    // a new series — a label taken straight from client input is an unbounded
    // label set wearing a useful name.
    const NET = ['slow-2g', '2g', '3g', '4g', '5g'];
    const net = typeof c['net'] === 'string' && NET.includes(c['net']) ? c['net'] : 'unknown';

    metrics.deviceCaps.inc({
      webgpu: yesNo(c['webgpu']),
      worklet: yesNo(c['worklet']),
      net,
      savedata: yesNo(c['saveData']),
    });
  }

  /**
   * Count which rung produced the live caption for a turn.
   *
   * Three closed sets — the source, the merchant's setting, and what the
   * availability probe found — so a browser cannot invent a series. The three
   * together are what make the result actionable: `kind=cloud` with
   * `state=downloadable` is a merchant who has not enabled installs, while
   * `kind=cloud` with `state=error` is a Permissions-Policy blocking us, and
   * those need different answers.
   */
  function recordPartials(diag: unknown): void {
    if (typeof diag !== 'object' || diag === null) return;
    const d = diag as Record<string, unknown>;
    // Read off the beacon the widget already sends once per turn rather than
    // asking it for a second one: two beacons carrying the same three fields is
    // a request per turn per shopper spent on nothing.
    if (d['voice'] !== 'capture_start') return;

    const oneOf = (v: unknown, allowed: readonly string[]): string =>
      typeof v === 'string' && allowed.includes(v) ? v : 'unknown';

    metrics.partials.inc({
      kind: oneOf(d['partials'], ['ondevice', 'cloud', 'none']),
      mode: oneOf(d['mode'], ['off', 'auto', 'on']),
      state: oneOf(d['state'], [
        'available',
        'downloadable',
        'downloading',
        'unavailable',
        'unsupported',
        'error',
        'unprobed',
      ]),
    });
  }

  /**
   * The funnel for the admin, or nothing at all.
   *
   * Omitted entirely on a shop with no sessions yet: a table of zeroes looks like
   * a broken feature, where an absent card simply is not there. A shop that has
   * installed today should see the setup instructions, not evidence that nobody
   * has ever used it.
   */
  async function funnelFor(shop: string): Promise<{
    funnel?: { exposed: FunnelCounts; holdout: FunnelCounts };
  }> {
    try {
      const funnel = await attribution.funnel(shop);
      if (funnel.exposed.sessions === 0 && funnel.holdout.sessions === 0) return {};
      return { funnel };
    } catch (err) {
      // The admin must render without it. A funnel is a nice-to-have on a page
      // whose other job is telling the merchant how to switch the thing on.
      log.warn('funnel_failed', { shop, reason: err instanceof Error ? err.message : String(err) });
      return {};
    }
  }

  /**
   * Add a variant to the cart, from a tap on a product card.
   *
   * ## Why this is a button and not a sentence
   *
   * The deterministic lane deliberately refuses to act on "add this": a sentence
   * does not say which size, and a wrong variant is discovered by the shopper at
   * checkout. A tap on a card carries an exact variant id, so the ambiguity that
   * made the text version unsafe is simply not present — which is the whole
   * distinction this endpoint rests on. The widget only offers the button when
   * there is exactly one available variant to offer.
   *
   * Goes through the same `add_to_cart` executor the model uses, so it inherits
   * the cart-merge safety and the attribution hook rather than reimplementing
   * either.
   */
  async function handleCartAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { sessionId?: unknown; shop?: unknown; variantId?: unknown; quantity?: unknown };
    try {
      body = JSON.parse(await readBody(req, 4 * 1024)) as typeof body;
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }

    const variantId = typeof body.variantId === 'string' ? body.variantId.trim() : '';
    // Shape-checked because it is client-supplied and reaches the storefront.
    // The same bounded exposure the chat route already accepts, and all it can
    // name is a variant in this merchant's own catalog.
    /**
     * `..` is refused as well as the obvious junk.
     *
     * Not because it could traverse anything — the id becomes a field in a
     * JSON-RPC payload, never a path segment — but because no real variant id
     * contains it. Shopify ids are `gid://shopify/ProductVariant/123`, numeric,
     * or handle-shaped. Refusing a value that cannot be legitimate costs one
     * `includes` and removes the need to reason about where it ends up later.
     */
    if (
      variantId === '' ||
      variantId.length > 200 ||
      variantId.includes('..') ||
      !/^[\w:/.=-]+$/.test(variantId)
    ) {
      json(res, 400, { error: 'variant_required' });
      return;
    }
    const quantity =
      typeof body.quantity === 'number' && Number.isInteger(body.quantity) && body.quantity > 0
        ? Math.min(body.quantity, 10)
        : 1;

    const claimed = parseShopDomain(body.shop);
    const shopDomain = claimed.ok ? claimed.shop! : (config.shopDomain ?? 'demo.local');
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : randomUUID();
    const existing = await sessions.get(sessionId);
    // Same rule as the chat route: a session id must never carry a cart from one
    // storefront into another.
    const session =
      existing !== undefined && existing.shopDomain === shopDomain
        ? existing
        : newSession(sessionId, shopDomain);

    const executor = createToolExecutor({
      session,
      ucp: ucpFor(shopDomain),
      productLookup: productLookupBreaker,
      catalogSnapshot,
      log,
      onCartChange: (cartId) => {
        // The deterministic join for attribution. A card tap creates carts just
        // as the agent does, and a cart with no session attached is revenue that
        // cannot be credited to the assistant that sold it.
        void attribution.linkCart({ shop: shopDomain, sessionId, cartId, createdAt: Date.now() });
      },
    });

    try {
      const result = (await executor.execute('add_to_cart', {
        variant_id: variantId,
        quantity,
      })) as {
        demo?: boolean;
        cart?: Parameters<typeof cartSummary>[0];
        messages?: readonly { text: string }[];
        error?: unknown;
      };
      await sessions.put(session);

      if (result.error !== undefined) {
        json(res, 502, { error: 'add_failed' });
        return;
      }
      metrics.fastLane.inc({ shop: shopDomain, intent: 'card_add' });
      // Funnel: the step nearest the sale that we can see without a webhook.
      void attribution.recordStep(shopDomain, sessionId, 'cart_add');
      json(res, 200, {
        ok: true,
        sessionId,
        ...(session.cartId === undefined ? {} : { cartId: session.cartId }),
        // Demo mode has no cart to describe, and inventing a subtotal is exactly
        // what the grounding layer exists to prevent.
        reply:
          result.cart === undefined
            ? 'Added to your cart.'
            : `Added. ${cartSummary(result.cart, result.messages)}`,
      });
    } catch (err) {
      log.warn('card_add_failed', {
        shop: shopDomain,
        reason: err instanceof Error ? err.message : String(err),
      });
      metrics.errors.inc({ kind: 'card_add' });
      json(res, 502, { error: 'add_failed' });
    }
  }

  /**
   * The cached prompt prefix for a shop, from what the merchant wrote.
   *
   * Replaces a single hardcoded pack that every merchant shared, which meant
   * every shop's assistant had the same voice and the same made-up shipping
   * policy — "Free shipping over $75" was being told to shoppers of stores that
   * have never offered it.
   *
   * Falls back to the neutral pack if the stored text somehow still trips
   * `assertStable`. Validation at save time is the real defence, but a value
   * written before that validation existed must degrade to a working assistant
   * rather than throw inside a shopper's turn — the merchant's typo is not the
   * shopper's problem.
   */
  async function merchantPackFor(shop: string): Promise<MerchantPack> {
    const pack = merchantPackFrom(await settings.get(shop));
    try {
      buildCachedPrefix(pack);
      return pack;
    } catch (err) {
      metrics.errors.inc({ kind: 'merchant_pack_unstable' });
      log.warn('merchant_pack_unstable', {
        shop,
        reason: err instanceof Error ? err.message : String(err),
      });
      return { ...DEMO_MERCHANT, merchantId: shop };
    }
  }

  /**
   * Notice when a shop's cached prefix changes.
   *
   * The prefix is 10–14k tokens and cache reads cost about a tenth of fresh
   * ones, so a prefix that changes between turns is the difference between the
   * unit economics in §7.4 working and not working — and it fails silently, with
   * no error and no failing test. A merchant editing their brand voice moves
   * this by one, which is expected and fine. It moving on every turn is the
   * canary for the entire cost model.
   */
  const lastPrefix = new Map<string, string>();
  function watchPrefix(shop: string, fingerprint: string): void {
    const previous = lastPrefix.get(shop);
    if (previous !== undefined && previous !== fingerprint) {
      metrics.prefixChanges.inc({ shop });
      log.info('prompt_prefix_changed', { shop, from: previous, to: fingerprint });
    }
    lastPrefix.set(shop, fingerprint);
  }

  /**
   * Answer a price, a stock question or an option list about the product the
   * shopper is standing on, from the catalog, with no model in the loop.
   *
   * Returns false — and says why in the log — the moment anything is missing.
   * The product cannot be read, the variants carry no price, nobody set
   * `available`: all of those are the model's turn. This lane may be fast and it
   * may be silent, but it may never be wrong, because a deterministic wrong
   * answer arrives in 300 ms sounding completely certain.
   */
  async function answerPageFactWithoutModel(
    request: PageFactRequest,
    ctx: {
      session: Session;
      page: { productId?: string; variantName?: string; title?: string };
      send: (event: string, data: unknown) => void;
      speakIfVoice: (text: string) => void;
      startedAt: number;
    },
  ): Promise<boolean> {
    const { session, page, send, speakIfVoice, startedAt } = ctx;
    const id = page.productId;
    if (id === undefined || id === '') return false;

    const ucp = ucpFor(session.shopDomain);
    if (ucp === undefined) return false; // demo mode: let the model answer

    /**
     * Through the executor, not the client, so this inherits the `get_product`
     * repair — the dev store advertises that tool and answers "Tool not found",
     * and resolving the id out of the catalog is what keeps it answerable.
     */
    const executor = createToolExecutor({
      session,
      ucp,
      ...(deps.catalogIndex === undefined ? {} : { catalogIndex: deps.catalogIndex }),
      productLookup: productLookupBreaker,
      catalogSnapshot,
      log,
    });

    let product: unknown;
    try {
      const result = (await executor.execute('get_product', { id })) as {
        product?: unknown;
        error?: unknown;
      };
      if (result.error !== undefined || result.product === undefined) {
        // Logged, because a lane that declines silently is a lane nobody can
        // tell is broken — which is exactly how an id-format mismatch between
        // the page and the catalog hid behind a working model answer.
        log.info('page_fact_declined', {
          shop: session.shopDomain,
          kind: request.kind,
          why: 'product not resolved',
          id,
        });
        return false;
      }
      product = result.product;
    } catch (err) {
      log.warn('page_fact_lookup_failed', {
        shop: session.shopDomain,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const reply = answerPageFact(
      request,
      product as Parameters<typeof answerPageFact>[1],
      page.variantName,
      money,
    );
    if (reply === undefined) {
      // The data would not carry the sentence. Counted by the caller.
      log.info('page_fact_declined', { shop: session.shopDomain, kind: request.kind });
      return false;
    }

    /**
     * The card goes with it. The shopper asked about this product, so showing it
     * is not decoration — it is where every price they can check against lives,
     * and the widget formats those from the same variant data this sentence came
     * from.
     */
    send('products', { products: [product], final: true });
    send('delta', { text: reply });
    speakIfVoice(reply);
    send('done', {
      reply,
      escalated: false,
      handedOff: false,
      // Grounded by construction: every figure in `reply` was copied out of the
      // catalog result above, and no model saw it.
      grounded: true,
      attempts: 0,
      ms: Date.now() - startedAt,
      fast: `page_${request.kind}`,
    });
    return true;
  }

  /**
   * Answer a turn with no model call, or decline it.
   *
   * Returns true only if the shopper has been completely answered. Declining is
   * a first-class outcome: a lane that guesses is worse than no lane, because a
   * wrong deterministic answer arrives fast, sounds certain, and leaves no trace
   * that a model was skipped.
   */
  async function answerWithoutModel(
    intent: FastIntent,
    ctx: {
      session: Session;
      send: (event: string, data: unknown) => void;
      speakIfVoice: (text: string) => void;
      sendChips: (products: readonly unknown[]) => void;
      startedAt: number;
    },
  ): Promise<boolean> {
    const { session, send, speakIfVoice, sendChips, startedAt } = ctx;

    const finish = (reply: string, products?: readonly unknown[]): true => {
      // Cards first: they are the answer, and the sentence is commentary on
      // something the shopper is already reading. Same order the model path uses.
      if (products !== undefined) send('products', { products, final: true });
      send('delta', { text: reply });
      speakIfVoice(reply);
      send('done', {
        reply,
        escalated: false,
        handedOff: false,
        // Grounded by construction: every number in these replies is copied
        // from a tool result or from the cart, and no model saw them.
        grounded: true,
        attempts: 0,
        ms: Date.now() - startedAt,
        fast: intent.kind,
      });
      return true;
    };

    if (intent.kind === 'filter') {
      const visible = session.products ?? [];
      const kept = applyFilter(visible, intent.filter);

      /**
       * An empty result means "I cannot answer this from what is on screen",
       * NOT "the store has none".
       *
       * The blue one may exist and simply not be among the six results we
       * showed. Reporting no matches here would tell a shopper the shop does
       * not stock something it does — so the model gets the turn and can
       * search. This also covers the number parser being wrong: a
       * mis-read amount filters everything out and lands here.
       */
      if (kept.length === 0) return false;
      // Nothing was actually narrowed, so there is nothing to say that the
      // shopper cannot already see. The model can respond to the sentiment.
      if (kept.length === visible.length && intent.filter.colour !== undefined) return false;

      session.products = kept;
      // Narrowing composes: the chips offered now come from the narrowed set, so
      // a shopper can keep going without ever reaching the model.
      sendChips(kept);
      /**
       * Short, and read aloud as often as it is read.
       *
       * No price in the sentence: these products carry amounts in minor units
       * with no currency attached at this layer, and naming a figure we cannot
       * label correctly is the one thing this path must not do. The cards beside
       * it show every price, formatted by the widget from the same data.
       */
      const reply =
        intent.filter.cheaper === true
          ? 'Cheapest first.'
          : intent.filter.dearer === true
            ? 'Dearest first.'
            : intent.filter.colour !== undefined
              ? `${kept.length} in ${intent.filter.colour}.`
              : `${kept.length} of those.`;
      return finish(reply, withVariantImages(kept, describeFilter(intent.filter)));
    }

    // --- cart read ---------------------------------------------------------

    if (session.cartId === undefined) {
      // Exact, and needs neither a model nor a round trip.
      return finish('Your cart is empty.');
    }

    const ucp = ucpFor(session.shopDomain);
    if (ucp === undefined) return false; // demo mode: let the model answer

    try {
      const { cart, messages } = await ucp.getCart(session.cartId);
      return finish(cartSummary(cart, messages));
    } catch (err) {
      // A cart that cannot be read is not an answer we can fake. The model gets
      // the turn, with tools that can try again.
      log.warn('fast_lane_cart_failed', {
        shop: session.shopDomain,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async function handleTranscribe(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Resolved before the try so the failure path can label its metric by shop
    // too. Without that, every unclassifiable failure lands on one unlabelled
    // series and "which merchant is this happening to" stops being answerable
    // at exactly the moment someone needs to ask it.
    const shop = url.searchParams.get('shop') ?? config.shopDomain ?? 'demo.local';
    try {
      const contentType = header(req, 'content-type') ?? 'audio/webm';
      const audio = await readRawBody(req, MAX_AUDIO_BYTES);
      const pageLang = (header(req, 'x-storefront-lang') ?? '').trim().toLowerCase();

      /**
       * The merchant's choice wins, then the page, then detection.
       *
       * The storefront header was promoted to authority too early. An
       * Indian store renders `lang="en"` and its customers speak Hindi, so
       * following the page would transcribe them as English and return
       * nonsense — and the merchant would have no way to correct it. Only
       * they know who is actually talking, so `voiceLanguage` is a setting
       * they own, defaulting to English.
       *
       * 'auto' is an explicit opt-in to detection, not the fallback: it is
       * what produced Urdu and then Turkish for the same English sentence.
       */
      const merchantDefault = (await settings.get(shop)).voiceLanguage;
      // The header carries the shopper's pick from the widget; it starts on
      // the merchant's default, so it is the more specific answer when
      // present. 'auto' is a real choice and means send no language at all.
      const chosen = pageLang === '' ? merchantDefault : pageLang;
      const resolved = chosen === 'auto' || !/^[a-z]{2}$/.test(chosen) ? '' : chosen;
      const cfg = {
        ...voiceConfig,
        log,
        // Both sinks, from one call inside the service. See VoiceConfig.onOutcome.
        onOutcome: (outcome: TranscriptOutcome) => {
          metrics.transcripts.inc({ shop, outcome });
        },
        // VOICE_LANGUAGE, if set, still overrides everything — it is the
        // operator's lever for a single-shop deployment.
        ...(voiceConfig.language === undefined && resolved !== '' ? { language: resolved } : {}),
      };
      /**
       * What language this turn was decoded as, and where that came from.
       *
       * An English question came back in Urdu script on a store whose page
       * says `lang="en"`, with a server that transcribes the same sentence
       * correctly when told "en" — three facts that cannot all be true, and
       * no way to tell which one was wrong because the header was read and
       * then never mentioned again. Neither field is shopper content: one
       * is a two-letter code, the other is where it was found.
       */
      log.info('voice_language', {
        header: pageLang === '' ? null : pageLang,
        using: (cfg as { language?: string }).language ?? 'auto-detect',
      });
      // Measured around the whole thing, including the ogg relabel retry and
      // the acoustic-model fallback. The shopper waits for all of it, so
      // timing only the first request would report a number nobody experiences.
      const startedAt = Date.now();
      metrics.audioBytes.observe(audio.length, { shop });
      const text = await transcribe(audio, contentType, cfg);
      metrics.transcribeDuration.observe(Date.now() - startedAt, { shop });
      // An empty transcript is a SUCCESS on the wire and a dead end for the
      // shopper: the widget quietly starts listening again, so a mic that
      // recorded perfectly well looks like it does nothing. Worth a line —
      // it is indistinguishable from a failure from the outside.
      if (text === '') {
        log.warn('voice_transcript_empty', { bytes: audio.length, contentType });
      }
      json(res, 200, { text });
    } catch (err) {
      const status = err instanceof VoiceError ? err.status : 500;
      // The service already counted anything it could classify. This catches
      // what it could not — a network failure, a malformed body, a bug here —
      // so the counter totals every attempt rather than only the ones that got
      // far enough to be named.
      if (!(err instanceof VoiceError)) {
        metrics.transcripts.inc({ shop, outcome: 'error' });
      }
      // Never the audio, never the transcript — the reason, the format and
      // the size, which is what distinguishes a rejected container from a
      // bad key from an oversized upload.
      log.error('voice_transcribe_failed', {
        status,
        contentType: header(req, 'content-type') ?? null,
        reason: err instanceof Error ? err.message : String(err),
      });
      json(res, status, { error: 'transcription_failed' });
    }
  }

  /**
   * Serve one utterance's audio, streamed.
   *
   * Two ways in, and the difference is latency rather than capability:
   *
   * - `GET ?id=…` — the id from the `speak` event. Synthesis is usually already
   *   running, so this mostly forwards bytes that are on their way, and a media
   *   element can be pointed straight at the URL and start playing at the first
   *   frames.
   * - `POST {text}` — the fallback, for a client that has no id or whose streamed
   *   playback failed. Same path underneath; it simply starts later.
   *
   * No `content-length`, deliberately: it is not known when the headers go out,
   * and withholding it is what makes the response chunked and therefore playable
   * before it is complete. That single field was a large part of the 1866 ms.
   */
  async function handleSpeak(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let text: string;
    if (req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      const found = id === '' ? undefined : speech.textForId(id);
      if (found === undefined) {
        // Expired or never announced. A 404 rather than synthesizing whatever
        // arrived: an id is a capability to replay one sentence we chose to say,
        // and treating an unknown one as "say this" would make it an open TTS
        // endpoint keyed on a querystring.
        json(res, 404, { error: 'unknown_audio' });
        return;
      }
      text = found;
    } else {
      try {
        const body = JSON.parse(await readBody(req, 8 * 1024)) as { text?: unknown };
        text = String(body.text ?? '');
      } catch {
        json(res, 400, { error: 'invalid_json' });
        return;
      }
    }

    if (text.trim() === '') {
      json(res, 400, { error: 'speech_failed' });
      return;
    }

    const startedAt = Date.now();
    let firstByteAt: number | undefined;
    let wroteAnything = false;

    await new Promise<void>((resolve) => {
      const cancel = speech.listen(text, {
        onChunk: (chunk) => {
          if (!wroteAnything) {
            wroteAnything = true;
            firstByteAt = Date.now();
            metrics.upstream.observe(firstByteAt - startedAt, { target: 'speech' });
            res.writeHead(200, {
              'content-type': SPEECH_CONTENT_TYPE,
              'cache-control': 'no-store',
              // Nginx and Traefik will otherwise hold a small response until it
              // completes, which reinstates exactly the wait this removes.
              'x-accel-buffering': 'no',
            });
          }
          if (!res.writableEnded) res.write(Buffer.from(chunk));
        },
        onEnd: (err) => {
          if (err !== undefined && !wroteAnything) {
            const status = err instanceof VoiceError ? err.status : 502;
            json(res, status, { error: 'speech_failed' });
          } else if (!res.writableEnded) {
            /**
             * A truncated utterance is still played, and that is the right call:
             * the alternative is silence, and the shopper has the same sentence on
             * screen either way.
             */
            res.end();
          }
          resolve();
        },
      });

      // A shopper who closes the panel or interrupts mid-sentence leaves us
      // writing to a dead socket; detach rather than keep buffering into it.
      res.on('close', () => {
        cancel();
        resolve();
      });
    });
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
    // Same purpose as widget_bootstrap on /api/config: only reachable if
    // widget.js actually executed. Recording the arm here means a merchant
    // reporting an invisible widget can be answered from the server, without
    // needing anything out of their browser.
    log.info('widget_exposure', { shop, arm, referer: header(req, 'referer') ?? null });
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

    /**
     * Which store is this shopper standing in?
     *
     * The app embed injects `shop.permanent_domain`, so the widget always
     * knows and now says so. Before this the answer was SHOP_DOMAIN for
     * everyone, which is how a snowboard question on one store got answered
     * from another.
     *
     * It is client-supplied and therefore spoofable — the same bounded
     * exposure the rate limiter above already accepts, and all it reaches is
     * public catalog data for the shop it names. Falling back to SHOP_DOMAIN
     * leaves single-tenant and demo deployments exactly as they were.
     */
    const claimed = parseShopDomain(body.shop);
    const shopDomain = claimed.ok ? claimed.shop! : (config.shopDomain ?? 'demo.local');

    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : randomUUID();
    const existing = await sessions.get(sessionId);
    // A session id is a string a browser handed us. It must never carry a
    // shop, a cart, or a transcript from one storefront into another, so a
    // mismatch starts a fresh session rather than adopting the old shop.
    const session =
      existing !== undefined && existing.shopDomain === shopDomain
        ? existing
        : newSession(sessionId, shopDomain);

    // Service level, decided before any model work so a degraded shop costs
    // less rather than costing a refusal.
    //
    // This REPLACES an earlier hard 402 at quota exhaustion, which violated
    // §8's "never a hard cut-off mid-conversation with a shopper". The person
    // cut off was the shopper — who has no idea a billing relationship exists,
    // was mid-sentence, and did nothing wrong. The merchant's plan is not the
    // shopper's problem, so an exhausted allowance now walks down the ladder
    // instead of off it. See resilience/ladder.ts.
    const entitlement = billing?.check(session.shopDomain);
    const level = decideLevel({
      budgetUsedFraction:
        entitlement === undefined || entitlement.included === 0
          ? 0
          : entitlement.used / entitlement.included,
      // Frozen or past an approved cap: no path to charging for more.
      unbillable: entitlement !== undefined && (entitlement.verdict === 'frozen' || entitlement.verdict === 'cap_reached'),
      catalogBreakerOpen: catalogBreaker.state(session.shopDomain) !== 'closed',
      modelDegraded: false,
      catalogUnavailable: false,
    });

    metrics.serviceLevel.inc({ shop: session.shopDomain, level: level.level });
    if (level.level !== 'full') {
      log.info('degraded', { shop: session.shopDomain, level: level.level, reason: level.reason });
    }

    // SSE. Headers go out immediately so the client can start rendering state
    // before the model produces anything.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // defeat nginx proxy buffering
    });
    /**
     * Emit one SSE frame, or drop it if the stream is already finished.
     *
     * The guard is not defensive tidiness — without it an ordinary failed turn
     * can take the process down. The speculative catalog search runs in parallel
     * with the model (see loop.ts), and when the model fails fast — a network
     * error, a 429 that outlives its retries — the turn's `finally` ends the
     * response while that search is still outstanding. It then resolves, tries to
     * send its `products` frame, and `res.write` throws ERR_STREAM_WRITE_AFTER_END
     * from a continuation no `await` is watching: an uncaught exception, which on
     * a single-instance deployment is every shopper's session, not just this one.
     *
     * Dropping is the right behaviour on its own terms, too. There is no client
     * left to receive the frame.
     */
    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('session', { sessionId });

    /**
     * Speak on a voice turn, as well as showing text.
     *
     * The rung below and the fast lane both answer without the orchestrator,
     * which is also what sends `speak` events — so without this a voice turn
     * that took either path put text on screen and said nothing, on a panel the
     * shopper is not necessarily looking at. Safe to speak in one piece: both
     * produce a short, already-settled sentence, so there is nothing for the
     * tripwire to retract.
     */
    /**
     * Emit one whole utterance, and start making its audio now.
     *
     * The `audioId` is what lets the widget fetch the sound with a GET and play it
     * progressively; announcing here is what lets the upstream round trip overlap
     * the SSE delivery, the widget's own request, and anything still playing ahead
     * of it. The text is still sent, because a client that cannot use the id — an
     * older widget, or one whose streamed playback failed — falls back to posting
     * it. See voice/speech-cache.ts.
     */
    const sendSpeak = (text: string): void => {
      if (text === '') return;
      send('speak', { text, audioId: speech.announce(text) });
    };

    const speakIfVoice = (text: string): void => {
      if (body.voice === true) sendSpeak(text);
    };

    /**
     * Offer the next narrowing, or explicitly clear what was offered before.
     *
     * Always sent, empty included. A chip row left over from the previous answer
     * is a suggestion about products that are no longer on screen — the same
     * mistake the early product cards made, where the pictures contradicted the
     * words and the pictures are what people believe.
     */
    const sendChips = (products: readonly unknown[]): void => {
      send('chips', { chips: renderChips(suggestChips(products), currencyOf(products)) });
    };

    // The bottom two rungs need no model at all. Answering here costs nothing
    // and is still not an error page — the shopper gets a route to a person.
    const bottomRung = shopperMessage(level.level);
    if (bottomRung !== undefined) {
      send('delta', { text: bottomRung });
      speakIfVoice(bottomRung);
      send('done', { reply: bottomRung, escalated: true, grounded: true, attempts: 0, ms: 0, degraded: level.level });
      res.end();
      return;
    }

    /**
     * The deterministic lane.
     *
     * Some turns are not questions. "Just the blue ones" narrows what is already
     * on screen; "what's in my cart" is a read. Both have exactly one correct
     * answer that we hold, and routing them through a model costs the shopper
     * seconds, the merchant a turn of allowance, and reliability — the model
     * would be re-deriving something we already know exactly.
     *
     * Every path here either answers completely or returns false and lets the
     * model have the turn. There is no half-answer: see the empty-filter case.
     */
    /**
     * Learn what the shopper just told us about what they want.
     *
     * Before the fast lane, so a narrowing turn still teaches us something — and
     * before the model, so the turn that mentions a size is already the turn
     * where the assistant knows it.
     */
    const heard = extractPreferences(body.message);
    if (Object.keys(heard).length > 0) {
      session.preferences = mergePreferences(session.preferences ?? {}, heard);
      log.info('preferences_learned', {
        shop: session.shopDomain,
        // The keys, never the values: a size is about a person.
        fields: Object.keys(heard),
      });
    }

    /**
     * The three questions about the product in front of them.
     *
     * Measured: the model owns 62% of the wait before a voice answer is audible,
     * and for a price, a stock boolean or an option list it spends it
     * re-deriving what one catalog read already holds exactly. Tried first
     * because it is the most specific lane — it needs the page to have named a
     * product, and the classifier refuses anything with a word it does not
     * recognise. See page-facts.ts for why that allowlist is the safety property.
     */
    const pageFact = body.page === undefined ? undefined : classifyPageFact(body.message, body.page);
    if (pageFact !== undefined) {
      const answered = await answerPageFactWithoutModel(pageFact, {
        session,
        page: body.page!,
        send,
        speakIfVoice,
        startedAt: Date.now(),
      });
      if (answered) {
        metrics.fastLane.inc({ shop: session.shopDomain, intent: `page_${pageFact.kind}` });
        log.info('fast_lane', {
          shop: session.shopDomain,
          intent: `page_${pageFact.kind}`,
          why: pageFact.reason,
        });
        await sessions.put(session);
        res.end();
        return;
      }
      metrics.fastLane.inc({ shop: session.shopDomain, intent: `page_${pageFact.kind}_declined` });
    }

    const fast = classifyIntent(body.message, {
      visibleProducts: session.products?.length ?? 0,
      hasCart: session.cartId !== undefined,
    });
    if (fast.kind !== 'none') {
      const answered = await answerWithoutModel(fast, {
        session,
        send,
        speakIfVoice,
        sendChips,
        startedAt: Date.now(),
      });
      if (answered) {
        metrics.fastLane.inc({ shop: session.shopDomain, intent: fast.kind });
        log.info('fast_lane', { shop: session.shopDomain, intent: fast.kind, why: fast.reason });
        await sessions.put(session);
        res.end();
        return;
      }
      // Fell through on purpose. Counted separately, because a lane that keeps
      // declining is a lane whose patterns are wrong, and that is invisible if
      // only its successes are counted.
      metrics.fastLane.inc({ shop: session.shopDomain, intent: `${fast.kind}_declined` });
    }

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
    // Every product seen this turn, not just the first search's — see the
    // reconciliation at .
    const allProducts: unknown[] = [];
    const executor = createToolExecutor({
      session,
      ucp: ucpFor(session.shopDomain),
      ...(deps.catalogIndex === undefined ? {} : { catalogIndex: deps.catalogIndex }),
      productLookup: productLookupBreaker,
      catalogSnapshot,
      log,
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
    const CART_TOOLS = new Set(['create_cart', 'update_cart', 'get_cart', 'cancel_cart']);
    const observing = {
      async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
        // §9: "disable cart actions rather than guessing". Adding the wrong
        // variant is worse than adding nothing, because the shopper finds out
        // at checkout.
        if (!level.cartActions && CART_TOOLS.has(name)) {
          return { error: 'Cart actions are temporarily unavailable for this store.' };
        }

        // Catalog calls go through the merchant's breaker, so a storefront
        // that keeps timing out stops holding connections open.
        const upstreamStart = Date.now();
        const result = await catalogBreaker
          .run(session.shopDomain, () => executor.execute(name, input, signal))
          .finally(() => metrics.upstream.observe(Date.now() - upstreamStart, { target: 'catalog' }));
        if (name === 'search_catalog' || name === 'get_product') {
          const extracted = extractProducts(result);
          // Everything seen this turn, deduped — the pool the final cards are
          // chosen from once the reply is settled. The early send below is
          // still only the first search, so something is on screen fast.
          for (const p of extracted) {
            const id = (p as { id?: unknown }).id;
            if (!allProducts.some((q) => (q as { id?: unknown }).id === id)) allProducts.push(p);
          }
          if (extracted.length > 0 && products.length === 0) {
            products.push(...extracted);
            send('products', { products: extracted });
          }
        }
        return result;
      },
    };

    // Degrading picks a cheaper tier rather than refusing. `faq_only` drops to
    // the classify tier, which is enough to answer from merchant policy but
    // not to reason over a live catalog — exactly the expensive part we are
    // trying to stop paying for.
    const tier = tierFor(level.level, false) ?? 'classify';
    const tieredModels =
      tier === 'workhorse'
        ? config.models
        : { ...config.models, workhorse: config.models[tier], escalation: config.models[tier] };

    const orchestrator = new Orchestrator({
      model,
      tools: observing,
      models: tieredModels,
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
            // Volatile, per-shopper, and therefore in the turn context rather
            // than the cached prefix. Omitted entirely when nothing is known, so
            // an early turn spends no tokens saying so.
            ...(() => {
              const line = renderPreferences(session.preferences ?? {});
              return line === '' ? {} : { preferences: line };
            })(),
          },
          merchant: await merchantPackFor(session.shopDomain),
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
              for (const utterance of chunker.push(text)) sendSpeak(utterance);
            }
          },
        },
      );

      // Whatever is left over once the model stops — usually a final clause
      // with no terminal punctuation.
      if (chunker !== undefined) {
        const tail = chunker.flush();
        if (tail !== undefined) sendSpeak(tail);
      }

      // The tripwire may have aborted a partial message — tell the client to
      // discard whatever it painted before showing the final text.
      if (result.events.some((e) => e.type === 'stream_aborted')) send('reset', {});

      /**
       * Re-send the cards, narrowed to the products the answer actually names.
       *
       * Cards are emitted early, off the FIRST catalog search, so they can be
       * on screen while the model is still writing. That first search is a
       * guess at what the shopper meant, and the answer is often composed
       * from a later or broader one — so the pictures and the words routinely
       * disagreed, showing two boards beside a reply discussing four others.
       *
       * By `done` the reply is settled and every tool result is in hand, so
       * the two can be reconciled. Only narrowed, never widened: a product
       * the answer does not mention has no business being pictured.
       */
      const named = allProducts.filter((p) => {
        const title = (p as { title?: unknown }).title;
        return typeof title === 'string' && title !== '' && result.reply.includes(title);
      });
      /**
       * ALWAYS sent, including empty.
       *
       * This used to fire only when the count changed, so an answer that
       * named no products at all left the early cards on screen — and the
       * early cards are whatever the first search returned, which for an
       * unmatched query is the browse fallback. Asked for "cheapest shoes",
       * a snowboard shop showed a gift card and a snowboard under "WHAT I
       * FOUND", beside a reply that had found nothing. The pictures
       * contradicted the words and the pictures are what people believe.
       *
       * An empty list clears the rail, which is the honest state when the
       * answer mentions nothing.
       */
      // The card shows the variant the conversation named — the white pair,
      // not whichever colourway the merchant featured. See variant-image.ts.
      const shown = withVariantImages(named, `${body.message} ${result.reply}`);
      send('products', { products: shown, final: true });

      /**
       * Remember exactly what is on screen.
       *
       * This is what makes the next turn's "just the blue ones" answerable
       * without a model — and it has to be THIS list, the reconciled one, not
       * the early speculative cards. Narrowing a set the shopper cannot see
       * would produce an answer about products that are not in front of them.
       *
       * Cleared when a turn shows nothing, so a narrowing phrase after an empty
       * answer goes to the model as a fresh search instead of silently reusing
       * a set from two turns ago.
       */
      // `delete` rather than assigning undefined: exactOptionalPropertyTypes
      // draws the distinction, and "the key is absent" is what the stores write
      // as SQL NULL.
      if (shown.length === 0) delete session.products;
      else session.products = shown.slice(0, MAX_VISIBLE_PRODUCTS);

      // Funnel: products actually reached the screen. Recorded from what the
      // server sent rather than from a client beacon, so it cannot be inflated.
      if (shown.length > 0) {
        void attribution.recordStep(session.shopDomain, sessionId, 'cards_shown');
      }

      /**
       * Offer the next narrowing, from what is actually on screen.
       *
       * Derived from the products rather than invented by the model, for the same
       * reason the catalog is never summarised into the prompt: the answer is in
       * the data. Each chip is verified against the real filter before being
       * offered, so it cannot suggest a colour nothing has — and because the
       * phrases classify, tapping one is answered with no model call at all.
       */
      sendChips(session.products ?? []);

      // A turn reaches a human two ways: the loop gave up (`escalated`) or the
      // agent chose to hand off (`handedOff`). A client asking "did this reach
      // a human?" means the union — reporting only the first told the smoke
      // test a lead-capture handoff was a clean answer, and it passed. Both are
      // sent so a client that cares which one can still tell them apart.
      send('done', {
        reply: result.reply,
        escalated: reachedHuman(result),
        handedOff: result.handedOff,
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
      // The metric is documented as "escalated to a human or lead capture", so
      // a deliberate handoff belongs in it. Counting only `escalated` made
      // every captured lead invisible to the SLO dashboards.
      if (reachedHuman(result)) {
        metrics.escalations.inc({ shop: session.shopDomain });
      }
      // Read the fields `TurnResult.usage` actually declares.
      //
      // This used to index `inputTokens`/`outputTokens`/`cachedInputTokens`
      // through a `Record<string, unknown>` cast. The usage object has none of
      // those keys — it has `input`/`output`/`cacheRead` — so every lookup was
      // `undefined`, the `> 0` guard rejected it, and the counter never moved.
      // Token spend is the only metric that says what a conversation costs, and
      // it had been reporting zero since the day it was added, on a dashboard
      // that looked healthy.
      //
      // Destructured rather than indexed so a future rename is a compile error
      // instead of another silently empty panel.
      if (result.usage !== undefined) {
        const { input, output, cacheRead } = result.usage;
        for (const [n, kind] of [
          [input, 'input'],
          [output, 'output'],
          [cacheRead, 'cached'],
        ] as const) {
          if (Number.isFinite(n) && n > 0) {
            metrics.tokens.inc({ shop: session.shopDomain, kind }, n);
          }
        }
      }

      // Beside the token counts, because that is the question it answers: a
      // prefix that keeps changing is why `cached` would be zero.
      watchPrefix(session.shopDomain, result.prefixFingerprint);

      // Never the message or the reply — see observability/logger.ts.
      //
      // `violations` is the codes only, deliberately. `grounded: false` said
      // that a shopper got an escalation instead of an answer and gave no way
      // to find out why: the verdict carried the reason and it was discarded
      // here, so every grounding failure looked identical in production. The
      // codes are a closed vocabulary from the validator, so they carry no
      // shopper text — the evidence field does, which is why it stays out.
      log.info('turn_complete', {
        shop: session.shopDomain,
        sessionId,
        grounded: result.verdict.ok,
        escalated: result.escalated,
        handedOff: result.handedOff,
        attempts: result.attempts,
        ttftMs: firstDeltaAt === undefined ? null : firstDeltaAt - startedTurnAt,
        ms: Date.now() - startedTurnAt,
        /**
         * WHY grounding failed, not just that it did.
         *
         * `grounded:false, escalated:true, attempts:2` with no tool error
         * says the tripwire fired twice and tells you nothing about what it
         * caught — and the cause turned out to be prices copied out of an
         * example in the system prompt rather than read from a tool result.
         * That took a code read to find and a violation code would have
         * named it. Codes only: the retracted text is the shopper's answer
         * and never goes in a log.
         */
        ...(result.events.some((e) => e.type === 'grounding_retry')
          ? {
              violations: result.events
                .filter((e) => e.type === 'grounding_retry')
                .map((e) => e.detail),
            }
          : {}),
        // A tool that threw is worth a line whether or not grounding failed:
        // the shopper is being told something is broken, and until now that
        // sentence was the only record of it anywhere.
        ...(result.events.some((e) => e.type === 'tool_error')
          ? {
              toolErrors: result.events
                .filter((e) => e.type === 'tool_error')
                .map((e) => e.detail ?? 'unknown'),
            }
          : {}),
        ...(result.verdict.violations.length === 0
          ? {}
          : {
              // Evidence included: for every code the validator emits it is
              // either a formatted amount or a match from a fixed phrase list,
              // never free-form shopper text. Without it the code says a price
              // was untraceable but not WHICH, which is most of the answer.
              violations: result.verdict.violations.map(
                (v) => `${v.severity}:${v.code}${v.evidence === undefined ? '' : `(${v.evidence})`}`,
              ),
              toolsCalled: result.events
                .filter((e) => e.type === 'tool_end')
                .map((e) => e.detail ?? 'unknown'),
            }),
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
  /** The storefront the widget is embedded in — `shop.permanent_domain`. */
  shop?: unknown;
  /**
   * What the widget read off the storefront. Identity only — no price and no
   * availability, because this arrives from the shopper's browser and a modified
   * page must not be able to put a figure in the assistant's mouth.
   */
  page?: {
    type: 'product' | 'collection' | 'cart' | 'other';
    title?: string;
    productId?: string;
    /** The variant `?variant=` names, and its option value ("Ice"). */
    variantId?: string;
    variantName?: string;
    handle?: string;
    collectionId?: string;
  };
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
/**
 * Serve a static file.
 *
 * ## Caching, and why it is not `no-cache`
 *
 * `widget.js` loads on **every page of every storefront**. Served
 * `no-cache` it forces a revalidation round trip on each navigation — and
 * Shopify themes are full-page reloads, so that is every product click. The
 * bytes come back 304, but the latency does not, and `ARCHITECTURE §12` gates
 * on not costing the merchant more than 10 Lighthouse points.
 *
 * `immutable` would be wrong at a fixed URL: a fix would never reach a
 * storefront. So assets get a short freshness window plus a long
 * `stale-while-revalidate` — a repeat visit inside the week paints from cache
 * with no blocking request, while the update lands on the next fetch. A bad
 * widget is therefore at most ten minutes from being replaced everywhere.
 *
 * HTML stays `no-cache`: the demo page is not worth a stale render.
 */
function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): boolean {
  const root = publicRoot();
  if (root === undefined) return false;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = builtWidget(root, pathname) ?? resolve(root, rel);
  if (!target.startsWith(resolve(root))) return false; // traversal attempt

  try {
    const body = readFileSync(target);
    const ext = extname(target);
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

    // A matching ETag means the storefront already has these exact bytes.
    if (header(req, 'if-none-match') === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControlFor(ext, pathname) });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': cacheControlFor(ext, pathname),
      etag,
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * The minified bundle, when there is one and it is current.
 *
 * `/widget.js` is the URL every storefront has embedded, so the built file is
 * served UNDER THE SOURCE'S NAME rather than at its own — renaming the asset
 * would strand every theme already pointing at the old one.
 *
 * The mtime comparison is the point. A stale build artifact is worse than no
 * build artifact: the source would say one thing, the storefront would run
 * another, and nothing anywhere would disagree out loud. Editing widget.js
 * without rebuilding therefore falls back to the source — slower, but what the
 * developer is actually looking at. `npm run build` regenerates it, so
 * production always serves the small one.
 */
function builtWidget(root: string, pathname: string): string | undefined {
  // Both bundles, by the same rule. `/widget-voice.js` is fetched by the host
  // on the first mic press; it is a separate file because the microphone is the
  // heaviest thing the widget does and the least often used, so it must not
  // ship with every page view. See ARCHITECTURE §3.1.
  const name =
    pathname === '/widget.js' ? 'widget' : pathname === '/widget-voice.js' ? 'widget-voice' : undefined;
  if (name === undefined) return undefined;
  const built = resolve(root, `${name}.min.js`);
  try {
    if (statSync(built).mtimeMs >= statSync(resolve(root, `${name}.js`)).mtimeMs) return built;
  } catch {
    // Not built yet — a fresh checkout, or `npm run build` has not run.
  }
  return undefined;
}

/**
 * Render a minor-unit amount for a reply the shopper reads or hears.
 *
 * ALWAYS two decimal places, never rounded. This is the exact mistake that
 * retracted live answers twice: the model wrote `$785` for a price of `78595`
 * minor, the tripwire found 78500 underivable and killed the stream. There is no
 * model on this path, which means nothing downstream would catch a rounding bug
 * here — so it does not round.
 *
 * Unknown currencies get their code rather than a guessed symbol. "974.95 SEK"
 * is plain; "$974.95" for kronor is wrong.
 */
const CURRENCY_SYMBOL: Readonly<Record<string, string>> = {
  USD: '$',
  CAD: '$',
  AUD: '$',
  GBP: '£',
  EUR: '€',
  INR: '₹',
  JPY: '¥',
};

export function money(minor: number, currency?: string): string {
  const code = (currency ?? 'USD').toUpperCase();
  const amount = (minor / 100).toFixed(2);
  const symbol = CURRENCY_SYMBOL[code];
  return symbol === undefined ? `${amount} ${code}` : `${symbol}${amount}`;
}

/**
 * Turn chip specs into what the widget shows and sends.
 *
 * The `message` comes from the orchestrator because it has to be a phrase the
 * classifier recognises — tapping a chip must be answered deterministically, not
 * cost a model turn. Only the LABEL is built here, because labelling a price
 * needs the shop's currency and `money` already knows how to do that without
 * rounding.
 */
function renderChips(
  chips: readonly Chip[],
  currency: string | undefined,
): { label: string; message: string }[] {
  return chips.map((c) => ({
    message: c.message,
    label:
      c.kind === 'colour'
        ? `Just the ${c.colour}`
        : c.kind === 'cheaper'
          ? 'Cheaper'
          : c.kind === 'similar'
            ? 'More like this'
            : `Under ${money(c.maxMinor ?? 0, currency)}`,
  }));
}

/**
 * Say what is in a cart, from the cart.
 *
 * Shared by the cart read and the add-from-a-card confirmation so the two cannot
 * describe the same cart differently. Every figure is copied from the payload and
 * formatted by `money`, which never rounds — there is no model on either path, so
 * nothing downstream would catch it if it did.
 *
 * `messages` are passed through VERBATIM. They carry business outcomes — out of
 * stock, quantity adjusted — and ARCHITECTURE §4 is explicit that paraphrasing
 * them is where hallucination enters.
 */
function cartSummary(
  cart: { line_items?: readonly { title?: string; quantity: number }[]; subtotal?: { amount: number; currency?: string } },
  messages: readonly { text: string }[] | undefined,
): string {
  const lines = (cart.line_items ?? []).filter((li) => li.quantity > 0);
  if (lines.length === 0) return 'Your cart is empty.';

  const named = lines.map((li) => `${li.title ?? 'item'}${li.quantity > 1 ? ` ×${li.quantity}` : ''}`);
  const parts = [`${named.join(', ')}.`];
  if (cart.subtotal !== undefined) {
    parts.push(`Subtotal ${money(cart.subtotal.amount, cart.subtotal.currency)}.`);
  }
  for (const m of messages ?? []) if (m.text !== '') parts.push(m.text);
  return parts.join(' ');
}

/** The currency a set of products is priced in, if they agree on one. */
function currencyOf(products: readonly unknown[]): string | undefined {
  for (const p of products) {
    const variants = (p as { variants?: unknown }).variants;
    if (!Array.isArray(variants)) continue;
    for (const v of variants) {
      const code = (v as { price?: { currency?: unknown } }).price?.currency;
      if (typeof code === 'string' && code !== '') return code;
    }
  }
  return undefined;
}

/** A search-ish string for variant image selection, from a filter. */
function describeFilter(filter: ProductFilter): string {
  return [filter.colour, filter.cheaper === true ? 'cheap' : '', filter.dearer === true ? 'premium' : '']
    .filter((s) => s !== undefined && s !== '')
    .join(' ');
}

function cacheControlFor(ext: string, pathname?: string): string {
  if (ext === '.html') return 'no-cache';

  // widget.js is the whole product and is unversioned: every storefront asks
  // for the same URL forever. The shared policy below would let a browser
  // serve a copy up to a WEEK old, so a merchant could keep running a bug for
  // days after it was fixed, and "I deployed a fix" and "you are still on the
  // old code" would be indistinguishable.
  //
  // `must-revalidate` was the first answer to that and overcorrected: past the
  // freshness window it blocks the page on a round trip, on a file that loads
  // on every navigation of every storefront — the exact cost the caching
  // policy above exists to avoid. It buys nothing either, because the ETag
  // already makes the revalidation a 304.
  //
  // A short `stale-while-revalidate` gets both: the page paints immediately
  // from cache and the update is fetched in the background, so a fix lands on
  // the shopper's NEXT navigation instead of stalling this one. An hour, not a
  // week — the ceiling on running old code stays measured in minutes.
  if (pathname === '/widget.js') return 'public, max-age=300, stale-while-revalidate=3600';

  /**
   * The voice chunk is requested with `?v=<BUILD>`, so it is genuinely
   * immutable at that URL: a new build asks for a new one. That earns a long
   * cache with no revalidation, which matters because the request sits between
   * a shopper pressing the microphone and being able to speak — the one place
   * in this product where a 304 round trip is felt directly.
   *
   * The query string is not part of the file we serve; it exists only to make
   * the URL change, which is exactly what makes this safe.
   */
  if (pathname === '/widget-voice.js') return 'public, max-age=31536000, immutable';

  return 'public, max-age=600, stale-while-revalidate=604800';
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

/**
 * Which storefront origins may call the gateway.
 *
 * ALLOWED_ORIGINS alone is a single-tenant answer to a multi-tenant question.
 * A public app cannot enumerate its merchants' storefronts in an env var
 * before they install, so every origin not on the list was refused — and a
 * refused preflight fails in the browser, before the request exists, with
 * nothing in our logs. App review enabled the embed on their own test store,
 * asked for snowboards, and got "I couldn't reach the store just then": the
 * widget rendered, the gateway was healthy, and the two were never introduced.
 *
 * Three ways in, cheapest first:
 *
 *   1. ALLOWED_ORIGINS — the operator's own list. Self-hosting, the demo page,
 *      localhost in development.
 *   2. Any `{name}.myshopify.com` over https. Every Shopify storefront has
 *      one, it is the origin a fresh install serves from, and the domain
 *      grammar is strict (see shopify/domain.ts).
 *   3. A custom storefront domain, but only when the request names an
 *      installed shop. The origin itself proves nothing here — anyone can host
 *      anything — so the install record is what vouches for it.
 *
 * None of this is the spend control, and it never was: the config notes
 * already say a script can POST /api/chat directly and skip CORS entirely.
 * The rate limiter and the per-shop daily ceiling are what bound the bill.
 * This decides whose *browser* can talk to us, so widening it costs a
 * freeloading dev store at worst, while narrowing it costs every real merchant
 * their assistant.
 */
async function allowedOrigin(
  origin: string | undefined,
  url: URL,
  allowed: readonly string[],
  shops: ShopStore,
): Promise<string | undefined> {
  if (allowed.includes('*')) return origin ?? '*';
  if (origin === undefined) return undefined;
  if (allowed.includes(origin)) return origin;

  let host: string;
  try {
    const parsed = new URL(origin);
    // A storefront is https. Anything else is either a local page or someone
    // stripping transport security, and neither is a merchant.
    if (parsed.protocol !== 'https:') return undefined;
    host = parsed.hostname;
  } catch {
    // Opaque origins ("null") and malformed values land here.
    return undefined;
  }

  if (isValidShopDomain(host)) return origin;

  const claimed = parseShopDomain(url.searchParams.get('shop'));
  if (claimed.ok && (await shops.get(claimed.shop!)) !== undefined) return origin;

  return undefined;
}

async function cors(
  res: ServerResponse,
  origin: string | undefined,
  url: URL,
  allowed: readonly string[],
  shops: ShopStore,
): Promise<void> {
  const ok = await allowedOrigin(origin, url, allowed, shops);
  if (ok !== undefined) res.setHeader('access-control-allow-origin', ok);
  /**
   * Every custom header the widget sends must be listed here.
   *
   * The widget is cross-origin by definition — it runs on the merchant's
   * storefront and posts here — so any header beyond the CORS-safelisted
   * ones triggers a preflight, and a preflight that does not name the
   * header fails the request before it is ever sent. Adding
   * `x-storefront-lang` to the voice upload without adding it here took
   * voice from working to "NetworkError when attempting to fetch
   * resource", with nothing whatsoever in the server log, because the
   * request never arrived.
   */
  res.setHeader('access-control-allow-headers', 'content-type,x-storefront-lang');
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
