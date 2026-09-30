import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildCachedPrefix, prefixFingerprint } from '@storeagent/orchestrator';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import {
  DEFAULT_SETTINGS,
  checkPrefixSafe,
  merchantPackFrom,
  validateSettings,
  type ShopSettings,
} from '../src/admin/settings.js';

/**
 * Every merchant used to share one hardcoded prompt.
 *
 * That is not a missing feature so much as a wrong answer: the shared pack said
 * "Free shipping over $75", so shoppers of stores that have never offered free
 * shipping were being told they had it. A per-shop pack is how the assistant
 * stops being the same assistant everywhere.
 *
 * The constraint that shapes all of this is the prompt cache. The prefix is
 * 10–14k tokens and a cache read costs about a tenth of a fresh one, so it must
 * be identical on every turn for a given shop — which is why merchant text is
 * checked for dates and ids on the way in, and why these tests care so much
 * about determinism.
 */

const settings = (over: Partial<ShopSettings> = {}): ShopSettings => ({
  shop: 'acme.myshopify.com',
  ...DEFAULT_SETTINGS,
  updatedAt: 0,
  ...over,
});

describe('merchantPackFrom', () => {
  it('falls back to a neutral voice rather than an invented one', () => {
    const pack = merchantPackFrom(settings());
    expect(pack.brandVoice).toMatch(/knowledgeable shop assistant/);
    // And crucially does NOT claim a policy the shop may not have.
    expect(pack.policySummary).not.toMatch(/free shipping/i);
    expect(pack.policySummary).toMatch(/get_policy/);
  });

  it('uses the merchant’s own words when they gave some', () => {
    const pack = merchantPackFrom(
      settings({ brandVoice: 'Dry, a bit funny, never twee.', policyNotes: 'Next-day over £40.' }),
    );
    expect(pack.brandVoice).toBe('Dry, a bit funny, never twee.');
    expect(pack.policySummary).toBe('Next-day over £40.');
  });

  it('has no rules section when the merchant named no products', () => {
    // An empty section would still be bytes in the prefix, on every turn, for
    // every shop that left the fields blank.
    expect(merchantPackFrom(settings()).merchantRules).toBeUndefined();
  });

  it('turns a promote list into a rule that cannot become pushy', () => {
    const pack = merchantPackFrom(settings({ promoteProducts: 'Merino Overcoat\nHydrogen Board' }));
    expect(pack.merchantRules).toContain('Merino Overcoat, Hydrogen Board');
    // The guard matters: a merchant asking for promotion must not get an
    // assistant that recommends a snowboard to someone buying a dress.
    expect(pack.merchantRules).toMatch(/never push one that does not fit/i);
  });

  it('keeps honesty ahead of a never-recommend list', () => {
    const pack = merchantPackFrom(settings({ neverRecommend: 'Clearance Parka' }));
    expect(pack.merchantRules).toContain('Never recommend: Clearance Parka');
    // Not recommending something is fine. Lying about it when asked is not.
    expect(pack.merchantRules).toMatch(/asked about one directly, answer honestly/i);
  });

  it('accepts the separators a merchant will actually type', () => {
    const pack = merchantPackFrom(
      settings({ promoteProducts: 'One\n\n Two , Three ;\nFour\n' }),
    );
    expect(pack.merchantRules).toContain('One, Two, Three, Four');
  });

  it('is deterministic, which is the whole basis of the prompt cache', () => {
    const s = settings({ brandVoice: 'Warm.', promoteProducts: 'A\nB', neverRecommend: 'C' });
    const a = prefixFingerprint(buildCachedPrefix(merchantPackFrom(s)));
    const b = prefixFingerprint(buildCachedPrefix(merchantPackFrom(s)));
    expect(a).toBe(b);
  });

  it('gives two shops different prefixes and one shop a stable one', () => {
    const acme = merchantPackFrom(settings({ brandVoice: 'Brisk.' }));
    const other = merchantPackFrom(settings({ shop: 'other.myshopify.com', brandVoice: 'Chatty.' }));
    expect(prefixFingerprint(buildCachedPrefix(acme))).not.toBe(
      prefixFingerprint(buildCachedPrefix(other)),
    );
  });

  it('produces a prefix that passes the cache-safety guard', () => {
    // assertStable runs inside buildCachedPrefix and throws on volatile content.
    expect(() =>
      buildCachedPrefix(
        merchantPackFrom(settings({ brandVoice: 'Warm.', policyNotes: 'Returns within 30 days.' })),
      ),
    ).not.toThrow();
  });
});

