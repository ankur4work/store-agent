# Phase 1 — Text MVP: Progress

**Status: 4 of 5 deliverables.** You can now run it and watch someone use it.

| Deliverable | Status |
|---|---|
| Grounding validator | ✅ `packages/grounding` |
| Orchestrator (agent loop) | ✅ `packages/orchestrator` |
| Streaming | ✅ end-to-end, with a mid-stream grounding tripwire |
| Gateway | ✅ `packages/gateway` — SSE, sessions, demo storefront |
| Widget | ✅ `packages/gateway/public/widget.js` — 5.7 KB gzipped |
| Merchant admin | ⬜ not started |

```
npm test          → 267 passed (11 files, 4 packages)
npm run typecheck → clean
npm run build && node packages/gateway/dist/src/main.js
                  → http://localhost:8787
```

---

## Run it

```bash
npm install
npm run build
node packages/gateway/dist/src/main.js
```

Open **http://localhost:8787** — a demo storefront with the widget on it. Ask
*"do you have a warm wool coat?"* or *"what's your return policy?"*.

Needs `OPENAI_API_KEY` in `.env`. With no `SHOP_DOMAIN` set it runs in **demo
mode** against a fixture catalog, so the Shopify development store is no longer
blocking. Set `SHOP_DOMAIN` and it talks to a real store instead — configuration,
not code.

End-to-end check against a running gateway:

```bash
node scripts/smoke-gateway.mjs "is the overcoat available in L?"
```

---

## Streaming: structured output vs. time-to-first-token

Our answers are structured output — `{"reply": "...", "claims": [...]}` — so the
model streams **JSON, not prose**. Naive streaming paints `{"reply":"The Mer`.
Waiting for valid JSON throws away the whole TTFT budget.

**Resolution:** `reply` is deliberately the first property in the schema, and
`ReplyExtractor` pulls that string out of a growing, still-invalid document —
correct across chunk boundaries, including a chunk ending mid-escape-sequence
(`"a\` + `nb"`) or mid-`\uXXXX`. Tested one character at a time.

## The mid-stream grounding tripwire

Streaming and grounding pull against each other. Full validation needs the
`claims` payload, which arrives last — but the shopper is watching prose appear
*now*. Two bad options: buffer everything (no TTFT), or stream optimistically and
retract (shows a hallucinated price, then takes it back — the worst possible
failure for a product whose headline claim is *never makes things up*).

The expensive half of grounding — *is this price in the tool results?* — needs
only the tool results, which we already hold before the model writes a word. So
`GroundingTripwire` checks each fact the moment it is fully typed and **aborts
the generation mid-sentence** if one is unsupported. This is why the agent loop
is hand-rolled rather than an SDK tool runner: it has to kill an in-flight
generation.

Two subtleties that make it work:

- **Partial-token safety.** While `$189.00` is arriving the buffer briefly reads
  `$18`. Every check runs against a *settled prefix* that excludes any trailing
  token still capable of growing. The dot is the fiddly part: `$189.` may become
  `$189.50`, but `$189.00.` already has its decimals, so that second dot is
  punctuation.
- **Text is only released once validated.** The loop forwards
  `settledPrefix(accumulated)`, not raw deltas. Forwarding eagerly would paint
  `$189` and only *then* discover it was unsupported. Costs about one token of
  lag; makes it impossible for an ungrounded number to be seen.

On a trip the gateway emits `reset` and the widget clears the partial bubble.

---

## Latency: the target in ARCHITECTURE §6.1 was measuring the wrong thing

Measured end-to-end through the gateway:

| Metric | Measured | Note |
|---|---:|---|
| **Time to renderable products** | **44 ms** | first useful pixel |
| TTFT prose | ~2.9–3.6 s | after the tool round trip |
| Total turn | ~4.0–5.2 s | |

The 350 ms first-token budget is **not achievable for a tool-driven turn**, and
no amount of tuning changes that: the reply cannot begin until the model has
done a full inference pass to decide which tool to call, the tool has run, and a
second pass has produced the answer. Speculation collapses the *tool execution*
time, not the *model round trips*.

**So the metric was wrong, not the system.** What a shopper experiences is time
to first *useful pixel*, and product cards render in 44 ms — from the
speculative catalog search, before the model has said anything. The prose is
commentary on cards the shopper is already reading.

Both numbers are now tracked separately. `ARCHITECTURE.md §6.1` is corrected.

**One concrete win along the way:** the model was calling `search_catalog` then
`get_product` for detail the search results already contained. Rewriting both
tool descriptions to say so cut a full round trip — 3 model calls to 2, TTFT
6,008 ms → 3,518 ms, input tokens 3,881 → 2,543, same answer quality.

---

## Deliberate deviations from the architecture

Both documented in `server.ts`, neither silent drift:

**SSE over POST, not WebSocket.** Voice (Phase 3) genuinely needs a
bidirectional channel. Text chat does not — the client sends one message and
consumes one stream. SSE-over-POST is dependency-free, survives proxies that
mangle upgrade requests, and needs no session-correlation dance.

**Node gateway, not Go.** Go's advantage is connection density at 100k+
sockets/node, a scale problem we do not have. A Go gateway would also put a
process boundary between itself and the TypeScript orchestrator for no present
benefit. The connection-termination layer can be extracted later; that is a
contained change.

**Vanilla widget, not Preact.** It is a panel and a list. Preact would cost 4 KB
and buy nothing yet. At 5.7 KB gzipped we have 9.3 KB of headroom under the
15 KB budget — spend it when complexity earns it.

---

## Defects found by running it

**Money written in prose was invisible to grounding.** A policy question
produced *"free shipping over $75"* — a correct, grounded fact — and the
tripwire **aborted it**. `collectMoneyFromResult` only recognised UCP
`{amount, currency}` objects, so money inside policy *text* counted as
unsupported. It now also extracts from string values, while still ignoring bare
numbers (ratings, quantities, counts) that carry no currency marker.

This is the second time the grounding mechanism has rejected a correct answer.
Both times the fix was the same shape: the check was right, its notion of
"supported" was too narrow. Worth watching for a third.

**Static file paths only resolved in the built layout.** `../../public` works
from `dist/src/` and not from `src/`, so the served-files tests failed under
vitest. Now resolved by walking up until `public/` is found — works in both, and
returns `undefined` rather than silently serving the wrong directory.

---

## Still open

- **Merchant admin** (Remix + Polaris + App Bridge) — last Phase 1 deliverable.
- **Shopify OAuth / install flow** — nothing can be installed on a real store yet.
- **No Shopify development store**, so `meta.ucp-agent.profile` (Phase 0
  OPEN-QUESTION #1) is still unverified. Demo mode routes around it for now.
- **Persistence** — sessions are in-memory. The `SessionStore` interface is
  Redis-shaped so swapping is an implementation change, not a refactor.
- **The `<1%` grounding gate is still unproven.** Both corpora pass and two live
  paths work, but that is not an eval. It needs a few hundred logged adversarial
  turns.
- **Voice may be simpler than designed** — `gpt-realtime-2.1` and
  `gpt-live-transcribe` could collapse the Phase 3 STT → LLM → TTS pipeline into
  one hop. Evaluate before building §6.3 as specced.
