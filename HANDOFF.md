# StoreAgent handoff - 2026-09-07

## Active task
Continue Claude's Shopify installation and extension deployment work from commit 35c4965. Do not restart the project or switch to unrelated backlog features.

## Verified on this device
- Public https://storeagent.tech/healthz returned ok=true, mode=live, install=ready, installedShops=0, shop=test-ankur-grxxuhm3.myshopify.com.
- Shopify CLI 4.7.1 is cached at C:/Users/kirti/AppData/Local/npm-cache/_npx/5e8c127031d71bbc/node_modules/@shopify/cli/bin/run.js. Run it with node; global shopify is absent. Use npm.cmd in PowerShell because npm.ps1 is blocked by execution policy.
- Authenticated CLI targets SDLC LIMITED / store agent; manifest client_id=37c27b85fef223ec4f8b89893af17ac6.
- app versions list showed only active store-agent-1, created 2026-08-31. No new version was created or released by Codex.

## Local fixes (uncommitted)
- Preserved the user's existing extension UID changes.
- Added @shopify/web-pixels-extension as a root dev dependency and updated lockfile: pixel bundling previously failed on missing import.
- Added extensions/storeagent-widget/locales/en.default.json: theme check previously failed on missing locales directory.
- Changed privacy webhook declaration to compliance_topics in shopify.app.toml.
- Added read_orders alongside read_products for the existing orders/create attribution webhook. Matched gateway scope default and .env.example. Existing local/hosted environment overrides are NOT changed; check SHOPIFY_SCOPES on the host before reinstalling.

## Verification
- Both extensions build successfully using Shopify CLI.
- npm.cmd run build passed.
- npm.cmd test --workspace @storeagent/gateway: 333 tests passed in 8 files.
- git diff --check passed.

## Current deployment blocker
app deploy --no-release now reaches Shopify version creation, which rejects:
"This app is not approved to subscribe to webhook topics containing protected customer data."
Do not delete the order webhook merely to hide this blocker; it is needed for revenue attribution.

## Next steps
1. In the Partner Dashboard select this app. If distribution is not selected, choose Public distribution as required by the user's App Store plan.
2. API access requests > Protected customer data access > Request access. Select protected customer data for order-based revenue attribution. The current order parser uses order id, total and cart token; it does not require name, email, phone or address fields.
3. Shopify documents that development-store-only testing does not need review submission after the relevant data selections are saved: https://shopify.dev/docs/apps/launch/protected-customer-data
4. Retry the cached CLI with app deploy --no-release, inspect the created version, then release as authorized.
5. Ensure hosted SHOPIFY_SCOPES matches read_products,read_orders and deploy the gateway changes through the existing hosting workflow.
6. Complete OAuth on the test store, enable the StoreAgent app embed, and test catalog answers. Pixel activation and order attribution still require end-to-end verification.

No secrets were copied into this handoff. Older README/STATUS/INSTALL documents contain stale progress claims; use current code and observed results.

## Update: dev-store test version RELEASED
- User prioritized running the app on the development store today.
- Full deployment remains blocked on protected customer data access.
- Added shopify.app.devtest.toml as an explicit widget/catalog-only configuration targeting the SAME app. Omits orders/create and the pixel extension, requests only read_products, and opens /admin. It does not provide order attribution.
- Removed optional app-level handle in devtest because Shopify rejected storeagent as non-unique. Full manifest still needs the same handle correction before full deployment.
- Created draft storeagent-2; separate app release reported version not found despite listing it. Combined app deploy --config devtest --allow-updates succeeded.
- ACTIVE version: storeagent-3, gid://shopify/Version/1118731075585.
- Dashboard: https://dev.shopify.com/dashboard/232511680/apps/417349271553/versions/1118731075585
- Confirmed widget.js HTTP 200; dev-store-origin CORS preflight HTTP 204 with matching allow-origin.
- Confirmed hosted OAuth redirect requests read_products and callback https://storeagent.tech/shopify/auth/callback, matching devtest scope.
- Live chat with home-page context returned six available snowboards and correct prices, grounded=true, escalated=false. About 17 seconds: functional but latency remains high.
- Existing smoke-gateway.mjs hardcodes page title Outerwear. Its generic run misleadingly passed after a no-results/handoff response; use correct Home context and snowboard query for this catalog.
- User must complete browser OAuth: https://storeagent.tech/shopify/auth?shop=test-ankur-grxxuhm3.myshopify.com
- Then Online Store > Themes > Customize > App embeds > StoreAgent > enable and Save. Keep Gateway URL https://storeagent.tech.
- Browser installation and actual storefront rendering are NOT yet verified. This session has no browser automation tool.
- Pending async user questions: installation result and dashboard protected-data access status.

## Update: price-rounding grounding bug found and reduced (2026-09-07, later session)

OAuth is still NOT done. `installedShops=0` on the live gateway; the browser
profile is not logged into Shopify, so the redirect stops at the login page.
This remains a user action.

### The bug
On the live gateway, "do you have any snowboards? what do they cost?" aborted
attempt 1 on **6 of 6** runs and escalated to a human handoff on **3 of 6** —
for a plain catalog question the store can answer.

Root cause: the model wrote `$785` for The Compare at Price Snowboard, whose
real price is `$785.95` (78595 minor). The tripwire extracted 78500, found it
underivable, and correctly killed the stream. This is the tripwire working as
designed, not a tripwire defect — verified by feeding the correct sentence
through `GroundingTripwire` at all 82 chunk-split points plus a realistic
token stream: zero false trips, so `settledPrefix` does not leak partials.

The defect was in the prompt. `GROUNDING_SYSTEM_RULES` said only "Prices come
back in minor units (18900 = $189.00). Convert before writing." Every example
had `.00` cents and nothing forbade rounding.

### Fixes applied (uncommitted)
- `packages/grounding/src/schema.ts` — price rule now gives a non-round example
  (78595 = $785.95), requires both decimal places, and forbids rounding.
  NOTE: this edits the cached system prefix, so it invalidates the prompt cache
  once on deploy. Unavoidable for any prompt change; cost is one-time.
- `packages/orchestrator/src/loop.ts` — `stream_aborted` trace now carries
  `violation.evidence`, not just the code. The bare code said an abort happened
  but not which number caused it; the evidence is what made this diagnosable.
- `scripts/smoke-gateway.mjs` — two repairs. Page context is no longer the
  hardcoded fabricated `collection/Outerwear`; it defaults to a bare home page
  and takes `PAGE_TYPE`/`PAGE_TITLE`. And PASS now requires `productCount > 0`,
  because a "we don't stock that" reply is grounded and unescalated and so
  passed vacuously before.

### Measured effect (local gateway, same model and live catalog)
- Before: 6/6 aborted attempt 1, 3/6 escalated, ~8s median.
- After: 5/6 single attempt, 0/6 escalated, 6/6 pass, ~5-6s median.
Reduced, NOT eliminated — 1 of 6 still rounded to $785 and recovered on retry.
If it needs to go to zero, the next lever is validating the model's own
`claims` prices against source money before streaming, rather than relying on
the prompt.

### Verification
- `npm.cmd run build` clean; full suite 799 tests across 9 workspaces passing.
- Local runs used an isolated DB in the scratchpad, never a shared one, per the
  single-node SQLite constraint.

### Gotcha
Local `.env` still has `AGENT_PROFILE=https://storeagent.dev/ucp-profile.json`,
the dead placeholder domain. Commit 35c4965 fixed code defaults but `.env` is
gitignored. Local UCP calls 422 until it is overridden to the `.tech` profile.
Worth fixing the line outright.
