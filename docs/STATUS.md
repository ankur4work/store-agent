# Status — what is built, what is not

Last updated 2026-09-04.

**Short answer: the product is built; the business around it is not, and none of
it has ever touched a real Shopify store.**

725 tests pass and typecheck is clean. That means the code does what the tests
say. It does not mean a merchant can use this yet — the two are different
claims, and this document keeps them apart.

---

## Built (Phases 0–3)

| Phase | Deliverable | State |
|---|---|---|
| **0 — Spike** | UCP client, cart merge semantics, latency harness | done |
| **1 — Text MVP** | Widget, gateway, orchestrator, grounding validator, admin | done |
| **2 — Trust** | Attribution chain, holdout, ROI dashboard | done |
| **3 — Voice** | Voice lane, semantic endpointing, barge-in | done |
| **Deploy** | SQLite persistence, Dockerfile, config validation | done |
| **Hardening** | Rate limiting, persisted daily spend ceilings | done |
| **Billing** | Plans, Shopify subscriptions, usage, overage, admin card | built, unverified |
| **Observability** | Metrics, SLO gates, redacting structured logs | done |
| **4 — Scale** | Ladder, breaker, chaos tests, Postgres layer | started |
| **5 — Launch** | Readiness audit, merchant docs, admin compliance | started |

Widget is 11.7 KB gzipped against a 15 KB gate. Grounding runs a 28-case eval.
Voice is verified live through a TTS → STT round trip.

---

## Remaining to develop

### 1. Billing — **built**

The `ARCHITECTURE §13` plan catalog, Shopify Billing API integration, usage
counting, overage with an approved cap, trials, and the merchant-facing plan
card in the admin.

Billed per **resolved conversation**, counted once per session — a 20-message
conversation costs the same as a one-message one. Ungrounded answers and
handed-off conversations are free, because billing for those would charge most
for the turns we are worst at.

**Never verified against Shopify.** No subscription has ever been created, no
merchant has ever approved one, and no usage record has ever been posted. The
GraphQL request shapes are pinned by tests against a fake transport, which
proves we send what we intend — not that Shopify accepts it. Treat the first
real subscription as a test.

**`SHOPIFY_BILLING_TEST` has no default in production.** Both mistakes are
silent: left on, merchants subscribe and you are never paid; left off during a
trial run, real cards are charged.

### 2. Rate limiting and spend control — **built**

Two independent controls, because they stop different things: a per-client
token bucket bounds the *rate*, and persisted daily unit ceilings (per shop and
global) bound the *total*. Only the ceiling stops distributed low-rate traffic
that never trips a per-client limit but runs all day.

Verified over real HTTP, not just in unit tests. `/healthz` and Shopify
webhooks are exempt — a 429 on the former makes the orchestrator kill a healthy
container, and dropping `orders/create` corrupts the revenue attribution the
product is sold on.

**Set `TRUST_PROXY_HOPS=1` on Coolify.** Left at 0 behind a proxy, every
shopper shares one bucket and they throttle each other; see `DEPLOY.md`.

Still open: `ARCHITECTURE §7.4`'s budget *ladder* — degrading to a cheaper
model as a shop approaches its ceiling, rather than refusing outright — is not
built. Today the ceiling is a hard stop.

### 3. Observability — **built**

Prometheus metrics at `/metrics`, the §12 gates as JSON at `/api/slo`, and a
structured logger. Both routes need a bearer token and are disabled entirely
without one.

**The §12 gates are now measurable**, which they were not before: SLO
thresholds are histogram *bucket edges*, so "what fraction of turns were under
400 ms" is a subtraction of two exact counters rather than an interpolation.
Gates read `unknown` below 100 samples — "no data" and "failing" must not look
alike on a dashboard.

**Shopper messages are never logged.** Redaction is enforced in the logger by
field name rather than left to call sites, because relying on every future
call site to remember is how it leaks.

Still open: no external error tracking (Sentry or similar), no tracing, and no
alerting — `/api/slo` is a thing to poll, not a thing that pages you.

### 4. Phase 4 — Scale (**started**)

Done: the **budget ladder**, a **per-merchant circuit breaker**, retry with
full jitter, chaos tests, and a **Postgres layer tested against real
PostgreSQL 18.3** (PGlite, in-process) — 31 tests that execute the SQL rather
than typecheck it.

