# The Experience Contract

**This document is the bar. Any change that violates it does not ship — the build fails, not the review.**

Three commitments, in priority order. When they conflict, higher wins.

1. **Fast** — the shopper never waits without knowing why
2. **Smooth** — nothing jumps, stutters, or drops a frame
3. **Friendly** — zero learning curve, no dead ends, no nagging

---

## Part 1 — Fast

### The perception rules

Raw milliseconds matter less than *acknowledgement*. These are the thresholds where humans stop feeling in control:

| Interaction | Hard limit | Rule |
|---|---:|---|
| Any tap → visible feedback | **100 ms** | Never wait for the network to acknowledge a tap |
| Panel open → interactive | **100 ms** | Chunk is already prefetched on hover |
| Message sent → first token | **350 ms p50 / 700 ms p95** | Skeletons fill the gap |
| Voice: stop speaking → hear reply | **500 ms p50 / 800 ms p95** | Interim transcript covers the gap |
| Add to cart → confirmed | **0 ms perceived** | Optimistic, rollback on failure |

### No spinners. Ever.

A spinner says *"waiting, indefinitely."* A skeleton says *"arriving, here's the shape."* We use skeletons for everything, populated from the speculative catalog search (`ARCHITECTURE.md §6.2`) so product cards have real dimensions before the model has finished its first sentence.

The only permitted indeterminate indicator is the voice state chip (`listening / thinking / speaking`), because there the shopper genuinely needs to know which mode they're in.

### Never block input

- The composer stays enabled while the agent is responding. You can type your next question mid-answer.
- Sending a new message mid-response **interrupts and replaces** — it does not queue behind the old one. Aborts the in-flight model request.
- Offline: composer stays enabled, message queues, sends on reconnect with an inline "sending…" chip. No modal, no error.

---

## Part 2 — Smooth

### Cross-page persistence — the one that makes or breaks it on Shopify

**This is the highest-severity item in this document.**

Shoppers navigate constantly: collection → PDP → cart → back to PDP. On a standard Shopify theme, every one of those is a **full page reload**. A chat widget that resets on navigation is worse than no widget — the shopper asks a question on the collection page, taps a recommended product, and arrives to find the agent has forgotten they exist.

Every competitor in this category gets this partially wrong. The contract:

- Conversation state persists in `sessionStorage`, keyed by session ID, written on every turn
- On new page load, the launcher restores in **open state** if it was open, with full transcript, in < 150 ms — before the shopper notices the reload
- WebSocket reconnects silently and rehydrates server-side session from Redis
- The agent is told the shopper navigated: it knows they're now on the product it just recommended, and it can say so
- Scroll position within the transcript is preserved
- A half-typed message in the composer survives the navigation

Test: start a conversation on a collection page, ask for a recommendation, tap the product card, land on the PDP. The agent should still be mid-conversation and aware you took its advice. If that flow breaks, nothing else in this document matters.

### Frame budget

- **60 fps, always.** No long task over 50 ms during any interaction.
- Streaming tokens buffer and flush on `requestAnimationFrame` — never per token. Per-token DOM writes are the single most common INP failure in chat UIs.
- `transform` and `opacity` only for animation. No `height`, no `top`, no `width` — nothing that triggers layout.
- `contain: layout paint` on the message list. Virtualize past 50 messages.
- Audio waveform runs in an `AudioWorklet` on a worker thread, never the main thread.
- Images: explicit `width`/`height` on every product card image. One missing dimension is a CLS event.

### Zero layout shift

CLS contribution is **0.00**, not "low."

- The launcher occupies a fixed 56×56 reserved box from first paint
- The panel is `position: fixed` — it cannot displace page content
- Product carousels have fixed-height rails; cards fade in within the reserved space
- Nothing we render ever appears above the fold or in document flow

---

## Part 3 — Friendly

### Zero learning curve

No onboarding, no tour, no "here's how to use me." If the interface needs explaining, the interface is wrong.

The first open shows three **contextual** suggestion chips derived from the current page — not generic ones:

