# StoreAgent — UI/UX & Performance Specification

**Principle:** the widget is a guest on someone else's revenue. It may never block a sale, never shift layout, never drop a frame, and never regress the merchant's Core Web Vitals.

---

## 1. Performance budget (CI-enforced)

Build fails on any regression.

| Metric | Budget | Measured by |
|---|---:|---|
| Loader bundle (gz) | **≤ 15 KB** | rollup-plugin-visualizer + size-limit |
| Full panel chunk (gz) | ≤ 25 KB | size-limit |
| Voice chunk (gz) | ≤ 40 KB | size-limit, lazy |
| Main-thread work before first interaction | **≤ 20 ms** | Lighthouse CI |
| CLS contribution | **0.00** | Lighthouse CI + CrUX diff |
| LCP contribution | **0 ms** | before/after CrUX on pilot stores |
| INP during streaming | ≤ 100 ms | field RUM, p75 |
| Panel open → interactive | ≤ 100 ms | RUM mark/measure |
| Frame rate while streaming | 60 fps | long-task observer |

**Context for why this is a headline feature:** the average Shopify app adds 50–150 KB of JS and 150–300 ms to LCP, and only ~48% of Shopify stores currently pass Core Web Vitals. Chat widgets are named among the top offenders. Being the app that provably *doesn't* cost the merchant rankings is a sales argument, not just engineering hygiene.

**Certification:** every pilot store gets a before/after 28-day CrUX comparison published in the merchant admin. We ship the receipts.

---

## 2. Load strategy

```
Page load
  └─ loader.js (defer, type=module, ~8 KB)
       └─ renders launcher button ONLY
          · no network calls
          · no webfonts
          · no images
          · no document.body writes
          · fixed 56×56 px reserved box → CLS 0.00

pointerenter / focus on launcher
  └─ prefetch panel chunk  ← user hasn't clicked yet; cost already paid

click
  └─ mount panel from cache  → interactive in < 100 ms

first mic press
  └─ lazy-load voice chunk (WebRTC + audio worklet)
```

**Never:**
- auto-open on first paint (destroys CWV *and* annoys shoppers)
- inject anything above the fold
- load a webfont — use the merchant's theme font stack via CSS custom properties
- run any work in the critical rendering path

**Intent-based invitation** (not auto-open): after 20 s dwell on a PDP, or on exit-intent with a non-empty cart, the launcher plays a subtle 200 ms pulse and shows a one-line contextual nudge ("Questions about sizing?"). Dismissed once → suppressed for the session. Dismissed twice → suppressed for 30 days.

---

## 3. Layout & placement

### Desktop
- Launcher: 56 px circle, bottom-right, 24 px inset
- Panel: 400 × 640 px, anchored bottom-right, 16 px above launcher
- Respects `prefers-reduced-motion` — animation collapses to an instant state change

### Mobile (the case that actually matters — 85%+ of traffic)
- Launcher: 52 px, bottom-right, **24 px above the safe-area inset**
- **Auto-hides on scroll-down, reappears on scroll-up.** A chat launcher parked over the "Add to cart" button on a 375 px viewport is a revenue bug. We detect the presence of a sticky ATC bar and offset above it.
- Panel opens as a **bottom sheet at 85 vh**, not a full-screen takeover — the shopper keeps visual context of the product they're asking about.
- Keyboard-aware: sheet resizes on `visualViewport` change; the composer never hides behind the keyboard.
- Drag-to-dismiss with rubber-band physics.

---

## 4. Conversation surface

### Streaming text
- Tokens buffer and flush on `requestAnimationFrame`, **not per token**. Per-token DOM writes are the single most common INP failure in chat UIs.
- No typewriter easing — render at the model's natural pace; artificial delay reads as slowness.
- The scroll container pins to bottom only while the user is already at the bottom. Scrolling up to re-read must never be yanked back.
- `contain: layout paint` on the message list; virtualize beyond 50 messages.

### Product cards
The highest-leverage UI in the product. Products are the answer to most questions — prose describing a product is a worse product page.

- Rendered as **structured components from tool results**, never as parsed markdown
- Horizontal snap-scroll carousel, 2.2 cards visible on mobile
- Each card: image, title, price, variant availability chip, one-tap **Add to cart**
- **Skeletons appear from the speculative catalog search** (see `ARCHITECTURE.md §6.2`) while the model's prose is still streaming — the shopper sees products before the sentence finishes
- Images preloaded via `<link rel="preload">` from the same speculative result

