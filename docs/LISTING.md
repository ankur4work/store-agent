# App Store listing

Draft copy for the Shopify App Store. Written to the App Store content rules:
no guarantees of outcome, no urgency pressure, no claims that cannot be
substantiated.

---

## Name

**StoreAgent** — 10 characters, does not truncate in the admin sidebar.

## Tagline (70 char limit)

> Product answers from your live catalog, with proof it drove sales.

## Short description (100 char limit)

> A shopping assistant that reads your live catalog, never invents a price, and
> proves its own lift.

---

## Long description

**Most shopping assistants are confidently wrong.** They index your catalog on
a schedule, so the moment you change a price or sell out, the assistant starts
telling shoppers something that is not true. Nobody finds out until a customer
does.

StoreAgent reads your catalog live, on every question. There is no index to go
stale, which is also why every plan includes **unlimited products** — we do not
charge for catalog size, because catalog size costs us nothing.

### It won't invent a price

Every answer is checked against the catalog data it was built from, before the
shopper sees it. A claim that cannot be traced to a real product is not sent —
and if a wrong number appears mid-sentence, it is retracted before it finishes
being typed.

This is enforced in code, not asked for in a prompt.

### It's fast enough not to be annoying

The widget is under 12 KB and loads after your page, never before it. Product
cards appear while the assistant is still writing, so shoppers see results
almost immediately rather than watching a spinner.

Nothing renders above the fold, and the launcher occupies a reserved space from
first paint — so it does not move your layout around.

### It shows you whether it actually worked

This is the part other assistants avoid.

A share of your shoppers — you choose, 20% by default — never see the
assistant at all. We compare what the two groups buy. That gives a real
before-and-after within the same period, on the same traffic, instead of
"influenced revenue" figures that quietly count sales you would have made
anyway.

You get a straight answer:

> Shoppers shown the assistant convert at 4.1% versus 3.2% held back — a 0.9
> point difference, 95% confident.

And when the numbers cannot yet support a conclusion, it says so and tells you
how much more traffic it needs. It will not show you a lift figure that
evaporates next month.

### Voice, when you want it

Shoppers can talk to it. Voice answers go through the same grounding checks as
typed ones — a spoken price cannot be un-said, so nothing unverified is ever
spoken.

---

## Key benefits (bullets)

- **Live catalog** — never a stale price, never a sold-out recommendation
- **Unlimited products on every plan**, including free
- **Under 12 KB**, deferred, zero layout shift
- **Real incrementality**, measured against a held-back control group
- **Installs in one click** — no theme code, removable from the theme editor

---

## Pricing

| Plan | Price | Resolved conversations |
|---|---:|---:|
| Free | $0 | 100 / month |
| Growth | $49 / month | 500 |
| Scale | $199 / month | 2,500 |
| Plus | $599 / month | 10,000 |

Additional conversations are $0.06 each, up to a limit you approve. Unlimited
products on every plan.

**You are billed for conversations the assistant resolves on its own.** A
twenty-message conversation counts once. Answers it could not ground, and
conversations handed to a human, are free — we would rather not charge for the
times it did not help.

---

## Screenshots to produce

1. Widget open on a product page, product cards visible mid-answer
2. The Results panel showing a measured lift with its confidence interval
3. The Results panel in its "still measuring" state — honesty is the pitch
4. Appearance settings with the live contrast check
5. Voice in progress

## Support

- Email: **admin@stockping.site**
- Docs: `SUPPORT.md`
- Privacy: `PRIVACY.md`

---

## Copy rules observed

Checked mechanically by `scripts/check-launch.mjs`:

- No countdown timers, urgency, or scarcity language
- No guaranteed outcomes — "proves its own lift" is a claim about
  *measurement*, not a promise of results, and the product shows a null result
  as readily as a positive one
- Plan-gated features are labelled, not hidden
- No comparison that names a competitor
