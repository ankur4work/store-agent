# Phase 5 — Launch

```bash
node scripts/check-launch.mjs
```

---

## A correction to §12

`ARCHITECTURE §12` lists **"Built for Shopify review"** as a Phase 5
deliverable, alongside docs, pricing and CWV certification. That is not
achievable, and the plan should say so.

Built for Shopify has prerequisites that no pre-launch app can satisfy:

- **50 net installs from paid shops**
- **5 reviews**, and a minimum rating
- **Admin Web Vitals at the 75th percentile over 28 days**, requiring at least
  100 recorded sessions

Built for Shopify is a **post-traction badge, not a launch gate.** You cannot
earn it before you have merchants, by construction.

What Phase 5 actually gates is the **Shopify App Store distribution review** —
the baseline needed to be listed at all. That *is* achievable now, and is what
`check-launch.mjs` audits. The BFS criteria are built toward anyway, since they
are the same engineering work; they simply cannot be claimed until later.

The competitive note from `RESEARCH.md` bears repeating here: SiteAgent has **0
reviews after 26 months**. Five reviews is not a formality for an app in this
category — it is a real milestone, and worth planning pilot stores around.

## Readiness

Everything mechanically checkable passes:

```
storefront performance (CWV)   11 checks   widget 11.82 KB gzipped
admin integration              10 checks   App Bridge, s-app-nav, save bar
extensions                      5 checks   theme app extension + web pixel
mandatory webhooks              6 checks   all four topics, HMAC verified
api version                     3 checks   2026-07, current
listing and copy                6 checks   no urgency, no guarantees
running server                  9 checks   auth, caching, ETag
```

Two real defects were found by writing this audit rather than by reading the
code:

1. **`widget.js` was served `no-cache`.** It loads on every page of every
   storefront, and Shopify themes are full-page reloads — so that was a
   revalidation round trip on every product click, against a gate that measures
   exactly this. Now `max-age=600, stale-while-revalidate=604800` with an ETag:
   repeat visits paint from cache, and a fix still reaches every storefront
   within ten minutes.
2. **The settings form used `alert()` for errors.** That is an unsolicited
   modal, which the guidelines forbid, and it put the error nowhere near the
   field that caused it. Errors are now inline and announced to screen readers.

## Submission checklist

Steps only a human can take, in order.

### Before submitting

- [ ] **Rotate every credential in this repo's history** — see `DEPLOY.md §1`.
      Three were pasted into a chat transcript and must be treated as public.
- [ ] Deploy to a stable HTTPS domain (`DEPLOY.md`)
- [ ] `SHOPIFY_BILLING_TEST=false` — and confirm you mean it
- [ ] Install on a **development store** and complete OAuth end to end
- [ ] Place a test order; confirm it reaches the Results panel
- [ ] Approve a test subscription and confirm the plan card updates
- [ ] Run a Lighthouse comparison with the app embed on and off (must be within
      10 points)
- [ ] Produce the five screenshots in `LISTING.md`
- [ ] Host `PRIVACY.md` at a public URL and link it in the listing
- [ ] Set the support email to a monitored inbox

### Listing

- [ ] Copy from `LISTING.md`
- [ ] Pricing matching `ARCHITECTURE §13` and the implemented plans
- [ ] App icon, 1200×1200
- [ ] Category: Store design → Chat, or Merchandising

### After approval

- [ ] Recruit pilot stores — 5 reviews is the binding BFS constraint
- [ ] Watch `/api/slo`: `groundingGate` is the one that matters
- [ ] Alert on `groundingGate == "fail"` and on `storeagent_errors_total`

## What is still unproven

Unchanged and worth repeating, because a passing audit is not a working app:

- **No OAuth install has ever completed.** HMAC, nonce and token exchange are
  unit-tested against constructed inputs, never against Shopify.
- **No order webhook has ever arrived**, so attribution is untested end to end.
- **The web pixel has never run in a storefront** — and it is the only join for
  holdout-arm orders, so if it is broken the product's central claim produces
  nothing.
- **No subscription has ever been created or approved.**
- **UCP is unverified against a live store.** Phase 0 OPEN-QUESTION #1 is open.
- **No microphone has ever been used.**
- **The Dockerfile has never been built.**
- **Multi-node Postgres is untested** — PGlite is single-connection.

The first development-store install converts most of that list into facts, and
it should be expected to fail once or twice. Nothing above is a reason to delay
it; all of them are reasons to do it before a merchant sees this.
