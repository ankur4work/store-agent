import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, OpenAIModelClient, reachedHuman, type MerchantPack } from '@storeagent/orchestrator';
import { UcpClient } from '@storeagent/ucp-client';
import type { GatewayConfig } from './config.js';
import { MemorySessionStore, newSession, type SessionStore } from './sessions.js';
import { createToolExecutor } from './tool-executor.js';
import { RateLimiter } from './limits/limiter.js';
import { BillingService } from './billing/service.js';
import { Telemetry } from './observability/telemetry.js';
import { CircuitBreaker, decideLevel, shopperMessage, tierFor } from '@storeagent/resilience';
import { createLogger, type Logger } from './observability/logger.js';
import { PLANS, PLAN_ORDER, isPlanId } from '@storeagent/billing';
import { DEMO_CATALOG } from './catalog-fixture.js';
import { beginInstall, completeInstall } from './shopify/oauth.js';
import { parseShopDomain } from './shopify/domain.js';
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
import { pricingPlansUrl } from './billing/managed.js';
import type { CatalogIndex } from './search/catalog-index.js';
import { withVariantImages } from './search/variant-image.js';
import { BillingApiError } from './billing/shopify-billing.js';
import {
  MemorySettingsStore,
  VOICE_LANGUAGES,
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

  // Per merchant: a storefront that keeps failing must not hold connections
  // and starve every other merchant's turns. See resilience/breaker.ts.
  const catalogBreaker = new CircuitBreaker();

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
    if (url.pathname === '/api/voice/speak' && req.method === 'POST') {
      await handleSpeak(req, res);
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
            mode: (ucp ? 'live' : 'demo') as 'live' | 'demo',
            model: config.models.workhorse,
          },
          lift,
          liftSummary: describeLift(lift),
          recommendedHoldout: recommendedHoldout(totals.exposed.sessions + totals.holdout.sessions),
          unmatchedOrders: await attribution.unmatchedCount(shop),
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

  async function handleTranscribe(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
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
      const shop = url.searchParams.get('shop') ?? config.shopDomain ?? 'demo.local';
      const merchantDefault = (await settings.get(shop)).voiceLanguage;
      // The header carries the shopper's pick from the widget; it starts on
      // the merchant's default, so it is the more specific answer when
      // present. 'auto' is a real choice and means send no language at all.
      const chosen = pageLang === '' ? merchantDefault : pageLang;
      const resolved = chosen === 'auto' || !/^[a-z]{2}$/.test(chosen) ? '' : chosen;
      const cfg = {
        ...voiceConfig,
        log,
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
      const text = await transcribe(audio, contentType, cfg);
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

    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : randomUUID();
    const session =
      (await sessions.get(sessionId)) ?? newSession(sessionId, config.shopDomain ?? 'demo.local');

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
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('session', { sessionId });

    // The bottom two rungs need no model at all. Answering here costs nothing
    // and is still not an error page — the shopper gets a route to a person.
    const bottomRung = shopperMessage(level.level);
    if (bottomRung !== undefined) {
      send('delta', { text: bottomRung });
      send('done', { reply: bottomRung, escalated: true, grounded: true, attempts: 0, ms: 0, degraded: level.level });
      res.end();
      return;
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
      ucp,
      ...(deps.catalogIndex === undefined ? {} : { catalogIndex: deps.catalogIndex }),
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
      send('products', {
        products: withVariantImages(named, `${body.message} ${result.reply}`),
        final: true,
      });

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
  const target = resolve(root, rel);
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

function cacheControlFor(ext: string, pathname?: string): string {
  if (ext === '.html') return 'no-cache';

  // widget.js is the whole product and is unversioned: every storefront asks
  // for the same URL forever. Under the shared policy below, a browser may
  // serve a copy up to a WEEK old while it revalidates — so a merchant can keep
  // running a bug for days after it is fixed, and "I deployed a fix" and "you
  // are still on the old code" are indistinguishable. It has an ETag, so
  // revalidation is a 304 and costs almost nothing.
  if (pathname === '/widget.js') return 'public, max-age=300, must-revalidate';

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

function cors(res: ServerResponse, origin: string | undefined, allowed: readonly string[]): void {
  const ok = allowed.includes('*') ? (origin ?? '*') : allowed.includes(origin ?? '') ? origin! : '';
  if (ok !== '') res.setHeader('access-control-allow-origin', ok);
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
