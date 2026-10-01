import { describe, expect, it } from 'vitest';
import { StorePolicies, extractPolicyText } from '../src/shopify/policies.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { newSession } from '../src/sessions.js';

/**
 * Answering a policy question from the merchant's policy, or not at all.
 *
 * `get_policy` read a hardcoded fixture for every shop. Verified against the live
 * dev store, a shopper asking about returns was told "within 30 days … return
 * shipping is free, refunds within 5 business days" — none of it the merchant's,
 * sourced to `example.test`, and reported `grounded: true`, because a tool result
 * did back the claim. The tripwire checks that a source exists. It cannot check
 * that the source was honest.
 *
 * So the tests that matter most here are the refusals.
 */

const POLICY_HTML = `<!doctype html><html><head><style>.x{color:red}</style></head>
<body><div class="shopify-policy__container"><div class="shopify-policy__body">
<p>Returns accepted within 14 days of delivery, in original condition.</p>
<p>Return postage is paid by the customer unless the item arrived faulty.</p>
</div></div><script>var theme={};</script></body></html>`;

describe('reading a merchant policy page', () => {
  it('pulls the merchant’s words out of the page', () => {
    const text = extractPolicyText(POLICY_HTML);
    expect(text).toContain('within 14 days');
    expect(text).toContain('paid by the customer');
    // Theme scripts and styles are not policy, and in a model's context they read
    // as though they were.
    expect(text).not.toContain('var theme');
    expect(text).not.toContain('color:red');
  });

  it('treats a page with no real prose as no policy at all', () => {
    // A cookie banner or a redirect stub is not a refund policy, and a few words
    // of it would be quoted as one.
    expect(extractPolicyText('<html><body><p>Enter store using password</p></body></html>')).toBe('');
  });

  it('fetches the shop’s own policy URL and caches it', async () => {
    const seen: string[] = [];
    const policies = new StorePolicies({
      now: () => 0,
      fetch: (async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return new Response(POLICY_HTML, { status: 200 });
      }) as typeof globalThis.fetch,
    });

    const got = await policies.get('acme.myshopify.com', 'returns');
    expect(got?.text).toContain('14 days');
    expect(got?.sourceUrl).toBe('https://acme.myshopify.com/policies/refund-policy');

    await policies.get('acme.myshopify.com', 'returns');
    expect(seen).toHaveLength(1); // policies change rarely; not once per turn
  });

  it('refuses to read a password page as a policy', async () => {
    /**
     * Every development store redirects `/policies/*` to `/password`, and that page
     * is a full HTML document whose stripped text reads like prose. Following the
     * redirect would turn "this store is not public" into a confident answer about
     * refunds, which is the exact failure class being fixed.
     */
    let redirectMode: RequestRedirect | undefined;
    const policies = new StorePolicies({
      now: () => 0,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        redirectMode = init?.redirect;
        return new Response('', { status: 302, headers: { location: '/password' } });
      }) as typeof globalThis.fetch,
    });

    expect(await policies.get('dev.myshopify.com', 'returns')).toBeUndefined();
    expect(redirectMode).toBe('manual');
  });

  it('caches the absence, so a closed store is not refetched every turn', async () => {
    let calls = 0;
    const policies = new StorePolicies({
      now: () => 0,
      fetch: (async () => {
        calls++;
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    });
    await policies.get('dev.myshopify.com', 'returns');
    await policies.get('dev.myshopify.com', 'returns');
    expect(calls).toBe(1);
  });

  it('only asks for topics it knows, never a model-supplied path', async () => {
    // The topic arrives from a model tool call. Interpolated unchecked it is a
    // request forgery against the merchant's own domain.
    const policies = new StorePolicies({
      now: () => 0,
      fetch: (async () => {
        throw new Error('should not fetch');
      }) as typeof globalThis.fetch,
    });
    expect(await policies.get('acme.myshopify.com', '../../admin')).toBeUndefined();
    expect(await policies.get('acme.myshopify.com', 'https://evil.test/x')).toBeUndefined();
  });

  it('survives a storefront that will not answer', async () => {
    const policies = new StorePolicies({
      now: () => 0,
      fetch: (async () => {
        throw new Error('ECONNRESET');
      }) as typeof globalThis.fetch,
    });
    expect(await policies.get('acme.myshopify.com', 'shipping')).toBeUndefined();
  });
});

describe('what a live shop is allowed to say', () => {
  const ucp = { getProduct: async () => ({}) } as never;

  function executor(policies?: ConstructorParameters<typeof StorePolicies>[0]) {
    return createToolExecutor({
      session: newSession('s1', 'acme.myshopify.com'),
      ucp,
      ...(policies === undefined ? {} : { policies: new StorePolicies(policies) }),
    });
  }

  it('answers from the merchant’s own page', async () => {
    const result = (await executor({
      now: () => 0,
      fetch: (async () => new Response(POLICY_HTML, { status: 200 })) as typeof globalThis.fetch,
    }).execute('get_policy', { topic: 'returns' })) as { text?: string; source_url?: string };

    expect(result.text).toContain('14 days');
    expect(result.source_url).toBe('https://acme.myshopify.com/policies/refund-policy');
  });

  it('never serves the demo fixture to a real shop', async () => {
    /**
     * The regression that matters. With the policy unreadable, the old code
     * returned the fixture — "30 days … return shipping is free" — as this
     * merchant's policy. It must now decline, and say so in a way the model can act
     * on rather than paper over.
     */
    const result = (await executor({
      now: () => 0,
      fetch: (async () => new Response('', { status: 302 })) as typeof globalThis.fetch,
    }).execute('get_policy', { topic: 'returns' })) as { error?: boolean; message?: string; text?: string };

    expect(result.error).toBe(true);
    expect(result.text).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/30 days|free|5 business days/i);
    expect(result.message).toMatch(/cannot confirm|not available/i);
  });

  it('declines when no policy source is wired at all', async () => {
    // Absent dependency must fail closed, not fall through to the fixture.
    const result = (await executor().execute('get_policy', { topic: 'shipping' })) as {
      error?: boolean;
      text?: string;
    };
    expect(result.error).toBe(true);
    expect(result.text).toBeUndefined();
  });
});