| Page | Chips |
|---|---|
| Product | "Will this fit me?" · "When does it arrive?" · "Show me similar" |
| Collection | "Help me choose" · "What's most popular?" · "Under $50" |
| Cart | "Shipping cost?" · "Return policy" · "Anything I'm missing?" |
| Order status | "Where's my order?" · "Start a return" |

### Never ask for what we can infer

The agent already knows: current page, product being viewed, cart contents, locale, currency, device, referring page, and whether the shopper is logged in. Asking "which product are you asking about?" while the shopper is staring at the product page is the fastest way to feel stupid.

### Tap economy

| Goal | Max taps |
|---|---:|
| Open agent → ask a question | 2 (open, type) |
| Recommendation → item in cart | **1** |
| Change size on a recommended item | 2 (inline variant selector — never bounce to the PDP) |
| Reach a human | 2 (overflow → "Talk to a human") |
| Close and never see it again this session | 1 |

### Forgiving input

Must handle without complaint: typos, vague intent ("something for my mom"), mid-sentence changes of mind, mixed language, questions about products the store doesn't carry, and pure browsing with no question at all.

The agent never says "I didn't understand that." It says what it *can* do and offers one working option.

### No dead ends

Every single response ends with a viable next action. If the agent can't help, the response is an escalation with an email capture — never a terminal apology.

| Situation | Response |
|---|---|
| Doesn't know | "I don't want to guess — let me get the team." → handoff |
| Out of stock | Show the closest in-stock alternatives + back-in-stock signup |
| Not carried | Show nearest category match, honestly framed |
| Out of scope | Redirect to one thing it can actually do |
| Everything down | Email capture with a stated response time |

### Doesn't nag

- Never auto-opens on load
- One contextual nudge per session, maximum, and only on a genuine intent signal (20 s dwell on a PDP, or exit-intent with a full cart)
- Dismissed once → silent for the session
- Dismissed twice → silent for 30 days
- Auto-hides on scroll-down on mobile so it never covers the Add to Cart button

### Tone

Short sentences. Plain words. No emoji unless the merchant's brand pack enables them. Never "Great question!" or "I'd be happy to help!" — just answer. Mobile shoppers read in glances; every wasted clause costs attention.

---

## Part 4 — Enforcement

None of the above is a guideline. Each maps to an automated gate.

| Contract item | Gate | Fails the build? |
|---|---|---|
| Loader ≤ 15 KB gz | `size-limit` in CI | ✅ |
| Panel ≤ 25 KB gz | `size-limit` in CI | ✅ |
| CLS 0.00 | Lighthouse CI budget | ✅ |
| No long task > 50 ms | Playwright + PerformanceObserver | ✅ |
| Panel open < 100 ms | Playwright trace assertion | ✅ |
| p50 TTFT < 350 ms | Load-test suite against staging | ✅ |
| Voice p50 < 500 ms | Synthetic voice harness | ✅ |
| Cross-page persistence | Playwright multi-navigation E2E | ✅ |
| Contrast ≥ 4.5:1 | axe-core on all brand token permutations | ✅ |
| Keyboard-only operation | axe-core + Playwright keyboard E2E | ✅ |
| No dead-end responses | Eval set: every response must contain an action | ✅ |

Plus a **field guard**: real-user monitoring reports p75 INP, CLS, and LCP delta attributed to our widget, per store, surfaced in the merchant admin. If we ever regress a merchant's Core Web Vitals, they see it before we do — which is exactly the accountability that makes the claim credible.

---

## The demo that proves it

One flow, recorded, in the sales page:

> Mobile. Collection page. Tap the launcher — panel is up in under 100 ms. Type "something warm for a wedding under $200." Product cards appear as skeletons within 200 ms, fill with real products before the sentence finishes. Tap one — full page navigation to the PDP, and the agent is still there, still open, mid-conversation, saying "good pick — that one runs slightly large." Tap the size. One tap to cart. Total: four taps, no waiting, no reload flicker, no layout shift.

If we can record that flow honestly on a real merchant's store, we win the category on feel alone.
