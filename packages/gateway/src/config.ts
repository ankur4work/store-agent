import { readFileSync } from 'node:fs';
import { DEFAULT_RATE_LIMITS, type RateLimitOptions } from './limits/limiter.js';

export interface ShopifyAppConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly scopes: string;
  readonly appUrl: string;
}

export interface GatewayConfig {
  readonly port: number;
  readonly production: boolean;
  /**
   * SQLite file. Must be on a mounted volume — on a container's ephemeral
   * filesystem it is no more durable than the Map it replaced.
   */
  readonly databasePath: string;
  readonly openaiApiKey: string;
  readonly shopDomain: string | undefined;
  readonly agentProfile: string;
  readonly models: { classify: string; workhorse: string; escalation: string };
  readonly allowedOrigins: readonly string[];
  /**
   * Present only when the app is fully configured for install. Absent means the
   * OAuth routes are disabled rather than half-working — a partly-configured
   * install flow fails in confusing ways at the worst moment.
   */
  readonly shopify: ShopifyAppConfig | undefined;
  readonly rateLimits: RateLimitOptions;
  /**
   * Create Shopify subscriptions as test charges (no money moves).
   *
   * Both mistakes here are silent, which is why production demands an explicit
   * value: left true, merchants subscribe and we are never paid while
   * everything looks healthy; set false while testing, real cards are charged.
   */
  readonly billingTest: boolean;
}

/** Load `.env` if present. Real deployments use the process environment. */
export function loadEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
        .filter(([k, v]) => k !== '' && v !== ''),
    );
  } catch {
    return {};
  }
}

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Put it in .env (gitignored) or the process environment.',
    );
  }
  const production = (env['NODE_ENV'] ?? '') === 'production';
  const allowedOrigins = (env['ALLOWED_ORIGINS'] ?? '*').split(',').map((s) => s.trim());
  const shopify = loadShopifyConfig(env);
  const rateLimits = loadRateLimits(env);

  // Defaults to test mode: of the two silent failures, never being paid is
  // recoverable and charging a real card by accident is not.
  const billingTestRaw = env['SHOPIFY_BILLING_TEST'];
  const billingTest = (billingTestRaw ?? 'true') !== 'false';

  // Fail at startup rather than in front of a merchant. Each of these is a
  // configuration mistake that is invisible in development and damaging in
  // production, so the check only fires when NODE_ENV=production.
  if (production) {
    const problems: string[] = [];
    if (allowedOrigins.includes('*')) {
      // A wildcard origin lets any site drive a merchant's assistant, and
      // bills them for it.
      problems.push('ALLOWED_ORIGINS must list real storefront origins, not "*"');
    }
    if (shopify === undefined) {
      problems.push(
        'SHOPIFY_API_KEY, SHOPIFY_API_SECRET and SHOPIFY_APP_URL are all required — ' +
          'without them the OAuth routes are disabled and no merchant can install',
      );
    }
    if (!env['STOREAGENT_DB']) {
      // Defaulting silently would put the database on the container's
      // ephemeral disk, which loses every install on the next deploy.
      problems.push('STOREAGENT_DB must point at a path on a mounted volume');
    }
    if (billingTestRaw === undefined && shopify !== undefined) {
      // Not defaulted in production. Silently shipping test mode means
      // merchants subscribe and we are never paid, and nothing looks broken;
      // silently shipping live mode charges real cards during a trial run.
      // Neither is a decision to make by omission.
      problems.push(
        'SHOPIFY_BILLING_TEST must be set explicitly in production — ' +
          '"true" to simulate charges, "false" to bill merchants for real',
      );
    }
    if (!rateLimits.enabled) {
      // /api/chat is reachable directly, so ALLOWED_ORIGINS — a browser-side
      // control — does not stop a script. Without limits the first signal of
      // abuse is the invoice.
      problems.push('RATE_LIMIT_ENABLED must not be false in production');
    }
    if (problems.length > 0) {
      throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
    }

    // A warning rather than a failure: running without a proxy is legitimate,
    // but behind one this is silently wrong in a way that is hard to notice.
    if (rateLimits.enabled && rateLimits.trustProxyHops === 0) {
      console.warn(
        '[config] TRUST_PROXY_HOPS=0. If this runs behind a reverse proxy, every request ' +
          'appears to come from the proxy, so all shoppers share one rate-limit bucket and ' +
          'will throttle each other. Set it to the number of proxies in front of this process.',
      );
    }
  }

  return {
    port: Number(env['PORT'] ?? 8787),
    production,
    databasePath: env['STOREAGENT_DB'] ?? './storeagent.db',
    openaiApiKey: apiKey,
    // Absent → demo mode with the fixture catalog. See tool-executor.ts.
    shopDomain: env['SHOP_DOMAIN'] ?? env['DEV_SHOP_DOMAIN'],
    agentProfile: env['AGENT_PROFILE'] ?? 'https://storeagent.dev/ucp-profile.json',
    models: {
      classify: env['MODEL_CLASSIFY'] ?? 'gpt-5.6-luna',
      workhorse: env['MODEL_WORKHORSE'] ?? 'gpt-5.6-terra',
      escalation: env['MODEL_ESCALATION'] ?? 'gpt-5.6-sol',
    },
    allowedOrigins,
    shopify,
    rateLimits,
    billingTest,
  };
}

function loadRateLimits(env: Record<string, string | undefined>): RateLimitOptions {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    // A typo must not silently disable a spend ceiling.
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
    return n;
  };

  return {
    enabled: (env['RATE_LIMIT_ENABLED'] ?? 'true') !== 'false',
    trustProxyHops: num('TRUST_PROXY_HOPS', DEFAULT_RATE_LIMITS.trustProxyHops),
    perIp: {
      burst: num('RATE_LIMIT_BURST', DEFAULT_RATE_LIMITS.perIp.burst),
      refillPerMin: num('RATE_LIMIT_REFILL_PER_MIN', DEFAULT_RATE_LIMITS.perIp.refillPerMin),
    },
    shopDailyUnits: num('DAILY_UNITS_PER_SHOP', DEFAULT_RATE_LIMITS.shopDailyUnits),
    globalDailyUnits: num('DAILY_UNITS_GLOBAL', DEFAULT_RATE_LIMITS.globalDailyUnits),
  };
}

function loadShopifyConfig(env: Record<string, string | undefined>): ShopifyAppConfig | undefined {
  const apiKey = env['SHOPIFY_API_KEY'];
  const apiSecret = env['SHOPIFY_API_SECRET'];
  const appUrl = env['SHOPIFY_APP_URL'];
  if (!apiKey || !apiSecret || !appUrl) return undefined;

  // A non-HTTPS app URL would put the OAuth callback — and therefore the
  // authorization code — on the wire in plaintext. Shopify rejects it too.
  if (!appUrl.startsWith('https://')) {
    throw new Error('SHOPIFY_APP_URL must be https:// — OAuth codes must not travel in plaintext');
  }

  return {
    apiKey,
    apiSecret,
    appUrl: appUrl.replace(/\/+$/, ''),
    scopes: env['SHOPIFY_SCOPES'] ?? 'read_products',
  };
}