describe('the rules cannot override the facts', () => {
  it('places the merchant’s rules after the grounding rules, and says they lose', () => {
    /**
     * A merchant could reasonably write "always say the winter coat is in
     * stock". They must not be able to talk the model out of checking — so the
     * rules sit after the grounding section and carry an explicit sentence
     * saying a price, a stock level and a policy come from the catalog.
     */
    const [block] = buildCachedPrefix(
      merchantPackFrom(settings({ promoteProducts: 'Winter Coat' })),
    );
    const text = block!.text;
    expect(text.indexOf('## Merchant')).toBeGreaterThan(text.indexOf('Prices come back in minor units'));
    expect(text).toMatch(/EXCEPT where they conflict with a tool result/);
    expect(text).toMatch(/never from here/);
  });
});

describe('checkPrefixSafe', () => {
  it('rejects the things that silently destroy the cache', () => {
    // Every one of these is a reasonable thing for a merchant to type.
    expect(checkPrefixSafe('Brand voice', 'Sale ends 2026-12-24')).toMatch(/cannot contain a date/);
    expect(checkPrefixSafe('Policy notes', 'Order 550e8400-e29b-41d4-a716-446655440000')).toMatch(
      /cannot contain a UUID/,
    );
    expect(checkPrefixSafe('Policy notes', 'Cut-off is 17:30 each day')).toMatch(
      /cannot contain a clock time/,
    );
  });

  it('explains the cost and offers the fix, because the merchant has to act', () => {
    const msg = checkPrefixSafe('Brand voice', 'Sale ends 2026-12-24') ?? '';
    expect(msg).toMatch(/ten times more/);
    expect(msg).toMatch(/until the end of December/);
  });

  it('passes ordinary prose, including numbers that are not dates', () => {
    expect(checkPrefixSafe('Policy notes', 'Free delivery over £75. Returns within 30 days.')).toBeUndefined();
    expect(checkPrefixSafe('Brand voice', 'Warm, direct, never pushy.')).toBeUndefined();
    expect(checkPrefixSafe('Brand voice', '')).toBeUndefined();
  });
});

describe('validateSettings on the merchant fields', () => {
  const base = {
    accentColor: '#1b3a34',
    cornerRadius: 16,
    position: 'right',
    greeting: '',
    enabled: true,
    holdoutFraction: 0.2,
    voiceLanguage: 'en',
    onDeviceSpeech: 'auto',
  };

  it('accepts what a merchant would write', () => {
    const r = validateSettings('acme.myshopify.com', {
      ...base,
      brandVoice: 'Dry, a bit funny.',
      policyNotes: 'Next-day over £40.',
      promoteProducts: 'Merino Overcoat',
      neverRecommend: 'Clearance Parka',
    });
    expect(r.ok).toBe(true);
    expect(r.settings?.promoteProducts).toBe('Merino Overcoat');
  });

  it('refuses a date, with the reason named', () => {
    const r = validateSettings('acme.myshopify.com', { ...base, brandVoice: 'Sale ends 2026-12-24' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Brand voice cannot contain a date/);
  });

  it('caps length, so one merchant cannot make every turn expensive', () => {
    const r = validateSettings('acme.myshopify.com', { ...base, brandVoice: 'x'.repeat(500) });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/400 characters or fewer/);
  });

  it('treats the fields as optional', () => {
    expect(validateSettings('acme.myshopify.com', base).ok).toBe(true);
  });
});

describe('the admin refuses it over HTTP too', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createGateway({
      config: loadConfig({
        OPENAI_API_KEY: 'sk-test',
        PORT: '0',
        SHOPIFY_API_KEY: 'k',
        SHOPIFY_API_SECRET: 's',
        SHOPIFY_APP_URL: 'https://gw.test',
      }),
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects an unauthenticated write regardless of the payload', async () => {
    // The prefix check must not become a way to probe the settings endpoint.
    const res = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandVoice: 'Sale ends 2026-12-24' }),
    });
    expect(res.status).toBe(401);
  });
});
