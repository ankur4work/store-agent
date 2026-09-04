# Status — what is built, what is not

Last updated 2026-09-04, at commit `3a95e8a`.

**Short answer: the product is built; the business around it is not, and none of
it has ever touched a real Shopify store.**

589 tests pass and typecheck is clean. That means the code does what the tests
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

Widget is 9.09 KB gzipped against a 15 KB gate. Grounding runs a 28-case eval.
Voice is verified live through a TTS → STT round trip.

---

## Remaining to develop

### 1. Billing — nothing exists

`ARCHITECTURE §13` specifies a pricing table. **No part of it is implemented.**
There is no Shopify Billing API integration, no plan enforcement, no usage
counting, no trial handling.

Concretely: **you cannot charge anyone.** Every install would be free and
unlimited, and every token would be billed to you. This is the largest single
gap and it is not a Phase 4/5 nicety — it is the difference between a product
and a hobby.

### 2. Rate limiting and spend control — nothing exists

There is no per-shop quota, no throttle, and no budget ceiling. `/api/chat` is
reachable directly, so `ALLOWED_ORIGINS` (a browser-enforced control) does not
stop a script.

The exposure is asymmetric: someone who finds the endpoint can run up
unbounded model spend on your key, and the first signal would be the invoice.
This should land **before** any public URL, not after.

`ARCHITECTURE §7.4`'s budget ladder is the intended design and is unbuilt.

### 3. Observability — nothing beyond stdout

No metrics, no error tracking, no tracing. `/healthz` reports liveness and
nothing else. A grounding regression, a rising validator failure rate, or a
latency cliff would all be invisible until a merchant complained.

The `validator failure < 1%` gate in §12 **cannot be measured** without this, so
Phase 1's own gate is currently unverifiable in production.

### 4. Phase 4 — Scale (unstarted)

Multi-region, tenant isolation, budget ladder, chaos tests. Includes replacing
SQLite with Postgres, which is what lifts the current one-instance limit and
allows zero-downtime deploys.

### 5. Phase 5 — Launch (unstarted)

Built for Shopify review, merchant-facing docs, pricing page, CWV certification.

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
- **The Dockerfile has never been built** — Docker is not installed in the
  development environment.

Expect the first development-store install to fail once or twice. That is normal
and is exactly why it should happen before any merchant sees this.

---

## Suggested order

1. **Install on a development store.** Cheapest way to convert five unknowns
   into facts, and it gates everything else.
2. **Rate limiting**, before any public URL exists.
3. **Billing**, before any merchant could plausibly sign up.
4. **Observability**, before there is traffic worth watching.
5. Phase 4, then Phase 5.

Steps 2–4 are each small next to what is already built. Step 1 is the one that
tells you whether the rest of the plan survives contact with reality.
