# Phase 2 — Attribution & Incrementality

**Status: built and verified end to end.** 518 tests, typecheck clean,
`scripts/check-attribution.mjs` green against a live gateway.

```bash
node scripts/check-attribution.mjs   # simulates 9,000 shoppers, checks the chain
```

---

## The problem this solves

Every rival reports **influenced revenue**: sales where the shopper happened to
talk to the assistant. It is always a big number and it means nothing — the
assistant naturally talks to shoppers who were already going to buy. Merchants
have learned to discount it, which is why "AI increased your revenue 34%" moves
nobody.

The only honest answer needs a control group: a slice of shoppers who never see
the assistant, whose conversion rate you compare against. That is the whole
design.

---

## The chain

```
exposure   every eligible session, BOTH arms, recorded on first page load
   ↓
cart       exposed arm only — the cart the assistant created (UCP attribution)
   ↓
order      orders/create webhook = server-side truth
   ↓
join       order → session, by pixel (both arms) or cart token (exposed only)
```

### Why the web pixel is load-bearing, not analytics garnish

The obvious design joins orders to sessions through the cart the assistant
created. That works for the exposed arm and is **useless for the holdout** —
held-back shoppers never see the assistant, so there is no cart of ours to match
on. An unmeasurable control arm makes the entire comparison worthless.

So the pixel reports `checkout_completed` with our session id for **both** arms.
It is the only join available for the control group. The cart token is a second,
independent path that corroborates the exposed arm and catches sessions where
the pixel was blocked.

This also shapes the widget: **held-back sessions still load the widget and
still get a session id**, written where the pixel can read it. The widget
renders nothing, but that one job it must still do.

### Assignment

`assignArm(shop, sessionId, fraction)` — SHA-256 of `shop:sessionId`, first four
bytes as a uniform value in [0,1). Three properties, each tested:

- **deterministic** — a session that flips arms mid-visit contaminates both
- **uniform** — no modulo bias; verified across 20,000 assignments
- **shop-salted** — otherwise the same session lands in the same arm at every
  merchant, correlating experiments that should be independent

**The arm is decided server-side.** The widget asks and obeys. Deciding it in
the browser would let anyone with devtools put themselves in either group.

---

## Refusing to answer

The interesting engineering is in `analyze()` declining to report.

A figure needs **≥300 sessions and ≥10 orders in the smaller arm** before the
normal approximation is defensible, and revenue is claimed only when the effect
is also **statistically significant** (two-proportion z-test, p < 0.05). Until
then the admin shows what is missing and nothing else — no greyed-out
placeholder, no "provisional" number.

That restraint is the product. A merchant who sees a number acts on it; a number
that evaporates next month costs more trust than an empty state ever does.

Also honest by construction:

- **Negative results are reported.** If the assistant *reduces* conversion, the
  panel says so. It says "lower".
- **Incremental revenue is derived from the lift**, not from exposed-arm revenue:
  `(rate_exposed − rate_holdout) × sessions_exposed × AOV`. A test asserts it
  comes out well below the exposed arm's total, because the tempting bug is to
  report all of it.
- **Unmatched orders are surfaced**, not silently dropped. Ad blockers and
  direct-to-checkout flows produce orders we cannot attribute; they are excluded
  from both arms and counted where the merchant can see them.

---

## The arithmetic vendors leave out

`ARCHITECTURE §10` specified a 5% holdout. Building it made clear that **5% is
statistically unaffordable for most stores.** The holdout arm is the bottleneck:
at 5%, you need roughly twenty times total traffic to fill it.

Detecting a +20% relative lift on a 3% base rate needs:

| Holdout | Total sessions required |
|---|---:|
| 5% | **> 280,000** |
| 20% | ~71,000 |
| 50% | ~28,000 |

For a store doing a few thousand sessions a month, a 5% holdout means never
getting an answer. So `recommendedHoldout()` scales it with traffic — 50% for
tiny stores down to 5% at half a million sessions a month — and the admin says
plainly what the merchant is trading:

> *A smaller share costs fewer sales but takes far longer to give you an
> answer — the held-back group is the slower of the two to fill.*

Default is **20%**, not 5%.

---

## Verified

`scripts/check-attribution.mjs` simulates 9,000 shoppers through the real HTTP
surface:

```
ok  server assigns an arm
ok  refuses a figure on a thin sample
ok  explains what is missing
ok  arm is stable for a session
    injected: exposed 478/7171 (6.67%) · holdout 57/1829 (3.12%)
ok  holdout share is near the 20% default
ok  shows a confidence interval
ok  shows both arms
    reported incremental revenue: $48,617.49
ok  confidence interval excludes zero
```

An earlier run with a *realistic* 1pp effect (4% vs 3%) at the same volume
correctly reported **"No measurable difference yet, p = 0.28"** — a genuine
effect the sample could not support. That is the system working, and it is worth
knowing that a real store will see that message for a while.

---

## Open

- **Persistence.** Everything is in-memory; a restart loses the experiment.
  `AttributionStore` is Postgres-shaped, so this is a swap, not a refactor — but
  it must land before any real store, since a lost experiment cannot be
  reconstructed.
- **The pixel is unverified against real Shopify.** It is written against the
  documented `strict` sandbox API but has never run in one. Notably, the pixel
  sandbox cannot read the storefront's `localStorage`, so the session id is
  mirrored into the sandbox on first event with a Shopify-client-id fallback —
  that fallback is the part most likely to need adjusting on contact with
  reality.
- **The pixel is forgeable**, being client-side. It is recorded as provisional;
  the `orders/create` webhook is server-side truth and dedupes on order id.
- **No time-windowing.** Totals are lifetime. Merchants will want "last 30 days",
  and a long-running experiment should be restartable after a big site change.
