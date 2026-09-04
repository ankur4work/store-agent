# StoreAgent help

Merchant-facing documentation.

---

## Getting started

### 1. Install

Install from the Shopify App Store. You will be asked to approve access to your
products — that is the only permission requested, and it is read-only.

### 2. Turn the assistant on

**Online Store → Themes → Customise → App embeds → StoreAgent.**

Nothing is added to your theme code. You can switch it off from the same place
at any time, and uninstalling removes it completely.

### 3. Check it works

Open your storefront and ask it about a product you know the price of. If the
number matches the product page, everything is connected.

---

## Settings

Found in **Apps → StoreAgent**.

| Setting | What it does |
|---|---|
| **Accent colour** | The launcher and buttons. Contrast against white is checked as you type — a colour too light for white text is rejected rather than shipped |
| **Corner radius** | Matches your theme's roundness |
| **Position** | Which corner the launcher sits in |
| **Greeting** | First line the shopper sees. Leave blank for the default |
| **Held-back share** | The measurement control group — see below |

Changes save through Shopify's own save bar and take effect on the next page
load.

---

## Understanding your results

### Why some shoppers don't see the assistant

By default 20% of your shoppers never see it. This is deliberate, and it is the
only way to know whether the assistant is actually earning anything.

Every other tool reports "influenced revenue": it counts sales where the
shopper happened to interact with the assistant. The problem is that many of
those people would have bought regardless — so the number is always flattering
and never true.

Holding a group back gives you a genuine comparison, on the same traffic in the
same period. The cost is that a small share of shoppers get the store without
the assistant. The benefit is that the number you get is real.

**You can set it to 0.** You will get every sale, and no way to know which ones
the assistant earned.

### "Still measuring"

You will see this until there is enough traffic for a trustworthy answer. It
tells you roughly how many more sessions are needed.

We show a lift figure only once the numbers support one. A result that looks
good this month and disappears next month costs more trust than waiting does.

### Why the held-back group takes longest

The control group is the bottleneck — it fills at whatever share you set. A
smaller share costs you fewer sales but takes far longer to reach an answer. At
5% you need roughly four times the traffic of 20%.

### Unmatched orders

Some orders cannot be tied to a session — ad blockers, or a checkout reached
outside the storefront. They are **excluded from both sides** rather than
guessed at, and the count is shown so you know how much is unaccounted for.

---

## Billing

### What counts as a conversation

**One shopper conversation counts once**, however many messages it contains. A
shopper who asks twenty questions is billed the same as one who asks a single
question.

**Not counted:**
- Answers the assistant could not verify against your catalog
- Conversations handed to a human
- Shoppers in the held-back group, who never see it

### If you reach your limit

The assistant does not disappear. It drops to answering from your policies and
offering to pass the shopper to you — never a dead widget mid-conversation.
You will see a prompt to upgrade in the admin; your shoppers see nothing about
your plan.

You are warned at 80%, not at the wall.

### Changing plans

**Apps → StoreAgent → Plan.** Shopify handles the approval and the charge; we
never see your payment details. Downgrading to Free cancels the subscription
immediately.

---

## Troubleshooting

**The assistant isn't showing up.**
Check the app embed is enabled in the theme editor. If it is, you may be in the
held-back group yourself — open the storefront in a private window to get a
fresh session.

**It says it can't check something.**
Your storefront is not responding to catalog requests, or the app has lost
access. It falls back to answering from your policies rather than guessing.
Reinstalling restores access.

**A price looks wrong.**
It should not be possible — every price is checked against live catalog data
before being sent. Please email us with the question that produced it; this is
the most important bug we can receive.

**Cart buttons are missing.**
Cart actions switch off automatically when catalog data is stale or
unavailable, because adding the wrong variant is worse than adding none. They
return on their own.

**It's slower than usual.**
Most often the model provider is under load. The assistant drops to a faster
model rather than making shoppers wait.

---

## Removing StoreAgent

Uninstall from **Apps**. The widget disappears immediately — nothing is left in
your theme, because nothing was ever added to it.

48 hours later Shopify sends a redaction request and every record for your
store is deleted: settings, sessions, conversations, and measurement history.

**Your measurement history cannot be recovered after that.** If you may return,
export your results first.

---

## Contact

**admin@stockping.site** — with your store domain and, if reporting a wrong
answer, the exact question asked.
