import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { bearerToken, signSessionToken, verifySessionToken } from '../src/admin/session-token.js';
import {
  MemorySettingsStore,
  accentIsAccessible,
  contrastWithWhite,
  validateSettings,
} from '../src/admin/settings.js';
import { esc, renderAdmin } from '../src/admin/render.js';
import { analyze, describe as describeLift } from '@storeagent/attribution';
import type { ShopSettings } from '../src/admin/settings.js';
import { MemoryShopStore } from '../src/shopify/shops.js';
import { BillingService } from '../src/billing/service.js';
import { SqliteBillingStore } from '../src/billing/store.js';
import { openDatabase } from '../src/store/sqlite.js';

const API_KEY = 'test-client-id';
const SECRET = 'shpss_admin_secret';
const SHOP = 'acme.myshopify.com';
const AUTH = { apiKey: API_KEY, apiSecret: SECRET };

function token(over: Record<string, unknown> = {}, secret = SECRET, alg = 'HS256'): string {
  return signSessionToken({ dest: `https://${SHOP}`, aud: API_KEY, ...over }, secret, alg);
}

/**
 * The session token is the auth boundary for the whole admin — everything a
 * merchant can see or change sits behind it. It gets the same scrutiny as the
 * OAuth path.
 */
describe('session token verification', () => {
  it('accepts a well-formed token', () => {
    const r = verifySessionToken(token(), AUTH);
    expect(r.ok).toBe(true);
    expect((r as { shop: string }).shop).toBe(SHOP);
  });

  it('rejects alg:none — the classic forgery', () => {
    // A token claiming no signature must never be trusted, however well-formed.
    const r = verifySessionToken(token({}, SECRET, 'none'), AUTH);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toContain('unsupported alg');
  });

  it('rejects RS256 rather than verifying it with our HMAC secret', () => {
    // Algorithm confusion: treating the HMAC secret as an RSA public key.
    expect(verifySessionToken(token({}, SECRET, 'RS256'), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects a signature from a different secret', () => {
    expect(verifySessionToken(token({}, 'other-secret'), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects a tampered payload', () => {
    const t = token();
    const [h, , s] = t.split('.');
    const evil = Buffer.from(JSON.stringify({ dest: 'https://evil.myshopify.com', aud: API_KEY }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifySessionToken(`${h}.${evil}.${s}`, AUTH)).toMatchObject({ ok: false });
  });

  it('rejects an expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifySessionToken(token({ exp: now - 600, nbf: now - 700 }), AUTH)).toMatchObject({
      ok: false,
      reason: 'token expired',
    });
  });

  it('rejects a not-yet-valid token', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifySessionToken(token({ nbf: now + 600, exp: now + 900 }), AUTH)).toMatchObject({
      ok: false,
      reason: 'token not yet valid',
    });
  });

  it('rejects a token minted for a DIFFERENT app', () => {
    // Same store, another app's token. Without the aud check it would pass.
    expect(verifySessionToken(token({ aud: 'someone-elses-app' }), AUTH)).toMatchObject({
      ok: false,
      reason: 'audience mismatch',
    });
  });

  it('rejects a dest that is not a shop domain', () => {
    expect(verifySessionToken(token({ dest: 'https://evil.com' }), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects a non-https dest', () => {
    expect(verifySessionToken(token({ dest: `http://${SHOP}` }), AUTH)).toMatchObject({ ok: false });
  });

  it('rejects an iss that does not match dest', () => {
    expect(
      verifySessionToken(token({ iss: 'https://other.myshopify.com/admin' }), AUTH),
    ).toMatchObject({ ok: false, reason: 'iss does not match dest' });
  });

  it.each([undefined, '', 'not.a.jwt', 'a.b', 'a.b.c.d'])('rejects malformed input: %s', (t) => {
    expect(verifySessionToken(t as string | undefined, AUTH)).toMatchObject({ ok: false });
  });

  it('does not throw on a garbage signature length', () => {
    const [h, p] = token().split('.');
    expect(() => verifySessionToken(`${h}.${p}.AA`, AUTH)).not.toThrow();
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['  Bearer   abc  ', 'abc'],
  ])('parses %s', (h, expected) => {
    expect(bearerToken(h)).toBe(expected);
  });

  it.each([undefined, '', 'Basic abc', 'abc'])('rejects %s', (h) => {
    expect(bearerToken(h)).toBeUndefined();
  });
});

describe('settings validation', () => {
  it('accepts a sane payload', () => {
    const r = validateSettings(SHOP, { accentColor: '#1b3a34', cornerRadius: 16, position: 'left' });
    expect(r.ok).toBe(true);
    expect(r.settings).toMatchObject({ shop: SHOP, position: 'left' });
  });

  it.each([
    'red;} body{display:none',
    'javascript:alert(1)',
    'var(--x)',
    '#12',
    'rgb(0,0,0)',
    '#1b3a34; background:url(x)',
  ])('rejects a non-hex accent: %s', (colour) => {
    // The accent is interpolated into a CSS custom property, so anything but a
    // strict hex literal could escape the declaration.
    expect(validateSettings(SHOP, { accentColor: colour }).ok).toBe(false);
  });

  it('rejects an out-of-range radius', () => {
    expect(validateSettings(SHOP, { cornerRadius: 400 }).ok).toBe(false);
    expect(validateSettings(SHOP, { cornerRadius: -4 }).ok).toBe(false);
  });

  it('rejects an unknown position', () => {
    expect(validateSettings(SHOP, { position: 'middle' }).ok).toBe(false);
  });

  it('rejects an over-long greeting', () => {
    expect(validateSettings(SHOP, { greeting: 'x'.repeat(200) }).ok).toBe(false);
  });

  it('always takes the shop from the caller, never the payload', () => {
    // Guards against a merchant writing another store's settings.
    const r = validateSettings(SHOP, { shop: 'victim.myshopify.com', accentColor: '#000000' });
    expect(r.settings!.shop).toBe(SHOP);
  });

  it('round-trips through the store', async () => {
    const store = new MemorySettingsStore();
    const r = validateSettings(SHOP, { accentColor: '#112233' });
    await store.put(r.settings!);
    expect((await store.get(SHOP)).accentColor).toBe('#112233');
  });

  it('returns defaults for an unknown shop', async () => {
    expect((await new MemorySettingsStore().get('new.myshopify.com')).accentColor).toBe('#1b3a34');
  });
});

describe('accent contrast', () => {
  it('passes a dark accent', () => {
    expect(accentIsAccessible('#1b3a34')).toBe(true);
  });

  it.each(['#ffff00', '#e0e0e0', '#ffffff', '#7fffd4'])('rejects a pale accent: %s', (c) => {
    // White text sits on the accent; a pale one is unreadable.
    expect(accentIsAccessible(c)).toBe(false);
  });

  it('expands 3-digit hex', () => {
    expect(contrastWithWhite('#000')).toBeCloseTo(contrastWithWhite('#000000'), 5);
  });

  it('gives black the maximum contrast', () => {
    expect(contrastWithWhite('#000000')).toBeCloseTo(21, 0);
  });
});

describe('render escaping', () => {
  it('escapes html metacharacters', () => {
    expect(esc('<script>"x"&\'y\'')).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
  });

  it('escapes a hostile greeting rather than emitting it raw', () => {
    const out = renderAdmin(viewModel({ greeting: '"><script>alert(1)</script>' }));
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });
});

function viewModel(settingsOver: Partial<ShopSettings> = {}, liftOver?: Parameters<typeof analyze>) {
  const lift = liftOver
    ? analyze(...liftOver)
    : analyze({ sessions: 0, conversions: 0, revenueMinor: 0 }, { sessions: 0, conversions: 0, revenueMinor: 0 });
  return {
    shop: SHOP,
    apiKey: API_KEY,
    host: '',
    settings: {
      shop: SHOP,
      accentColor: '#1b3a34',
      cornerRadius: 16,
      position: 'right' as const,
      greeting: '',
      enabled: true,
      holdoutFraction: 0.2,
      updatedAt: 0,
      ...settingsOver,
    },
    stats: { activeSessions: 0, mode: 'demo' as const, model: 'm' },
    lift,
    liftSummary: describeLift(lift),
    recommendedHoldout: 0.2,
    unmatchedOrders: 0,
  };
}

/**
 * A stored offline token dies whenever the app is reinstalled or its scopes
 * change. Provisioning only ran when no shop row existed, so the first dead
 * token was permanent: every Admin API call 401'd, the subscription could
 * never be read, and a merchant who had paid was shown "Free" for good —
 * reinstalling did not help, because the row still existed.
 */
describe('recovering from a rejected access token', () => {
  let server: Server;
  let base: string;
  let realFetch: typeof globalThis.fetch;
  let graphqlCalls: string[];
  let exchanges: number;

  const env = {
    OPENAI_API_KEY: 'sk-test',
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: SECRET,
    SHOPIFY_APP_URL: 'https://app.test',
  };

  const subscription = {
    data: {
      currentAppInstallation: {
        activeSubscriptions: [
          {
            id: 'gid://shopify/AppSubscription/1',
            name: 'StoreAgent Plus',
            status: 'ACTIVE',
            test: true,
            currentPeriodEnd: '2026-10-09T08:00:00Z',
            trialDays: 0,
            lineItems: [
              {
                id: 'gid://shopify/AppSubscriptionLineItem/1',
                plan: {
                  pricingDetails: {
                    __typename: 'AppRecurringPricing',
                    price: { amount: '599.00', currencyCode: 'USD' },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  };

  /**
   * Shopify, with a token that has been invalidated. The first exchange hands
   * back the dead token the app already had; the second hands back a live one.
   */
  function stubShopify({ everRecovers = true } = {}) {
    exchanges = 0;
    graphqlCalls = [];
    globalThis.fetch = (async (input: any, init: any) => {
      const target = String(typeof input === 'string' ? input : input.url);
      // The test's own requests to the gateway must not be intercepted.
      if (target.includes('127.0.0.1')) return realFetch(input, init);

      if (target.includes('/admin/oauth/access_token')) {
        exchanges++;
        const fresh = exchanges > 1 && everRecovers;
        return new Response(
          JSON.stringify({ access_token: fresh ? 'shpat_live' : 'shpat_dead', scope: 'read_products' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (target.includes('/graphql.json')) {
        const sent = String((init.headers ?? {})['x-shopify-access-token']);
        graphqlCalls.push(sent);
        if (sent !== 'shpat_live') {
          return new Response('unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify(subscription), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
  }

  beforeEach(async () => {
    realFetch = globalThis.fetch;
    // Wired as main.ts wires it: apiFor reads the token from the shop store on
    // every call, so a re-provisioned token is the one the retry uses.
    const shops = new MemoryShopStore();
    const billing = new BillingService({
      store: new SqliteBillingStore(openDatabase({ path: ':memory:' })),
      apiFor: async (s) => {
        const record = await shops.get(s);
        if (record === undefined) return undefined;
        return {
          shop: s,
          accessToken: record.accessToken,
          returnUrl: 'https://app.test/admin',
          test: true,
        };
      },
    });
    server = createGateway({ config: loadConfig(env), shops, billing });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('re-mints the token when Shopify rejects it, and reads the real plan', async () => {
    stubShopify();
    const body = await realFetch(`${base}/admin?id_token=${token()}&charge_id=1`).then((r) =>
      r.text(),
    );

    // Exchanged once to provision, then again because the token was refused.
    expect(exchanges).toBe(2);
    expect(graphqlCalls).toEqual(['shpat_dead', 'shpat_live']);
    // And the merchant is finally shown what they are paying for.
    expect(body).toContain('Plus');
    expect(body).not.toMatch(/<span class="chip">Free<\/span>/);
  });

  it('gives up after one re-mint rather than exchanging forever', async () => {
    // If the fresh token is refused too, the problem is not the token.
    stubShopify({ everRecovers: false });
    const r = await realFetch(`${base}/admin?id_token=${token()}&charge_id=1`);

    expect(r.status).toBe(200); // the dashboard still renders
    expect(exchanges).toBe(2);
    expect(graphqlCalls).toHaveLength(2);
  });
});

describe('stale plan self-heal', () => {
  const withBilling = (planId: string) => ({
    ...viewModel(),
    billing: {
      planId,
      planName: planId === 'plus' ? 'Plus' : 'Free',
      status: 'active',
      used: 18,
      included: 100,
      remaining: 82,
      overageMinor: 0,
      verdict: 'ok',
      test: true,
      history: [],
    },
  });

  it('asks the server to reconcile after paint', () => {
    // Without this the page only ever reconciled when the merchant returned
    // with a charge_id, so opening the app normally showed a stale plan.
    const out = renderAdmin(withBilling('free') as Parameters<typeof renderAdmin>[0]);
    expect(out).toContain("fetch('/admin/billing'");
  });

  it('compares against the plan it actually rendered, so it cannot reload forever', () => {
    // The rendered plan is embedded; a reload only happens when it differs
    // from the reconciled one, and the reconcile has already persisted that.
    const out = renderAdmin(withBilling('plus') as Parameters<typeof renderAdmin>[0]);
    expect(out).toContain('var rendered = "plus"');
  });

  it('does nothing when billing is not configured', () => {
    const out = renderAdmin(viewModel() as Parameters<typeof renderAdmin>[0]);
    expect(out).toContain('var rendered = null');
  });
});

/**
 * The whole product rests on not overclaiming. These assert the admin refuses
 * to show a lift figure the sample cannot support — no greyed-out placeholder,
 * no "provisional" number a merchant might act on.
 */
describe('results panel honesty', () => {
  const arm = (sessions: number, conversions: number) => ({
    sessions,
    conversions,
    revenueMinor: conversions * 18_900,
  });

  it('shows no lift figure while the sample is thin', () => {
    const out = renderAdmin(viewModel({}, [arm(120, 5), arm(30, 1)]));
    expect(out).toContain('Still measuring');
    expect(out).not.toMatch(/Incremental revenue[\s\S]{0,200}\$\d/);
  });

  it('explains what is missing rather than showing an empty box', () => {
    const out = renderAdmin(viewModel({}, [arm(120, 5), arm(30, 1)]));
    expect(out).toMatch(/Not enough (sessions|orders)/);
  });

  it('reports revenue only once the effect is significant', () => {
    const out = renderAdmin(viewModel({}, [arm(20_000, 800), arm(20_000, 600)]));
    expect(out).toContain('Incremental revenue');
    expect(out).toContain('95% CI');
    expect(out).not.toContain('Still measuring');
  });

  it('does not claim revenue when the arms are indistinguishable', () => {
    const out = renderAdmin(viewModel({}, [arm(5_000, 150), arm(5_000, 148)]));
    expect(out).toContain('Not proven yet');
  });

  it('reports a negative result rather than hiding it', () => {
    const out = renderAdmin(viewModel({}, [arm(20_000, 500), arm(20_000, 700)]));
    expect(out).toContain('lower');
    expect(out).toContain('Not proven yet');
  });

  it('surfaces unmatched orders instead of silently dropping them', () => {
    const vm = { ...viewModel({}, [arm(20_000, 800), arm(20_000, 600)]), unmatchedOrders: 7 };
    expect(renderAdmin(vm)).toContain('7 order(s)');
  });

  it('suggests a different holdout when the current one is off', () => {
    const vm = { ...viewModel({ holdoutFraction: 0.05 }), recommendedHoldout: 0.3 };
    expect(renderAdmin(vm)).toContain('30%');
  });
});

describe('admin http surface', () => {
  let server: Server;
  let base: string;

  const env = {
    OPENAI_API_KEY: 'sk-test',
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: SECRET,
    SHOPIFY_APP_URL: 'https://app.test',
  };

  beforeEach(async () => {
    server = createGateway({ config: loadConfig(env) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses an unauthenticated admin load', async () => {
    const r = await fetch(`${base}/admin`);
    expect(r.status).toBe(401);
  });

  it('refuses a shop query parameter as authentication', async () => {
    // Otherwise anyone could read any merchant's settings by guessing a name.
    const r = await fetch(`${base}/admin?shop=${SHOP}`);
    expect(r.status).toBe(401);
  });

  it('renders for a valid session token', async () => {
    const r = await fetch(`${base}/admin?id_token=${token()}&host=abc`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(SHOP);
    expect(body).toContain('StoreAgent');
  });

  it('scopes frame-ancestors to the shop and the Shopify admin', async () => {
    const r = await fetch(`${base}/admin?id_token=${token()}`);
    expect(r.headers.get('content-security-policy')).toBe(
      `frame-ancestors https://${SHOP} https://admin.shopify.com;`,
    );
  });

  it('denies framing entirely when unauthenticated', async () => {
    const r = await fetch(`${base}/admin`);
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none';");
  });

  /**
   * The unauthenticated page is only ever seen inside the Shopify admin iframe,
   * and `frame-ancestors 'none'` meant the browser blocked the frame and showed
   * its own security warning instead. The merchant got a scary generic error in
   * place of the one page that could tell them what to do — and the fix for the
   * usual cause (never connected) was one click they could not reach.
   */
  it('lets the named shop frame the unauthenticated page, so it is readable', async () => {
    const r = await fetch(`${base}/admin?shop=${SHOP}`);
    expect(r.status).toBe(401);
    expect(r.headers.get('content-security-policy')).toBe(
      `frame-ancestors https://${SHOP} https://admin.shopify.com;`,
    );
  });

  it('offers an install link that escapes the iframe', async () => {
    const body = await fetch(`${base}/admin?shop=${SHOP}`).then((x) => x.text());
    expect(body).toContain(`/shopify/auth?shop=${encodeURIComponent(SHOP)}`);
    // Shopify's login refuses to be framed, so OAuth must break out of the
    // admin iframe or it dead-ends on a blank frame.
    expect(body).toContain('target="_top"');
  });

  it('still denies framing when the named shop is not a real myshopify domain', async () => {
    // The relaxation rides entirely on the strict allowlist. If a bogus or
    // injected value could widen frame-ancestors, this would be clickjacking.
    for (const bogus of ['evil.com', 'acme.myshopify.com.evil.com', 'a b', '']) {
      const r = await fetch(`${base}/admin?shop=${encodeURIComponent(bogus)}`);
      expect(r.status).toBe(401);
      expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none';");
    }
  });

  it('never lets a shop value inject a second header or directive', async () => {
    const r = await fetch(`${base}/admin?shop=${encodeURIComponent('acme.myshopify.com https://evil.com')}`);
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none';");
  });

  it('never caches admin html', async () => {
    const r = await fetch(`${base}/admin?id_token=${token()}`);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a settings write with no token', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accentColor: '#000000' }),
    });
    expect(r.status).toBe(401);
  });

  it('accepts a valid settings write', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ accentColor: '#102030', cornerRadius: 12, position: 'left' }),
    });
    expect(r.status).toBe(200);
  });

  it('rejects a pale accent with an explanation', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ accentColor: '#ffff00' }),
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toContain('4.5:1');
  });

  it('ignores a shop supplied in the settings payload', async () => {
    // The shop must come from the verified token, not the request body.
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ shop: 'victim.myshopify.com', accentColor: '#123456' }),
    });
    expect(r.status).toBe(200);

    // Victim's settings must be untouched: load the admin AS the victim.
    const victimToken = signSessionToken(
      { dest: 'https://victim.myshopify.com', aud: API_KEY },
      SECRET,
    );
    const page = await fetch(`${base}/admin?id_token=${victimToken}`).then((x) => x.text());
    expect(page).not.toContain('#123456');
  });

  it('rejects malformed json on save', async () => {
    const r = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: 'nope',
    });
    expect(r.status).toBe(400);
  });

  it('404s an unknown admin route', async () => {
    expect((await fetch(`${base}/admin/nope?id_token=${token()}`)).status).toBe(404);
  });
});

describe('plan chooser', () => {
  const billing = {
    planName: 'Free',
    planId: 'free',
    status: 'none',
    used: 18,
    included: 100,
    remaining: 82,
    overageMinor: 0,
    verdict: 'ok',
    test: true,
  };
  const vm = () => ({
    shop: SHOP,
    apiKey: API_KEY,
    host: 'abc',
    settings: {
      shop: SHOP,
      enabled: true,
      accentColor: '#1b3a34',
      cornerRadius: 16,
      position: 'right' as const,
      greeting: '',
      holdoutFraction: 0.2,
      updatedAt: 0,
    },
    stats: { activeSessions: 8, mode: 'live' as const, model: 'gpt-5.6-terra' },
    lift: analyze({ sessions: 0, conversions: 0, revenueMinor: 0 }, { sessions: 0, conversions: 0, revenueMinor: 0 }),
    liftSummary: '',
    recommendedHoldout: 0.2,
    unmatchedOrders: 0,
    billing,
  });

  /**
   * The chooser used to be three bare "Switch to Growth/Scale/Plus" buttons.
   * A merchant deciding whether to upgrade had to leave the page to find out
   * what a plan cost or included — the two facts the decision is made on.
   */
  it('shows the price and allowance at the point of choice', () => {
    const html = renderAdmin(vm());
    expect(html).toContain('$49.00');
    expect(html).toContain('$199.00');
    expect(html).toContain('$599.00');
    expect(html).toMatch(/500 conversations/);
    expect(html).toMatch(/2,500 conversations/);
    expect(html).toMatch(/10,000 conversations/);
  });

  it('marks the current plan and offers no button to re-buy it', () => {
    const html = renderAdmin(vm());
    expect(html).toContain('plan-current');
    expect(html).toContain('Your plan');
    // The current plan must not also appear as a purchasable option.
    expect(html).not.toMatch(/data-plan="free"[^>]*>Cancel/);
  });

  it('offers cancellation only when there is a subscription to cancel', () => {
    const paid = renderAdmin({ ...vm(), billing: { ...billing, planId: 'plus', planName: 'Plus' } });
    expect(paid).toContain('Cancel subscription');
    // On Free there is nothing to cancel.
    expect(renderAdmin(vm())).not.toContain('Cancel subscription');
  });

  it('states the overage rate next to the plans that charge it', () => {
    const html = renderAdmin(vm());
    expect(html).toMatch(/then \$0\.06 each/);
  });

  it('reports usage as a labelled meter, not a bare bar', () => {
    const html = renderAdmin(vm());
    expect(html).toContain('meter-ok');
    expect(html).toMatch(/18 of 100 conversations used/);
    expect(html).toMatch(/18% used/);
    expect(html).toMatch(/82 left/);
  });

  it('turns the meter amber before the merchant hits the wall', () => {
    // Discovering the limit by the widget going quiet is how merchants churn.
    const html = renderAdmin({ ...vm(), billing: { ...billing, used: 85, remaining: 15 } });
    expect(html).toContain('meter-warn');
  });

  it('keeps test-billing visible rather than hiding it', () => {
    expect(renderAdmin(vm())).toContain('Test billing is on');
  });
});
