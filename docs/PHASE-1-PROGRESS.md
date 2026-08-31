# Phase 1 — Text MVP: Progress

**Status: 2 of 5 deliverables complete.** Gate not yet claimable — see §4.

| Deliverable | Status |
|---|---|
| Grounding validator | ✅ `packages/grounding` — 60 tests |
| Orchestrator (agent loop) | ✅ `packages/orchestrator` — 58 tests |
| Widget (theme app extension) | ⬜ not started |
| Gateway (Go, WebSocket) | ⬜ not started |
| Merchant admin (Remix + Polaris) | ⬜ not started |

```
npm test       → 160 passed (7 files, 3 packages)
npm run typecheck → clean (tsc --build, project references)
npm run bench  → ALL BUDGETS MET
```

---

## 1. Grounding validator — the gate metric

The differentiator, built first because `validator failure < 1%` is the Phase 1 gate.

**Two independent check families**, deliberately separated so a failure is diagnosable rather than just "grounding failed":

- **Citation checks** — every declared claim resolves to a real tool call from this turn whose payload actually supports it. Catches *mis-citation*.
- **Coverage checks** — factual language in the prose must be traceable to some tool result, declared or not. Catches *fabrication*.

Coverage is the non-obvious half. Without it a model could emit `claims: []` and pass validation trivially while inventing prices in `reply`. There is a test for exactly that bypass.

**The validator is pure and synchronous.** No model in the loop where a string or number comparison suffices — the check must be cheaper and more reliable than the thing it is checking.

### Both halves of the gate are tested

A validator that rejects everything catches 100% of hallucinations and is useless. So the suite has two corpora:

| Corpus | Requirement | Contents |
|---|---|---|
| **Adversarial** | all must be caught | invented price, plausible-but-wrong price, alternate currency forms, spelled-out amounts, in-stock claim on a sold-out item, price with no tool call at all |
| **False-positive** | all must pass | correctly cited price, clarifying question, honest refusal, rating numbers (`4.6 out of 5`), quantities (`2 of those`), legitimate two-item sum, accurate out-of-stock with alternatives, brand copy without a delivery number |

The false-positive corpus is what keeps the < 1% target honest.

### Design notes

- **Bare numbers are never treated as money.** Only the UCP `{amount, currency}` shape counts as a source value. Otherwise ratings, counts, and quantities would register as prices and the check would be meaningless.
- **Negation is handled explicitly.** `"not in stock"` contains the substring `"in stock"` — naive matching gets it exactly backwards. Out-of-stock patterns are evaluated first, with a dedicated negation pattern ahead of them.
- **Bounded arithmetic derivation.** The model legitimately says "that's $268 for both", a value in no single tool field. Exact match is tried first, then pairs, triples, and the full-set total. *Known limitation:* quantity-weighted sums (3 × $79) are not covered — in practice cart results carry `subtotal`/`total`, so real totals match by exact lookup.
- **Retry feedback names the failure.** `violationsToFeedback` produces the specific violation codes and messages. A bare "try again" wastes the regeneration.

---

## 2. Orchestrator

### Prompt caching enforced in code, not code review

Caching is the business model (`ARCHITECTURE.md §7.4`): ~$84k/month of model spend with it, ~$310k without. A single interpolated timestamp disables it silently — no error, no failing test, just a 4× bill.

So the §7.3 audit checklist is now executable. `assertStable()` runs on every prefix build, in production as well as tests, and throws `UnstablePrefixError` on ISO timestamps, dates, clock times, UUIDs, session ids, cart ids, and epoch millis — naming the offending fragment and pointing at the fix.

`prefixFingerprint()` gives a stable 16-char hash per merchant. If it changes mid-session the cache was just invalidated; alert on it rather than discovering it in the monthly bill.

Volatile state has a designated home: `renderTurnContext()` renders page, cart, and navigation state into the **last user turn**, never the prefix.

### Adaptive thinking stays ON