The ladder corrected a real bug: billing previously returned a hard `402` at
quota, which broke §8's *"never a hard cut-off mid-conversation with a
shopper"*. The person cut off was the shopper, who has no idea a billing
relationship exists. An exhausted allowance now degrades to FAQ-only instead.

Not done:
- **Multi-region and DNS failover.** Needs real infrastructure; unbuildable
  and untestable here.
- **Concurrency is unproven.** PGlite is single-connection, so multi-node
  contention is argued (single atomic statements everywhere) but not
  demonstrated. Two nodes on one Postgres is still an untested configuration.
- **Postgres is not wired into `main.ts`.** SQLite remains the default; the
  swap is documented in `POSTGRES.md` and needs a driver dependency.
- **Row-level security** — schema supports it, policies are a deployment step.
- **The 10x load test** in the §12 gate has not been run.

### 5. Phase 5 — Launch (**started**)

Done: `scripts/check-launch.mjs` (40 mechanical App Store / Built for Shopify
checks), merchant docs (`LISTING.md`, `PRIVACY.md`, `SUPPORT.md`), the launch
runbook (`LAUNCH.md`), and the admin gaps the audit exposed — `s-app-nav`,
Contextual Save Bar, inline errors replacing `alert()`.

**A correction to §12:** it lists "Built for Shopify review" as a Phase 5
deliverable. BFS requires **50 net paid installs and 5 reviews** — it is a
post-traction badge, not a launch gate, and cannot be earned before having
merchants. What Phase 5 actually gates is App Store *distribution* review.

Two real defects the audit found: `widget.js` was served `no-cache` (a
revalidation round trip on every storefront page load, against the very gate
that measures it), and the settings form used `alert()` for errors — an
unsolicited modal, nowhere near the offending field.

Not done: screenshots, a hosted privacy URL, the Lighthouse on/off comparison
(needs a real theme and Chrome), and submission itself.

### 6. Smaller gaps inside built phases

- **Attribution has no time-windowing.** Totals are lifetime; merchants will
  want "last 30 days", and an experiment should be restartable after a big site
  change.
- **Voice latency misses its gate.** TTS is ~2.6 s for a sentence against a
  500 ms mouth-to-ear target. Streaming TTS is the fix.
- **Widget VAD is energy-only.** The tested transcript-aware endpointer runs
  server-side and is not wired to the browser, so widget thresholds are
  conservative. This is the next voice latency win.
- **Voice cost is unmodelled.** §7.4 covers neither STT nor TTS, and a voice
  turn is likely several times the cost of a text turn.

---

## Not development — verification

Distinct from the list above, and the higher risk of the two. These are built
and tested against constructed inputs, but have **never run against Shopify**:

- **The OAuth install flow has never completed once.** HMAC, nonce, and token
  exchange are unit-tested; the round trip is not.
- **No order webhook has ever arrived.** Attribution is untested end to end.
- **The web pixel has never run in a storefront.** It is the only join for
  holdout-arm orders — if it is broken, the experiment produces nothing, and
  incrementality is the product's core claim.
- **UCP is unverified against a live store.** Phase 0 OPEN-QUESTION #1, the
  `meta.ucp-agent.profile` encoding, is still open.
- **No microphone has ever been used.** Widget capture, VAD, and playback are
  unexercised.
- **No subscription has ever been created.** Billing talks to Shopify's
  GraphQL Admin API, and not one call has been made against a real store.
- **The Dockerfile has never been built** — Docker is not installed in the
  development environment.

Expect the first development-store install to fail once or twice. That is normal
and is exactly why it should happen before any merchant sees this.

---

## Suggested order

1. **Install on a development store.** Cheapest way to convert five unknowns
   into facts, and it gates everything else.
2. ~~Rate limiting~~ — **done** (2026-09-04).
3. ~~Billing~~ — **done** (2026-09-04), but unverified against Shopify.
4. ~~Observability~~ — **done** (2026-09-04).
5. Phase 4 and Phase 5 — both started; see each section for what remains.

Every numbered item above is now built. What is left is not more code: it is
installing on a development store, which converts the unverified list below
into facts. Step 1 is the one that
tells you whether the rest of the plan survives contact with reality.