### Inline actions
- **Add to cart** inside the chat, optimistic UI with rollback on failure
- Quantity stepper, variant selector inline — never bounce the shopper to the PDP to change a size
- Cart state chip in the header, live
- Handoff: "Talk to a human" always visible in the overflow menu, never buried

### Motion
- `transform` and `opacity` only. No `height`, no `top`, no layout-triggering property.
- Panel open: 180 ms `cubic-bezier(0.32, 0.72, 0, 1)`
- Message enter: 120 ms translateY(4px) + fade
- All motion collapses to instant under `prefers-reduced-motion: reduce`

---

## 5. Voice UX

Voice is an affordance, not the product (see `RESEARCH.md §W3`). It must be excellent when chosen and invisible when not.

- **Never** request microphone permission on load. The prompt appears on the first deliberate mic press, preceded by a one-line explanation of why.
- Two interaction modes: **press-and-hold** (default on mobile — no permission ambiguity, no hot-mic anxiety) and **toggle** (hands-free, desktop).
- Live waveform driven by an `AudioWorklet` on a worker thread — never the main thread.
- **Interim transcript renders as the shopper speaks.** This is the single biggest perceived-latency win in voice: seeing words appear makes 400 ms feel instant.
- Explicit state machine, always visible: `idle → listening → thinking → speaking`. Ambiguity about whether the agent heard you is worse than latency.
- **Barge-in within 50 ms.** Speaking cancels TTS playback *and* aborts the in-flight model request. An agent that talks over you is unusable at any latency.
- Auto-fallback to text on: permission denial, three consecutive STT failures, or a noisy-environment signal — silently, mid-conversation, with the transcript preserved.
- Audio ducks (not stops) if the page has other media playing.

---

## 6. Merchant-facing customization

Pulled automatically from theme settings where possible — merchants should not re-enter their brand.

| Token | Source | Override |
|---|---|---|
| Accent color | Theme `color_scheme` | Admin |
| Border radius | Theme settings | Admin |
| Font stack | Theme CSS custom property | Admin |
| Launcher icon | Default set of 6 | Custom SVG upload |
| Position | bottom-right / bottom-left | Admin |
| Dark mode | `prefers-color-scheme` + theme | Force light / force dark / auto |

Everything renders inside Shadow DOM with tokens as CSS custom properties, so merchant CSS cannot break us and our CSS cannot break them.

**Merchant admin** (Remix + Polaris + App Bridge) is deliberately boring and native — Polaris components only, no custom design system. Merchants trust apps that look like Shopify.

---

## 7. Accessibility

Non-negotiable; also a Built for Shopify review criterion.

- Full keyboard operation: `Tab` to launcher, `Enter` opens, `Esc` closes, focus trapped in panel, focus returned to launcher on close
- Streaming responses announced via `aria-live="polite"` with debounced updates (announcing every token is unusable with a screen reader)
- Product cards are a proper `role="list"` with descriptive labels including price and availability
- 4.5:1 contrast minimum on all text, verified in CI against the merchant's chosen accent color — **we reject accent colors that fail contrast** rather than shipping an inaccessible widget
- Voice controls have text equivalents; voice is never the only path to any capability
- `prefers-reduced-motion` fully respected
- Touch targets ≥ 44 × 44 px

---

## 8. Empty, error, and edge states

Every state has a designed response. The agent never shows a stack trace, a spinner without end, or the word "error."

| State | Response |
|---|---|
| First open | Three contextual suggestion chips derived from the current page (PDP → sizing/shipping/similar; cart → shipping cost/returns; collection → "help me choose") |
| Model unavailable | Silent degrade down the ladder; shopper sees nothing |
| Everything unavailable | "I'm having trouble reaching our systems — leave your email and we'll follow up within an hour." Captures the lead. |
| Grounding validator fails twice | "I don't want to guess on that. Let me connect you to the team." → handoff |
| Out of scope | Redirect to what the agent *can* do, with one working suggestion |
| Merchant over budget | FAQ-only mode; shopper never learns why |
| Shopper in holdout | Launcher does not render at all |
| Offline | Composer disabled with an inline notice; queued message sends on reconnect |

---

## 9. Instrumentation

Every session emits to ClickHouse: open, first message, turn latencies (TTFT, tool time, total), tool calls, grounding validation results, product impressions, add-to-carts, escalations, voice mode usage, abandonment point.

Real-user monitoring reports p75 INP, CLS, and LCP delta **attributed to our widget specifically**, surfaced in the merchant admin next to the ROI numbers. A merchant who can see we cost them 0 ms doesn't churn over a performance rumour.