The tempting latency optimization is `thinking: {type: 'disabled'}`. It is wrong here: on Sonnet 5 that makes the model measurably less likely to call tools — and this product is entirely tool-driven, so it would silently degrade the grounding we sell. `effort: 'low'` is the latency lever. There is a test asserting the request shape so nobody "optimizes" it later.

### Speculative tool execution

`search_catalog` fires in parallel with the model request, driven by a <2 ms local intent extraction. On a hit the model's tool round trip collapses to a memory read; on a miss we pay one wasted (edge-cached) call. Support intents (`where is my order`, `return policy`, `refund`) are excluded — no point speculating on those.

### The grounding gate wired into the loop

```
tool loop → structured output → validate
   ok            → return
   fail (1st)    → regenerate ONCE with the specific violations as feedback
   fail (2nd)    → escalate; never ship an ungrounded answer
```

Escalation is also the response to a model refusal (`stop_reason: 'refusal'`, checked *before* reading content), unparseable structured output, and a stuck tool loop. Tool failures do **not** escalate — the error is handed to the model so it can adapt, and grounding decides whether the answer is still safe.

Tests assert the escalation reply never contains the hallucinated figures from either failed attempt.

---

## 3. Bugs found

**Live array reference passed into the model call (real).** The loop passed its working `messages` array into `create()` and then kept pushing into it, so every recorded request mutated after being issued. A real HTTP client serializes immediately, so production output was correct — but request logs, traces, and any payload-replaying retry would all have lied. Fixed by snapshotting: a request is a value, not a reference. The test harness now deep-freezes what it records so the mock can't hide this class of bug again.

*How it surfaced:* a test asserted on `requests[2]` and got a `tool_result` where a user turn belonged. The instinct is to fix the index; the actual cause was upstream.

**`exactOptionalPropertyTypes` violation.** `evidence: string | undefined` is not assignable to `evidence?: string`. Fixed by omitting the key rather than assigning `undefined` — the distinction is real and the strict flag exists to enforce it.

**Monorepo type resolution.** Cross-package imports were resolving through a vitest alias but failing under `tsc`, meaning cross-package types were never actually checked. Fixed with proper TypeScript **project references** and a root solution `tsconfig.json`, so `tsc --build` compiles in dependency order and types are verified through real emitted `.d.ts`. Entry points corrected to `dist/src/` (tests share the package rootDir so they're typechecked too).

---

## 4. Gate status — not yet claimable

| Gate criterion | Status |
|---|---|
| Validator failure < 1% | **Partial.** Both corpora pass 100%, but on ~15 hand-written cases. A real rate needs a few hundred logged production turns. |
| p50 TTFT < 400 ms | **Unmeasured.** Needs the gateway + a live model endpoint. Client-side overhead is ~0.1 ms, so the budget is entirely network + model. |
| Loader < 15 KB | **Not applicable yet** — widget not started. Budget is wired in `perf/size-limit.json`. |

---

## 5. Still open

**OPEN-QUESTION #1 (from Phase 0) is still unresolved** — the `meta.ucp-agent.profile` key encoding needs verification against a live development store. It remains isolated to `UcpTransport.buildMeta()`.

**New in Phase 1:**

- **No live model verification.** No `ANTHROPIC_API_KEY` in this environment, so the orchestrator has only ever run against a scripted mock. The request *shape* is asserted, but nothing has verified that Sonnet 5 actually honours the structured-output schema and emits usable `claims`. This is the first thing to check once a key is available — the grounding design depends on it.
- **Streaming not implemented.** The loop is request/response. The p50 TTFT < 400 ms gate requires token streaming, which lands with the gateway.
- **Distributed cart lock** (Phase 0 OQ#2) still outstanding.

---

## 6. Next

1. Gateway (Go) — WebSocket termination, session hydration, streaming
2. Widget — theme app extension against the `perf/` budgets
3. Merchant admin — Remix + Polaris + App Bridge
4. Verify the orchestrator against a live Anthropic endpoint
5. Resolve OPEN-QUESTION #1 against a dev store
