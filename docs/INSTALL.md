# Installing on a Shopify store

What's built, what you need to supply, and the security decisions behind it.

---

## What exists

| Piece | Status |
|---|---|
| OAuth install flow (`/shopify/auth`, `/shopify/auth/callback`) | ✅ |
| HMAC verification — query + webhook | ✅ timing-safe |
| Shop domain validation (open-redirect / SSRF guard) | ✅ 26 rejection cases tested |
| Single-use, shop-bound, TTL'd state nonce (CSRF) | ✅ |
| Webhooks incl. the mandatory GDPR three | ✅ |
| `shopify.app.toml` manifest | ✅ needs your tunnel URL |
| Theme app extension (app embed block) | ✅ |
| Merchant admin UI | ⬜ **not built** — last Phase 1 item |
| Token persistence beyond process restart | ⬜ in-memory only |

108 gateway tests, 73 of them on the install path specifically.

---

## Steps

### 1. Rotate the API secret

The secret shared earlier is compromised. Partner Dashboard → your app →
**Client credentials** → rotate. The client ID does not change and is public —
it appears in every OAuth redirect.

### 2. Create a development store

Partner Dashboard → **Stores** → *Add store* → development store. Free, and it
also closes Phase 0's open question about the `meta.ucp-agent.profile` encoding,
which is still unverified against a real storefront.

### 3. Start a tunnel

Shopify's servers must reach your machine over HTTPS; `localhost` will not do.

```bash
cloudflared tunnel --url http://localhost:8787
```

Copy the `https://…trycloudflare.com` URL.

### 4. Fill in `.env`

```bash
SHOPIFY_API_KEY=37c27b85fef223ec4f8b89893af17ac6
SHOPIFY_API_SECRET=<the ROTATED secret>
SHOPIFY_APP_URL=https://your-tunnel.trycloudflare.com
SHOPIFY_SCOPES=read_products
```

All three of key / secret / URL must be present or the install routes stay
**disabled (503)** rather than half-working. A partly-configured OAuth flow
fails confusingly, at the worst possible moment — a merchant clicking *Install*.

### 5. Match the URLs in `shopify.app.toml`

`application_url` and `redirect_urls` must match `SHOPIFY_APP_URL` **exactly**.
A quick tunnel gets a new URL on every restart, so these move together — a
mismatch surfaces as a `redirect_uri` error mid-install.

### 6. Install

```bash
npm run build && node packages/gateway/dist/src/main.js
```

Then open:

```
https://your-tunnel.trycloudflare.com/shopify/auth?shop=your-dev-store.myshopify.com
```

You should be sent to Shopify's permission screen, and back into the store admin
afterwards. `GET /healthz` will show `"install": "ready"` and a non-zero
`installedShops`.

### 7. Turn the widget on

Store admin → **Online Store → Themes → Customise → App embeds** → enable
**StoreAgent**, and set the gateway URL to your tunnel. Brand colour and corner
radius are configurable there and passed to the widget as CSS custom properties.

---

## Security decisions

**Shop domain validation is the most critical function in the flow.** The `shop`
parameter is attacker-controlled and is used both to build a redirect the
merchant's browser follows *and* to build a server-side POST carrying our client
secret. A permissive check is simultaneously an open redirect and a
credential-leaking SSRF.

So it is a strict allowlist — only `{name}.myshopify.com` — and rejects anything
that merely *contains* a valid domain. Tested against 26 hostile inputs
including `acme.myshopify.com.evil.com`, `evil.com/acme.myshopify.com`,
`https://acme.myshopify.com`, `acme.myshopify.com:8080`, a Cyrillic-`а`
homoglyph, a trailing-dot FQDN, and `169.254.169.254`.

**Every HMAC comparison is timing-safe.** A `===` on an HMAC leaks the correct
value a byte at a time to anyone who can measure response time, turning
"unforgeable" into "forgeable in a few thousand requests".

**Webhooks verify the RAW body.** Parsing to JSON and re-serializing changes
whitespace and key order, so the HMAC never matches — and the tempting "fix" is
to skip verification, which makes the endpoint an unauthenticated write endpoint
for anyone who learns the URL. There is a test asserting the re-serialized body
fails, precisely so nobody is tempted.

**The state nonce is single-use, TTL'd, and bound to a shop.** Checking only
that the nonce exists would let a valid nonce for shop A authorize an install
against shop B. Both cases are tested.

**Failures leak nothing.** A rejected webhook returns a bare
`{"error":"unauthorized"}` — explaining *why* verification failed helps forge
the next attempt. A failed token exchange never includes the upstream response
body, which can echo the code or secret into our logs.

**Scopes are minimal.** Only `read_products`. Catalog data comes from the
*unauthenticated* UCP endpoint, not the Admin API, so we genuinely need very
little. `read_orders` is deliberately not requested — it needs Shopify's
protected customer data approval, which is a review process, and unused scopes
slow app review.

---

## Known gaps

**Tokens are in-memory.** A restart loses every install and the merchant must
reinstall. `ShopStore` is Postgres/Redis-shaped so this is an implementation
swap, not a refactor — but it must be done before anything real.

**No merchant admin.** After install there is nowhere to configure anything
beyond the theme editor settings. Last Phase 1 deliverable.

**Webhook registration isn't automated.** `shopify.app.toml` declares the
subscriptions; the Shopify CLI registers them on deploy. Nothing registers them
at runtime, so a manually-created app needs them added by hand.

**Not verified against a real store.** Every test uses a simulated Shopify. The
flow is correct by construction and heavily tested, but no merchant has
installed it yet — that step needs the dev store from §2.
